// Ampio v2 API node: generic/ampio-api.js, tools/extract-designer-api.js and the node against a fake M-SERV HTTP API
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const EventEmitter = require('events');
const { execFileSync } = require('child_process');
const api = require('../generic/ampio-api');

const ROOT = path.join(__dirname, '..');
const spec = require('../ampioin/db/openapi.json');
const ops = api.operations(spec);
const op = (id) => ops.find((o) => o.id === id);
const SET1 = 'GET /api/set/{id_dev}/{function}/{value}';

test('openapi.json', async (t) => {
    await t.test('is the Ampio API document from Designer', () => {
        assert.equal(spec.info.title, 'Ampio API');
        assert.ok(Object.keys(spec.paths).length >= 40);
    });
    await t.test('operations with parameters, enums deduplicated', () => {
        const set = op(SET1);
        assert.equal(set.method, 'GET');
        assert.equal(set.tag, 'Control');
        assert.deepEqual(set.params.map((p) => p.name), ['id_dev', 'function', 'value']);
        const fn = set.params[1].enum;
        assert.ok(fn.includes('setVirtualValue') && fn.includes('setValue'));
        assert.equal(fn.filter((f) => f === 'setVirtualValue').length, 1);
        assert.ok(op('POST /api/json/device/{object_id}/addPinList').body);
        assert.ok(op('GET /api/run/scene/{scene_id}'));
    });
});

test('ampio-api helpers', async (t) => {
    await t.test('parameter order: msg.params, node, msg property, msg.payload for value', () => {
        const set = op(SET1);
        assert.deepEqual(api.param_values(set, {id_dev: '474', function: 'setVirtualValue'}, {payload: 1}),
            {id_dev: '474', function: 'setVirtualValue', value: 1});
        assert.deepEqual(api.param_values(set, {id_dev: '474', function: 'setVirtualValue', value: '0'}, {payload: 1, params: {id_dev: 475}}),
            {id_dev: 475, function: 'setVirtualValue', value: '0'});
        assert.deepEqual(api.param_values(set, {}, {id_dev: 3, function: 'setValue', value: 0, payload: 9}),
            {id_dev: 3, function: 'setValue', value: 0});
        const push = op('GET /api/pushNotification/{message}');
        assert.deepEqual(api.param_values(push, {}, {payload: 'Hello'}), {message: 'Hello'});
        assert.deepEqual(api.param_values(op('POST /api/json/device/{object_id}/addPinList'), {object_id: 5}, {payload: [{pin: '1'}]}), {object_id: 5});
    });
    await t.test('path is URL encoded, missing values rejected', () => {
        assert.equal(api.build_path(op(SET1), {id_dev: 474, function: 'setVirtualValue', value: 1}), '/api/set/474/setVirtualValue/1');
        assert.equal(api.build_path(op('GET /api/pushNotification/{message}'), {message: 'Brama otwarta / 2'}), '/api/pushNotification/Brama%20otwarta%20%2F%202');
        assert.throws(() => api.build_path(op(SET1), {id_dev: 474, function: 'setValue'}), /missing value/);
    });
    await t.test('responses', () => {
        assert.deepEqual(api.parse_response(200, 'text/xml', '<?xml version="1.0" encoding="utf-8"?><Response> OK </Response>'), {payload: 'OK', error: null});
        assert.deepEqual(api.parse_response(200, 'text/xml', '<Response> BAD REQUEST </Response>'), {payload: 'BAD REQUEST', error: 'BAD REQUEST'});
        assert.deepEqual(api.parse_response(200, 'application/json', '{"List":[{"stan":""}],"Status":0}').payload, {List: [{stan: ''}], Status: 0});
        assert.equal(api.parse_response(200, 'text/xml', '<Results><Row><stan/></Row></Results>').error, null);
        assert.match(api.parse_response(401, 'text/html', 'Unauthorized').error, /^HTTP 401: Unauthorized/);
    });
    await t.test('base URL from the config server', () => {
        assert.equal(api.base_url('192.168.122.133', ''), 'http://192.168.122.133:8060');
        assert.equal(api.base_url('', 8061), 'http://127.0.0.1:8061');
        assert.equal(api.base_url('fd00::1', 8060), 'http://[fd00::1]:8060');
    });
});

test('extract-designer-api', () => {
    const bundle = 'var z={openapi:"3.0"};x.target==="openapi-3.0";' +
        'const Q={openapi:"3.0.1",info:{title:"Ampio API",version:"1.0.4"},paths:{"/api/set/{id_dev}/{function}":{get:{tags:["Control"],' +
        'summary:"Function",parameters:[{name:"id_dev",in:"path",required:!0,schema:{type:"integer"}}],responses:{200:{description:"R `ok` {x}"}}}}}};';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ampio-api-'));
    try {
        fs.writeFileSync(path.join(dir, 'App.js'), bundle);
        const out = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools', 'extract-designer-api.js'), path.join(dir, 'App.js')], {encoding: 'utf8'}));
        assert.equal(out.info.title, 'Ampio API');
        assert.equal(out.paths['/api/set/{id_dev}/{function}'].get.parameters[0].required, true);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('Ampio v2 API node against a fake M-SERV API', async (t) => {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            calls.push({method: req.method, url: req.url, auth: req.headers.authorization, body: body});
            if (req.url === '/api/json/devices') {
                res.setHeader('content-type', 'application/json');
                return res.end('{"List":[{"id":474,"typ_komponentu":"flaga","opis_menu":"Virt flag 0","stan_json":null}]}');
            }
            res.setHeader('content-type', 'text/xml');
            res.end('<?xml version="1.0" encoding="utf-8"?><Response> ' + (req.url.startsWith('/api/get/') || req.url.includes('/999/') ? 'BAD REQUEST' : 'OK') + ' </Response>');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const types = {}, nodes = {}, routes = {};
    const RED = {
        nodes: {
            createNode(n, c) {
                Object.setPrototypeOf(n, EventEmitter.prototype);
                EventEmitter.call(n);
                n.id = c.id;
                n.status = (s) => (n._status = s);
                n.send = () => {};
                n.warn = (w) => (n.warns = (n.warns || []).concat([w]));
                n.error = () => {};
                nodes[c.id] = n;
            },
            registerType(name, fn) { types[name] = fn; },
            getNode(id) { return nodes[id]; },
        },
        httpAdmin: { get(p, perm, h) { routes[p] = h; } },
        auth: { needsPermission() {} },
    };
    require('../ampioin/api.js')(RED);
    nodes.cfg = {server: '127.0.0.1', username: 'admin', password: 'secret'};
    const mk = (c) => { const n = {}; types['Ampio v2 API'].call(n, Object.assign({id: 'api' + Math.random(), server: 'cfg', port: port}, c)); return n; };
    const call = (n, msg) => new Promise((resolve) => {
        let sent = null;
        n.emit('input', msg, (m) => (sent = m), (err) => resolve({sent: sent, err: err}));
    });

    try {
        await t.test('setVirtualValue from msg.payload, basic auth, OK', async () => {
            const n = mk({operation: SET1, params: {id_dev: '474', function: 'setVirtualValue'}});
            const r = await call(n, {payload: 1});
            assert.equal(r.err, undefined);
            assert.equal(r.sent.payload, 'OK');
            assert.equal(r.sent.statusCode, 200);
            assert.equal(r.sent.url, 'http://127.0.0.1:' + port + '/api/set/474/setVirtualValue/1');
            const last = calls[calls.length - 1];
            assert.equal(last.auth, 'Basic ' + Buffer.from('admin:secret').toString('base64'));
        });
        await t.test('msg.operation and msg.params override the node; BAD REQUEST is an error', async () => {
            const n = mk({operation: SET1, params: {id_dev: '474', function: 'setVirtualValue'}});
            const ok = await call(n, {operation: 'GET /api/run/scene/{scene_id}', scene_id: 1});
            assert.equal(calls[calls.length - 1].url, '/api/run/scene/1');
            assert.equal(ok.sent.payload, 'OK');
            const bad = await call(n, {payload: 1, params: {id_dev: 999}});
            assert.match(bad.err.message, /BAD REQUEST/);
            assert.equal(bad.sent, null);
        });
        await t.test('missing parameter and unknown operation', async () => {
            const n = mk({operation: SET1, params: {function: 'setValue'}});
            assert.match((await call(n, {payload: 1})).err.message, /missing id_dev/);
            assert.match((await call(mk({operation: ''}), {})).err.message, /Unknown operation/);
        });
        await t.test('JSON answers parsed, POST sends msg.payload as JSON body', async () => {
            const list = await call(mk({operation: 'GET /api/json/devices', params: {}}), {});
            assert.equal(list.sent.payload.List[0].opis_menu, 'Virt flag 0');
            await call(mk({operation: 'POST /api/json/device/{object_id}/addPinList', params: {object_id: '7'}}), {payload: [{pin: '1234', type: 1, security: 1}]});
            const last = calls[calls.length - 1];
            assert.equal(last.method, 'POST');
            assert.deepEqual(JSON.parse(last.body), [{pin: '1234', type: 1, security: 1}]);
        });
        await t.test('editor endpoints: operations and application objects', async () => {
            const get = (route, req) => new Promise((resolve) => {
                const res = {code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; resolve(this); }};
                routes[route](req, res);
            });
            assert.ok((await get('/ampio-v2-api/operations', {})).body.some((o) => o.id === SET1));
            const objs = await get('/ampio-v2-api/:cfg/objects', {params: {cfg: 'cfg'}, query: {port: port}});
            assert.deepEqual(objs.body, [{id: 474, name: 'Virt flag 0', type: 'flaga'}]);
            assert.equal((await get('/ampio-v2-api/:cfg/objects', {params: {cfg: 'nope'}, query: {}})).code, 404);
        });
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('API node help lists every operation of openapi.json', () => {
    const help = require('../tools/api-help');
    const html = fs.readFileSync(path.join(ROOT, 'ampioin', 'api.html'), 'utf8');
    assert.equal(help.update(html, spec), html, 'run node tools/api-help.js');
    for (const o of ops) {
        assert.ok(html.includes(o.method + ' ' + o.path.replace(/&/g, '&amp;')), o.id);
    }
    assert.ok(html.includes('<code>setVirtualValue</code> (any value to set state)'));
});

test('short operation names', async (t) => {
    await t.test('method first, then the path: no /api/ and json/, ids as {ID}, xml marked', () => {
        assert.equal(api.short_name('GET', '/api/json/group_devices'), '(GET) group_devices');
        assert.equal(api.short_name('GET', '/api/json/group_devices/{id_group}'), '(GET) group_devices/{ID}');
        assert.equal(api.short_name('GET', '/api/xml/groups'), '(GET) groups (xml)');
        assert.equal(api.short_name('GET', '/api/set/{id_dev}/{function}/{value}'), '(GET) set/{ID}/{function}/{value}');
        assert.equal(api.short_name('get', '/api/run/scene/{scene_id}'), '(GET) run/scene/{ID}');
        assert.equal(api.short_name('POST', '/api/json/device/{object_id}/addPinList'), '(POST) device/{ID}/addPinList');
    });
    await t.test('unique for every operation, node label uses the same name', () => {
        const names = ops.map((o) => o.name);
        assert.equal(new Set(names).size, names.length);
        const html = fs.readFileSync(path.join(ROOT, 'ampioin', 'api.html'), 'utf8');
        const code = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)[1];
        let def;
        new Function('RED', code)({nodes: {registerType: (n, d) => (def = d)}, validators: {number: () => () => true}});
        for (const o of ops) {
            assert.equal(def.label.call({operation: o.id, params: {}}), 'Ampio API ' + o.name);
        }
        assert.equal(def.label.call({operation: SET1, params: {id_dev: '474', function: 'setVirtualValue'}}), 'Ampio API #474 setVirtualValue');
    });
});
