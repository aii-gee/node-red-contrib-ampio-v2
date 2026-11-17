module.exports = function(RED) {
    const au = require('../generic/ampio-utils');

    // virtual devices of the mobile application: objects are looked up again after this time when none was found
    const APP_RETRY_TIME = 60000;

    function ampioin(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.mac = config.mac;
        node.valtype = config.valtype || '';
        node.devtype = Number(config.devtype);
        node.attribute = Number(config.attribute) || 0;
        node.index = Number(config.index) || 0;
        node.retainignore = config.retainignore;
        // 'app' = virtual device of the mobile application, read through its objects' states
        node.source = config.source || '';
        node.brokerConn = RED.nodes.getNode(config.server);

        if (!node.brokerConn) {
            node.error("Ampio server configuration missing");
            return;
        }

        node.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
        node.brokerConn.register(node);

        if (node.source === 'app') {
            startApp();
        } else {
            startMqtt();
        }

        // valtype set = older CAN device on the legacy ampio/ API
        function startMqtt() {
            const legacy = node.valtype !== '';
            const topic = legacy
                ? au.legacy_state_topic(node.mac, node.valtype, node.index)
                : au.build_topic('state', node.mac, node.devtype, node.attribute, node.index);
            const decode = legacy ? au.decode_legacy_value : au.decode_value;
            const target = legacy
                ? {mac: node.mac, valtype: node.valtype, index: node.index}
                : {mac: node.mac, devtype: node.devtype, attribute: node.attribute, index: node.index};
            node.topics = [topic];
            node.brokerConn.subscribe(topic, function(topic, payload, packet) {
                if (payload.length === 0 || (node.retainignore && packet.retain)) {
                    return;
                }
                let value;
                try {
                    value = decode(payload);
                } catch (err) {
                    node.warn("Invalid payload on " + topic + ": " + err.message);
                    return;
                }
                node.send(Object.assign({topic: topic, payload: value}, target));
            }, node.id);
            if (node.brokerConn.connected) {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            }
        }

        // The server publishes an object's state once per application user: the same change (same "on"
        // time and state) is passed on once
        function startApp() {
            const leafId = au.app_leaf_id(node.mac, node.devtype, node.attribute, node.index);
            const target = {mac: node.mac, devtype: node.devtype, attribute: node.attribute, index: node.index};
            let last = null;
            node.topics = [];
            node.status({fill:"yellow",shape:"ring",text:"looking up application objects"});
            function lookup() {
                node.brokerConn.appObjectIds(node.mac, node.devtype, node.attribute, node.index, function(err, ids) {
                    if (node.closed) {
                        return;
                    }
                    if (!ids.length) {
                        if (!err && !node.warned) {
                            node.warned = true;
                            node.warn("No application object for " + leafId + ": add one in Ampio Designer (Application) to receive its values");
                        }
                        node.status({fill:"red",shape:"ring",text:err ? "application objects not available" : "no application object for " + leafId});
                        node.retry = setTimeout(lookup, APP_RETRY_TIME);
                        return;
                    }
                    ids.forEach(function(id) {
                        const topic = au.app_state_topic(id);
                        node.topics.push(topic);
                        node.brokerConn.subscribe(topic, function(topic, payload) {
                            if (payload.length === 0) {
                                return;
                            }
                            let state;
                            try {
                                state = au.decode_app_state(payload);
                            } catch (err) {
                                node.warn("Invalid payload on " + topic + ": " + err.message);
                                return;
                            }
                            const key = state.on + '|' + state.value;
                            if (state.on !== undefined && key === last) {
                                return;
                            }
                            last = key;
                            node.send(Object.assign({topic: topic, payload: state.value, object: id, desc: state.desc}, target));
                        }, node.id);
                    });
                    node.status({fill:"green",shape:"dot",text:"object" + (ids.length > 1 ? "s " : " ") + ids.map(function(id) { return '#' + id; }).join(', ')});
                });
            }
            lookup();
        }

        node.on('close', function(removed, done) {
            node.closed = true;
            clearTimeout(node.retry);
            node.topics.forEach(function(topic) {
                node.brokerConn.unsubscribe(topic, node.id, removed);
            });
            node.brokerConn.deregister(node, done);
        });
    }
    RED.nodes.registerType("Ampio v2 IN", ampioin);
};
