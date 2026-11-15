import { z } from 'zod';

/** Android browser handoff. The redirect contains only a one-use code. */
export const AndroidSignInStart = z.object({
  android: z.literal('1'),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  client_state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
});
export const AndroidCodeExchange = z.object({
  code: z.string().regex(/^[a-f0-9]{64}$/),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
