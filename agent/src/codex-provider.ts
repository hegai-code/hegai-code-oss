import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeProvider } from '@cc-remote/shared';
import { gatewayUrl } from './gateway.js';
import { codexHome, codexProviderFromToml } from './runtime-status.js';
import { notifyRuntimeChanged } from './runtime-jobs.js';
import { resetCodexModels } from './codex-run.js';

/**
 * Per-machine Codex provider switch: the same rewrite of `~/.codex/config.toml`
 * the gateway installer (server-rs/assets/codex-gateway.sh) does, plus the way
 * back. Only the top-level keys and the marker block are touched; the rest of
 * the file is the person's.
 */

export const DEFAULT_GATEWAY_MODEL = 'gpt-5.6-sol';
const EFFORT = 'medium';
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
// Same bounds as the hub (16..=200 incl. prefix); no quote, backslash or space, as it lands in a TOML string.
const KEY_RE = /^sk-bf-[^\s"\\]{10,194}$/;
const BLOCK_START = /^\s*#\s*>>>\s*hegai-gateway/;
const BLOCK_END = /^\s*#\s*<<<\s*hegai-gateway/;
const TABLE_HEGAI = /^\s*\[model_providers\.hegai\]\s*$/;
const TOP_KEYS = /^\s*(model|model_provider|model_reasoning_effort)\s*=/;

export interface GatewaySettings {
  baseUrl: string;
  key: string;
  model?: string;
  effort?: string;
}

function tomlQuote(v: string): string {
  return JSON.stringify(v);
}

/** The top-level `model = "..."` value, if any (before the first table). */
function topLevelModel(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) return undefined;
    const m = /^model\s*=\s*"([^"]*)"/.exec(line) ?? /^model\s*=\s*'([^']*)'/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Drop the managed marker block, the `[model_providers.hegai]` table and, when
 * `dropTop`, the top-level model / model_provider / model_reasoning_effort.
 */
function strip(text: string, dropTop: boolean): string {
  const out: string[] = [];
  let inBlock = false;
  let inTable = false;
  let seenTable = false;
  for (const line of text.split(/\r?\n/)) {
    if (BLOCK_START.test(line)) { inBlock = true; continue; }
    if (BLOCK_END.test(line)) { inBlock = false; continue; }
    if (inBlock) continue;
    if (TABLE_HEGAI.test(line)) { inTable = true; continue; }
    if (inTable) {
      if (/^\s*\[/.test(line)) inTable = false;
      else continue;
    }
    if (/^\s*\[/.test(line)) seenTable = true;
    if (dropTop && !seenTable && TOP_KEYS.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

const PREV_MODEL = /^\s*#\s*hegai-gateway:\s*previous model\s*=\s*"((?:[^"\\]|\\.)*)"/;

/** The model the person had before the gateway took over, from the marker block. */
function previousModel(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = PREV_MODEL.exec(line);
    if (m) {
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Pure transform of config.toml text. */
export function applyCodexProvider(text: string, mode: 'gateway' | 'own', gw?: GatewaySettings): string {
  const wasGateway = codexProviderFromToml(text).providerName === 'hegai';
  if (mode === 'own') {
    // Top-level keys go only when the installer wrote them (provider hegai);
    // the model the person had before is put back.
    const prev = wasGateway ? previousModel(text) : undefined;
    const body = strip(text, wasGateway).replace(/^\n+/, '').replace(/\n+$/, '');
    const head = prev ? `model = ${tomlQuote(prev)}` : '';
    const all = [head, body].filter(Boolean).join('\n');
    return all ? `${all}\n` : '';
  }
  if (!gw) throw new Error('gateway settings required');
  // Remember the person's own model (never the gateway's) so «own» can restore it.
  const prev = wasGateway ? previousModel(text) : topLevelModel(text);
  const body = strip(text, true).replace(/^\n+/, '').replace(/\n+$/, '');
  return [
    `model = ${tomlQuote(gw.model ?? DEFAULT_GATEWAY_MODEL)}`,
    'model_provider = "hegai"',
    `model_reasoning_effort = "${gw.effort && EFFORTS.includes(gw.effort) ? gw.effort : EFFORT}"`,
    ...(body ? [body] : []),
    '',
    '# >>> hegai-gateway (managed by installer - do not edit inside) >>>',
    ...(prev ? [`# hegai-gateway: previous model = ${tomlQuote(prev)}`] : []),
    '[model_providers.hegai]',
    'name = "HegAI Gateway"',
    `base_url = ${tomlQuote(gw.baseUrl)}`,
    `experimental_bearer_token = ${tomlQuote(gw.key)}`,
    'wire_api = "responses"',
    '# <<< hegai-gateway <<<',
    '',
  ].join('\n');
}

export type CodexProviderResult = { ok: true; provider: RuntimeProvider } | { ok: false; error: string };

export interface CodexProviderDeps {
  /** True while a Codex run is alive on this machine. */
  codexBusy: () => boolean;
  /** Close idle Codex runs so they restart on the new provider. */
  closeIdleCodexRuns: () => void;
}

let deps: CodexProviderDeps = { codexBusy: () => false, closeIdleCodexRuns: () => {} };
export function setCodexProviderDeps(d: CodexProviderDeps): void {
  deps = d;
}

export async function setCodexProvider(
  mode: 'gateway' | 'own',
  apiKey: string | undefined,
  trustedBase: string = gatewayUrl(),
  defaults: { model?: string; effort?: string } = {},
): Promise<CodexProviderResult> {
  if (mode === 'gateway') {
    if (!trustedBase) return { ok: false, error: 'no_gateway' };
    if (!apiKey || !KEY_RE.test(apiKey)) return { ok: false, error: 'bad_key' };
    if (defaults.model !== undefined && !MODEL_RE.test(defaults.model)) return { ok: false, error: 'bad_model' };
  }
  if (deps.codexBusy()) return { ok: false, error: 'busy' };

  const dir = codexHome();
  const cfg = path.join(dir, 'config.toml');
  let current = '';
  try {
    current = await readFile(cfg, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: 'write_failed' };
  }
  // A provider of the person's own choosing is not ours to remove.
  const now = codexProviderFromToml(current);
  if (now.provider === 'gateway' && now.providerName !== 'hegai') {
    return { ok: false, error: 'custom_provider' };
  }
  const next =
    mode === 'gateway'
      ? applyCodexProvider(current, 'gateway', {
          baseUrl: trustedBase,
          key: apiKey!,
          ...(defaults.model ? { model: defaults.model } : {}),
          ...(defaults.effort ? { effort: defaults.effort } : {}),
        })
      : applyCodexProvider(current, 'own');
  const tmp = `${cfg}.tmp-${randomUUID()}`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (current) await backupWithoutKey(cfg, current);
    await writeFile(tmp, next, { mode: 0o600 });
    await rename(tmp, cfg);
    await chmod(cfg, 0o600).catch(() => {}); // not meaningful on Windows
  } catch (e) {
    await unlink(tmp).catch(() => {});
    console.error('[agent] codex provider switch failed:', (e as Error).message);
    return { ok: false, error: 'write_failed' };
  }
  await pruneBackups(dir).catch(() => {});
  console.log(`[agent] codex provider switched to ${mode === 'gateway' ? 'gateway' : 'own login'}`);
  resetCodexModels();
  deps.closeIdleCodexRuns();
  notifyRuntimeChanged();
  return { ok: true, provider: mode === 'gateway' ? 'gateway' : 'own' };
}

const KEEP_BACKUPS = 3;
/** Our own backups; the installer's and the person's `config.toml.bak-*` are never pruned by count. */
const OURS = 'config.toml.hegai-bak-';

async function listBackups(dir: string): Promise<Array<{ file: string; mtime: number }>> {
  const names = (await readdir(dir)).filter((n) => n.startsWith('config.toml.bak-') || n.startsWith(OURS));
  const out: Array<{ file: string; mtime: number }> = [];
  for (const n of names) {
    const file = path.join(dir, n);
    const st = await stat(file).catch(() => undefined);
    if (st?.isFile()) out.push({ file, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * A backup of the person's config as it is WITHOUT the gateway block: a copy of
 * the live file would keep the key on disk after switching back to «own».
 */
async function backupWithoutKey(cfg: string, current: string): Promise<void> {
  const clean = applyCodexProvider(current, 'own');
  if (!clean) return;
  const dir = path.dirname(cfg);
  const newest = (await listBackups(dir).catch(() => [])).find((b) => path.basename(b.file).startsWith(OURS));
  if (newest && (await readFile(newest.file, 'utf8').catch(() => undefined)) === clean) return;
  const name = path.join(dir, `${OURS}${Date.now()}-${randomUUID().slice(0, 8)}`);
  await writeFile(name, clean, { mode: 0o600, flag: 'wx' });
}

/** Newest few backups stay; any older backup that carries a gateway key goes. */
async function pruneBackups(dir: string): Promise<void> {
  const all = await listBackups(dir);
  let ours = 0;
  for (const b of all) {
    const text = await readFile(b.file, 'utf8').catch(() => '');
    const hasKey = /experimental_bearer_token/.test(text) && /model_providers\.hegai/.test(text);
    const mine = path.basename(b.file).startsWith(OURS);
    if (hasKey || (mine && ours++ >= KEEP_BACKUPS)) await unlink(b.file).catch(() => {});
  }
}
