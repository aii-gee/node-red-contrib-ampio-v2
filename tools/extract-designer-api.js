#!/usr/bin/env node
// Generates ampioin/db/openapi.json (the M-SERV HTTP API, "Ampio API") from the OpenAPI document
// embedded in the Ampio Designer bundle (http://<mserv>/assets/App-*.js).
//
//   node tools/extract-designer-api.js App-xxxx.js > ampioin/db/openapi.json
//
// The bundle also holds JSON Schema libraries mentioning "openapi", so the document is located by its
// shape: an object literal starting with openapi:"3..." whose info.title is "Ampio API".
// Only that plain object literal is cut out of the bundle and evaluated, in an empty vm context.
'use strict';
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');

// returns the balanced {...} literal starting at index `at`
function literalAt(at) {
    let depth = 0, quote = null;
    for (let i = at; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) { quote = null; }
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') { depth++; }
        else if (c === '}' && --depth === 0) { return src.slice(at, i + 1); }
    }
    throw new Error('unbalanced literal at ' + at);
}

const re = /\{\s*"?openapi"?\s*:\s*["']3[.\d]*["']/g;
let spec = null, m;
while (!spec && (m = re.exec(src))) {
    let doc;
    try {
        doc = vm.runInNewContext('(' + literalAt(m.index) + ')', Object.create(null), {timeout: 2000});
    } catch {
        continue;
    }
    if (doc && doc.info && doc.info.title === 'Ampio API' && doc.paths) {
        spec = doc;
    }
}
if (!spec) {
    throw new Error('could not locate the Ampio API OpenAPI document');
}
process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
