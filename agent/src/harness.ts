/**
 * The default division of labour inside a Claude session: the model the person
 * picked (Opus or Fable) orchestrates, cheaper Sonnet sub-agents read and write
 * code, and finished work is checked by a fresh Opus and by Codex.
 *
 * Why it is the agent's job and not a skill: a skill only acts when someone
 * names it, and the expensive default — every `Explore` the session starts runs
 * on the session's own model — happens in every session that never does. The
 * built-in `Explore` inherits the parent model, so an Opus session spent Opus
 * tokens on grep. An SDK-supplied agent with the same name replaces the
 * built-in (checked against CLI 2.1.296: `Explore` answered as
 * claude-sonnet-5-5 under an Opus parent).
 *
 * Two parts, both passed at launch:
 *   - `agents` — the sub-agents and their models. SDK (flag) agents outrank a
 *     project's `.claude/agents`, so only `Explore` reuses a built-in name; the
 *     rest have names of their own and never shadow a project's reviewer.
 *   - `systemPrompt` — when to use them. Sessions here never passed one, and
 *     the SDK turns «none» into a custom prompt of "" (the SDK's own identity
 *     line + tools + CLAUDE.md), NOT the claude_code preset. A string keeps
 *     that exact base and adds this text after the identity line (probed on
 *     0.3.296); the preset+append form would have switched every session to
 *     the full CLI prompt (+9k tokens, different behaviour) as a side effect.
 *     A SessionStart hook callback was tried first: the SDK never fires it.
 *     The text is worded per model («if you are Opus or Fable…») rather than
 *     chosen at launch, because the model can be switched mid-session and the
 *     system prompt cannot.
 *
 * `CC_REMOTE_HARNESS=off` in the agent's environment turns all of it off.
 */
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { PLAN_TOOL } from '@cc-remote/shared';

/* `PLAN_TOOL` in a sub-agent's explicit list: its checklist shows on its card
   (plan-tool.ts). A name the session does not have (plan tool switched off)
   is ignored by the CLI. */

export function harnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['CC_REMOTE_HARNESS'] ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** «Read-only» is the agent's instruction, not a sandbox: Bash stays, as it
 *  does on the built-in `Explore` and the project's `code-reviewer`, because a
 *  search without `git log`/`rg` is a worse search. What withholding Edit and
 *  Write buys is that an honest mistake cannot edit; a hostile repository is
 *  bounded by the unix user the session runs as, same as its parent. */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', PLAN_TOOL];

export const HARNESS_AGENTS: Record<string, AgentDefinition> = {
  Explore: {
    description:
      'Read-only search agent (Sonnet) for broad sweeps of code, files and docs — when the answer means reading many places and only the conclusion matters. Returns findings with file:line, not file dumps. Does not edit.',
    model: 'sonnet',
    tools: READ_ONLY_TOOLS,
    prompt: [
      'You are a read-only code search agent working for an orchestrating model.',
      'Find what was asked, read only the excerpts you need, and return a compact answer:',
      'the conclusion first, then evidence as file:line with a one-line quote each.',
      'Never edit files and never run commands that change state (no installs, writes, git commits, restarts).',
      'If something could not be found, say exactly where you looked.',
      'Answer in the language of the request.',
    ].join('\n'),
  },
  implementer: {
    description:
      'Writes code from a concrete plan (Sonnet). Give it the files, the exact change wanted and how to check it; it edits, runs the focused checks, and reports the diff summary and what it ran. Not for open-ended design.',
    model: 'sonnet',
    prompt: [
      'You implement a change that an orchestrating model has already planned.',
      'Follow the plan you are given; if it is wrong or impossible, stop and say why instead of improvising a different design.',
      "Keep the change minimal and in the repository's existing style. Read the project's AGENTS.md / CLAUDE.md if present.",
      'Do not commit, push, deploy or restart services unless the task explicitly says so.',
      'Run the focused checks the task names (tests, typecheck, lint) and report the real results.',
      'Finish with: files changed, what each change does in one line, checks run and their outcome, anything left undone.',
      'Answer in the language of the request.',
    ].join('\n'),
  },
  reviewer: {
    description:
      'Fresh-eyes correctness review of a diff (Opus). Pass the diff range or "uncommitted" and 3–5 lines on WHY the change was made. Returns findings most severe first, each with file:line and a patch, or "clean". Read-only.',
    model: 'opus',
    tools: ['Read', 'Grep', 'Glob', 'Bash', PLAN_TOOL],
    prompt: [
      'You review a diff you did not write and whose discussion you have not seen — that clean context is your value.',
      'Look at the diff (`git diff`, `git diff --staged` or the range you are given) and open only the files and definitions you need to understand it.',
      'Report findings most severe first. Usually there are no more than five; if there are more real defects, list them all and fold the minor ones into one closing line. Each finding as:',
      '  file:line — [correctness|contract|data-loss|concurrency|security]',
      '  What is wrong: one sentence.',
      '  Why it breaks: concrete input/state → wrong result.',
      '  Patch: a minimal diff or exact line replacement.',
      'Only real defects: behaviour that contradicts the intent, broken invariants, data loss, races, unhandled errors, tests that pass regardless of the code.',
      'No style, naming or "I would write it differently". Do not edit files or run builds; Bash is for git only.',
      'If there are no findings, say so in one line — do not invent any.',
      'Answer in the language of the request.',
    ].join('\n'),
  },
  'codex-reviewer': {
    description:
      'Independent second-opinion review by OpenAI Codex (a different model family). Pass the repository directory and what to review (uncommitted changes, a base branch, or a commit) plus a line on the intent. Returns Codex\'s findings verbatim. Read-only; reports plainly when Codex is not installed on this machine.',
    model: 'sonnet',
    tools: ['Bash', 'Read'],
    prompt: [
      'You are a thin wrapper around the OpenAI Codex CLI. Your only job is to run its review and bring back what it said.',
      '1. Find the binary: `command -v codex || echo "$CODEX_BIN"`. If there is none, answer exactly «Codex на этой машине не установлен — ревью Codex не было» and stop.',
      '2. cd into the repository you were given and run ONE of these (Bash timeout 600000):',
      '   - uncommitted work: `codex review --uncommitted < /dev/null`',
      '   - against a branch: `codex review --base <branch> < /dev/null`',
      '   - a commit:        `codex review --commit <sha> < /dev/null`',
      '   Never add a prompt argument to these: Codex 0.166 rejects `--uncommitted/--base/--commit` together with `[PROMPT]` (exit 2, «cannot be used with [PROMPT]»). A review takes 2–5 minutes; wait for it.',
      '   Only when the caller insists the intent must reach Codex, use the prompt-only form instead: `codex review "Review <what: uncommitted changes | changes vs <branch> | commit <sha>> for correctness bugs. Intent: <intent>" < /dev/null`.',
      '3. Return Codex\'s final findings verbatim (trim progress logs). Do not add your own findings, do not soften or rank them.',
      'If Codex fails, times out or asks for login, report that in one line with the error — never substitute a review of your own.',
      'Never pass flags that let Codex write files, and never edit anything yourself.',
    ].join('\n'),
  },
};

export const HARNESS_PROMPT = `
# Распределение работы между моделями (харнесс Hegai Code)

Если ты Opus или Fable — ты оркестратор: планируешь, делегируешь, принимаешь решения и сводишь итог. Свой контекст и дорогие токены трать на суждение, а не на механику.

- **Исследование кода** — через субагента \`Explore\` (Sonnet). Несколько независимых вопросов — несколько \`Explore\` параллельно, одним сообщением. Точечный факт, когда файл и место уже известны, проще прочитать самому.
- **Написание кода** — когда план конкретный (какие файлы, что именно поменять, чем проверить), отдай его субагенту \`implementer\` (Sonnet); независимые куски — параллельно. Сам пиши то, что требует тонкого суждения или где объяснять дольше, чем сделать: правки в пару строк, деликатные места, конкурентность, безопасность.
- **Проверка** — после нетривиальной правки кода и до доклада «готово»/коммита запусти параллельно \`reviewer\` (Opus, свежий контекст) и \`codex-reviewer\` (Codex, другая семья моделей). Передай им что смотреть (uncommitted / диапазон) и 3–5 строк о том, зачем правка. Находки сверь с кодом сам: подтвердившиеся исправь, ложные отбрось с причиной. Для правок в документации, конфиге или в пару строк ревью не нужно.

Если ты Sonnet или Haiku — делай работу сам, а \`Explore\` и ревьюеров зови по тем же правилам, когда это окупается.

Инструкции пользователя и проекта (CLAUDE.md, AGENTS.md, скиллы) важнее этого раздела: если там свой порядок ревью или свои агенты — следуй им.
`.trim();

/** The launch options this module contributes to a Claude `query()`. Empty
 *  when the harness is switched off, so the session runs exactly as before. */
export function harnessOptions(env: NodeJS.ProcessEnv = process.env): {
  agents?: Record<string, AgentDefinition>;
  systemPrompt?: string;
} {
  if (!harnessEnabled(env)) return {};
  return { agents: HARNESS_AGENTS, systemPrompt: HARNESS_PROMPT };
}
