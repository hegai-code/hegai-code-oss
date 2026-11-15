#!/usr/bin/env node
// Prints the esbuild --define value for __CC_REMOTE_RELEASE_KEYS__:
// a JS string literal holding the JSON array of trusted release keys.
//   node agent/scripts/release-keys.mjs external   -> "[\"MCow...\"]"
//   node agent/scripts/release-keys.mjs internal   -> "[]"
// The internal bundle trusts no key (its updates are vouched for by the hub
// deploy, as always), so its bytes do not depend on deploy/release-keys.txt.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const edition = process.argv[2] ?? 'internal';
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../deploy/release-keys.txt');
let keys = [];
if (edition === 'external') {
  keys = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const k of keys) {
    // 44 bytes: 12-byte Ed25519 SPKI prefix + 32-byte key.
    const der = Buffer.from(k, 'base64');
    if (der.length !== 44 || der.subarray(0, 12).toString('hex') !== '302a300506032b6570032100') {
      console.error(`release-keys.txt: not an Ed25519 SPKI key: ${k.slice(0, 20)}…`);
      process.exit(1);
    }
  }
}
process.stdout.write(JSON.stringify(JSON.stringify(keys)));
