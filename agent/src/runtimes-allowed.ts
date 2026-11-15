/**
 * `CC_REMOTE_DISABLE_CLAUDE=1`: Claude is switched off for this agent.
 *
 * No Claude session starts, resumes or is taken over (refused before any
 * liveness check or kill), no Claude login is started, the machine reports
 * Claude as `disabled` instead of whoever is in `~/.claude.json`, no Claude
 * usage is polled or reported, and a session that names no CLI goes to Codex.
 *
 * Why it exists (06.10.2026): clientco runs two agents as root — Marat's node
 * and Owner's — sharing one `~/.claude`. The login there was Owner's personal
 * Claude, and Marat's account showed it as his. His machine is Codex-only
 * (through the gateway's pool-c); Owner's node on the same box is untouched,
 * because the switch is per agent (env), not per box.
 *
 * A switch, not an allowlist: an owner who sets it means "off". Unset, empty,
 * `0`/`false`/`no`/`off` = on as always; ANY other value — a typo included —
 * reads as off, so a misspelling can never quietly re-enable Claude.
 */
export function claudeDisabledFromEnv(raw: string | undefined = process.env['CC_REMOTE_DISABLE_CLAUDE']): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value || ['0', 'false', 'no', 'off'].includes(value)) return false;
  if (!['1', 'true', 'yes', 'on'].includes(value)) {
    console.warn(`[agent] CC_REMOTE_DISABLE_CLAUDE=${raw}: not a yes/no — treating as disabled`);
  }
  return true;
}

let cached: boolean | undefined;

/** Read once per process, like the rest of the agent's env. */
export function claudeDisabled(): boolean {
  cached ??= claudeDisabledFromEnv();
  return cached;
}

export const CLAUDE_DISABLED_MESSAGE = 'Claude на этой машине выключен (CC_REMOTE_DISABLE_CLAUDE) — сессии здесь идут через Codex.';
