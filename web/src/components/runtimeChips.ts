import type { ClaudeRuntimeStatus, CodexRuntimeStatus, RuntimeStatus } from '@cc-remote/shared';

/**
 * One reading of a machine's runtime, as the UI says it. Shared by the
 * «Железо» card (chips + a hint line), the limits meter (a status row where a
 * section would otherwise be silently missing) and the start screen (whether
 * «Codex» deserves «· шлюз»).
 *
 * Three tones. `ok` is a fact worth reading («Codex · Plus · ilya@…»); `attn`
 * is something the person has to DO on that machine, and the hint names the
 * command; `muted` is «we do not know» — an agent too old to say — which must
 * never be drawn as a problem, because most of the fleet will be that for a
 * while after any agent change.
 */
export interface RuntimeChip {
  runtime: 'claude' | 'codex';
  label: string;
  tone: 'ok' | 'attn' | 'muted';
  /** What to do on the machine, when `tone` is `attn`. */
  hint?: string;
  /** Free detail from the agent (dirs searched, stderr tail). */
  detail?: string;
  /** The button that fixes an `attn` chip: install the coder, or log into it
   *  (`runtime.install` / `runtime.login.start`, RuntimeRows.tsx). */
  action?: 'install' | 'login';
}

/** `plus` → `Plus`, `max 20x` → `Max 20x`, `pro` → `Pro`. */
export function planLabel(plan?: string): string | undefined {
  if (!plan) return undefined;
  const p = plan.trim();
  return p ? p[0]!.toUpperCase() + p.slice(1) : undefined;
}

const CODEX_INSTALL_HINT =
  'На машине: npm install -g @openai/codex — либо укажите путь в CODEX_BIN в окружении агента. ' +
  'Codex из nvm/volta агент найдёт сам; Codex, встроенный в ChatGPT.app, установленным не считается.';
const CODEX_LOGIN_HINT = 'На машине: codex login; без браузера — codex login --device-auth.';
const CLAUDE_INSTALL_HINT = 'На машине: npm i -g @anthropic-ai/claude-code, затем claude';
const CLAUDE_LOGIN_HINT = 'На машине: claude — войти подпиской Claude Pro/Max или ключом из Anthropic Console.';
const CLAUDE_RELOGIN_HINT =
  'Имя учётки осталось, а токена нет — сессии Claude здесь не запустятся. Войдите заново; ' +
  'токен с другой машины не копируйте: при обновлении он вытолкнет одну из двух.';
const CLAUDE_TOKEN_HINT = 'Долгий токен скоро кончится: claude setup-token и заменить CLAUDE_CODE_OAUTH_TOKEN в окружении агента.';

export function codexChip(s: CodexRuntimeStatus): RuntimeChip {
  const who = [planLabel(s.plan), s.account].filter(Boolean).join(' · ');
  if (!s.present || s.error === 'not_found') {
    return { runtime: 'codex', label: 'Codex не найден', tone: 'attn', hint: CODEX_INSTALL_HINT, action: 'install', ...(s.detail ? { detail: s.detail } : {}) };
  }
  if (s.provider === 'gateway') {
    // A gateway machine spends the gateway's allowance; whose auth.json sits
    // beside it is irrelevant, and saying «Plus» here would mislead.
    return { runtime: 'codex', label: `Codex · шлюз${s.providerName && s.providerName !== 'hegai' ? ` ${s.providerName}` : ''}`, tone: 'ok' };
  }
  if (s.error === 'not_logged_in' || s.auth === 'none') {
    return { runtime: 'codex', label: 'Codex · нет входа', tone: 'attn', hint: CODEX_LOGIN_HINT, action: 'login' };
  }
  if (s.error === 'timeout' || s.error === 'app_server_error') {
    return { runtime: 'codex', label: 'Codex · не отвечает', tone: 'attn', hint: 'Codex стоит, но app-server не ответил — попробуйте войти заново.', action: 'login', ...(s.detail ? { detail: s.detail } : {}) };
  }
  if (s.auth === 'chatgpt') return { runtime: 'codex', label: who ? `Codex · ${who}` : 'Codex · ChatGPT', tone: 'ok', ...(s.detail ? { detail: s.detail } : {}) };
  if (s.auth === 'apikey') return { runtime: 'codex', label: 'Codex · API-ключ', tone: 'ok' };
  return { runtime: 'codex', label: 'Codex · вход не проверен', tone: 'muted' };
}

/** Claude switched off on this machine by its owner (`CC_REMOTE_DISABLE_CLAUDE`).
 *  Not a problem to fix — the machine simply has no Claude to offer, so the
 *  picker, the limits and «Железо» leave it out. */
export function claudeOff(r: RuntimeStatus | undefined): boolean {
  return r?.claude?.error === 'disabled';
}

/** Per-machine Claude usage minus the machines with Claude switched off: a
 *  reading cached from before the switch (here, or on a hub that ignored the
 *  clearing frame while monitoring was paused) must not show up as limits. */
export function withoutClaudeOff<T>(usage: Record<string, T>, runtimesOf: (machineId: string) => RuntimeStatus | undefined): Record<string, T> {
  return Object.fromEntries(Object.entries(usage).filter(([mid]) => !claudeOff(runtimesOf(mid))));
}

export function claudeChip(s: ClaudeRuntimeStatus): RuntimeChip {
  if (s.error === 'disabled') return { runtime: 'claude', label: 'Claude выключен', tone: 'muted' };
  const who = [planLabel(s.plan), s.account].filter(Boolean).join(' · ');
  if (s.error === 'login_cli_missing') return { runtime: 'claude', label: 'Claude · нет входа · нужен claude для входа', tone: 'attn', hint: CLAUDE_INSTALL_HINT, action: 'install' };
  if (!s.present && s.error === 'not_found') return { runtime: 'claude', label: 'Claude не найден', tone: 'attn', hint: CLAUDE_INSTALL_HINT, action: 'install', ...(s.detail ? { detail: s.detail } : {}) };
  if (!s.present) return { runtime: 'claude', label: 'Claude не найден', tone: 'attn', hint: 'Агент без Claude Code — подключите машину заново: Настройки → Машины → «Подключить машину».', ...(s.detail ? { detail: s.detail } : {}) };
  // A dead login is a warning even when ~/.claude.json still names the
  // account — that name survives the CLI blanking the tokens (28.09.2026:
  // four servers «logged in» for months, none able to run a turn).
  // The env token outranks the file, so «Войти» (which rewrites the file)
  // cannot fix a dead long-lived token — that one gets its own chip below.
  if (s.auth !== 'token' && (s.error === 'logged_out' || s.error === 'token_expired' || s.error === 'token_rejected')) {
    const why = s.error === 'token_rejected' ? 'токен отклонён' : s.error === 'token_expired' ? 'токен истёк' : 'вход слетел';
    return { runtime: 'claude', label: `Claude · ${why}`, tone: 'attn', hint: CLAUDE_RELOGIN_HINT, action: 'login', ...(s.account ? { detail: s.account } : {}) };
  }
  if (s.auth === 'token') {
    const until = s.expiresAt ? new Date(s.expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : undefined;
    if (s.error === 'token_expired' || s.error === 'token_rejected') {
      return { runtime: 'claude', label: 'Claude · долгий токен не действует', tone: 'attn', hint: CLAUDE_TOKEN_HINT };
    }
    if (s.error === 'token_expiring') {
      return { runtime: 'claude', label: `Claude · токен до ${until ?? '?'}`, tone: 'attn', hint: CLAUDE_TOKEN_HINT };
    }
    return { runtime: 'claude', label: until ? `Claude · токен до ${until}` : 'Claude · долгий токен', tone: 'ok' };
  }
  if (s.auth === 'oauth') return { runtime: 'claude', label: who ? `Claude · ${who}` : 'Claude · вход есть', tone: 'ok' };
  if (s.auth === 'apikey') return { runtime: 'claude', label: 'Claude · API-ключ', tone: 'ok' };
  if (s.auth === 'none') return { runtime: 'claude', label: 'Claude · нет входа', tone: 'attn', hint: CLAUDE_LOGIN_HINT, action: 'login' };
  return { runtime: 'claude', label: 'Claude · вход не проверен', tone: 'muted' };
}

/** Both chips for a machine, Claude first. `undefined` when the agent has not
 *  said — the caller draws «нет данных» or nothing, never a warning. */
export function runtimeChips(r: RuntimeStatus | undefined): RuntimeChip[] | undefined {
  if (!r || (!r.claude && !r.codex)) return undefined;
  const out: RuntimeChip[] = [];
  if (r.claude && !claudeOff(r)) out.push(claudeChip(r.claude));
  if (r.codex) out.push(codexChip(r.codex));
  return out;
}

/** The quiet, read-only line for a team member's runtime («Машины команды»):
 *  the hub strips account, plan and details but keeps the fixed `error` code,
 *  so a refused token or a timeout does not read as «signed in».
 *  `undefined` = the agent has not said. */
export function teamRuntimeState(
  s: { present: boolean; auth: string; error?: string; provider?: string } | undefined,
): { text: string; tone: 'ok' | 'attn' | 'muted' } {
  if (!s) return { text: 'нет данных', tone: 'muted' };
  if (s.error === 'disabled') return { text: 'выключен', tone: 'muted' };
  if (!s.present) return { text: 'не найден', tone: 'attn' };
  const failing = !!s.error && s.error !== 'token_expiring';
  // A healthy gateway machine has no login of its own (auth 'none'); an error
  // still reads as one.
  if (s.provider === 'gateway') return failing ? { text: 'шлюз: ошибка', tone: 'attn' } : { text: 'шлюз', tone: 'ok' };
  if (s.auth === 'none' || s.auth === 'unknown' || failing) {
    return { text: 'нет входа', tone: 'attn' };
  }
  return { text: 'вход выполнен', tone: 'ok' };
}

/** Is this machine's Codex on a gateway? Unknown reads as «no». */
export function codexOnGateway(r: RuntimeStatus | undefined): boolean {
  return r?.codex?.provider === 'gateway';
}

/**
 * Can a session of this runtime START on the machine, as far as it has said?
 *
 * Not the chip's tone: a long-lived token with a month left is an `attn` chip
 * and runs fine. This is the narrower question — is there a binary and a login
 * that has not been refused — and it is the one both callers need: the start
 * screen, to pick a default nobody has to correct, and the light shell, which
 * shows no picker at all and so has to be right.
 *
 * Unknown reads as usable: an agent too old to report is most of the fleet
 * after any agent change, and second-guessing it would hide a working runtime.
 */
export function runtimeUsable(r: RuntimeStatus | undefined, which: 'claude' | 'codex'): boolean {
  if (which === 'claude') {
    const s = r?.claude;
    if (!s) return true;
    if (!s.present || s.auth === 'none') return false;
    return !['disabled', 'sdk_binary_missing', 'logged_out', 'token_expired', 'token_rejected'].includes(s.error ?? '');
  }
  const s = r?.codex;
  if (!s) return true;
  if (!s.present || s.error === 'not_found') return false;
  // A gateway machine needs no login of its own.
  if (s.provider === 'gateway') return true;
  return s.auth !== 'none' && s.error !== 'not_logged_in';
}

/** The runtime to start on: the preferred one unless it cannot start and the
 *  other can. With neither usable the preference stands — the failure then
 *  names the runtime the person asked for. */
export function pickRuntime(r: RuntimeStatus | undefined, preferred: 'claude' | 'codex'): 'claude' | 'codex' {
  const other = preferred === 'claude' ? 'codex' : 'claude';
  return !runtimeUsable(r, preferred) && runtimeUsable(r, other) ? other : preferred;
}

/** The softer sibling of `runtimeGate`: the runtime is not usable on this
 *  machine (`runtimeUsable`) and a button fixes it, but the evidence is not
 *  strong enough to refuse sending (login_cli_missing, auth «none» alone). The
 *  composer shows a notice with the same button and still lets the person send.
 *  Unknown (an old agent) and «switched off» yield nothing. */
export function runtimeHint(r: RuntimeStatus | undefined, which: 'claude' | 'codex'): 'install' | 'login' | undefined {
  const hard = runtimeGate(r, which);
  if (hard) return hard;
  if (runtimeUsable(r, which)) return undefined;
  const s = which === 'claude' ? r?.claude : r?.codex;
  if (!s) return undefined;
  const chip = which === 'claude' ? claudeChip(s as ClaudeRuntimeStatus) : codexChip(s as CodexRuntimeStatus);
  return chip.action;
}

/**
 * Should a session of this runtime be REFUSED at the composer, because the
 * machine has said there is no coder to run it or no login to run it with —
 * and there is a button (`install` / `login`) that fixes it? Narrower than
 * `!runtimeUsable`: a state with no button (SDK binary missing, switched
 * off) keeps today's behaviour, and unknown (an old agent) never blocks.
 */
export function runtimeGate(r: RuntimeStatus | undefined, which: 'claude' | 'codex'): 'install' | 'login' | undefined {
  const s = which === 'claude' ? r?.claude : r?.codex;
  if (!s) return undefined;
  const e = s.error ?? '';
  // Only a PROVEN problem blocks. `auth: 'none'` alone does not: the agent sees
  // an API key only in its own env, so a machine on a gateway, an apiKeyHelper,
  // settings.json env or Bedrock/Vertex reads «none» and works. That is just a
  // «нет входа» on the card.
  if (which === 'claude') {
    // login_cli_missing is INFERRED from auth 'none' (gateway env, Bedrock,
    // apiKeyHelper look the same), so it never blocks sending — the card still
    // offers «Установить», and a real refusal renders as a plain notice.
    if (e === 'not_found' || (!s.present && e !== 'sdk_binary_missing' && e !== 'disabled')) return 'install';
    if (['token_expired', 'token_rejected', 'logged_out', 'not_logged_in'].includes(e) && s.auth !== 'token') return 'login';
    return undefined;
  }
  const c = s as CodexRuntimeStatus;
  if (c.provider === 'gateway') return undefined;
  if (!c.present || e === 'not_found') return 'install';
  if (e === 'not_logged_in' || e === 'token_expired' || e === 'token_rejected') return 'login';
  return undefined;
}

/** The exact line a CLI prints when it has no login: Claude's «Not logged in ·
 *  Please run /login» / «Invalid API key · Please run /login», or Codex's
 *  «not logged in … codex/chatgpt». Whole-line matches only — `gh auth status`
 *  output and prose that merely mention logging in must pass untouched. */
export function notLoggedInRuntime(text: string): 'claude' | 'codex' | undefined {
  const t = text.trim();
  if (/^(Not logged in · Please run \/login|Invalid API key · Please run \/login)$/.test(t)) return 'claude';
  if (t.length <= 200 && /^(not logged in|authentication required)\b.*\b(codex|chatgpt)\b/i.test(t)) return 'codex';
  return undefined;
}
