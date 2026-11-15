import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_TOOL } from '@cc-remote/shared';
import { NATIVE_PLAN_TOOLS, planToolOptions } from '../src/plan-tool.js';

test('every session gets our plan tool, always loaded and never asked about', () => {
  const opts = planToolOptions({});
  const server = opts.mcpServers?.['hegai'];
  assert.ok(server, 'the hegai server is registered');
  assert.equal(server.type, 'sdk');
  assert.equal(PLAN_TOOL, 'mcp__hegai__plan', 'server «hegai» + tool «plan» is the name clients match');
  assert.deepEqual(opts.allowedTools, [PLAN_TOOL]);
  assert.deepEqual(opts.disallowedTools, NATIVE_PLAN_TOOLS);
  assert.ok(!NATIVE_PLAN_TOOLS.includes('TaskStop') && !NATIVE_PLAN_TOOLS.includes('TaskOutput'), 'background jobs keep their tools');
});

test('each launch gets its own server instance', () => {
  assert.notEqual(planToolOptions({}).mcpServers?.['hegai'], planToolOptions({}).mcpServers?.['hegai']);
});

test('CC_REMOTE_PLAN_TOOL=off leaves the session exactly as before', () => {
  for (const v of ['off', '0', 'false', 'no', 'OFF ']) assert.deepEqual(planToolOptions({ CC_REMOTE_PLAN_TOOL: v }), {});
});

test('the plan rule rides after the harness prompt; nothing on → no systemPrompt at all', async () => {
  const { sessionLaunchOptions, PLAN_PROMPT } = await import('../src/plan-tool.js');
  const { harnessOptions, HARNESS_PROMPT } = await import('../src/harness.js');
  const both = sessionLaunchOptions(harnessOptions({}), planToolOptions({}));
  assert.equal(both['systemPrompt'], `${HARNESS_PROMPT}\n\n${PLAN_PROMPT}`);
  assert.ok(both['agents'] && both['mcpServers'] && !('prompt' in both));
  const planOnly = sessionLaunchOptions(harnessOptions({ CC_REMOTE_HARNESS: 'off' }), planToolOptions({}));
  assert.equal(planOnly['systemPrompt'], PLAN_PROMPT);
  assert.deepEqual(sessionLaunchOptions({}, planToolOptions({ CC_REMOTE_PLAN_TOOL: 'off' })), {});
});
