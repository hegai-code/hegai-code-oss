#!/usr/bin/env node
// One-time setup of the release signer: an Ed25519 key pair, a TOTP secret and
// the bearer token the build machine uses to ASK for a signature.
//   node setup.mjs <directory> [--account "Release signer"]
// Writes key.pem (PKCS8, 0600), totp-secret and request-token (0600) into
// <directory>, prints the line for deploy/release-keys.txt and the otpauth:// URI
// for the phone.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { newSecret, otpauthUri } from './totp.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const ai = args.indexOf('--account');
const account = ai >= 0 ? args[ai + 1] : 'Release signer';
if (!dir) {
  console.error('usage: node setup.mjs <directory> [--account "name shown in the authenticator"]');
  process.exit(2);
}
const keyPath = path.join(dir, 'key.pem');
const secretPath = path.join(dir, 'totp-secret');
const tokenPath = path.join(dir, 'request-token');
if (existsSync(keyPath) || existsSync(secretPath) || existsSync(tokenPath)) {
  console.error(`${dir} already holds a key or secret — refusing to overwrite. Move it away first (see README, rotation).`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const secret = newSecret();
writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
const requestToken = randomBytes(32).toString('hex');
writeFileSync(tokenPath, `${requestToken}\n`, { mode: 0o600 });
chmodSync(keyPath, 0o600);
chmodSync(secretPath, 0o600);
chmodSync(tokenPath, 0o600);

const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const uri = otpauthUri('Hegai Code release', account, secret);
console.log(`Key pair and TOTP secret written to ${dir} (mode 0600).\n`);
console.log('1) Add this line to deploy/release-keys.txt in the repository:\n');
console.log(pub);
console.log('\n2) Import this into Google Authenticator (the secret exists only here and on the phone):\n');
console.log(uri);
const qr = spawnSync('qrencode', ['-t', 'ansiutf8', uri], { stdio: ['ignore', 'inherit', 'ignore'] });
if (qr.error || qr.status !== 0) console.log('\n(install qrencode to see a QR code here; or type the secret in by hand: ' + secret + ')');
console.log(`\n3) The build machine asks for signatures with ${tokenPath} (copy it there, mode 0600, and point SIGN_RELEASE_TOKEN_FILE at it).\n   The token can only ASK; the authenticator code is typed on the signer's own page.`);
console.log('\nThe private key never leaves this host. Back up key.pem and totp-secret offline.');
