/**
 * OpenCode Go: a flat-rate model subscription reached through the Codex runtime.
 *
 * It is not a third runtime. A Go session is an ordinary Codex thread whose
 * app-server was started on the `hegai_go` provider, and nothing changes on the
 * wire: the picker offers `pool-go/<id>` rows and the model field carries them.
 *
 * The subscription key lives in the gateway on the hub box, because a session runs
 * as the same OS user as anything on its machine and could read a key kept there.
 * The machine holds only a gateway virtual key limited to the `pool-go` provider,
 * in `~/.hegai-opencode-go-vk`. Revoking it costs nothing upstream. Codex reads it
 * through a command when it needs a token, which keeps it out of the environment
 * commands inherit and out of `ps`. `~/.codex/config.toml` stays untouched: the
 * provider exists only in the overrides of a Go app-server.
 *
 * The provider has to be set when the app-server STARTS. `turn/start` compares a
 * thread's provider against the process's configured one and answers
 * `modelProviderMismatch`, so one thread cannot change provider later.
 *
 * Who can spend the plan is decided by the OS account, like every other credential
 * on a machine: any session under that account can read the key file. So the file
 * belongs only on a machine whose account is the plan owner's own, never on a shared
 * or sandbox one. `~/.hegai-opencode-go-users` is not a security boundary: it keeps
 * someone else's session on such a machine from landing on the plan by accident.
 * Gateway-pinned and confined runs never use it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelInfoLite } from '@cc-remote/shared';
import { CODEX_FALLBACK_PROMPT } from './codex-fallback-prompt.js';
import { stateDir } from './config.js';
import { confinePrefix } from './confine.js';
import { gatewayUrl } from './gateway.js';
import { asRecord, optionalString } from './json-util.js';
import { codexVersion, isResolved, resolveCodexBin } from './runtime-locate.js';

export const GO_MODEL_PREFIX = 'pool-go/';
export const GO_PROVIDER_ID = 'hegai_go';
const GO_USER_AGENT = 'hegai-code/1.0';
const MODELS_TTL_MS = 60 * 60_000;
const MODELS_TIMEOUT_MS = 5_000;
const FIRST_LINE_LIMIT = 2 * 1024 * 1024;

/**
 * Listed by the endpoint but kept out of the picker:
 * - `contributor` models train on prompts;
 * - Crouton is refused for this account's country. DeepSeek runs since Owner chose
 *   the Global region in the Console (06.11.2026), and refuses again if that is undone;
 * - `gpt-*` is what Codex already offers;
 * - hy3 returned reasoning without calling the tool in the probe (06.11.2026).
 */
const HIDDEN_MODELS = /contributor|^crouton|^gpt-|^hy3$/;

export function goKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  return env['CC_REMOTE_OPENCODE_GO_VK_FILE'] || join(homedir(), '.hegai-opencode-go-vk');
}

function readGoKey(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return readFileSync(goKeyFile(env), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this machine offers Go at all. Windows is out because `spawnCodex` goes
 * through a shell there, which would mangle the quoted overrides. A confined run
 * does not see the key file. The key is a virtual key of this machine's trusted
 * gateway (gatewayUrl), so no gateway means no Go - the external edition by default.
 */
export function goAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform !== 'win32' && confinePrefix(env) === undefined && readGoKey(env) !== undefined && gatewayUrl(env) !== '';
}

/**
 * Guards against an accidental pick, not a deliberate reader (see the file header).
 * Fails closed: automation has no user id, and a missing list names nobody.
 */
export function goUserAllowed(userId: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!userId) return false;
  try {
    const file = env['CC_REMOTE_OPENCODE_GO_USERS_FILE'] || join(homedir(), '.hegai-opencode-go-users');
    return readFileSync(file, 'utf8').split(/\r?\n/).some((line) => line.trim() === userId);
  } catch {
    return false;
  }
}

export function isGoModel(model: string | undefined): model is string {
  return !!model && model.startsWith(GO_MODEL_PREFIX);
}

/**
 * Context windows of the Go models, by id without the `pool-go/` prefix.
 *
 * Codex has no catalogue entry for any of them, so it describes each with its
 * fallback for an unknown model: a 272,000-token window that `model_context_window`
 * cannot raise (the fallback's `max_context_window` caps it), reported as 258,400,
 * and an automatic compaction at 90% of 272k. A DeepSeek session (1M window) was
 * compacted mid-turn at 244k on 08.11.2026 while the meter read «91%».
 *
 * The gateway's `/v1/models` carries no limits. The figures are the `context`
 * limits models.dev publishes for the `opencode-go` provider (08.11.2026); that
 * limit holds the reply too, and Codex compacts at 90% of it. DeepSeek is measured
 * instead: V4.1 Flash and V4 Pro both accepted 945,7xx input tokens through the
 * gateway, and Flash refused 1,060,891 with «model limit 1048576 tokens».
 *
 * A model missing here gets Codex's 272k fallback, but only through an entry of
 * its own (`goModelCatalog`): too small rather than too large, since an early
 * compaction is recoverable and an overflow refuses turns.
 */
const GO_CONTEXT_WINDOW: Readonly<Record<string, number>> = {
  'beam-free': 1_048_576,
  'claude-haiku-5-5': 1_000_000,
  'deepseek-v4-pro': 1_048_576,
  'deepseek-v4.1-flash': 1_048_576,
  'gemini-4-argon': 1_048_576,
  'glm-5.2': 1_000_000,
  'glm-5.3': 1_000_000,
  'glm-5.3-flash': 1_000_000,
  'grok-4.7': 500_000,
  hy4: 983_010,
  'hy4-preview': 1_024_000,
  'kimi-k2.7-code': 262_144,
  'kimi-k3': 1_048_576,
  'kimi-k3.1-pro': 1_048_576,
  'longcat-2.0': 1_000_000,
  'mimo-v2.6-flash': 1_048_576,
  'mimo-v2.6-pro': 1_048_576,
  'minimax-m3': 1_000_000,
  'minimax-m3.1-flash': 1_000_000,
  'qwen3.7-plus': 1_000_000,
  'qwen3.8-flash': 1_000_000,
  'qwen3.8-max': 1_000_000,
  'step-5-preview': 1_000_000,
};

/** The window Codex gives a model it does not know (`model_info_from_slug`). */
const CODEX_FALLBACK_WINDOW = 272_000;

/**
 * A Codex model catalogue (`model_catalog_json`) describing the Go models.
 *
 * Each entry is Codex's own fallback for an unknown slug
 * (`model_info_from_slug`, codex-rs/models-manager/src/model_info.rs at
 * rust-v0.167.0) field for field, except the window. So a Go turn gets the same
 * instructions, tools and truncation as before, and only the window, the meter
 * and the compaction point move. Each model carries its own window, so switching
 * between Go models inside a session stays correct.
 *
 * The catalogue replaces Codex's for that app-server, which only ever serves Go
 * models. Codex matches a model to the LONGEST catalogue slug it starts with
 * (`find_model_by_longest_prefix`, models-manager/src/manager.rs), so a new
 * `pool-go/glm-5.3-air` would inherit the 1M window of `pool-go/glm-5.3`. Every
 * Go model the gateway lists therefore gets an exact entry, at the fallback's
 * 272k when the table does not know it.
 */
export function goModelCatalog(liveIds: readonly string[] = []): { models: Record<string, unknown>[] } {
  const windows: Record<string, number> = { ...GO_CONTEXT_WINDOW };
  for (const id of liveIds) {
    if (!isGoModel(id)) continue;
    const bare = id.slice(GO_MODEL_PREFIX.length);
    if (!Object.hasOwn(windows, bare)) windows[bare] = CODEX_FALLBACK_WINDOW;
  }
  return {
    models: Object.entries(windows).map(([bare, window]) => ({
      slug: GO_MODEL_PREFIX + bare,
      display_name: GO_MODEL_PREFIX + bare,
      description: null,
      supported_reasoning_levels: [],
      shell_type: 'unified_exec',
      visibility: 'none',
      supported_in_api: true,
      priority: 99,
      availability_nux: null,
      upgrade: null,
      model_messages: { instructions_template: CODEX_FALLBACK_PROMPT },
      include_skills_usage_instructions: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: false,
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: 'text',
      truncation_policy: { mode: 'bytes', limit: 10_000 },
      context_window: window,
      max_context_window: window,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
    })),
  };
}

/**
 * Write the catalogue where the app-server can read it, named by its content so
 * a new agent version never reads an older file. Rewritten when missing, so a
 * cleaned-up file costs nothing. Undefined when it cannot be written: the
 * session then runs on Codex's 272k fallback rather than not at all.
 */
export function writeGoCatalog(liveIds: readonly string[] = [], dir: string = stateDir()): string | undefined {
  try {
    const body = JSON.stringify(goModelCatalog(liveIds));
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    // Absolute: Codex resolves a relative path against CODEX_HOME, and a
    // catalogue it cannot load stops the app-server instead of falling back.
    const file = join(resolve(dir), `codex-go-catalog-${hash}.json`);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, body);
      renameSync(temp, file);
    }
    return file;
  } catch (error) {
    console.error('[agent] opencode go catalog not written:', (error as Error).message);
    return undefined;
  }
}

/**
 * `-c` overrides placing an app-server on Go. The plan refuses requests without a
 * stable session header, and the gateway forwards only `x-bf-eh-` prefixed ones.
 */
export function goCodexArgs(session: string, env: NodeJS.ProcessEnv = process.env, catalog?: string): string[] {
  const s = JSON.stringify;
  const provider = [
    `name=${s('OpenCode Go')}`,
    `base_url=${s(gatewayUrl(env))}`,
    `wire_api=${s('responses')}`,
    `http_headers={"User-Agent"=${s(GO_USER_AGENT)},"x-bf-eh-x-opencode-session"=${s(session)}}`,
    `auth={command="cat",args=[${s(goKeyFile(env))}]}`,
  ].join(',');
  const args = ['-c', `model_provider=${s(GO_PROVIDER_ID)}`, '-c', `model_providers.${GO_PROVIDER_ID}={${provider}}`];
  if (catalog) args.push('-c', `model_catalog_json=${s(catalog)}`);
  return args;
}

/** Gateway `/v1/models` → picker rows, named by the id the run reports as live. */
export function goModelsFromList(answer: unknown): ModelInfoLite[] {
  const rows = asRecord(answer)?.['data'];
  if (!Array.isArray(rows)) return [];
  const out: ModelInfoLite[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    const id = optionalString(row?.['id']);
    if (!isGoModel(id)) continue;
    const bare = id.slice(GO_MODEL_PREFIX.length);
    if (HIDDEN_MODELS.test(bare)) continue;
    const type = optionalString(row?.['type']);
    if (type && type !== 'chat') continue;
    out.push({ id, resolved: id, name: `${optionalString(row?.['name']) ?? bare} · Go`, supportsEffort: false });
  }
  return out;
}

let cached: { at: number; models: ModelInfoLite[] } | undefined;

/** Reset between tests; the cache is otherwise per process. */
export function forgetGoModels(): void {
  cached = undefined;
}

/**
 * The Go rows of `models.list`. A failed fetch must not cost the Codex rows
 * beside it, so it answers with the last good list or nothing.
 */
export async function listGoModels(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<ModelInfoLite[]> {
  try {
    if (!goAvailable(env)) return [];
    if (cached && now - cached.at < MODELS_TTL_MS) return cached.models;
    const response = await fetchImpl(`${gatewayUrl(env)}/models`, {
      headers: { Authorization: `Bearer ${readGoKey(env) ?? ''}`, 'User-Agent': GO_USER_AGENT },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const models = goModelsFromList(await response.json());
    if (models.length) cached = { at: now, models };
    return models.length ? models : (cached?.models ?? []);
  } catch (error) {
    // Also a malformed CC_REMOTE_CONFINE_RUNS, which goAvailable() throws on.
    console.error('[agent] opencode go model list failed:', (error as Error).message);
    return cached?.models ?? [];
  }
}

/**
 * Did this rollout's thread run on Go? Its `session_meta` line records the
 * provider, and a resume has to start the app-server on that same provider.
 * That line holds the base instructions, so it can be tens of kilobytes. The read
 * is bounded so a corrupt rollout with no newline cannot fill the agent's memory.
 */
export async function rolloutUsesGo(path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(FIRST_LINE_LIMIT);
      const { bytesRead } = await file.read(buffer, 0, FIRST_LINE_LIMIT, 0);
      const head = buffer.subarray(0, bytesRead).toString('utf8');
      const newline = head.indexOf('\n');
      const line = newline === -1 ? head : head.slice(0, newline);
      return asRecord(asRecord(JSON.parse(line))?.['payload'])?.['model_provider'] === GO_PROVIDER_ID;
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

/**
 * Everything a Go app-server is spawned with: the provider, and a catalogue that
 * covers every model the gateway lists right now (see `goModelCatalog`). The
 * list is cached for an hour and its failure answers the last good one, so this
 * waits on the network only for the first Go session after the agent starts.
 * The session's own model is added in case that first fetch fails.
 *
 * `catalogue` lists the slugs it covers, so a switch to a model listed later can
 * be refused (Codex would match it by prefix). It is absent when no catalogue was
 * passed, and then every Go model runs on Codex's fallback as before.
 */
export async function goSpawnArgs(
  session: string,
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ args: string[]; catalogue?: ReadonlySet<string> }> {
  if (!(await catalogueFitsCodex())) return { args: goCodexArgs(session, env) };
  const live = (await listGoModels(fetch, env)).map((m) => m.id);
  const ids = model ? [...live, model] : live;
  const file = writeGoCatalog(ids);
  if (!file) return { args: goCodexArgs(session, env) };
  const catalogue = new Set(goModelCatalog(ids).models.map((m) => String(m['slug'])));
  return { args: goCodexArgs(session, env, file), catalogue };
}

/**
 * Would Codex describe `model` by another model's catalogue entry? True when the
 * catalogue has no entry of its own but one whose slug it starts with (Codex's
 * longest-prefix lookup), e.g. a `pool-go/glm-5.3-air` listed after the session
 * started inheriting the 1M window of `pool-go/glm-5.3`.
 */
export function goCatalogueMisfit(catalogue: ReadonlySet<string> | undefined, model: string | undefined): boolean {
  if (!catalogue || !isGoModel(model) || catalogue.has(model)) return false;
  for (const slug of catalogue) if (model.startsWith(slug)) return true;
  return false;
}

/**
 * The Codex release the catalogue mirrors (fallback fields and prompt). Codex
 * updates on its own schedule, and a catalogue it cannot parse stops the
 * app-server, so another release runs Go on its plain fallback instead. On a
 * Codex update: re-check `model_info_from_slug` and prompt.md, regenerate
 * codex-fallback-prompt.ts, then move this.
 */
export const GO_CATALOGUE_CODEX = '0.167.';

let fitWarned = false;

async function catalogueFitsCodex(): Promise<boolean> {
  const bin = await resolveCodexBin();
  const version = isResolved(bin) ? await codexVersion(bin.path) : undefined;
  if (version?.startsWith(GO_CATALOGUE_CODEX)) return true;
  if (!fitWarned) {
    fitWarned = true;
    console.error(
      `[agent] opencode go: model catalogue is for codex ${GO_CATALOGUE_CODEX}x, found ${version ?? 'none'}; Go models keep the 272k fallback window`,
    );
  }
  return false;
}

const TAIL_LIMIT = 1024 * 1024;

/**
 * The model of the last turn a rollout recorded, for a resume whose client named
 * none: the catalogue must cover the model the thread actually runs. Read from
 * the tail only, since a rollout can be hundreds of megabytes and every turn
 * starts with a `turn_context` line.
 */
export async function rolloutLastModel(path: string | null | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - TAIL_LIMIT);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] ?? '';
        if (!line.includes('"turn_context"')) continue;
        try {
          const row = asRecord(JSON.parse(line));
          if (row?.['type'] !== 'turn_context') continue;
          const model = optionalString(asRecord(row['payload'])?.['model']);
          if (model) return model;
        } catch {
          // The first line of the tail can be cut in half.
        }
      }
      return undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}
