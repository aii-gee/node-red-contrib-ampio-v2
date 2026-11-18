module.exports = function(RED) {
    const api = require('../generic/ampio-api');
    const operations = api.operations(require('./db/openapi.json'));

    function find(id) {
        return operations.find(function(op) { return op.id === id; });
    }

    // Calls the M-SERV HTTP API ("Ampio API"): control application objects, scenes, notifications, events,
    // read devices, groups, states and the logbook
    function ampioapi(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.operation = config.operation || '';
        node.params = config.params || {};
        node.port = Number(config.port) || api.DEFAULT_PORT;
        node.brokerConn = RED.nodes.getNode(config.server);

        if (!node.brokerConn) {
            node.error("Ampio server configuration missing");
            return;
        }
        if (node.operation && !find(node.operation)) {
            node.warn("Unknown operation " + node.operation);
        }

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            const id = msg.operation || node.operation;
            const op = find(id);
            if (!op) {
                return done(new Error("Unknown operation " + (id || '(none)') + ", set it in the node or in msg.operation"));
            }
            let url;
            try {
                url = api.base_url(node.brokerConn.server, node.port) + api.build_path(op, api.param_values(op, node.params, msg));
            } catch (err) {
                return done(err);
            }
            node.status({fill:"yellow",shape:"ring",text:op.method + ' ' + url.replace(/^https?:\/\/[^/]+/, '')});
            api.request(url, op, {user: node.brokerConn.username, password: node.brokerConn.password}, msg.payload).then(function(res) {
                msg.payload = res.payload;
                msg.statusCode = res.status;
                msg.url = url;
                msg.operation = op.id;
                if (res.error) {
                    node.status({fill:"red",shape:"dot",text:res.error.slice(0, 40)});
                    return done(new Error(res.error));
                }
                node.status({fill:"green",shape:"dot",text:"HTTP " + res.status});
                send(msg);
                done();
            }).catch(function(err) {
                msg.url = url;
                node.status({fill:"red",shape:"dot",text:err.name === 'TimeoutError' ? 'timeout' : err.message.slice(0, 40)});
                done(err.name === 'TimeoutError' ? new Error("No answer from " + url) : err);
            });
        });

        node.on('close', function() {
            node.status({});
        });
    }
    RED.nodes.registerType("Ampio v2 API", ampioapi);

    // editor: operations of the API, application objects of the server for the object pickers
    RED.httpAdmin.get('/ampio-v2-api/operations', RED.auth.needsPermission('ampiov2.read'), function(req, res) {
        res.json(operations);
    });
    RED.httpAdmin.get('/ampio-v2-api/:cfg/objects', RED.auth.needsPermission('ampiov2.read'), function(req, res) {
        const cfg = RED.nodes.getNode(req.params.cfg);
        if (!cfg) {
            return res.status(404).json("Deploy the server config first");
        }
        const op = find('GET /api/json/devices');
        api.request(api.base_url(cfg.server, req.query.port) + op.path, op, {user: cfg.username, password: cfg.password}).then(function(r) {
            if (r.error) {
                return res.status(502).json(r.error);
            }
            res.json(api.objects_of(r.payload));
        }).catch(function(err) {
            res.status(502).json(err.message);
        });
    });
};
