#!/usr/bin/env node
// Writes the operations reference of the Ampio v2 API node help (ampioin/api.html, between the
// <!-- operations:start --> and <!-- operations:end --> markers) from ampioin/db/openapi.json.
//
//   node tools/api-help.js          update ampioin/api.html
//   node tools/api-help.js --check  exit 1 when the help is out of date
'use strict';
const fs = require('fs');
const path = require('path');
const api = require('../generic/ampio-api');

const FILE = path.join(__dirname, '..', 'ampioin', 'api.html');
const START = '<!-- operations:start -->';
const END = '<!-- operations:end -->';

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// descriptions of the document: markdown `code` and <br> line breaks, anything else as text
function text(s) {
    return esc(String(s).replace(/<br>\s*/g, '\n')).replace(/`([^`]+)`/g, '<code>$1</code>').trim().replace(/\n/g, '<br>');
}

exports.render = function (spec) {
    const ops = api.operations(spec);
    const tags = [];
    ops.forEach((op) => { if (tags.indexOf(op.tag) === -1) { tags.push(op.tag); } });
    const out = [START, '    <h3>Operations</h3>',
        '    <p>From the "' + esc(spec.info.title) + '" OpenAPI document ' + esc(spec.info.version) + ' of Ampio Designer. <code>*</code> required.</p>'];
    tags.forEach((tag) => {
        out.push('    <h4>' + esc(tag || 'Other') + '</h4>', '    <dl class="message-properties">');
        ops.filter((op) => op.tag === tag).forEach((op) => {
            out.push('        <dt>' + esc(op.name) + ' <span class="property-type">' + esc(op.method + ' ' + op.path) + '</span></dt>');
            const dd = [text(op.summary)];
            if (op.description && op.description !== op.summary) {
                dd.push(text(op.description));
            }
            // functions explained in the description are not listed again
            const listed = /List of functions/.test(op.description);
            if (op.params.length) {
                dd.push(op.params.map((p) => '<code>' + esc(p.name) + (p.required ? '*' : '') + '</code> ' + text(p.description) +
                    (p.enum && !listed ? ': ' + p.enum.map((v) => '<code>' + esc(v) + '</code>').join(', ') : '')).join('<br>'));
            }
            if (op.body) {
                dd.push('Body: <code>msg.payload</code> as JSON.');
            }
            out.push('        <dd>' + dd.join('<br>') + '</dd>');
        });
        out.push('    </dl>');
    });
    out.push('    ' + END);
    return out.join('\n');
};

exports.update = function (html, spec) {
    const a = html.indexOf(START), b = html.indexOf(END);
    if (a === -1 || b === -1) {
        throw new Error('operations markers not found');
    }
    return html.slice(0, a) + exports.render(spec) + html.slice(b + END.length);
};

if (require.main === module) {
    const html = fs.readFileSync(FILE, 'utf8');
    const next = exports.update(html, require('../ampioin/db/openapi.json'));
    if (process.argv.includes('--check')) {
        if (next !== html) {
            console.error('ampioin/api.html help is out of date: run node tools/api-help.js');
            process.exit(1);
        }
    } else {
        fs.writeFileSync(FILE, next);
    }
}
