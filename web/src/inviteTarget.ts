/** What the team «Пригласить» field holds: an e-mail, or a Telegram @username. */
export type InviteTarget = { email: string } | { telegram: string };

const TG_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
const EMAIL = /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@.]+$/;

/** Only input that starts with «@» is a Telegram username; everything else is
 *  an e-mail. `null` when it is neither (the form says so before sending). */
export function parseInviteTarget(raw: string): InviteTarget | null {
  const value = raw.trim();
  if (value.startsWith('@')) {
    const name = value.slice(1);
    return TG_USERNAME.test(name) ? { telegram: name.toLowerCase() } : null;
  }
  return value.length <= 254 && EMAIL.test(value) ? { email: value } : null;
}
