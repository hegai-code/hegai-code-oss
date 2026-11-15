/**
 * Why a model call failed, when its text lets us tell.
 *
 * `budget_exhausted` = the LLM gateway (or the provider behind it) refused for
 * quota: an HTTP 429, a rate limit, a spent budget. The web renders that as a
 * calm "your share for today is used up; the session waits for the reset" card
 * instead of a red failure, so the classifier errs towards a plain error — a
 * wrong "budget" card would tell someone to wait for a reset that never comes.
 */
export type ModelErrorCode = 'budget_exhausted';

const BUDGET_PATTERNS: RegExp[] = [
  /\b429\b/,
  /\brate[ _-]?limit/i,
  /too many requests/i,
  /\bquota\b/i,
  /budget[ _-]?(?:exceeded|exhausted)/i,
  /insufficient[ _-]?quota/i,
  /usage limit/i,
  /exceeded your current/i,
];

/** Pure: the text of a failure -> a machine-readable code, or undefined for
 *  everything that is not a quota refusal. */
export function classifyModelError(text: string | undefined): ModelErrorCode | undefined {
  if (!text) return undefined;
  // EDQUOT is the filesystem talking, not the model provider.
  if (/disk quota/i.test(text)) return undefined;
  return BUDGET_PATTERNS.some((re) => re.test(text)) ? 'budget_exhausted' : undefined;
}

/** What a person reads when the gateway refuses for quota. Short on purpose:
 *  the web adds the numbers (used / limit, time to reset) from `/api/budget`. */
export const BUDGET_EXHAUSTED_TEXT =
  'The model gateway refused for quota — your share is used up for now. The session is kept; continue after the reset.';

/**
 * What the API actually said, when a turn fails, in words a person can act on.
 *
 * The CLI ends a failed turn with `errors: ["[ede_diagnostic] result_type=user
 * last_content_type=n/a stop_reason=null"]` — a diagnostic of ITS state, not of
 * the cause. The cause arrived earlier and was thrown away: every retry says it
 * (`api_retry` with `error_status: 401, error: "authentication_failed"`), and so
 * does the assistant message's `error` and the result's `api_error_status`.
 * 24.09.2026 a broken login on stage failed every turn for half an hour and
 * every client showed only the diagnostic — nobody could tell it was a 401.
 *
 * `kind` is the SDK's `SDKAssistantMessageError`. Undefined = nothing better
 * than the CLI's own text is known; the caller keeps that.
 */
export function describeApiFailure(
  kind: string | undefined,
  status: number | null | undefined,
): { code: string; text: string } | undefined {
  if (kind === 'authentication_failed' || status === 401) {
    return {
      code: 'auth_failed',
      text:
        'Claude не принимает вход на этой машине (401 authentication_failed). Войдите заново — «Войти» напротив Claude на экране «Начало» или `claude /login` на машине. ' +
        'Если там задан ANTHROPIC_API_KEY или apiKeyHelper, он перекрывает вход по подписке.',
    };
  }
  if (kind === 'oauth_org_not_allowed' || status === 403) {
    return {
      code: 'auth_failed',
      text: `Учётке Claude на этой машине отказано в доступе (${status ?? 403} ${kind ?? 'forbidden'}) — войдите аккаунтом, которому он разрешён.`,
    };
  }
  if (kind === 'billing_error') {
    return { code: 'billing_error', text: 'Claude отказал по оплате аккаунта (billing_error) — проверьте подписку или баланс.' };
  }
  if (kind === 'model_not_found') {
    return { code: 'turn_failed', text: `Модель не найдена (${status ?? 404} model_not_found) — выберите другую модель для сессии.` };
  }
  if (kind === 'overloaded' || status === 529) {
    return { code: 'turn_failed', text: 'API Claude перегружен (529 overloaded) — ход не выполнен после всех повторов; отправьте сообщение ещё раз чуть позже.' };
  }
  if (kind === 'server_error' || (typeof status === 'number' && status >= 500)) {
    return { code: 'turn_failed', text: `Ошибка на стороне API Claude (${status ?? '5xx'} server_error) — ход не выполнен; отправьте ещё раз.` };
  }
  if (kind === 'invalid_request' || status === 400) {
    return { code: 'turn_failed', text: `API Claude отклонил запрос (${status ?? 400} invalid_request).` };
  }
  // rate_limit / 429 are left to `classifyModelError`, which already turns them
  // into the calm «budget» card rather than a red failure.
  return undefined;
}
