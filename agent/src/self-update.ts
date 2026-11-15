import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, constants, copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExternal } from './edition.js';
import { RELEASE_KEYS } from './release-keys.js';

/**
 * The agent updates ITSELF.
 *
 * Agents dial out only (rule 2), so a machine with no inbound path — buildbox-pc
 * behind its NAT, a Mac nobody can SSH into, a member's laptop — used to keep
 * whatever bundle it was installed with until somebody drove a terminal on it
 * by hand. A fix to the agent reached the boxes with SSH and nobody else.
 *
 * The door that already exists is the one the agent opened: it can reach the
 * hub. The hub serves the bundle it was built with at `/install/agent.mjs` and
 * its hash at `/install/agent.mjs.sha256`, from the same binary — so the two
 * cannot disagree, and an agent that reaches the hub by a path nginx is not on
 * (the Mac mini's ssh tunnel straight to :4318) gets them the same way it gets
 * everything else. Restarting the hub makes every agent reconnect, so "check on
 * every connect" means a deploy reaches the fleet within a minute; the
 * 30-minute poll catches anything a reconnect missed.
 *
 * Nothing here trusts more than the agent already did. The bundle comes from the
 * hub it holds a session with, over the same TLS, and the hub can already open a
 * shell on this machine. What it adds is care about WHEN and HOW:
 *
 * - the download must hash to what the hub advertised (a deploy mid-write, a
 *   proxy that truncated it — both are a refusal, never a half-file);
 * - the new file must pass `--self-test`: load its whole module graph against
 *   THIS machine's node_modules and exit. A bundle that cannot even start is the
 *   one failure a supervisor turns into a crash loop with no way back;
 * - it is swapped in only when no run is mid-turn or waiting on a person —
 *   restarting kills every run the agent holds, and an idle one resumes on the
 *   next message while a busy one loses its turn;
 * - the previous bundle is kept as `agent.mjs.prev`.
 *
 * Then the process exits and the supervisor starts the new file: systemd
 * `Restart=always`, launchd `KeepAlive`, the Windows Scheduled Task's keepalive
 * repetition (up to five minutes there) or the Hegai Code app's supervisor.
 *
 * The external edition (a customer's own hub) adds one more gate
 * (docs/EXTERNAL-EDITION.md): the hub vouches for nothing. Next to the bundle
 * it serves a release manifest and our Ed25519 signature over it; the agent
 * installs the download only if the manifest's sha256 equals the download's
 * and a key compiled into THIS bundle (`release-keys.ts`) verifies the
 * signature — and it checks that BEFORE the file touches disk or runs, because
 * a `--self-test` is running the bundle. The internal edition does none of this.
 *
 * Only a deployed bundle updates itself — a source run (`tsx src/main.ts`) is
 * somebody's dev tree and must stay what they built. `CC_REMOTE_AUTO_UPDATE=0`
 * turns it off for a machine that has to stay pinned.
 */

/** How often to look even without a reconnect. */
const POLL_MS = 30 * 60_000;
/** While an update waits for the runs to settle, how often to look again. */
const QUIET_RETRY_MS = 20_000;
/** The whole fleet reconnects in the same second after a hub restart — spread
 *  the downloads out a little. */
const CONNECT_JITTER_MS = 30_000;
const SELF_TEST_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;

/** What the agent must answer for the updater. */
export interface UpdateHost {
  /** True when a restart right now would interrupt nothing a person is waiting on. */
  isQuiet(): boolean;
  /** Close runs politely and exit so the supervisor starts the new bundle. */
  restartForUpdate(): void;
}

/** The file this process was started from. */
export function runningBundle(): string {
  return fileURLToPath(import.meta.url);
}

/** Only a deployed `agent.mjs` updates itself, and only when not pinned. */
export function selfUpdateEnabled(bundle: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['CC_REMOTE_AUTO_UPDATE'] === '0') return false;
  return path.basename(bundle) === 'agent.mjs';
}

/** `wss://code.acme.test` → `https://code.acme.test/install` — the hub the agent
 *  is already talking to, by the same route. An explicit `CC_REMOTE_UPDATE_URL`
 *  wins. (The first self-updating bundles used nginx's `/dl/`, which the Mac
 *  mini's tunnel cannot see; `deploy-hub.sh` still publishes there for them.) */
/** A private machine keeps its content key on disk, so only an updater that
 *  verifies a release signature the hub cannot forge (the external edition) may
 *  replace its agent. The internal edition trusts what the hub serves. */
export function selfUpdateAllowedFor(isPrivate: boolean, external: boolean): boolean {
  return !isPrivate || external;
}

/** Dotted-number comparison (1.2.10 > 1.2.9); a non-numeric part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function updateBase(centralUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['CC_REMOTE_UPDATE_URL'];
  if (explicit) return explicit.replace(/\/+$/, '');
  const http = centralUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
  return `${http}/install`;
}

/** The first 64-hex token of a `sha256sum`-style line, lowercased. */
export function parseSha(text: string): string | undefined {
  const m = /\b([0-9a-fA-F]{64})\b/.exec(text);
  return m ? m[1]!.toLowerCase() : undefined;
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** What an external-edition updater trusts. Tests pass their own; production
 *  is the edition and key list compiled into the running bundle. */
export interface ReleasePolicy {
  /** False = the internal edition: no manifest, no signature. */
  external: boolean;
  /** Base64 SPKI DER Ed25519 public keys. */
  keys: readonly string[];
}

export const BUILT_IN_POLICY: ReleasePolicy = { external: isExternal(), keys: RELEASE_KEYS };

/** The release manifest, exactly as signed — LF endings, trailing LF. It
 *  attests the edition: the signer only signs the external build, and an
 *  external agent installs only a manifest that says `edition=external`. */
export function manifestText(version: string, sha: string, edition = 'external'): string {
  return `hegai-code-agent-release/1\nedition=${edition}\nversion=${version}\nsha256=${sha}\n`;
}

/** `{edition, version, sha256}` of a manifest, or undefined unless it is
 *  byte-for-byte the canonical form (a looser parse would let two texts mean
 *  one signature). */
export function parseManifest(text: string): { edition: string; version: string; sha256: string } | undefined {
  const m = /^hegai-code-agent-release\/1\nedition=([a-z]+)\nversion=([^\n\r]+)\nsha256=([0-9a-f]{64})\n$/.exec(text);
  return m ? { edition: m[1]!, version: m[2]!, sha256: m[3]! } : undefined;
}

/** The Ed25519 signature (base64 of 64 bytes) in a `.sig` file. */
export function parseSig(text: string): Buffer | undefined {
  const m = /^\s*([A-Za-z0-9+/]{86}==)\s*$/.exec(text);
  return m ? Buffer.from(m[1]!, 'base64') : undefined;
}

/** True when one of `keys` signed exactly these bytes. A key that does not
 *  parse is skipped, never trusted. */
export function signedByTrustedKey(body: Buffer, sig: Buffer, keys: readonly string[]): boolean {
  return keys.some((k) => {
    try {
      return verify(null, body, createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), sig);
    } catch {
      return false;
    }
  });
}

/** Load a candidate bundle in a child and make sure it can start at all. With
 *  `edition` the candidate must also report that it is that product's build
 *  (`HEGAI_AGENT_EDITION=…`, edition.ts): a validly signed INTERNAL bundle,
 *  which trusts no release key and so verifies nothing, must never replace an
 *  external one. */
function selfTest(file: string, edition?: 'external'): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [file, '--self-test'],
      { timeout: SELF_TEST_TIMEOUT_MS, cwd: path.dirname(file), windowsHide: true },
      (err, stdout, stderr) => {
        if (!err && /self-test ok/.test(stdout)) {
          if (!edition || stdout.split(/\s+/).includes(`HEGAI_AGENT_EDITION=${edition}`)) return resolve();
          return reject(new Error(`the candidate does not report an ${edition} build`));
        }
        reject(new Error(`${err?.message ?? 'no ok line'} ${String(stderr).slice(0, 400)}`.trim()));
      },
    );
  });
}

export class SelfUpdater {
  private runningSha?: string;
  private staged?: { file: string; sha: string };
  /** Hashes that failed verification or the self-test — not retried. */
  private readonly refused = new Set<string>();
  private checking = false;
  private pollTimer?: NodeJS.Timeout;
  private connectTimer?: NodeJS.Timeout;
  private quietTimer?: NodeJS.Timeout;
  private applying = false;
  private lastError = '';
  /** A connect that landed before `start()` finished hashing — honoured once it
   *  has. On a fast link the register ack beats the hash, and dropping it would
   *  push the first check out to the half-hour poll. */
  private connectedEarly = false;

  constructor(
    /** Where `/agent.mjs` and its hash are fetched from. A function, because
     *  the door that opens may not be the configured one (hub-url.ts), and a
     *  machine that can only reach `:8443` must update through it. */
    private readonly baseUrl: string | (() => string),
    private readonly host: UpdateHost,
    private readonly bundle: string = runningBundle(),
    private readonly policy: ReleasePolicy = BUILT_IN_POLICY,
    /** A machine that holds a content key does not take an older release, even a
     *  signed one: a replayed old bundle is how a fixed hole is brought back. */
    private readonly rollback?: { running: string; keyed: () => boolean },
  ) {}

  private get base(): string {
    return typeof this.baseUrl === 'function' ? this.baseUrl() : this.baseUrl;
  }

  /** Hash the file we were started from, before anybody can replace it. */
  async start(): Promise<void> {
    // A managed install — the sandboxes run a root-owned shared release under
    // `ProtectSystem=strict` — cannot replace its own bundle; its host does
    // (`sb-agent-autoupdate.sh`). Say so once and stay out of the way, rather
    // than downloading a bundle every half hour only to be refused the write.
    try {
      await access(path.dirname(this.bundle), constants.W_OK);
    } catch {
      console.log(`[agent] self-update off: ${path.dirname(this.bundle)} is not writable — this install is updated by its host`);
      return;
    }
    if (this.policy.external && this.policy.keys.length === 0) {
      console.log('[agent] self-update off: this external build has no release key compiled in — it is updated by re-running the installer');
      return;
    }
    try {
      this.runningSha = sha256(await readFile(this.bundle));
    } catch (err) {
      console.warn(`[agent] self-update off: cannot read ${this.bundle}: ${(err as Error).message}`);
      return;
    }
    console.log(`[agent] self-update on: ${this.base}/agent.mjs (running ${this.runningSha.slice(0, 12)})`);
    this.pollTimer = setInterval(() => void this.check(), POLL_MS);
    this.pollTimer.unref?.();
    if (this.connectedEarly) this.onConnected();
  }

  /** Called on every successful register — a hub deploy always lands here. */
  onConnected(): void {
    if (!this.runningSha) {
      this.connectedEarly = true;
      return;
    }
    if (this.connectTimer) return;
    const delay = 3_000 + Math.floor(Math.random() * CONNECT_JITTER_MS);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      void this.check();
    }, delay);
    this.connectTimer.unref?.();
  }

  stop(): void {
    for (const t of [this.pollTimer, this.connectTimer, this.quietTimer]) if (t) clearTimeout(t);
  }

  async check(): Promise<void> {
    if (!this.runningSha || this.checking || this.applying) return;
    this.checking = true;
    try {
      const advertised = await this.fetchText(`${this.base}/agent.mjs.sha256`).then(parseSha);
      if (!advertised) throw new Error('no sha256 published');
      if (advertised === this.runningSha || this.refused.has(advertised)) return;
      if (this.staged?.sha !== advertised) await this.stage(advertised);
      this.tryApply();
    } catch (err) {
      // Once per distinct reason: a hub without /dl (a dev hub) would otherwise
      // log this every half hour forever.
      const msg = (err as Error).message;
      if (msg !== this.lastError) console.warn(`[agent] self-update check failed: ${msg}`);
      this.lastError = msg;
    } finally {
      this.checking = false;
    }
  }

  private async stage(sha: string): Promise<void> {
    const res = await fetch(`${this.base}/agent.mjs`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GET agent.mjs → ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const got = sha256(body);
    // A deploy writes the bundle and then its hash; landing between the two is
    // a mismatch that the next check resolves. Not refused for good.
    if (got !== sha) throw new Error(`downloaded ${got.slice(0, 12)}, advertised ${sha.slice(0, 12)}`);
    if (this.policy.external) await this.verifyRelease(sha);
    // `.mjs`, not `agent.mjs.update`: node refuses an unknown extension inside
    // a `"type": "module"` directory, which would fail every self-test.
    const file = path.join(path.dirname(this.bundle), 'agent.update.mjs');
    await writeFile(file, body);
    try {
      await selfTest(file, this.policy.external ? 'external' : undefined);
    } catch (err) {
      this.refused.add(sha);
      await unlink(file).catch(() => {});
      throw new Error(`bundle ${sha.slice(0, 12)} failed its self-test, not installing: ${(err as Error).message}`);
    }
    this.staged = { file, sha };
    console.log(`[agent] self-update: staged ${sha.slice(0, 12)} — waiting for the runs to settle`);
  }

  /**
   * External edition: the manifest says THIS file and a trusted key signed the
   * manifest. Files the hub has not published yet are a retry (mid-deploy, a
   * hub that does not know the scheme) or unreadable are a retry; a manifest
   * that is well-formed and wrong for the edition is a verdict on this hash —
   * never fetched again by this process. A hash or signature mismatch is a
   * verdict only if the hub STILL advertises this hash: a release landing
   * between the bundle fetch and the sidecar fetches mixes two releases, and
   * the next check sorts it out.
   */
  private async verifyRelease(sha: string): Promise<void> {
    const manifest = await this.fetchBuffer(`${this.base}/agent.mjs.release`);
    const sigText = await this.fetchBuffer(`${this.base}/agent.mjs.sig`);
    const refuse = (why: string): never => {
      this.refused.add(sha);
      throw new Error(`bundle ${sha.slice(0, 12)} ${why}, not installing`);
    };
    /** The sidecars disagree with the bundle: refuse only if the hub did not move meanwhile. */
    const mismatch = async (why: string): Promise<never> => {
      let now: string | undefined;
      try {
        now = parseSha(await this.fetchText(`${this.base}/agent.mjs.sha256`));
      } catch {
        // cannot tell whether the hub moved: not a verdict
      }
      if (now !== sha) {
        throw new Error(`bundle ${sha.slice(0, 12)} ${why}, but the hub now advertises ${now ? now.slice(0, 12) : 'nothing readable'}; retrying`);
      }
      return refuse(why);
    };
    const parsed = parseManifest(manifest.toString('utf8'));
    // Unreadable is not a verdict: a hub that predates the scheme may answer
    // 200 with its web page. Asked again at the next check.
    if (!parsed) throw new Error(`bundle ${sha.slice(0, 12)} has no readable release manifest, not installing`);
    if (parsed.edition !== 'external') return refuse(`has a release manifest for the ${parsed.edition} edition`);
    if (parsed.sha256 !== sha) return mismatch(`has a release manifest for ${parsed.sha256.slice(0, 12)}`);
    const sig = parseSig(sigText.toString('utf8'));
    if (!sig) throw new Error(`bundle ${sha.slice(0, 12)} has no readable signature, not installing`);
    if (!signedByTrustedKey(manifest, sig, this.policy.keys)) return mismatch('is not signed by a trusted release key');
    if (this.rollback?.keyed() && compareVersions(parsed.version, this.rollback.running) < 0) {
      return refuse(`is release ${parsed.version}, older than the running ${this.rollback.running}, and this machine holds a content key`);
    }
    console.log(`[agent] self-update: release ${parsed.version} (${sha.slice(0, 12)}) signature ok`);
  }

  private tryApply(): void {
    if (!this.staged || this.applying) return;
    if (!this.host.isQuiet()) {
      if (!this.quietTimer) {
        this.quietTimer = setTimeout(() => {
          this.quietTimer = undefined;
          this.tryApply();
        }, QUIET_RETRY_MS);
        this.quietTimer.unref?.();
      }
      return;
    }
    void this.apply(this.staged);
  }

  private async apply(staged: { file: string; sha: string }): Promise<void> {
    this.applying = true;
    try {
      await copyFile(this.bundle, `${this.bundle}.prev`);
      // Same directory, so this is an atomic replace on every platform node
      // runs on — a crash here leaves the old file or the new one, never half.
      await rename(staged.file, this.bundle);
    } catch (err) {
      this.applying = false;
      this.staged = undefined;
      console.error(`[agent] self-update: could not install ${staged.sha.slice(0, 12)}: ${(err as Error).message}`);
      return;
    }
    console.log(`[agent] self-update: installed ${staged.sha.slice(0, 12)} (was ${this.runningSha?.slice(0, 12)}) — restarting`);
    this.stop();
    this.host.restartForUpdate();
  }

  private async fetchBuffer(url: string): Promise<Buffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async fetchText(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.text();
  }
}
