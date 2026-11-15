import { z } from 'zod';

/**
 * The cloud browser's HTTP contract (`/api/browser*`, server-rs `browser.rs`,
 * which forwards `deploy/browser` browserd / runner.py answers verbatim).
 * Optional fields are absent, never `null`.
 */

/** `GET /api/browser`. `down` is present only when browserd is unreachable. */
export const BrowserInfo = z.object({
  enabled: z.boolean(),
  egress: z.boolean(),
  down: z.boolean().optional(),
});
export type BrowserInfo = z.infer<typeof BrowserInfo>;

export const BrowserProfile = z.object({
  /** 16 lowercase hex. */
  id: z.string().regex(/^[0-9a-f]{16}$/),
  name: z.string(),
  /** Unix SECONDS (browserd stores `int(time.time())`). */
  created_at: z.number(),
  last_used_at: z.number(),
  running: z.boolean(),
});
export type BrowserProfile = z.infer<typeof BrowserProfile>;

export const BrowserProfileList = z.object({ profiles: z.array(BrowserProfile) });
export type BrowserProfileList = z.infer<typeof BrowserProfileList>;

export const BrowserTab = z.object({
  index: z.number(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;

/** The `result` of the `status` command. */
export const BrowserStatus = z.object({
  url: z.string(),
  title: z.string(),
  tabs: z.array(BrowserTab),
  egress_ok: z.boolean(),
});
export type BrowserStatus = z.infer<typeof BrowserStatus>;

/** `POST /api/browser/profiles/{id}/cmd`: HTTP 200 `{ok:true}`, or `{ok:false}` with an error status. */
export const BrowserCommandResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type BrowserCommandResponse = z.infer<typeof BrowserCommandResponse>;

/** The hub's `api_error` body. */
export const BrowserErrorBody = z.object({ error: z.string() });
export type BrowserErrorBody = z.infer<typeof BrowserErrorBody>;
