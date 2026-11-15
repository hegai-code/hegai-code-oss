/**
 * Masks secret-shaped values in text that is about to leave the machine.
 *
 * First user: process command lines (`machine_stats` every tick, `proc.list`).
 * `ps args=` shows what a person typed — `psql postgres://app:hunter2@db`,
 * `curl -H "Authorization: Bearer …"`, `deploy --token=…` — and that went to
 * the hub verbatim and sat on the «Железо» page for anyone who can see the
 * machine.
 *
 * It is a net, not a proof: it catches the shapes secrets usually have and
 * keeps the rest readable, because the command line is what makes the list
 * useful. Anything it catches becomes `‹masked›`.
 */

const MASK = '‹masked›';

/** Well-known token formats, recognisable on their own. */
const KNOWN_TOKENS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bsk-(?:proj-|bf-|svcacct-)[A-Za-z0-9_-]{20,}/g, // OpenAI project / HegAI gateway
  /\bsk-(?=[A-Za-z_-]{0,60}\d)[A-Za-z0-9_-]{32,}/g, // legacy OpenAI: long and has digits, not `sk-learn-…`
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, // Telegram bot token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];

/** A name that says "the value next to me is a secret". */
// Bounded on both sides on purpose: two unbounded classes around an
// alternation backtrack cubically, and `'token-'.repeat(3000)` in any process's
// argv froze the agent's event loop until the watchdog killed it, every tick.
// The secret word must END the name (`GITHUB_TOKEN`, `DB_PASSWORD`,
// `--auth-token`): in the middle it names a setting, not a secret
// (`PasswordAuthentication=no`, `TOKEN_FILE=`). `auth` alone is not a secret
// word (`--author=`) and neither is `session` (`--session-id` is what makes
// the row useful).
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]{0,40}(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|[_-]key|auth(?:orization|[_-]?token)|credential|cookie)s?\d{0,3}`;

/** The whole value is a reference to a secret, not a secret. */
const REFERENCE =
  /^(?:%[-+ 0#]?\d*[sdvqx]|\{\d*\}|\$\(.*|\$\{?[A-Za-z_][\w.]*\}?|\$\{\{.*\}\}|%[A-Za-z_]\w*%|<[^<>\s]+>|\{\{[^}]+\}\}|(?:process\.env|os\.environ|os\.getenv|getenv|env)\b.*)$/;

const PLACEHOLDER =
  /^(?:none|null|nil|undefined|true|false|required|optional|string|number|example|changeme|placeholder|redacted|masked|bearer|basic|digest|token|x+|\*+|\.+|‹masked›)$/i;

/**
 * Does the value next to a secret NAME look like a secret, or like a
 * reference / placeholder / word? In code and prose the name is everywhere
 * (`token=$TOKEN`, `password=None`, `--password is required`) and masking
 * those only makes the transcript unreadable.
 *
 * `strict` is for command lines (`machine_stats`): there a value after
 * `--password` is the password, whatever it looks like.
 */
function looksSecret(raw: string, strict: boolean): boolean {
  // Quotes and the punctuation code puts after an expression are not the value.
  const v = raw.replace(/^["'`]+|["'`;,)\]}]+$/g, '');
  if (!v || PLACEHOLDER.test(v) || REFERENCE.test(v)) return false;
  if (strict) return true;
  if (v.length < 6) return false;
  // Real secrets are dense. Nearly every generated one has a digit; the rest
  // are long runs of token characters. Anything with a dot or a space and no
  // digit is code (`meeting.reschedule_token`) or prose.
  if (/\d/.test(v)) return true;
  return v.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v);
}

type Replacer = (substring: string, ...args: string[]) => string;
type Rule = [RegExp, string | Replacer];

function rules(strict: boolean): Rule[] {
  const maskValue: Replacer = (_m, head, value) => (looksSecret(value!, strict) ? `${head}${MASK}` : `${head}${value}`);
  // After `Authorization: Bearer` or `Cookie:` the value IS the credential,
  // whatever it looks like — only a reference or a placeholder is spared.
  const maskHeader: Replacer = (_m, head, value) => (looksSecret(value!, true) ? `${head}${MASK}` : `${head}${value}`);
  return [
    // user:password@ inside a URL. Every part bounded and the scheme anchored
    // to a word start: unbounded, this was quadratic on a long run of `a.a.a.`
    // (200 KB of tool output froze the agent for 27 s).
    [/((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{1,256}:)[^\s@/]{1,1024}@/gi, `$1${MASK}@`],
    // Authorization / Cookie headers: keep the scheme word, drop the credential
    [/(\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)\s+)([^\s"']{1,4096})/gi, maskHeader],
    [/(\bcookie\s*[:=]\s*)([^"'\n]{1,4096})/gi, maskHeader],
    // A flag starts a word: `dev-token value` is prose, not `-token value`.
    [new RegExp(String.raw`((?<=^|[\s"'=])--?${SECRET_NAME}(?:=|\s+))(?!-)("[^"\n]{0,4096}"|'[^'\n]{0,4096}'|\S{1,4096})`, 'gim'), maskValue],
    // NAME=value (env assignments, key=value configs)
    [new RegExp(String.raw`(\b${SECRET_NAME}\s?=\s?)("[^"\n]{0,4096}"|'[^'\n]{0,4096}'|\S{1,4096})`, 'gi'), maskValue],
    // "token": "value" in JSON, token: value in YAML
    [new RegExp(String.raw`("${SECRET_NAME}"\s*:\s*)("[^"\n]{0,4096}")`, 'gi'), maskValue],
    [new RegExp(String.raw`(^[ \t-]*${SECRET_NAME}:[ \t]+)(["']?[^\s"'#]{1,4096}["']?)`, 'gim'), maskValue],
  ];
}

const PROSE_RULES = rules(false);
const ARGV_RULES = rules(true);

/**
 * A PEM private key, whole block — found with indexOf, not a regex: a lazy
 * `[\s\S]{1,16384}?` restarted at every BEGIN was 2.7 s on a megabyte of them.
 */
function maskPem(text: string): string {
  const BEGIN = /-----BEGIN ([A-Z ]{0,40})PRIVATE KEY-----/g;
  let out = '';
  let from = 0;
  // Where the next END of each kind is, so a thousand BEGINs without an END
  // cost one scan, not a thousand.
  const nextEnd = new Map<string, number>();
  for (let m = BEGIN.exec(text); m; m = BEGIN.exec(text)) {
    const endMarker = `-----END ${m[1]}PRIVATE KEY-----`;
    const bodyStart = m.index + m[0].length;
    let end = nextEnd.get(endMarker);
    if (end === undefined || (end >= 0 && end < bodyStart)) {
      end = text.indexOf(endMarker, bodyStart);
      nextEnd.set(endMarker, end);
    }
    if (end < 0) continue;
    if (end - bodyStart > 16384) continue;
    out += text.slice(from, bodyStart) + MASK;
    from = end;
    BEGIN.lastIndex = end + endMarker.length;
  }
  return from === 0 ? text : out + text.slice(from);
}

export function maskSecrets(text: string, opts: { strict?: boolean } = {}): string {
  let out = text.includes('PRIVATE KEY-----') ? maskPem(text) : text;
  for (const [re, replacement] of opts.strict ? ARGV_RULES : PROSE_RULES) out = out.replace(re, replacement as never);
  for (const re of KNOWN_TOKENS) out = out.replace(re, MASK);
  return out;
}
