/**
 * Where the full client lives.
 *
 * The light shell and the full one are two faces of ONE hub — the same account,
 * the same machines, the same sessions — and they share `router.ts`, so every
 * address means the same thing on both hosts. That makes «открыть в полной
 * версии» a change of origin and nothing else: no id to translate, no state to
 * hand over. It is the shell's escape hatch, and it is why the shell can afford
 * to leave things out.
 *
 * Build-time (`VITE_FULL_ORIGIN`) when the deployment says so. Unset, the
 * answer comes from where the page is: HegAI's own light-shell name
 * (`*.acme.test`) points at production's `code.acme.test`, and any other host —
 * a customer's self-hosted hub, a dev server — is its own full client.
 */
import { resolveFullOrigin } from './full-origin.js';

const ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

export const FULL_ORIGIN = resolveFullOrigin(ENV?.['VITE_FULL_ORIGIN'], location);

/** The same address on the full client. Defaults to the one on screen. */
export function fullHref(path: string = location.pathname + location.search): string {
  return FULL_ORIGIN + path;
}
