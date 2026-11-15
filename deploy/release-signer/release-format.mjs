// The release manifest and its signature file: the one place the exact bytes
// are defined. Mirrored by agent/src/self-update.ts and server-rs/src/agent_release.rs.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MANIFEST_MAGIC = 'hegai-code-agent-release/1';

/**
 * The manifest attests the edition: only the EXTERNAL build is ever signed, and
 * an external agent / hub installs or offers nothing whose manifest does not
 * say `edition=external` (a signed internal bundle trusts no key and verifies
 * nothing, so it must never be able to replace an external agent).
 */
export function manifestText(version, sha256, edition = 'external') {
  return `${MANIFEST_MAGIC}\nedition=${edition}\nversion=${version}\nsha256=${sha256}\n`;
}

export function parseManifest(text) {
  const m = /^hegai-code-agent-release\/1\nedition=([a-z]+)\nversion=([^\n\r]+)\nsha256=([0-9a-f]{64})\n$/.exec(text);
  return m ? { edition: m[1], version: m[2], sha256: m[3] } : undefined;
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Which product a built agent bundle is, read from the sentinel string the
 * build defines (agent/src/edition.ts, deploy/build-agent.sh):
 * `HEGAI_AGENT_EDITION=external|internal`. `undefined` when it carries none or
 * carries both - neither is something to sign.
 */
export function bundleEdition(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const external = text.includes('"HEGAI_AGENT_EDITION=external"');
  const internal = text.includes('"HEGAI_AGENT_EDITION=internal"');
  if (external === internal) return undefined;
  return external ? 'external' : 'internal';
}

/** Trusted public keys: base64 SPKI DER, one per line, `#` comments. */
export function readKeys(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function verifySignature(manifestBytes, sigB64, keys) {
  const sig = Buffer.from(String(sigB64).trim(), 'base64');
  if (sig.length !== 64) return false;
  return keys.some((k) => {
    try {
      return verify(null, manifestBytes, createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), sig);
    } catch {
      return false;
    }
  });
}
