exports.sanitize_mac = function(mac_string) {
    mac_string = mac_string.toUpperCase();
    let mac_stripped_leading_zeroes = false;
    while(mac_stripped_leading_zeroes == false){
        if(mac_string[0] == '0'){
            mac_string = mac_string.substring(1);
        } else {
            mac_stripped_leading_zeroes = true;
        }
    }
    return mac_string;
}

exports.sanitize_ioid = function(ioid_string) {
    let ioid_stripped_leading_zeroes = false;
    while(ioid_stripped_leading_zeroes == false){
        if(ioid_string[0]=='0'){
            ioid_string = ioid_string.substring(1);
        } else{
            ioid_stripped_leading_zeroes=true;
        }
    }
    return ioid_string;
}

exports.setup_mqtt_client = function(node, config) {
    const mqtt = require('mqtt');
    const client = mqtt.connect('mqtt://' + config.srvaddress);
    return client;
}

exports.setup_node_status_from_mqtt_client = function(node) {
    node.status({fill: "yellow", shape: "dot", text: "not connected"});

    node.client.on('reconnect', function () {
        node.status({fill:"yellow", shape: "dot", text: "reconnecting"});
    })

    node.client.on('error', function() {
        node.status({fill: "red", shape: "dot", text: "error"});
    })

    node.client.on('close', function() {
        node.status({fill: "red",shape: "dot", text: "connection closed"});
    })

    node.client.on('offline', function() {
        node.status({fill: "red", shape:"dot", text: "disconnected"});
    })
}

exports.hex2rgb565 = function (hexcol){
    var leftPad = require('left-pad');
	let r=hexcol.substring(0,2);
	let g=hexcol.substring(2,4);
	let b=hexcol.substring(4,6);

	r = parseInt(r,16);
	g = parseInt(g,16);
	b = parseInt(b,16);

	let r5 = r>>3;
	let g6 = g>>2;
	let b5 = b>>3;

	let rgb565 = r5<<11 | g6<<5 | b5;

    let byte_h = (rgb565 >> 8) & 0xFF;
    let byte_l = (rgb565 >> 0) & 0xFF;
    rgb565 = byte_l << 8 | byte_h;

	let rgb565s = leftPad(rgb565.toString(16),4,'0');

	return rgb565s.toUpperCase();
}

exports.decStrToHexStr = function (dec_str) {
    const val = parseInt(dec_str, 10);
    return val.toString(16).padStart(2, '0');
}

// device/v1/<state|set>/leaf/<MAC>/<type>/<attribute>/<index>
exports.build_topic = function (action, mac, type, attribute, index) {
    return 'device/v1/' + action + '/leaf/' + mac + '/' + type + '/' + attribute + '/' + index;
}

// Payloads are JSON objects carrying the value in "v", ex. {"v": 1} or {"v": {"h": 0, "s": 0, "v": 0}}
// booleans are sent as 1/0, optional time is passed as "time" (same as Ampio Designer)
exports.encode_value = function (value, time) {
    const data = {v: typeof value === 'boolean' ? (value ? 1 : 0) : value};
    if (time !== undefined) {
        data.time = time;
    }
    return JSON.stringify(data);
}

// Value for a device/v1 set, checked against the Designer attribute definition (leafdefs.json) when known.
// Modules ignore string values ({"v":"9"}) and wrap numbers out of range (U8 300 -> 44, -1 -> 255),
// so numeric strings are converted and out of range numbers rejected. Objects (hsv, rgb, cct) pass as they are.
const NUMERIC_KINDS = {binary: true, linearU8: true, linearI16: true, enum: true};

exports.normalize_value = function (attr, value) {
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    if (!attr || !NUMERIC_KINDS[attr.kind]) {
        return value;
    }
    let v = value;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        v = s === 'true' || s === 'on' ? 1 : (s === 'false' || s === 'off' ? 0 : (s !== '' && !isNaN(s) ? Number(s) : v));
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error('value must be a number, got ' + JSON.stringify(value));
    }
    if (attr.kind === 'binary' && v !== 0 && v !== 1) {
        throw new Error('value must be 0 / 1, got ' + v);
    }
    if (attr.kind === 'enum' && attr.enum && !attr.enum.hasOwnProperty(v)) {
        throw new Error('value must be one of ' + Object.keys(attr.enum).join(', ') + ', got ' + v);
    }
    if ((attr.min !== undefined && v < attr.min) || (attr.max !== undefined && v > attr.max)) {
        throw new Error('value must be ' + attr.min + ' .. ' + attr.max + ', got ' + v);
    }
    return v;
}

exports.decode_value = function (payload) {
    const data = JSON.parse(payload.toString('utf-8'));
    if (data === null || typeof data !== 'object' || !data.hasOwnProperty('v')) {
        throw new Error('missing "v" field');
    }
    return data.v;
}

// Minimal protobuf reader: [{field, value}], value is Number for varints, Buffer for length-delimited
function pb_fields(buf) {
    const out = [];
    let i = 0;
    function varint() {
        let r = 0, mul = 1, b;
        do {
            b = buf[i++];
            r += (b & 0x7f) * mul;
            mul *= 128;
        } while (b & 0x80);
        return r;
    }
    while (i < buf.length) {
        const key = varint();
        const wt = key % 8;
        const field = Math.floor(key / 8);
        if (wt === 0) {
            out.push({field: field, value: varint()});
        } else if (wt === 2) {
            const len = varint();
            out.push({field: field, value: buf.slice(i, i + len)});
            i += len;
        } else if (wt === 5) {
            i += 4;
        } else if (wt === 1) {
            i += 8;
        } else {
            throw new Error('unsupported protobuf wire type ' + wt);
        }
    }
    return out;
}

function pb_get(fields, field) {
    const f = fields.find(function (x) { return x.field === field; });
    return f ? f.value : undefined;
}

// deviceConfigTable: 3-byte records, record 01 <type> <count> describes a leaf type
exports.parse_config_table = function (b64) {
    const buf = Buffer.from(b64 || '', 'base64');
    const leafs = [];
    for (let i = 0; i + 2 < buf.length; i += 3) {
        if (buf[i] === 1) {
            leafs.push({type: buf[i + 1], count: buf[i + 2]});
        }
    }
    return leafs;
}

// Section 17 (protobuf): 1 = device name, 3 = repeated {1 = type, 2 = {1 = repeated {1 = index, 2 = {1 = name}}}}
exports.parse_descriptions = function (b64) {
    const result = {name: '', channels: {}};
    const fields = pb_fields(Buffer.from(b64 || '', 'base64'));
    const name = pb_get(fields, 1);
    result.name = name ? name.toString('utf-8') : '';
    fields.filter(function (f) { return f.field === 3; }).forEach(function (t) {
        const tf = pb_fields(t.value);
        const type = pb_get(tf, 1);
        const list = pb_get(tf, 2);
        const names = result.channels[type] = {};
        if (!list) {
            return;
        }
        pb_fields(list).filter(function (c) { return c.field === 1; }).forEach(function (c) {
            const cf = pb_fields(c.value);
            const desc = pb_get(cf, 2);
            const label = desc ? pb_get(pb_fields(desc), 1) : undefined;
            if (label && label.length) {
                names[pb_get(cf, 1) || 0] = label.toString('utf-8');
            }
        });
    });
    return result;
}

// get_devices device -> {mac (macUser, as used in topics), name, leafs: [{type, count}], channels: {type: {index: name}}}
exports.device_info = function (dev) {
    const info = {
        mac: (dev.macUser || dev.macProd).toString(16),
        name: dev.name ? Buffer.from(dev.name, 'base64').toString('utf-8') : '',
        leafs: exports.parse_config_table(dev.deviceConfigTable),
        channels: {}
    };
    const section = (dev.sections || []).find(function (s) { return s.type === 17 && s.length > 0; });
    if (section) {
        try {
            const desc = exports.parse_descriptions(section.data);
            info.name = info.name || desc.name;
            info.channels = desc.channels;
        } catch {
            // descriptions are optional, device stays usable without names
        }
    }
    return info;
}

// Legacy API for older CAN devices: ampio/from/<MAC>/state/<valtype>/<index>, ampio/to/<MAC>/<valtype>/<index>/cmd
// MAC is uppercase hex, index counts from 1 (au32 from 0), payload is a plain string.
const LEGACY_SET_VALTYPE = {a: 'o'};

exports.legacy_state_topic = function (mac, valtype, index) {
    return 'ampio/from/' + String(mac).toUpperCase() + '/state/' + valtype + '/' + index;
}

exports.legacy_set_topic = function (mac, valtype, index) {
    return 'ampio/to/' + String(mac).toUpperCase() + '/' + (LEGACY_SET_VALTYPE[valtype] || valtype) + '/' + index + '/cmd';
}

exports.decode_legacy_value = function (payload) {
    const s = payload.toString('utf-8');
    return s.trim() !== '' && !isNaN(s) ? Number(s) : s;
}

exports.encode_legacy_value = function (value) {
    if (typeof value === 'boolean') {
        return value ? '1' : '0';
    }
    if (value !== null && typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

// Legacy value types the bridge does not accept on ampio/to/<MAC>/<valtype>/<index>/cmd, written as raw CAN frames.
// afu8 (8 bit analog flag): 7A F9 <value> <index - 1>, checked on M-CON-DALI-s (as in node-red-contrib-ampio 0.x).
exports.legacy_raw_frame = function (valtype, index, value) {
    if (valtype !== 'afu8') {
        return undefined;
    }
    const v = typeof value === 'boolean' ? (value ? 1 : 0) : Number(typeof value === 'string' ? value.trim() : value);
    if (!Number.isInteger(v) || v < 0 || v > 255 || (typeof value === 'string' && value.trim() === '')) {
        throw new Error('afu8 value must be an integer 0 .. 255, got ' + JSON.stringify(value));
    }
    if (!Number.isInteger(index) || index < 1 || index > 256) {
        throw new Error('afu8 index must be 1 .. 256, got ' + index);
    }
    return '7af9' + v.toString(16).padStart(2, '0') + (index - 1).toString(16).padStart(2, '0');
}

// Raw CAN frame: ampio/to/<mac>/raw with hex payload, MAC lowercase hex as sent by Ampio Designer
exports.raw_topic = function (mac) {
    return 'ampio/to/' + String(mac).toLowerCase() + '/raw';
}

// accepts hex string ("0901", "09 01", "0x0901"), Buffer or array of bytes
exports.encode_raw = function (value) {
    if (Buffer.isBuffer(value) || Array.isArray(value)) {
        return Buffer.from(value).toString('hex');
    }
    const hex = String(value).replace(/^0x/i, '').replace(/[\s:,-]/g, '');
    if (!/^([0-9a-fA-F]{2})+$/.test(hex)) {
        throw new Error('raw payload must be hex bytes, got "' + value + '"');
    }
    return hex.toLowerCase();
}

// device_api list "descriptions": records [len u16][code u16][index u16][4 bytes][utf-8 name], little endian.
// Description code -> [legacy valtype, offset added to index]
const LEGACY_DESCRIPTION_CODES = {
    3: [['t', 1]], 6: [['f', 1]], 7: [['afu8', 1]], 8: [['afi16', 1]], 10: [['i', 1]],
    12: [['o', 1]], 16: [['o', 1], ['a', 1]], 44: [['a', 1], ['o', 1]], 17: [['rs', 1]],
    29: [['au32', 0]], 38: [['au16l', 1]], 39: [['au16l', 4]], 40: [['au16l', 7]]
};

exports.parse_legacy_descriptions = function (b64) {
    const buf = Buffer.from(b64 || '', 'base64');
    const names = {};
    let i = 0;
    while (i + 10 <= buf.length) {
        const len = buf.readUInt16LE(i);
        if (len < 10 || i + len > buf.length) {
            break;
        }
        const name = buf.slice(i + 10, i + len).toString('utf-8').trim();
        (LEGACY_DESCRIPTION_CODES[buf.readUInt16LE(i + 2)] || []).forEach(function (map) {
            if (name && name !== '.') {
                const byType = names[map[0]] = names[map[0]] || {};
                byType[buf.readUInt16LE(i + 4) + map[1]] = name;
            }
        });
        i += len;
    }
    return names;
}

// Virtual (child) devices: a module publishes their values on device/v1 under the child's own MAC,
// get_devices does not list them. MAC = 0x3000000 | childType << 20 | ..., as Ampio Designer builds it:
//   Satel (1):  0x3100000 | parent macProd                     (M-SERV / module with INT-RS on RS232)
//   Modbus (4): 0x3400000 | slaveId << 12 | parent macProd & 0xfff (M-CON-485 Modbus master slave)
const CHILD_SATEL = 1;
const CHILD_MODBUS = 4;
const SATEL_CONFIG_SECTION = 36;
const MODBUS_CONFIG_SECTION = 37;
const SF_BIN_IN = 128, SF_SATEL_OUT = 161, SF_ALARM_ZONE = 162, SF_I32_GENERIC = 167;

exports.satel_mac = function (parentMacProd) {
    return ((0x3000000 | (CHILD_SATEL << 20) | parentMacProd) >>> 0).toString(16);
}

exports.modbus_mac = function (parentMacProd, slaveId) {
    return ((0x3000000 | (CHILD_MODBUS << 20) | ((slaveId & 255) << 12) | (parentMacProd & 4095)) >>> 0).toString(16);
}

// Designer TLV used by sections 36/37: varint tag, varint length, value -> [[tag, Buffer]]
function tlv_fields(buf) {
    const out = [];
    let i = 0;
    function varint() {
        let r = 0, mul = 1, b;
        do {
            if (i >= buf.length) {
                throw new Error('TLV varint runs past the data');
            }
            b = buf[i++];
            r += (b & 0x7f) * mul;
            mul *= 128;
        } while (b & 0x80);
        return r;
    }
    while (i < buf.length) {
        const tag = varint();
        const len = varint();
        if (i + len > buf.length) {
            throw new Error('TLV field ' + tag + ' runs past the data');
        }
        out.push([tag, buf.slice(i, i + len)]);
        i += len;
    }
    return out;
}

function tlv_items(buf, itemTag) {
    return tlv_fields(buf).filter(function (f) { return f[0] === itemTag; }).map(function (f) { return f[1]; });
}

// little endian unsigned of any length up to 4 bytes
function le_uint(b) {
    let r = 0;
    for (let i = Math.min(b.length, 4) - 1; i >= 0; i--) {
        r = r * 256 + b[i];
    }
    return r;
}

// Section 36 (Satel config): 2 name, 5/6/7 inputs/outputs/zones count u16 LE (default 32),
// 8/9/10 inputs/outputs/zones, items tag 16: 17 num varint, 18 name. The PIN (tag 3) is not read.
exports.parse_satel_config = function (b64) {
    const cfg = {name: '', counts: {}, names: {}};
    cfg.counts[SF_BIN_IN] = cfg.counts[SF_SATEL_OUT] = cfg.counts[SF_ALARM_ZONE] = 32;
    cfg.names[SF_BIN_IN] = {};
    cfg.names[SF_SATEL_OUT] = {};
    cfg.names[SF_ALARM_ZONE] = {};
    const countTag = {5: SF_BIN_IN, 6: SF_SATEL_OUT, 7: SF_ALARM_ZONE};
    const listTag = {8: SF_BIN_IN, 9: SF_SATEL_OUT, 10: SF_ALARM_ZONE};
    tlv_fields(Buffer.from(b64 || '', 'base64')).forEach(function (f) {
        const tag = f[0], v = f[1];
        if (tag === 2) {
            cfg.name = v.toString('utf-8');
        } else if (countTag[tag]) {
            cfg.counts[countTag[tag]] = le_uint(v.slice(0, 2));
        } else if (listTag[tag]) {
            tlv_items(v, 16).forEach(function (item) {
                let num = 0, name = '';
                tlv_fields(item).forEach(function (x) {
                    if (x[0] === 17) {
                        num = tlv_varint(x[1]);
                    } else if (x[0] === 18) {
                        name = x[1].toString('utf-8');
                    }
                });
                if (name) {
                    cfg.names[listTag[tag]][num] = name;
                }
            });
        }
    });
    return cfg;
}

function tlv_varint(b) {
    let r = 0, mul = 1;
    for (let i = 0; i < b.length; i++) {
        r += (b[i] & 0x7f) * mul;
        mul *= 128;
        if (!(b[i] & 0x80)) {
            break;
        }
    }
    return r;
}

// Section 37 (Modbus master config): 2 devices, items tag 16: 17 slaveId u8, 18 name, 23 macUser u32 LE,
// 24 leafSlots, items tag 40: 1 outNum u8, 2 leafName. Every slot is I32_GENERIC (167) attr 0 index outNum.
exports.parse_modbus_config = function (b64, parentMacProd) {
    const out = [];
    tlv_fields(Buffer.from(b64 || '', 'base64')).forEach(function (f) {
        if (f[0] !== 2) {
            return;
        }
        tlv_items(f[1], 16).forEach(function (item) {
            const dev = {slaveId: 0, name: '', mac: '', slots: {}};
            let macUser = 0;
            tlv_fields(item).forEach(function (x) {
                if (x[0] === 17) {
                    dev.slaveId = x[1][0] || 0;
                } else if (x[0] === 18) {
                    dev.name = x[1].toString('utf-8');
                } else if (x[0] === 23) {
                    macUser = le_uint(x[1]);
                } else if (x[0] === 24) {
                    tlv_items(x[1], 40).forEach(function (slot) {
                        let num = 0, name = '';
                        tlv_fields(slot).forEach(function (s) {
                            if (s[0] === 1) {
                                num = s[1][0] || 0;
                            } else if (s[0] === 2) {
                                name = s[1].toString('utf-8');
                            }
                        });
                        dev.slots[num] = name;
                    });
                }
            });
            dev.mac = macUser ? macUser.toString(16) : exports.modbus_mac(parentMacProd, dev.slaveId);
            out.push(dev);
        });
    });
    return out;
}

// get_devices device -> child devices from its Satel (36) and Modbus (37) sections:
//   [{mac, name, parent, counts: {type: n}, channels: {type: {index: name}}}]
exports.child_devices = function (dev, parentName) {
    const children = [];
    const parent = (dev.macUser || dev.macProd).toString(16);
    const label = parentName || parent;
    (dev.sections || []).forEach(function (s) {
        if (!s.data) {
            return;
        }
        try {
            if (s.type === SATEL_CONFIG_SECTION) {
                const cfg = exports.parse_satel_config(s.data);
                children.push({mac: exports.satel_mac(dev.macProd), name: cfg.name || 'Satel (' + label + ')', parent: parent, counts: cfg.counts, channels: cfg.names});
            } else if (s.type === MODBUS_CONFIG_SECTION) {
                exports.parse_modbus_config(s.data, dev.macProd).forEach(function (m) {
                    const counts = {}, channels = {};
                    const slots = Object.keys(m.slots).map(Number);
                    counts[SF_I32_GENERIC] = slots.length ? Math.max.apply(null, slots) + 1 : 0;
                    channels[SF_I32_GENERIC] = m.slots;
                    children.push({mac: m.mac, name: m.name || 'Modbus ' + m.slaveId + ' (' + label + ')', parent: parent, counts: counts, channels: channels});
                });
            }
        } catch {
            // child names are optional, values seen on device/v1 still make the device usable
        }
    });
    return children;
}

// Kind of a child device MAC (seen on device/v1 only), or undefined for a module MAC
exports.child_kind = function (mac) {
    const m = parseInt(mac, 16);
    if (!(m >= 0x3000000 && m < 0x4000000)) {
        return undefined;
    }
    const type = (m >> 20) & 0xf;
    return type === CHILD_SATEL ? 'Satel' : (type === CHILD_MODBUS ? 'Modbus' : 'Virtual');
}

// get_devices device a child MAC belongs to: Satel keeps the whole parent macProd, Modbus its low 12 bits
// (taken only when exactly one module matches)
function child_parent(mac, kind, rpcDevices) {
    const m = parseInt(mac, 16);
    if (kind === 'Satel') {
        return rpcDevices.find(function (d) { return d.macProd === (m & 0xfffff); });
    }
    if (kind === 'Modbus') {
        const found = rpcDevices.filter(function (d) { return (d.macProd & 4095) === (m & 4095); });
        return found.length === 1 ? found[0] : undefined;
    }
    return undefined;
}

// get_devices result + retained state topics + device_api list ->
//   [{mac, name, legacy, virtual, parent, leafs: [{type, attribute, count, names}], legacyTypes: [{valtype, indexes, names}]}]
// Types and channel counts come from deviceConfigTable, attributes from retained device/v1 states (default 0).
// Legacy value types come from retained ampio/from states, their names from device_api descriptions.
// Old CAN devices report no leafs (legacy: true), they are used through the legacy API.
// Virtual devices (virtual: true) are not listed by get_devices: Satel/Modbus children of a module (parent = its
// MAC, names and counts from the parent's sections 36/37) and other devices seen only on device/v1.
exports.discover_devices = function (rpcDevices, topics, legacyTopics, apiDevices) {
    const seen = {};
    topics.forEach(function (topic) {
        const p = topic.split('/');
        if (p.length !== 8) {
            return;
        }
        const types = seen[p[4]] = seen[p[4]] || {};
        const attrs = types[p[5]] = types[p[5]] || {};
        attrs[p[6]] = Math.max(attrs[p[6]] || 0, Number(p[7]) + 1);
    });
    const legacySeen = {};
    (legacyTopics || []).forEach(function (topic) {
        const p = topic.split('/');
        if (p.length !== 6 || p[3] !== 'state') {
            return;
        }
        const mac = p[2].toLowerCase();
        const valtypes = legacySeen[mac] = legacySeen[mac] || {};
        (valtypes[p[4]] = valtypes[p[4]] || {})[p[5]] = true;
    });
    const apiInfo = {};
    (apiDevices || []).forEach(function (dev) {
        apiInfo[(dev.macUser || dev.macProd).toString(16)] = {
            name: dev.name ? Buffer.from(dev.name, 'base64').toString('utf-8') : '',
            names: exports.parse_legacy_descriptions(dev.descriptions)
        };
    });
    const devices = {};
    const children = {};
    rpcDevices.forEach(function (dev) {
        const info = exports.device_info(dev);
        devices[info.mac] = info;
        exports.child_devices(dev, info.name).forEach(function (child) {
            children[child.mac] = child;
        });
    });
    // states retained under a module's production MAC (published before its MAC was changed) are not virtual
    const byMacProd = {};
    rpcDevices.forEach(function (dev) {
        if (dev.macUser && dev.macUser !== dev.macProd) {
            byMacProd[dev.macProd.toString(16)] = devices[dev.macUser.toString(16)];
        }
    });
    Object.keys(seen).concat(Object.keys(legacySeen)).forEach(function (mac) {
        if (devices[mac] || children[mac]) {
            return;
        }
        const module = byMacProd[mac];
        if (module) {
            devices[mac] = {mac: mac, name: (module.name || module.mac) + ' (old MAC)', leafs: [], channels: module.channels};
            return;
        }
        // without get_devices data a missing module is not necessarily virtual, only child MACs are
        const kind = exports.child_kind(mac);
        devices[mac] = {mac: mac, name: '', leafs: [], channels: {}, virtual: !!kind || rpcDevices.length > 0 && !!seen[mac]};
        if (kind) {
            const parent = child_parent(mac, kind, rpcDevices);
            const info = parent && devices[(parent.macUser || parent.macProd).toString(16)];
            const suffix = info ? ' (' + (info.name || info.mac) + ')' : '';
            if (info) {
                devices[mac].parent = info.mac;
            }
            devices[mac].name = (kind === 'Modbus' ? 'Modbus ' + ((parseInt(mac, 16) >> 12) & 255) : kind) + suffix;
        }
    });
    // children configured on their parent show up even before they publish a value
    Object.keys(children).forEach(function (mac) {
        const child = children[mac];
        const info = devices[mac] = devices[mac] || {mac: mac, name: '', leafs: [], channels: {}};
        info.virtual = true;
        info.parent = child.parent;
        info.name = info.name || child.name;
        info.channels = child.channels;
        info.leafs = Object.keys(child.counts).map(function (type) { return {type: Number(type), count: child.counts[type]}; });
    });
    return Object.keys(devices).sort().map(function (mac) {
        const info = devices[mac];
        const retained = seen[mac] || {};
        const counts = {};
        info.leafs.forEach(function (l) { counts[l.type] = l.count; });
        Object.keys(retained).forEach(function (type) {
            const max = Math.max.apply(null, Object.values(retained[type]));
            // virtual devices may publish more channels than configured (ex. Satel inputs)
            if (!counts.hasOwnProperty(type) || (info.virtual && max > counts[type])) {
                counts[type] = max;
            }
        });
        const leafs = [];
        Object.keys(counts).map(Number).sort(function (a, b) { return a - b; }).forEach(function (type) {
            const attrs = retained[type] ? Object.keys(retained[type]).map(Number) : [0];
            attrs.forEach(function (attribute) {
                leafs.push({type: type, attribute: attribute, count: counts[type], names: info.channels[type] || {}});
            });
        });
        const api = apiInfo[mac] || {name: '', names: {}};
        const legacyTypes = Object.keys(legacySeen[mac] || {}).sort().map(function (valtype) {
            return {
                valtype: valtype,
                indexes: Object.keys(legacySeen[mac][valtype]).map(Number).sort(function (a, b) { return a - b; }),
                names: api.names[valtype] || {}
            };
        });
        const out = {mac: mac, name: info.name || api.name, legacy: leafs.length === 0, leafs: leafs, legacyTypes: legacyTypes};
        if (info.virtual) {
            out.virtual = true;
            out.legacy = false;
            out.name = out.name || 'Virtual device';
            if (info.parent) {
                out.parent = info.parent;
            }
        }
        return out;
    });
}

// Audit: describe one state change. devices = map mac -> discover_devices() entry.
// Returns {value, moduleMac, moduleName, valueType, valueName, index, api} or null for other topics.
exports.describe_change = function (topic, value, devices, leafdefs, legacydefs) {
    const p = topic.split('/');
    if (p.length === 8 && p[0] === 'device' && p[2] === 'state' && p[3] === 'leaf') {
        const mac = p[4], type = Number(p[5]), attribute = Number(p[6]), index = Number(p[7]);
        const dev = devices[mac];
        const def = leafdefs[type];
        const attr = def && def.attributes[attribute];
        const leaf = dev && dev.leafs.find(function (l) { return l.type === type; });
        let valueType = def ? def.label : 'type ' + type;
        if (attr && attr.label) {
            valueType += ' - ' + attr.label;
        } else if (attribute !== 0) {
            valueType += ' - attribute ' + attribute;
        }
        return {
            value: value,
            moduleMac: mac,
            moduleName: dev && dev.name || undefined,
            valueType: valueType,
            valueName: leaf && leaf.names[index] || undefined,
            index: index,
            api: 'device/v1'
        };
    }
    if (p.length === 6 && p[0] === 'ampio' && p[1] === 'from' && p[3] === 'state') {
        const mac = p[2].toLowerCase(), valtype = p[4], index = Number(p[5]);
        const dev = devices[mac];
        const lt = dev && (dev.legacyTypes || []).find(function (l) { return l.valtype === valtype; });
        return {
            value: value,
            moduleMac: mac,
            moduleName: dev && dev.name || undefined,
            valueType: legacydefs[valtype] ? legacydefs[valtype].label : valtype,
            valueName: lt && lt.names[index] || undefined,
            index: index,
            api: 'legacy'
        };
    }
    return null;
}

// Legacy value types which newer modules also publish on device/v1, used to avoid duplicate audit entries
const LEGACY_ON_V1 = {i: [128], o: [129, 131, 132, 133], a: [131, 132, 133], f: [139], t: [130], rgbw: [134], afu8: [149]};

exports.legacy_on_v1 = function (dev, valtype) {
    const types = LEGACY_ON_V1[valtype];
    return !!(dev && !dev.legacy && types && dev.leafs.some(function (l) { return types.indexOf(l.type) !== -1; }));
}

// ---- Virtual devices of the mobile application (device type 256, added in Designer) ----
// They are not on CAN and not on device/v1: their values are set through the M-SERV API
// (/api/set/<object>/setVirtualValue/<value>) and published only as states of application objects,
// on ampio/fromDB/<app user>/ob/<object id>/state, once per application user, not retained.
// An object belongs to a channel through its leafId 0_<mac>_<type>_<attribute>_<index>.
exports.APP_VIRTUAL_TYPE = 256;
const APP_DELETED = 16;

exports.app_leaf_id = function (mac, type, attribute, index) {
    return ['0', String(mac).toLowerCase(), type, attribute, index].join('_');
}

exports.app_state_topic = function (objectId) {
    return 'ampio/fromDB/+/ob/' + objectId + '/state';
}

// Deleted the Designer's way: the DELETED bit (params can exceed 32 bits) or visible to nobody
function app_object_deleted(o) {
    return Math.floor(Number(o.params) / APP_DELETED) % 2 === 1 || o.prawa === '0';
}

function parse_app_leaf(leafId) {
    const p = String(leafId || '').split('_');
    if (p.length !== 5) {
        return null;
    }
    return {mac: p[1].toLowerCase(), type: Number(p[2]), attribute: Number(p[3]), index: Number(p[4])};
}

// ids of the (not deleted) application objects of one channel
exports.app_object_ids = function (appObjects, mac, type, attribute, index) {
    const leafId = exports.app_leaf_id(mac, type, attribute, index);
    return (appObjects || []).filter(function (o) {
        return !app_object_deleted(o) && String(o.leafId || '').toLowerCase() === leafId;
    }).map(function (o) { return o.id; });
}

// payload of an object state ({"state":"1","desc":"...","on":<ms>}) -> {value, desc, on}
// numeric states become numbers
exports.decode_app_state = function (payload) {
    const data = JSON.parse(payload.toString());
    if (!data || typeof data !== 'object' || !data.hasOwnProperty('state')) {
        throw new Error('no state');
    }
    const s = data.state;
    const value = typeof s === 'string' && s.trim() !== '' && !isNaN(s) ? Number(s) : s;
    return {value: value, desc: data.desc, on: data.on};
}

// Application devices table + objects table -> discover_devices() entries of the virtual devices:
// channel types and counts from the device's data.sf ([{key: type, val: count}]), plus types its objects use;
// names and object ids per channel from its objects
exports.app_virtual_devices = function (appDevices, appObjects) {
    const objects = {};
    (appObjects || []).forEach(function (o) {
        const leaf = !app_object_deleted(o) && parse_app_leaf(o.leafId);
        if (leaf) {
            (objects[leaf.mac] = objects[leaf.mac] || []).push({leaf: leaf, o: o});
        }
    });
    return (appDevices || []).filter(function (d) {
        return Number(d.typ_urzadzenia) === exports.APP_VIRTUAL_TYPE && d.mac;
    }).map(function (d) {
        const mac = Number(d.mac).toString(16);
        const counts = {};
        let data = {};
        try {
            data = typeof d.data === 'string' ? JSON.parse(d.data) : (d.data || {});
        } catch {
            // channels still come from the objects
        }
        (data.sf || []).forEach(function (f) {
            counts[f.key] = Math.max(counts[f.key] || 0, Number(f.val) || 0);
        });
        const leafs = {};
        function leaf(type, attribute) {
            const k = type + '/' + attribute;
            return leafs[k] = leafs[k] || {type: type, attribute: attribute, count: counts[type] || 0, names: {}, objects: {}};
        }
        Object.keys(counts).forEach(function (type) { leaf(Number(type), 0); });
        (objects[mac] || []).forEach(function (x) {
            const l = leaf(x.leaf.type, x.leaf.attribute);
            l.count = Math.max(l.count, x.leaf.index + 1);
            l.names[x.leaf.index] = l.names[x.leaf.index] || x.o.opis_menu || '';
            (l.objects[x.leaf.index] = l.objects[x.leaf.index] || []).push(x.o.id);
        });
        return {
            mac: mac,
            name: d.nazwa_urzadzenia || 'Virtual device',
            legacy: false,
            virtual: true,
            app: true,
            leafs: Object.keys(leafs).map(function (k) { return leafs[k]; }).sort(function (a, b) {
                return a.type - b.type || a.attribute - b.attribute;
            }),
            legacyTypes: []
        };
    });
}

// adds the application's virtual devices to a discover_devices() list (devices already there are kept)
exports.merge_app_devices = function (devices, appDevices, appObjects) {
    const known = {};
    devices.forEach(function (d) { known[d.mac] = true; });
    const extra = exports.app_virtual_devices(appDevices, appObjects).filter(function (d) { return !known[d.mac]; });
    return devices.concat(extra).sort(function (a, b) { return a.mac < b.mac ? -1 : (a.mac > b.mac ? 1 : 0); });
}
