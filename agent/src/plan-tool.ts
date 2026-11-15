/**
 * `mcp__hegai__plan` — the session's checklist, served by the agent itself.
 *
 * Claude Code's own checklist tools (`TodoWrite`, `TaskCreate`/`TaskUpdate`)
 * are switched off per model by a remote flag: CLI 2.1.319 gives an Opus 5.5
 * session neither, while Sonnet 4.6 gets `TaskCreate` (probed 07.11.2026). A
 * session watched from a phone then has no way to say how far along it is.
 * This tool has TodoWrite's exact input, so clients render it with the
 * checklist they already have and count «3/7» off it (shared/src/plan.ts).
 *
 * One tool for every model: the CLI's own ones are disallowed, otherwise a
 * Sonnet session would keep two lists and the strip would follow neither.
 *
 * `alwaysLoad` keeps it out of tool search — a deferred tool is a tool the
 * model never thinks to look for. `allowedTools` lets it run without asking
 * in every permission mode: it touches nothing but the model's own list.
 *
 * `CC_REMOTE_PLAN_TOOL=off` in the agent's environment turns it off.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { PLAN_TOOL, planItems, planProgress } from '@cc-remote/shared';

export function planToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['CC_REMOTE_PLAN_TOOL'] ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** The CLI's own checklist tools, replaced by ours. `TaskOutput`/`TaskStop`
 *  are background jobs, not the list, and stay. */
export const NATIVE_PLAN_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'];

export const PLAN_TOOL_DESCRIPTION = [
  'Show the person your plan as a live checklist with a progress bar ("3/7 · Running tests") in the Hegai Code app.',
  'The person usually watches from a phone and otherwise cannot tell how much of a long task is left — this is how they know.',
  '',
  'When to use: any task with 3 or more distinct steps, or one that will take more than a few minutes (including the work of a sub-agent you are). Skip it for a single quick action, a question, or plain conversation.',
  '',
  'How:',
  '- Call it as soon as you know the steps, before doing them.',
  '- Every call sends the FULL list (it replaces the previous one). Add, drop, split or reword steps whenever the plan changes.',
  '- Exactly one item is in_progress while you work. Mark an item completed the moment it is done — not in a batch at the end — and set the next one in_progress in the same call.',
  '- content: a short outcome-oriented step in the language you are speaking with the person. activeForm: the same step in present continuous, shown while it runs (e.g. "Прогоняю тесты").',
  '- Steps are units of work the person cares about (change the API, update the iOS screen, deploy), not individual tool calls.',
  '- Before your final answer, every finished step is completed; anything you did not do stays pending or is removed.',
].join('\n');

const ItemShape = z.object({
  content: z.string().min(1).describe('The step, imperative, in the person\'s language'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1).describe('Present continuous form shown while the step runs'),
});

export function planServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'hegai',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool(
        'plan',
        PLAN_TOOL_DESCRIPTION,
        { todos: z.array(ItemShape).describe('The whole updated list') },
        async (args) => {
          const { done, total } = planProgress(planItems(args) ?? []);
          return { content: [{ type: 'text', text: `Plan updated: ${done}/${total} done. The person sees it.` }] };
        },
        { annotations: { readOnlyHint: true, title: 'План' } },
      ),
    ],
  });
}

/** The tool's description alone did not do it: probed 07.11.2026, Opus 5.5
 *  built a five-step package (module, README, tests, run, fix) without ever
 *  calling it. A rule in the system prompt is what a model actually follows. */
export const PLAN_PROMPT = `
# План для человека (Hegai Code)

Человек обычно следит за сессией с телефона и видит над полем ввода полоску «3/7 · сейчас: …», которую рисует инструмент \`mcp__hegai__plan\`. Без него длинная работа выглядит как бесконечное «думаю».

- Задача из трёх и больше шагов или дольше пары минут — первым делом вызови \`mcp__hegai__plan\` со всем списком шагов, потом работай.
- После каждого законченного шага вызывай снова с полным обновлённым списком: этот шаг completed, следующий in_progress. Не копи отметки до конца.
- План поменялся — поменяй список. Шаги — то, что важно человеку (поменять API, обновить экран iOS, выкатить), а не отдельные команды.
- Субагент с многошаговой задачей ведёт свой план так же — он виден на его карточке.
- Короткий ответ, вопрос, разговор — без плана.
`.trim();

/** The launch options this module contributes to a Claude `query()`. Empty
 *  when switched off, so the session runs exactly as before. `prompt` is
 *  appended to the session's system prompt by the caller (see
 *  `withSystemPrompt`), because `harnessOptions` owns that field too. */
export function planToolOptions(env: NodeJS.ProcessEnv = process.env): {
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  allowedTools?: string[];
  disallowedTools?: string[];
  prompt?: string;
} {
  if (!planToolEnabled(env)) return {};
  return {
    mcpServers: { hegai: planServer() },
    allowedTools: [PLAN_TOOL],
    disallowedTools: NATIVE_PLAN_TOOLS,
    prompt: PLAN_PROMPT,
  };
}

/** Both launch contributions as `query()` options, the two prompt parts
 *  joined. No part at all → no `systemPrompt`, exactly as before either
 *  existed (harness.ts explains why «none» and «a string» differ). */
export function sessionLaunchOptions(
  harness: { agents?: Record<string, unknown>; systemPrompt?: string },
  plan: ReturnType<typeof planToolOptions>,
): Record<string, unknown> {
  const { prompt, ...planRest } = plan;
  const systemPrompt = [harness.systemPrompt, prompt].filter(Boolean).join('\n\n');
  return { ...harness, ...planRest, ...(systemPrompt ? { systemPrompt } : {}) };
}
