/**
 * The environment every process the agent starts inherits — sessions, the
 * terminal, Codex, `claude auth login`, `npm i -g`.
 *
 * Without this, the agent's own credential to the hub rode into every child:
 * a session asked to run `env` printed `CC_REMOTE_TOKEN` (or the per-machine
 * device token), the output landed in the transcript, the transcript was
 * replicated to the hub and shown to everyone who can see the session. A
 * prompt injection in a README was enough to exfiltrate the key that lets its
 * holder register as this machine.
 *
 * Only the agent's CREDENTIALS are removed. Behaviour switches
 * (`CC_REMOTE_ALLOW_BYPASS`, `CC_REMOTE_FILES_ROOTS`, …) stay: a session that
 * works on cc-remote itself may legitimately read them, and none of them lets
 * anyone in. The person's own secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`)
 * are theirs to hand to their sessions and are left alone.
 */

/** Exact names the agent authenticates or enrolls with. */
const AGENT_CREDENTIALS = new Set(['CC_REMOTE_TOKEN', 'CC_REMOTE_DEVICE_TOKEN', 'CC_REMOTE_ENROLLMENT_CODE', 'LLM_JOURNAL_KEY']);

/** Any future `CC_REMOTE_*` that looks like a credential is treated as one. */
const CREDENTIAL_SHAPE = /^CC_REMOTE_\w*(TOKEN|SECRET|PASSWORD|CODE|KEY)\w*$/i;

export function isAgentCredential(name: string): boolean {
  return AGENT_CREDENTIALS.has(name) || CREDENTIAL_SHAPE.test(name);
}

/**
 * Who in the hub started a run, for the scripts inside it (HEGAI_RUN_USER_ID /
 * HEGAI_RUN_USER_EMAIL, plus HEGAI_RUN_STATE_FILE). Only the run's own spawn may set them; an inherited
 * value from the agent's environment is never passed on, so it cannot name
 * someone the hub did not.
 */
const RUN_USER_ENV = /^HEGAI_RUN_/i; // Windows env names are case-insensitive
const RUN_USER_SAFE = /^[A-Za-z0-9._@+-]{1,320}$/;

/** The env vars for a run's coder process; a field outside the conservative
 *  charset is dropped (warned about without its value). */
export function runUserEnv(
  runBy?: { userId: string; email?: string },
  stateFile?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  // Path of the per-run identity file (run-state.ts): who authored the latest turn.
  if (stateFile) out.HEGAI_RUN_STATE_FILE = stateFile;
  if (!runBy) return out;
  if (RUN_USER_SAFE.test(runBy.userId)) out.HEGAI_RUN_USER_ID = runBy.userId;
  else console.warn('[agent] runBy.userId has unexpected characters — HEGAI_RUN_USER_ID not set');
  if (runBy.email !== undefined) {
    if (RUN_USER_SAFE.test(runBy.email)) out.HEGAI_RUN_USER_EMAIL = runBy.email;
    else console.warn('[agent] runBy.email has unexpected characters — HEGAI_RUN_USER_EMAIL not set');
  }
  return out;
}

export function childEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!isAgentCredential(name) && !RUN_USER_ENV.test(name)) env[name] = value;
  }
  return { ...env, ...extra };
}
