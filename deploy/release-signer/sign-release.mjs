#!/usr/bin/env node
// Release build-machine CLI: ASK the signer to sign an agent bundle, then wait
// for the operator to approve it on the signer's own page.
//   node deploy/release-signer/sign-release.mjs --signer https://signer.example \
//        --bundle deploy/agent-external.mjs [--version 0.3.4] [--commit <sha>] [--note "..."] \
//        [--token-file <file>] [--keys deploy/release-keys.txt] [--timeout-s 900] [--poll-ms 3000]
// The request token is read from --token-file or SIGN_RELEASE_TOKEN_FILE (a
// file, so it never shows in `ps` or shell history). This machine never sees an
// authenticator code and cannot produce a signature by itself: it prints the
// sha256, the operator compares it on their phone and types the code there.
// Writes <bundle>.release and <bundle>.sig next to the bundle once signed and
// verifies them against the trusted keys.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bundleEdition, manifestText, parseManifest, readKeys, sha256Hex, verifySignature } from './release-format.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    out[a.slice(2)] = argv[++i];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.signer || !args.bundle) {
    console.error('usage: sign-release.mjs --signer <https://signer> --bundle <agent-external.mjs> [--version <v>] [--commit <sha>] [--note <text>] [--token-file <file>] [--keys <release-keys.txt>]');
    process.exit(2);
  }
  const tokenFile = args['token-file'] ?? process.env.SIGN_RELEASE_TOKEN_FILE;
  if (!tokenFile) throw new Error('the request token file is required (--token-file or SIGN_RELEASE_TOKEN_FILE)');
  const token = readFileSync(tokenFile, 'utf8').trim();
  const signer = args.signer.replace(/\/+$/, '');
  const bundle = readFileSync(args.bundle);
  // Never even ask for a signature on anything but the external build: a signed
  // internal bundle trusts no release key and verifies nothing.
  const edition = bundleEdition(bundle);
  if (edition !== 'external') {
    throw new Error(`${args.bundle} is not an external-edition build (edition marker: ${edition ?? 'none'}); build it with AGENT_EDITION=external bash deploy/build-agent.sh`);
  }
  const sha256 = sha256Hex(bundle);
  const version = args.version ?? JSON.parse(readFileSync(path.join(here, '../../agent/package.json'), 'utf8')).version;
  const commit = args.commit ?? gitCommit();
  const keysFile = args.keys ?? path.join(here, '../release-keys.txt');
  const timeoutMs = Number(args['timeout-s'] ?? 900) * 1000;
  const pollMs = Number(args['poll-ms'] ?? 3000);
  console.error(`bundle ${args.bundle}\nversion ${version}\nsha256  ${sha256}${commit ? `\ncommit  ${commit}` : ''}`);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const payload = { version, sha256 };
  if (commit && /^[0-9a-f]{7,40}$/.test(commit)) payload.commit = commit;
  if (args.note) payload.note = args.note;
  const created = await fetch(`${signer}/requests`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
  const request = await created.json().catch(() => ({}));
  if (!created.ok) throw new Error(`signer refused the request (${created.status}): ${request.error ?? 'no reason'}`);
  console.error(`\nrequest ${request.id}\nsha256  ${sha256}\n\nOpen ${signer}/ on your phone, compare the sha256 above with the page, and approve with your authenticator code.\nWaiting (up to ${Math.round(timeoutMs / 60000)} min)...`);
  const deadline = Date.now() + timeoutMs;
  let result;
  for (;;) {
    const res = await fetch(`${signer}/requests/${request.id}`, { headers, signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`signer error while waiting (${res.status}): ${body.error ?? 'no reason'}`);
    if (body.status === 'signed') {
      result = body;
      break;
    }
    if (body.status !== 'pending') throw new Error(`the request ended as "${body.status}" without a signature`);
    if (Date.now() >= deadline) throw new Error('timed out waiting for the operator to approve');
    await sleep(pollMs);
  }
  const expected = manifestText(version, sha256);
  if (result.manifest !== expected) throw new Error('the signer returned a manifest we did not ask for');
  const parsed = parseManifest(result.manifest);
  if (!parsed || parsed.sha256 !== sha256 || parsed.edition !== 'external') throw new Error('malformed manifest from the signer');
  const keys = readKeys(keysFile);
  if (!verifySignature(Buffer.from(result.manifest), result.signature, keys)) {
    throw new Error(`the signature does not verify against any key in ${keysFile} - is the key added there?`);
  }
  writeFileSync(`${args.bundle}.release`, result.manifest);
  writeFileSync(`${args.bundle}.sig`, `${result.signature}\n`);
  console.error(`signed: ${args.bundle}.release, ${args.bundle}.sig (verified against ${keys.length} trusted key(s))`);
}

main().catch((err) => {
  console.error(`sign-release: ${err.message}`);
  process.exit(1);
});
