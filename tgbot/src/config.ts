/**
 * Environment contract, resolved once at boot so a missing variable is a loud
 * failure on start rather than a silent no-op three taps into a chat.
 *
 * The bot speaks to the hub as ONE person (the whitelist model): every allowed
 * Telegram account drives the same hub identity, exactly as if they shared a
 * browser. That is why there is no per-user binding here — see README.md for
 * what changes the day the bot is opened to the community.
 */
import os from 'node:os';
import path from 'node:path';

export interface SsoIdentity {
  /** HS256 key shared with admin.acme.test. Present only on the hub box. */
  secret: string;
  /** The hub user id to act as — the SSO `userId`, not an email. */
  userId: string;
  email: string;
}

export interface Config {
  botToken: string;
  /** Telegram user ids allowed to talk to the bot. Never empty. */
  allow: Set<number>;
  /** Hub base, http(s). Loopback on the hub box, https from a dev machine. */
  http: string;
  /** Same base as a ws(s) URL — derived, never configured separately. */
  ws: string;
  statePath: string;
  /** A pre-issued workspace session (`__Host-cc-remote-auth` cookie value). Wins over `sso`. */
  session: string | undefined;
  /** Mint a session locally instead. Requires the hub's own SSO secret. */
  sso: SsoIdentity | undefined;
  /** `CC_REMOTE_TG_LOGIN_SECRET`: the bot's own credential for «Войти через
   *  Telegram» (login.ts). Unset => the login branch is off and strangers get
   *  the old «private bot» answer. Never the owner's session or SSO secret. */
  loginSecret?: string;
}

function env(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : undefined;
}

/** Parse `123,456` into ids. Non-numeric entries are a config error, not a skip:
 *  a typo'd id would silently lock its owner out of a bot that looks healthy. */
function parseAllow(raw: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const id = Number(trimmed);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`CC_REMOTE_TG_ALLOW: "${trimmed}" is not a Telegram user id`);
    }
    out.add(id);
  }
  return out;
}

export function loadConfig(): Config {
  const botToken = env('TELEGRAM_BOT_TOKEN');
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is required');

  const allowRaw = env('CC_REMOTE_TG_ALLOW');
  if (!allowRaw) {
    throw new Error(
      'CC_REMOTE_TG_ALLOW is required (comma-separated Telegram user ids). ' +
        'Refusing to start without a whitelist: this bot drives real machines.',
    );
  }
  const allow = parseAllow(allowRaw);
  if (!allow.size) throw new Error('CC_REMOTE_TG_ALLOW is empty');

  const http = (env('CC_REMOTE_HUB_HTTP') ?? 'http://127.0.0.1:4318').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(http)) throw new Error(`CC_REMOTE_HUB_HTTP must be http(s): ${http}`);

  const session = env('CC_REMOTE_TG_SESSION');
  const secret = env('CC_REMOTE_SSO_SECRET');
  const userId = env('CC_REMOTE_TG_HUB_USER_ID');
  const email = env('CC_REMOTE_TG_HUB_EMAIL');
  const sso: SsoIdentity | undefined =
    secret && userId && email ? { secret, userId, email } : undefined;

  if (!session && !sso) {
    throw new Error(
      'No hub credential. Set CC_REMOTE_TG_SESSION=<session cookie value>, or ' +
        'CC_REMOTE_SSO_SECRET + CC_REMOTE_TG_HUB_USER_ID + CC_REMOTE_TG_HUB_EMAIL ' +
        'to mint one against the hub (hub box only).',
    );
  }
  if (sso && sso.secret.length < 32) {
    throw new Error('CC_REMOTE_SSO_SECRET must be at least 32 chars (the hub rejects shorter)');
  }

  return {
    botToken,
    allow,
    http,
    ws: http.replace(/^http/, 'ws'),
    statePath: env('CC_REMOTE_TG_STATE') ?? path.join(os.homedir(), '.cc-remote-tgbot.json'),
    session,
    sso,
    loginSecret: env('CC_REMOTE_TG_LOGIN_SECRET'),
  };
}
