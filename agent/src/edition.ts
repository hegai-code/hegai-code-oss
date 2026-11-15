/**
 * Which product this agent bundle belongs to — fixed at BUILD time, never read
 * from the hub or the environment, because the external edition's whole
 * promise is that a hub cannot change what the agent trusts.
 *
 * - `internal` (default; `deploy/agent.mjs`): the Hegai Code fleet. A hub
 *   deploy is the rollout, exactly as before this file existed.
 * - `external` (`AGENT_EDITION=external deploy/build-agent.sh` →
 *   `deploy/agent-external.mjs`): a customer's self-hosted hub. Self-updates
 *   must carry a release signature from a key in the compiled-in list, and no
 *   HegAI host (gateway, spare relay ports) is assumed.
 *
 * Source runs (`npm run start`, tests) are `internal` unless
 * `CC_REMOTE_AGENT_EDITION=external` is set — a development convenience only;
 * a built bundle ignores that variable.
 */
declare const __CC_REMOTE_EDITION__: string | undefined;
declare const __CC_REMOTE_EDITION_MARKER__: string | undefined;

export type Edition = 'internal' | 'external';

function resolve(): Edition {
  if (typeof __CC_REMOTE_EDITION__ === 'string') return __CC_REMOTE_EDITION__ === 'external' ? 'external' : 'internal';
  return process.env['CC_REMOTE_AGENT_EDITION'] === 'external' ? 'external' : 'internal';
}

export const EDITION: Edition = resolve();

/**
 * A sentinel string the build defines (`deploy/build-agent.sh`:
 * `HEGAI_AGENT_EDITION=external|internal`) and `--self-test` prints, so that
 * both a person with `grep` (deploy/release-signer/sign-release.mjs refuses to
 * ask for a signature on anything but the external build) and the updater (it
 * runs the verified candidate once and reads the marker back) can tell which
 * product a bundle is without trusting a file name or a manifest.
 */
export const EDITION_MARKER: string =
  typeof __CC_REMOTE_EDITION_MARKER__ === 'string' ? __CC_REMOTE_EDITION_MARKER__ : `HEGAI_AGENT_EDITION=${EDITION}`;
export const isExternal = (): boolean => EDITION === 'external';
