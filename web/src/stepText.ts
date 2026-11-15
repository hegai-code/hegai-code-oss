import { PLAN_TOOL } from '@cc-remote/shared';
import { commandActivity, hostOf, serviceActivity } from './workActivity.js';

/**
 * One tool call as a person reads it (19.10.2026, by request): «Смотрю размер
 * папок на мини», «Читаю Subagents.tsx», «Ищу «stepOf»» — not
 * `Bash · cd /srv/main-source; deploy/term.sh …`.
 *
 * Claude writes a `description` for every Bash call; that sentence IS the step.
 * Without one (Codex shells, an older model) the command is read by what it
 * most visibly does — the same rules as the «Думаю / Собираю» word under the
 * transcript (`workActivity.ts`). The raw command or path stays as `detail`,
 * one hover away, for the reader who wants it.
 */
export interface Step {
  /** The sentence the card shows. */
  text: string;
  /** The raw argument behind it (command, full path, URL), for a tooltip. */
  detail?: string;
}

const MAX = 160;

export function humanStep(name: string, input: unknown): Step {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const desc = s('description');
  switch (name) {
    case 'Bash':
    case '$':
    case 'PowerShell': {
      const cmd = s('command');
      if (desc) return step(sentence(desc), cmd);
      return step(commandText(cmd), cmd);
    }
    case 'Read':
      return fileStep('Читаю', s('file_path') || s('path'));
    case 'Edit':
    case 'MultiEdit':
      return fileStep('Правлю', s('file_path') || s('path'));
    case 'Write':
      return fileStep('Пишу', s('file_path') || s('path'));
    case 'NotebookEdit':
      return fileStep('Правлю блокнот', s('notebook_path') || s('file_path'));
    case 'Grep': {
      const pattern = s('pattern');
      const where = s('path') ? ` в ${tail(s('path'))}` : '';
      return step(pattern ? `Ищу «${short(pattern, 60)}»${where}` : 'Ищу в коде', s('path') || undefined);
    }
    case 'Glob':
      return step(s('pattern') ? `Ищу файлы ${short(s('pattern'), 60)}` : 'Ищу файлы', s('path') || undefined);
    case 'LS':
      return fileStep('Смотрю папку', s('path'));
    case 'WebFetch': {
      const host = hostOf(s('url'));
      return step(host ? `Читаю ${host}` : 'Читаю сайт', s('url') || undefined);
    }
    case 'WebSearch':
    case 'web_search':
    case 'Search':
    case 'web_search_call':
      return step(s('query') ? `Ищу в интернете: ${s('query')}` : 'Ищу в интернете');
    case 'Agent':
    case 'Task':
      return step(desc ? `Помощник: ${desc}` : 'Зову помощника');
    case 'TodoWrite':
    case PLAN_TOOL:
      return step('Обновляю план');
    case 'ExitPlanMode':
      return step('Предлагаю план');
    case 'AskUserQuestion':
      return step('Задаю вопрос');
    case 'Skill':
      return step(s('skill') ? `Открываю инструкцию ${s('skill')}` : 'Открываю инструкцию');
    case 'ToolSearch':
    case 'tool_search_call':
      return step('Подбираю инструменты');
    case 'Monitor':
    case 'BashOutput':
    case 'TaskOutput':
      return step(desc ? sentence(desc) : 'Слежу за фоновым процессом');
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return step('Останавливаю фоновый процесс');
    case 'Workflow':
      return step('Запускаю сценарий');
    case 'ScheduleWakeup':
      return step('Ставлю напоминание себе');
  }
  if (name.startsWith('mcp__') || name.startsWith('mcp:')) {
    const tool = name.split('__').filter(Boolean).pop() ?? '';
    const what = name.startsWith('mcp__') && tool !== name ? ` · ${tool.replace(/_/g, ' ')}` : '';
    return step(`${serviceActivity(name.replace(/^mcp:\s*/, ''))}${what}`);
  }
  if (desc) return step(sentence(desc));
  return step(name || 'Работаю');
}

/**
 * A live `tool_use` line: Claude's «Name {json}», Codex's «$ cmd»,
 * «edit paths», «web_search: q», «mcp: tool».
 */
export function humanToolLine(text: string): Step {
  const t = text.trim();
  if (t.startsWith('$ ')) return humanStep('$', { command: t.slice(2) });
  if (t.startsWith('edit ')) {
    const paths = t.slice(5).split(/[,\s]+/).filter(Boolean);
    return step(paths.length ? `Правлю ${paths.map(tail).join(', ')}` : 'Правлю файлы', t.slice(5));
  }
  if (t.startsWith('web_search:')) return humanStep('WebSearch', { query: t.slice(11).trim() });
  if (t.startsWith('mcp:')) return step(serviceActivity(t.slice(4).trim()));
  const sp = t.indexOf(' ');
  if (sp < 0) return humanStep(t, {});
  if (t[sp + 1] !== '{') return step(t);
  const name = t.slice(0, sp);
  const json = t.slice(sp + 1);
  let input: unknown = {};
  try {
    input = JSON.parse(json);
  } catch {
    // A long input arrives cut off; the leading fields still read.
    input = salvage(json);
  }
  return humanStep(name, input);
}

/** Tool names the agent writes in a sub-agent's «Tool · what» line, and the
 *  input field that «what» stood for. */
const ACTION_FIELD: Record<string, string> = {
  Read: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
  LS: 'path',
  WebFetch: 'url',
  WebSearch: 'query',
  Search: 'query',
  Agent: 'description',
  Task: 'description',
  Skill: 'skill',
};

/**
 * A sub-agent's step as the agent sends it (`Subagent.lastAction`, `recent`,
 * `steps`): the CLI's own summary sentence, or «Tool · what». For Claude the
 * «what» of a Bash call is usually its description already; for Codex it is
 * the command. Tell them apart and word the rest like any other step.
 */
export function humanAction(action: string): Step {
  const a = action.trim();
  if (/^(\$ |edit |web_search:|mcp:)/.test(a)) return humanToolLine(a);
  const m = /^([A-Za-z][\w-]*) · (.+)$/s.exec(a);
  if (!m) return step(a);
  const [, name, rest] = m as unknown as [string, string, string];
  if (name === 'Bash') {
    if (!looksLikeCommand(rest)) return step(sentence(rest));
    const asCommand = humanStep('Bash', { command: rest });
    // «check generated files»: plain words no rule recognises read better as
    // the description they most likely are than as «Запускаю check».
    if ((asCommand.text.startsWith('Запускаю ') || asCommand.text === 'Выполняю команду') && /^[a-z]+(?: [a-z]+)+$/i.test(rest.trim())) return step(sentence(rest));
    return asCommand;
  }
  if (name === 'Edit' && rest.includes(', ')) return step(`Правлю ${rest.split(', ').map(tail).join(', ')}`, rest);
  if (name === 'MCP') return step(serviceActivity(rest.split('/')[0] ?? rest) + (rest.includes('/') ? ` · ${rest.split('/').pop()}` : ''));
  if (name === 'Tool') return step(rest);
  const field = ACTION_FIELD[name];
  if (field) return humanStep(name, { [field]: rest });
  return humanStep(name, { description: rest });
}

/** A Bash description, not a shell line: a sentence starts with a capital (or
 *  Cyrillic) letter and carries no shell punctuation. */
function looksLikeCommand(s: string): boolean {
  const t = s.trim();
  if (/^[А-ЯЁа-яё]/.test(t)) return false;
  if (/[;|&`$<>]|\s--?\w/.test(t)) return true;
  if (/^(?:[A-Za-z_]\w*=\S*\s+)+\S/.test(t)) return true; // ENV=x cmd
  if (/^[A-Z][a-z]+-[A-Z]/.test(t)) return true; // PowerShell Verb-Noun
  if (/^[A-Z]/.test(t)) return false;
  return true;
}

/** A command without a description, by what it does: «Смотрю размер папок
 *  на dev-mac-mini-001», «Жду ответа legal.acme.test», «Запускаю node». */
function commandText(cmd: string, depth = 0): string {
  const c = cmd.trim();
  if (!c) return 'Запускаю команду';
  // `cd somewhere; real thing` — the cd says nothing.
  const body = c.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '');
  // Before the remote check: a loop that polls over ssh is a wait, not a login.
  const wait = waitText(body, depth);
  if (wait) return wait;
  const remote = depth === 0 ? remoteTarget(body) : undefined;
  if (remote) return remoteStep(remote, depth);
  const read = /^(?:cat|head|tail|less|bat|wc|sed\s+-n\s+\S+)\b(?:\s+-\S+(?:\s+\d+)?)*\s+([^\s|;&<>]+\.\w+)/.exec(body)?.[1];
  if (read) return `Читаю ${tail(read)}`;
  const ls = /^(?:ls|tree)\b(?:\s+-\S+)*\s*([^\s|;&<>]*)/.exec(body);
  if (ls) return ls[1] ? `Смотрю папку ${tail(ls[1])}` : 'Смотрю, что в папке';
  const git = /^git\s+(status|log|diff|show|branch)\b/.exec(body)?.[1];
  if (git) return GIT_LOOK[git]!;
  const service = serviceStep(body);
  if (service) return service;
  const label = commandActivity(body);
  if (label !== 'Запускаю команду') return label;
  return programStep(body) ?? 'Выполняю команду';
}

/**
 * A pause or a polling loop, by what it waits for (02.11.2026: a card of
 * «Жду · Жду · Жду» over a deploy check told the owner nothing). `sleep N`
 * names the pause and what follows it; `until` / `while` / a `for` with
 * `sleep` names the condition: a site, a background task's output, a git
 * ref, a process, a file, a server. Not a wait → undefined. iOS twin:
 * `StepText.waitText`.
 */
function waitText(body: string, depth: number): string | undefined {
  const pause = /^sleep\s+(\d+(?:\.\d+)?)([smhd]?)\s*(?:(?:;|&&)\s*([\s\S]*))?$/.exec(body);
  if (pause) {
    const head = `Жду ${duration(Number(pause[1]), pause[2] ?? '')}`;
    const rest = (pause[3] ?? '').trim();
    if (!rest) return head;
    const host = urlHost(rest);
    const then = host ? `проверяю ${host}` : lowerFirst(commandText(rest, depth));
    return `${head}, потом ${then}`;
  }
  const loop = /^(until|while)\s+([\s\S]+?)[;\n]\s*do\b/.exec(body);
  let cond = loop?.[2];
  if (!loop && /^for\b/.test(body) && /\bsleep\b/.test(body)) cond = /\bdo\b([\s\S]*?)\bsleep\b/.exec(body)?.[1] ?? '';
  if (cond === undefined) return /^sleep\b/.test(body) ? 'Жду' : undefined;
  if (/\/tasks\/[\w-]+\.output\b/.test(cond)) return 'Жду фоновую задачу';
  const host = urlHost(cond);
  if (host) return `Жду ответа ${host}`;
  if (/refs\/ci-ok\b/.test(cond)) return 'Жду зелёный CI';
  const ref = /refs\/heads\/([\w./-]+)/.exec(cond)?.[1];
  if (ref) return `Жду ветку ${ref}`;
  // `until X` and `while ! X` wait for X to appear; `while X` for it to go.
  const neg = /^\s*!/.test(cond) || /\[\s+!\s/.test(cond);
  const forAppear = (loop?.[1] === 'while') === neg;
  const proc = /\bpgrep\b(?:\s+-\S+)*\s+['"]?([\w.-]+)/.exec(cond)?.[1];
  if (proc) return forAppear ? `Жду запуска ${proc}` : `Жду, пока завершится ${proc}`;
  const file = /\[\s+(?:!\s+)?-[sfed]\s+['"]?([^\s'"\]]+)/.exec(cond)?.[1];
  if (file) return forAppear ? `Жду файл ${tail(file)}` : `Жду, пока исчезнет ${tail(file)}`;
  const server = remoteTarget(cond)?.host;
  if (server) return `Жду сервер ${server.replace(/^[^@]*@/, '')}`;
  return 'Жду';
}

function duration(n: number, unit: string): string {
  if (unit === 'm') return `${n} мин`;
  if (unit === 'h') return `${n} ч`;
  if (unit === 'd') return `${n} дн`;
  return n >= 60 && n % 60 === 0 ? `${n / 60} мин` : `${n} с`;
}

function urlHost(s: string): string {
  const url = /https?:\/\/[^\s'"\\);|&<>]+/.exec(s)?.[0];
  return url ? hostOf(url) : '';
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

interface Remote {
  host: string;
  /** The command sent to the machine; '' for an interactive login. */
  command: string;
  /** `term.sh` (a command through the machine's agent) rather than `ssh`. */
  term: boolean;
}

/**
 * Work on another machine is named by what is done there (31.10.2026, owner:
 * «Работаю на сервере» said nothing): the remote command is worded by the same
 * rules and gets «на <машина>». Unworded → «Захожу на stage» (ssh) or «Даю
 * команду на dev-mac-mini-001» (term.sh). No «сервер»: the mini and buildbox
 * are computers.
 */
function remoteStep(r: Remote, depth: number): string {
  const host = r.host.replace(/^[^@]*@/, '');
  const fallback = r.term ? `Даю команду на ${host}` : `Захожу на ${host}`;
  if (!r.command) return fallback;
  const inner = commandText(r.command, depth + 1);
  if (inner === 'Выполняю команду' || inner === 'Запускаю команду' || inner === 'Работаю на другой машине') return fallback;
  if (inner === 'Проверяю состояние') return `Проверяю состояние ${host}`;
  if (inner.startsWith('Запускаю скрипт на ')) return `Запускаю скрипт на ${host}`;
  return `${inner} на ${host}`;
}

/** Service and machine commands, worded: `uptime`, `systemctl`, `journalctl`,
 *  `pm2 restart`, `git pull`. Undetermined → undefined. */
function serviceStep(body: string): string | undefined {
  const b = body.replace(/^sudo\s+/, '');
  if (/^uptime\b/.test(b)) return 'Проверяю состояние';
  const ctl = /^systemctl\s+(?:-[\w-]*(?:\s+\d+)?\s+)*(status|is-active|restart|reload|start|stop)\b\s*(?:-[A-Za-z0-9_-]*(?:\s+\d+)?\s+)*((?:[A-Za-z0-9_@.:][A-Za-z0-9_@.:-]*)?)/.exec(b);
  if (ctl) {
    const unit = (ctl[2] ?? '').replace(/\.service$/, '');
    switch (ctl[1]) {
      case 'status':
      case 'is-active':
        return unit ? `Проверяю службу ${unit}` : 'Проверяю службы';
      case 'restart':
      case 'reload':
        return unit ? `Перезапускаю ${unit}` : 'Перезапускаю службу';
      case 'start':
        return unit ? `Запускаю службу ${unit}` : 'Запускаю службу';
      default:
        return unit ? `Останавливаю службу ${unit}` : 'Останавливаю службу';
    }
  }
  if (/^journalctl\b/.test(b)) {
    const unit = /\s(?:-u\s*|--unit[=\s])([A-Za-z0-9_@.:-]+)/.exec(b)?.[1]?.replace(/\.service$/, '');
    return unit ? `Читаю лог ${unit}` : 'Читаю лог';
  }
  const pm2 = /^pm2\s+(?:restart|reload)\s+([A-Za-z0-9_@.-]+)(?!\S)/.exec(b)?.[1];
  if (pm2) return `Перезапускаю ${pm2}`;
  if (/^git\s+pull\b/.test(b)) return 'Обновляю код';
  return undefined;
}

/** Wrappers and shell words that say nothing about what runs. */
const SHELL_NOISE = new Set(['sudo', 'env', 'nice', 'nohup', 'time', 'exec', 'export', 'set', 'local', 'then', 'do', 'if', '!', '(', '{']);

/**
 * The program a command runs, worded (20.10.2026: «Запускаю S» for
 * `S=$(…)`, «Запускаю sed» told nothing). Assignments and wrappers are
 * skipped; `sed -i` edits a file; an interpreter with a script names it,
 * inline code is «скрипт на Python». Undetermined → undefined.
 */
function programStep(body: string): string | undefined {
  const tokens = body.slice(0, 600).split(/\s+/).filter(Boolean).slice(0, 60);
  let i = 0;
  let inner: string | undefined;
  while (i < tokens.length && (/^[A-Za-z_]\w*=/.test(tokens[i]!) || SHELL_NOISE.has(tokens[i]!))) {
    // `S=$(du -sk …)` — what runs is inside the substitution.
    const sub = /^[A-Za-z_]\w*="?\$\((.+)$/.exec(tokens[i]!)?.[1];
    if (sub) {
      inner = sub;
      break;
    }
    i++;
  }
  if (inner !== undefined) tokens[i] = inner;
  if (tokens[i] === 'timeout' && /^\d/.test(tokens[i + 1] ?? '')) i += 2;
  const prog = tokens[i];
  if (!prog || prog.startsWith('-') || !/^[\w./-]+$/.test(prog)) return undefined;
  const name = tail(prog);
  const rest = tokens.slice(i + 1);
  if (name === 'sed' && rest.some((t) => t.startsWith('-i'))) {
    const file = [...rest].reverse().find((t) => /\.\w+$/.test(t) && !t.startsWith('-'));
    return file ? `Правлю ${tail(file.replace(/^['"]|['"]$/g, ''))}` : 'Правлю файл';
  }
  const lang: Record<string, string> = { python: 'Python', python3: 'Python', node: 'Node', bash: 'bash', sh: 'bash', zsh: 'bash', ruby: 'Ruby', perl: 'Perl' };
  if (lang[name]) {
    const script = rest.find((t) => !t.startsWith('-') && /\.\w+$/.test(t));
    if (script && !rest.slice(0, rest.indexOf(script)).some((t) => t === '-c' || t === '-e')) return `Запускаю скрипт ${tail(script)}`;
    return `Запускаю скрипт на ${lang[name]}`;
  }
  if (name === 'du') return 'Смотрю размер папок';
  if (name === 'df') return 'Смотрю место на диске';
  return `Запускаю ${name}`;
}

/** ssh options that take a value (`-o X`, `-p 22`, `-iKEY`). */
const SSH_ARG = /^-[BbcDEeFIiJLlmOoPpQRSWw]$/;

/** Shell words that end the remote part of `ssh host cmd | local`. */
const LOCAL_TAIL = /^(?:\||\|\||&&|;|&|<.*|>.*|\d>.*)$/;

/**
 * The machine a command works on and the command sent there: `term.sh HOST
 * [WAIT] 'cmd'` or the first `ssh [flags] HOST [cmd]`, by a linear token scan
 * — a regex with optional flag arguments backtracks exponentially on a long
 * run of flags (found in review, 20.10.2026). Quotes group a token.
 */
function remoteTarget(cmd: string): Remote | undefined {
  const term = /\bterm\.sh\s/.exec(cmd);
  if (term) {
    const tokens = shellTokens(cmd.slice(term.index + 8));
    const host = tokens[0];
    if (host && /^[\w.-]+$/.test(host)) {
      const rest = tokens.slice(1);
      if (/^\d+$/.test(rest[0] ?? '')) rest.shift();
      return { host, command: remoteCommand(rest), term: true };
    }
  }
  // `rsync -e ssh …` copies; `GIT_SSH_COMMAND="ssh …"` configures — neither is a login.
  if (/^(?:sudo\s+)?(?:scp|rsync)\b/.test(cmd)) return undefined;
  const at = /(?<!["'=])\bssh\s/.exec(cmd);
  if (!at) return undefined;
  const tokens = shellTokens(cmd.slice(at.index + 4));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('-')) {
      if (SSH_ARG.test(t)) i++;
      continue;
    }
    if (!/^[\w@.][\w@.-]*$/.test(t)) return undefined;
    return { host: t, command: remoteCommand(tokens.slice(i + 1)), term: false };
  }
  return undefined;
}

/** `"…"` | `'…'` | `\S+`, at most 40 tokens of the first 600 characters. */
function shellTokens(s: string): string[] {
  return (s.slice(0, 600).match(/"[^"]*"|'[^']*'|\S+/g) ?? []).slice(0, 40);
}

/** The tokens after the host up to the first local pipe or redirect, one
 *  layer of quotes off: `'du -sk' | tail` → `du -sk`. */
function remoteCommand(tokens: string[]): string {
  const taken: string[] = [];
  for (const t of tokens) {
    if (LOCAL_TAIL.test(t)) break;
    taken.push(t);
    if (t.endsWith(';')) break;
  }
  let out = taken.join(' ').replace(/;$/, '').trim();
  const q = out[0];
  if (q === "'" || q === '"') out = out.slice(1, out.endsWith(q) && out.length > 1 ? -1 : undefined).trim();
  return out;
}

const GIT_LOOK: Record<string, string> = {
  status: 'Смотрю, что изменено в git',
  log: 'Смотрю историю git',
  diff: 'Смотрю изменения',
  show: 'Смотрю коммит',
  branch: 'Смотрю ветки git',
};

function fileStep(verb: string, path: string): Step {
  return path ? step(`${verb} ${tail(path)}`, path) : step(`${verb} файл`);
}

function step(text: string, detail?: string): Step {
  const out: Step = { text: short(text, MAX) };
  if (detail && detail !== text) out.detail = detail.length > 2000 ? `${detail.slice(0, 1999)}…` : detail;
  return out;
}

/** «list files in home» → «List files in home». */
function sentence(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function tail(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function short(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The string fields of a JSON object cut off mid-way. */
function salvage(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)/g;
  for (let m = re.exec(json); m; m = re.exec(json)) {
    try {
      out[m[1]!] = JSON.parse(`"${m[2]!}"`) as string;
    } catch {
      out[m[1]!] = m[2]!;
    }
  }
  return out;
}
