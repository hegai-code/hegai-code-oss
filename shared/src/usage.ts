import { z } from 'zod';

/**
 * «Расходы» — per-person AI usage and limits (`GET /api/workspaces/{id}/usage`
 * and `GET /api/me/usage`, server-rs `llm_usage.rs` + `llm_api.rs`).
 *
 * Two independent sources, never pooled:
 *  - the LLM gateway (Bifrost): tokens and requests per day and model from the
 *    seat's logs, plus the seat's own budget / rate-limit window;
 *  - the person's OWN Claude / Codex subscription, as their agents report it.
 *
 * Optional fields are absent, never `null`. No prompt text is ever part of it.
 */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const UsageModelRow = z.object({
  model: z.string(),
  requests: z.number(),
  tokens: z.number(),
});
export type UsageModelRow = z.infer<typeof UsageModelRow>;

export const UsageDayRow = z.object({ day: Day, tokens: z.number(), requests: z.number() });
export type UsageDayRow = z.infer<typeof UsageDayRow>;

export const UsageGateway = z.object({
  requests: z.number(),
  errors: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  cachedTokens: z.number(),
  totalTokens: z.number(),
  /** Top models by tokens (at most 5). */
  models: z.array(UsageModelRow),
  /** Only days that have traffic, ascending. */
  days: z.array(UsageDayRow),
});
export type UsageGateway = z.infer<typeof UsageGateway>;

/** The seat's current governance window. */
export const UsageSeatLimit = z.object({
  active: z.boolean(),
  tokens: z.number().optional(),
  tokensUsed: z.number().optional(),
  tokensWindow: z.string().optional(),
  requests: z.number().optional(),
  requestsUsed: z.number().optional(),
  requestsWindow: z.string().optional(),
  /** Token window reset (ms). */
  resetAt: z.number().optional(),
  /** Request window reset (ms): the two windows reset independently. */
  requestsResetAt: z.number().optional(),
  /** Highest used share of the token / request limit, 0-100+. */
  percent: z.number().optional(),
});
export type UsageSeatLimit = z.infer<typeof UsageSeatLimit>;

export const UsageSubWindow = z.object({
  key: z.string(),
  label: z.string(),
  /** USED percent at the latest sample. */
  percent: z.number(),
  resetsAt: z.number().optional(),
  /** Epoch ms of the latest sample. */
  sampledAt: z.number(),
  /** Days of the period on which this window reached the "limit hit" mark. */
  hitDays: z.number(),
  /** Highest sample within the period. */
  peakPercent: z.number(),
});
export type UsageSubWindow = z.infer<typeof UsageSubWindow>;

export const UsageSubscription = z.object({
  provider: z.enum(['claude', 'codex']),
  account: z.string().optional(),
  windows: z.array(UsageSubWindow),
});
export type UsageSubscription = z.infer<typeof UsageSubscription>;

export const UsageMember = z.object({
  userId: z.string(),
  email: z.string().optional(),
  fullName: z.string().optional(),
  role: z.string().optional(),
  gateway: UsageGateway,
  limit: UsageSeatLimit.optional(),
  subscriptions: z.array(UsageSubscription),
  /** A subscription window reached the limit mark on several days of the period. */
  hitsLimit: z.boolean(),
});
export type UsageMember = z.infer<typeof UsageMember>;

export const UsageReport = z.object({
  from: Day,
  to: Day,
  /** The hub has a gateway to read usage from. */
  configured: z.boolean(),
  /** Epoch ms of the newest gateway log folded in; absent before the first collection. */
  collectedAt: z.number().optional(),
  /** Governance (seat limits) could not be read this time. */
  limitsUnavailable: z.boolean().optional(),
  /** What the caller may see: everyone, assigned people, or only themselves. */
  scope: z.enum(['all', 'assigned', 'self']),
  members: z.array(UsageMember),
});
export type UsageReport = z.infer<typeof UsageReport>;
