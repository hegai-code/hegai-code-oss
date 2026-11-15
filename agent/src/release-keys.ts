/**
 * The public keys an EXTERNAL-edition self-update must be signed by
 * (`self-update.ts`, docs/EXTERNAL-EDITION.md «Release signing»).
 *
 * Fixed at BUILD time from `deploy/release-keys.txt` (`deploy/build-agent.sh`
 * passes them as the define `__CC_REMOTE_RELEASE_KEYS__`, a JSON array of
 * base64 SPKI DER Ed25519 keys). Never read from the hub or the environment:
 * the hub is exactly what this list exists to distrust. The internal bundle and
 * source runs compile in an empty list — they do not check signatures.
 */
declare const __CC_REMOTE_RELEASE_KEYS__: string | undefined;

function resolve(): readonly string[] {
  if (typeof __CC_REMOTE_RELEASE_KEYS__ !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(__CC_REMOTE_RELEASE_KEYS__);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export const RELEASE_KEYS: readonly string[] = resolve();
