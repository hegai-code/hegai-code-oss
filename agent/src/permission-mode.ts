import type { PermissionMode } from '@cc-remote/shared';

/**
 * The posture a machine starts its sessions in when the session itself named
 * none (`CC_REMOTE_DEFAULT_PERMISSION_MODE`). Read by BOTH runtimes — Claude
 * (`defaultPermissionMode` in `claude-session.ts`) and Codex
 * (`codexDefaultPermissionMode` in `codex-run.ts`) — so a box configured with
 * «don't click through every command» (`CC_REMOTE_AUTOAPPROVE=sandbox`,
 * `CC_REMOTE_DEFAULT_PERMISSION_MODE=acceptEdits` in devbox's `agent.env`)
 * means the same thing whichever runtime its sessions use.
 *
 * This lives in its own module on purpose: `claude-session.ts` imports the
 * Claude SDK, and a value import from it would drag the SDK into every
 * Codex-only process and test. Keep this file free of such imports.
 *
 * Anything not a real mode is never passed to a runtime — but it is not
 * ignored either. Unset means «nothing configured» and the floor applies (no
 * prompts where the machine allows it, 24.09.2026). A value that is set and
 * wrong means an operator wrote a restriction and misspelt it; reading that as
 * the floor would turn `accept_edits` into full bypass without a word. So a
 * typo is `default` — the runtime asks, which is visible — and is said once
 * in the log. The env is read per call (default parameter), not captured at
 * import, so tests can set or clear it.
 */
export function machineDefaultPermissionMode(
  raw: string | undefined = process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'],
): PermissionMode | undefined {
  if (!raw) return undefined;
  const known: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
  const mode = known.find((candidate) => candidate === raw);
  if (mode) return mode;
  if (!warnedAbout.has(raw)) {
    warnedAbout.add(raw);
    console.error(
      `[agent] CC_REMOTE_DEFAULT_PERMISSION_MODE=${JSON.stringify(raw)} is not a permission mode ` +
        `(one of ${known.join(', ')}) — sessions start in \`default\` (asking) until it is fixed`,
    );
  }
  return 'default';
}

const warnedAbout = new Set<string>();
