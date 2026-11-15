import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  forgetGoModels,
  goAvailable,
  goCatalogueMisfit,
  goCodexArgs,
  goModelCatalog,
  goModelsFromList,
  goUserAllowed,
  isGoModel,
  listGoModels,
  rolloutLastModel,
  rolloutUsesGo,
  writeGoCatalog,
} from '../src/opencode-go.js';

const dir = mkdtempSync(join(tmpdir(), 'go-test-'));
const keyFile = join(dir, 'vk');
writeFileSync(keyFile, 'sk-bf-test\n');
const env = { CC_REMOTE_OPENCODE_GO_VK_FILE: keyFile } as NodeJS.ProcessEnv;
const listing = { data: [{ id: 'pool-go/glm-5.3', name: 'GLM-5.3', type: 'chat' }] };

test('the prefix marks a Go pick', () => {
  assert.equal(isGoModel('pool-go/glm-5.3'), true);
  assert.equal(isGoModel('pool-a/gpt-5.6-sol'), false);
  assert.equal(isGoModel(undefined), false);
});

test('the picker gets Go rows only, without training, region-refused or duplicate models', () => {
  const rows = goModelsFromList({
    data: [
      { id: 'pool-go/glm-5.3', name: 'GLM-5.3', type: 'chat' },
      { id: 'pool-go/kimi-k3', type: 'chat' },
      { id: 'pool-go/muse-spark-1.3-contributor', type: 'chat' },
      { id: 'pool-go/iceman-contributor-free', type: 'chat' },
      { id: 'pool-go/deepseek-v4-pro', type: 'chat' },
      { id: 'pool-go/crouton-alpha-free', type: 'chat' },
      { id: 'pool-go/gpt-6-luna', type: 'chat' },
      { id: 'pool-go/hy3', type: 'chat' },
      { id: 'pool-go/some-embedding', type: 'embedding' },
      { id: 'pool-a/gpt-5.6-sol', type: 'chat' },
    ],
  });
  assert.deepEqual(rows, [
    { id: 'pool-go/glm-5.3', resolved: 'pool-go/glm-5.3', name: 'GLM-5.3 · Go', supportsEffort: false },
    { id: 'pool-go/kimi-k3', resolved: 'pool-go/kimi-k3', name: 'kimi-k3 · Go', supportsEffort: false },
    { id: 'pool-go/deepseek-v4-pro', resolved: 'pool-go/deepseek-v4-pro', name: 'deepseek-v4-pro · Go', supportsEffort: false },
  ]);
  assert.deepEqual(goModelsFromList({ error: 'nope' }), []);
});

test('the app-server override carries a key path, never the key, and the forwarded header', () => {
  const args = goCodexArgs('sess-1', env);
  assert.equal(args.length, 4);
  assert.equal(args[1], 'model_provider="hegai_go"');
  assert.match(args[3]!, /"x-bf-eh-x-opencode-session"="sess-1"/);
  assert.match(args[3]!, /auth=\{command="cat",args=\[".*vk"\]\}/);
  assert.equal(args.join(' ').includes('sk-bf-test'), false);
});

test('only a listed user may spend the plan, and no identity means no', () => {
  const file = join(dir, 'users');
  writeFileSync(file, 'user-1\n  user-2  \n');
  const usersEnv = { CC_REMOTE_OPENCODE_GO_USERS_FILE: file } as NodeJS.ProcessEnv;
  assert.equal(goUserAllowed('user-1', usersEnv), true);
  assert.equal(goUserAllowed('user-2', usersEnv), true);
  assert.equal(goUserAllowed('user-3', usersEnv), false);
  assert.equal(goUserAllowed('user', usersEnv), false);
  assert.equal(goUserAllowed(undefined, usersEnv), false);
  assert.equal(goUserAllowed('user-1', { CC_REMOTE_OPENCODE_GO_USERS_FILE: join(dir, 'absent') } as NodeJS.ProcessEnv), false);
});

test('no key or a confined machine means no Go', async () => {
  assert.equal(goAvailable(env), process.platform !== 'win32');
  const bare = { CC_REMOTE_OPENCODE_GO_VK_FILE: join(dir, 'absent') } as NodeJS.ProcessEnv;
  assert.equal(goAvailable(bare), false);
  assert.equal(goAvailable({ ...env, CC_REMOTE_CONFINE_RUNS: '/srv/x' }), false);
  forgetGoModels();
  const fetchMustNotRun = (async () => assert.fail('no fetch without a key')) as typeof fetch;
  assert.deepEqual(await listGoModels(fetchMustNotRun, bare), []);
});

test('a failed fetch answers with the last good list, and the list is cached', async () => {
  forgetGoModels();
  let calls = 0;
  let seen = '';
  const ok = (async (url: string, init: RequestInit) => {
    calls += 1;
    seen = `${url} ${(init.headers as Record<string, string>)['Authorization']}`;
    return new Response(JSON.stringify(listing));
  }) as unknown as typeof fetch;
  const first = await listGoModels(ok, env, 0);
  assert.equal(first.length, 1);
  assert.equal(seen, 'https://llm.acme.test/v1/models Bearer sk-bf-test');
  await listGoModels(ok, env, 1000);
  assert.equal(calls, 1);
  const down = (async () => new Response('', { status: 503 })) as typeof fetch;
  assert.deepEqual(await listGoModels(down, env, 2 * 60 * 60_000), first);
  forgetGoModels();
  assert.deepEqual(await listGoModels(down, env, 0), []);
});

test('a resume reads the provider from the first rollout line only', async () => {
  const write = (name: string, lines: unknown[]) => {
    const path = join(dir, name);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return path;
  };
  const meta = (provider: string) => ({ type: 'session_meta', payload: { id: 'x', model_provider: provider } });
  assert.equal(await rolloutUsesGo(write('go.jsonl', [meta('hegai_go')])), true);
  assert.equal(await rolloutUsesGo(write('hegai.jsonl', [meta('hegai'), meta('hegai_go')])), false);
  const big = write('big.jsonl', [{ type: 'session_meta', payload: { pad: 'x'.repeat(300_000), model_provider: 'hegai_go' } }]);
  assert.equal(await rolloutUsesGo(big), true);
  assert.equal(await rolloutUsesGo(null), false);
  assert.equal(await rolloutUsesGo(join(dir, 'absent.jsonl')), false);
  writeFileSync(join(dir, 'huge.jsonl'), 'x'.repeat(3 * 1024 * 1024));
  assert.equal(await rolloutUsesGo(join(dir, 'huge.jsonl')), false);
  writeFileSync(join(dir, 'torn.jsonl'), '{"type":"sess');
  assert.equal(await rolloutUsesGo(join(dir, 'torn.jsonl')), false);
});

test('the Go catalogue is the fallback of Codex with the real window, and the app-server reads it', () => {
  const models = goModelCatalog().models;
  const flash = models.find((m) => m['slug'] === 'pool-go/deepseek-v4.1-flash');
  assert.equal(flash?.['context_window'], 1_048_576);
  assert.equal(flash?.['max_context_window'], 1_048_576);
  assert.equal(models.find((m) => m['slug'] === 'pool-go/kimi-k2.7-code')?.['context_window'], 262_144);
  for (const m of models) {
    assert.match(String(m['slug']), /^pool-go\//);
    assert.match(String((m['model_messages'] as Record<string, unknown>)['instructions_template']), /^You are a coding agent running in the Codex CLI/);
    assert.equal(m['include_apps_usage_instructions'], false, 'serde defaults this to true; the fallback sets false');
  }
  const catalogDir = mkdtempSync(join(tmpdir(), 'go-catalog-'));
  const file = writeGoCatalog([], catalogDir);
  assert.ok(file);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), goModelCatalog());
  assert.equal(writeGoCatalog([], catalogDir), file);
  assert.deepEqual(goCodexArgs('sess-1', env, file).slice(4), ['-c', `model_catalog_json=${JSON.stringify(file)}`]);
  assert.equal(writeGoCatalog([], join(keyFile, 'not-a-dir')), undefined);
});

test('a listed Go model the table does not know gets its own 272k entry, not a neighbour by prefix', () => {
  const windowOf = (ids: string[], slug: string) =>
    goModelCatalog(ids).models.find((m) => m['slug'] === slug)?.['context_window'];
  const live = ['pool-go/glm-5.3-air', 'pool-go/glm-5.3', 'gpt-6-sol'];
  assert.equal(windowOf(live, 'pool-go/glm-5.3-air'), 272_000);
  assert.equal(windowOf(live, 'pool-go/glm-5.3'), 1_000_000);
  assert.equal(windowOf(live, 'gpt-6-sol'), undefined);
  assert.equal(goModelCatalog(live).models.length, goModelCatalog().models.length + 1);
});

test('a Go model is a misfit only when a shorter catalogue slug would capture it', () => {
  const catalogue = new Set(goModelCatalog().models.map((m) => String(m['slug'])));
  assert.equal(goCatalogueMisfit(catalogue, 'pool-go/glm-5.3-air'), true);
  assert.equal(goCatalogueMisfit(catalogue, 'pool-go/glm-5.3'), false);
  assert.equal(goCatalogueMisfit(catalogue, 'pool-go/hy3'), false);
  assert.equal(goCatalogueMisfit(catalogue, 'gpt-6-sol'), false);
  assert.equal(goCatalogueMisfit(undefined, 'pool-go/glm-5.3-air'), false);
});

test('a resume reads the model of the last turn from the rollout tail', async () => {
  const tailDir = mkdtempSync(join(tmpdir(), 'go-model-'));
  const ctx = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });
  const file = join(tailDir, 'r.jsonl');
  writeFileSync(file, [ctx('pool-go/glm-5.3'), '{"type":"event_msg"}', ctx('pool-go/deepseek-v4-pro'), '{"type":"event_msg"}', ''].join('\n'));
  assert.equal(await rolloutLastModel(file), 'pool-go/deepseek-v4-pro');
  const big = join(tailDir, 'big.jsonl');
  writeFileSync(big, `${ctx('pool-go/glm-5.3')}\n${'x'.repeat(2 * 1024 * 1024)}\n${ctx('pool-go/kimi-k3')}\n`);
  assert.equal(await rolloutLastModel(big), 'pool-go/kimi-k3');
  writeFileSync(join(tailDir, 'none.jsonl'), '{"type":"event_msg"}\n');
  assert.equal(await rolloutLastModel(join(tailDir, 'none.jsonl')), undefined);
  assert.equal(await rolloutLastModel(join(tailDir, 'absent.jsonl')), undefined);
  assert.equal(await rolloutLastModel(null), undefined);
});

test('Go follows the trusted gateway: a named one is used, none means no Go', async () => {
  const own = { ...env, CC_REMOTE_GATEWAY_URL: 'https://gw.example.test/v1/' } as NodeJS.ProcessEnv;
  assert.match(goCodexArgs('sess-1', own)[3]!, /base_url="https:\/\/gw\.example\.test\/v1"/);
  forgetGoModels();
  let seen = '';
  const ok = (async (url: string) => {
    seen = url;
    return new Response(JSON.stringify(listing));
  }) as unknown as typeof fetch;
  await listGoModels(ok, own, 0);
  assert.equal(seen, 'https://gw.example.test/v1/models');
  forgetGoModels();
  const off = { ...env, CC_REMOTE_GATEWAY_URL: '' } as NodeJS.ProcessEnv;
  assert.equal(goAvailable(off), false);
  let fetched = false;
  const fetchMustNotRun = (async () => { fetched = true; throw new Error('no fetch without a gateway'); }) as unknown as typeof fetch;
  assert.deepEqual(await listGoModels(fetchMustNotRun, off, 0), []);
  assert.equal(fetched, false);
});
