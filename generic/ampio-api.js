// M-SERV HTTP API ("Ampio API", OpenAPI document taken from Ampio Designer: ampioin/db/openapi.json).
// The API runs on the M-SERV (default port 8060) with basic authentication; objects are mobile
// application objects (id_dev / object_id = object id), not CAN devices.
'use strict';

const DEFAULT_PORT = 8060;
const TIMEOUT = 10000;

// Parameters taken from msg.payload when neither the node nor msg sets them
const PAYLOAD_PARAMS = ['value', 'text', 'message'];

// Short name of an operation: the method, then the path without /api/ and json/, ids as {ID}, XML variants marked,
// ex. GET /api/json/group_devices/{id_group} -> "(GET) group_devices/{ID}", GET /api/xml/groups -> "(GET) groups (xml)".
// Same rules as the label of the node in ampioin/api.html.
exports.short_name = function (method, path) {
    let s = String(path).replace(/^\/api\//, '');
    let suffix = '';
    if (/^xml\//.test(s)) {
        s = s.slice(4);
        suffix = ' (xml)';
    } else {
        s = s.replace(/^json\//, '');
    }
    s = s.replace(/\{([^}]+)\}/g, function (m, name) { return /^id|id$|Id$/.test(name) ? '{ID}' : m; });
    return '(' + String(method || 'GET').toUpperCase() + ') ' + s + suffix;
}

function schemaOf(p) {
    return p.schema || {};
}

// OpenAPI document -> [{id, method, path, tag, summary, description, params: [...], body}]
// id is "METHOD path", ex. "GET /api/set/{id_dev}/{function}/{value}"
exports.operations = function (spec) {
    const list = [];
    Object.keys(spec.paths || {}).forEach(function (path) {
        const item = spec.paths[path];
        Object.keys(item).forEach(function (method) {
            const op = item[method];
            if (!op || typeof op !== 'object' || method === 'parameters') {
                return;
            }
            const params = (item.parameters || []).concat(op.parameters || []).map(function (p) {
                const s = schemaOf(p);
                const out = {name: p.name, in: p.in, required: !!p.required, type: s.type || 'string', description: p.description || ''};
                if (s.enum) {
                    out.enum = s.enum.filter(function (v, i, a) { return a.indexOf(v) === i; });
                }
                if (s.default !== undefined) {
                    out.default = s.default;
                }
                return out;
            });
            list.push({
                id: method.toUpperCase() + ' ' + path,
                name: exports.short_name(method, path),
                method: method.toUpperCase(),
                path: path,
                tag: (op.tags && op.tags[0]) || '',
                summary: op.summary || '',
                description: op.description || '',
                params: params,
                body: !!op.requestBody
            });
        });
    });
    return list;
}

// Parameter values of one call. Order: msg.params[name], the node setting, msg[name],
// and for value / text / message msg.payload (body operations send msg.payload as the body instead).
exports.param_values = function (op, configured, msg) {
    const values = {};
    const fromMsg = (msg && msg.params) || {};
    const payloadParam = op.body ? null : op.params.map(function (p) { return p.name; }).find(function (n) {
        return PAYLOAD_PARAMS.indexOf(n) !== -1;
    });
    op.params.forEach(function (p) {
        const candidates = [fromMsg[p.name], (configured || {})[p.name], msg && msg[p.name]];
        if (p.name === payloadParam) {
            candidates.push(msg && msg.payload);
        }
        const v = candidates.find(function (x) { return x !== undefined && x !== null && x !== ''; });
        if (v !== undefined) {
            values[p.name] = v;
        }
    });
    return values;
}

// path with {name} replaced by URL encoded values; throws when a required value is missing
exports.build_path = function (op, values) {
    const missing = op.params.filter(function (p) {
        return p.required && p.in === 'path' && (values[p.name] === undefined || values[p.name] === '');
    }).map(function (p) { return p.name; });
    if (missing.length) {
        throw new Error('missing ' + missing.join(', ') + ' for ' + op.id);
    }
    const query = op.params.filter(function (p) { return p.in === 'query' && values[p.name] !== undefined; }).map(function (p) {
        return encodeURIComponent(p.name) + '=' + encodeURIComponent(String(values[p.name]));
    }).join('&');
    const path = op.path.replace(/\{([^}]+)\}/g, function (_, name) {
        return encodeURIComponent(typeof values[name] === 'object' ? JSON.stringify(values[name]) : String(values[name]));
    });
    return path + (query ? '?' + query : '');
}

// HTTP response -> {payload, error}
// JSON bodies are parsed. Control calls answer XML <Response> OK </Response>: payload is the text inside,
// anything but OK (ex. BAD REQUEST) is an error. Other XML is passed on as text.
exports.parse_response = function (status, contentType, text) {
    let payload = text;
    let error = null;
    if (/json/i.test(contentType || '') || /^\s*[[{]/.test(text)) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = text;
        }
    } else {
        const m = /<Response>\s*([\s\S]*?)\s*<\/Response>/.exec(text);
        if (m) {
            payload = m[1];
            if (payload.toUpperCase() !== 'OK') {
                error = payload || 'empty response';
            }
        }
    }
    if (status >= 400) {
        error = 'HTTP ' + status + (typeof payload === 'string' && payload ? ': ' + payload.slice(0, 200) : '');
    }
    return {payload: payload, error: error};
}

// Base URL of the M-SERV API: the MQTT server of the config node (local socket = this M-SERV)
exports.base_url = function (server, port) {
    const host = server && server !== '' ? server : '127.0.0.1';
    return 'http://' + (host.indexOf(':') !== -1 && host[0] !== '[' ? '[' + host + ']' : host) + ':' + (Number(port) || DEFAULT_PORT);
}

// one call; resolves {status, payload, error}
exports.request = async function (url, op, credentials, body) {
    const headers = {};
    if (credentials && credentials.user) {
        headers.authorization = 'Basic ' + Buffer.from(credentials.user + ':' + (credentials.password || '')).toString('base64');
    }
    const init = {method: op.method, headers: headers, signal: AbortSignal.timeout(TIMEOUT)};
    if (op.body) {
        headers['content-type'] = 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body === undefined ? [] : body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    return Object.assign({status: res.status}, exports.parse_response(res.status, res.headers.get('content-type'), text));
}

// application objects for the editor: [{id, name, type}] from /api/json/devices
exports.objects_of = function (payload) {
    return ((payload && payload.List) || []).map(function (o) {
        return {id: o.id, name: o.opis_menu || '', type: o.typ_komponentu || ''};
    });
}

exports.DEFAULT_PORT = DEFAULT_PORT;
