import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableCodexPermissionModes,
  codexApprovalPosture,
  codexApprovalRequest,
  codexCollaborationMode,
  codexEffectiveEffort,
  codexSandboxConfig,
  codexThreadSelection,
  codexTurnSandbox,
  codexWindowFor,
  pickCodexDecision,
  codexThreadSettings,
  encodeCodexAnswers,
  normalizeCodexQuestions,
  parseCodexTokenUsage,
  codexContextUsage,
  machineDefaultPermissionMode,
  selectionRejected,
  codexModelsFromList,
  codexModeAfterPlan,
  extractProposedPlan,
} from '../src/codex-run.js';

test('Codex questions preserve ids, choices, and secret input metadata', () => {
  assert.deepEqual(
    normalizeCodexQuestions([
      {
        id: 'mode',
        header: 'Plan',
        question: 'How should I proceed?',
        options: [{ label: 'Review', description: 'Ask before edits' }],
        isSecret: true,
      },
    ]),
    [
      {
        id: 'mode',
        header: 'Plan',
        question: 'How should I proceed?',
        options: [{ label: 'Review', description: 'Ask before edits' }],
        isOther: false,
        isSecret: true,
      },
    ],
  );
});

test('duplicate Codex question ids are normalized once', () => {
  assert.deepEqual(
    normalizeCodexQuestions([
      { id: 'same', question: 'First?', options: [] },
      { id: 'same', question: 'Redelivery?', options: [] },
    ]).map((q) => q.question),
    ['First?'],
  );
});

test('only picker rejection errors permit startup fallback', () => {
  assert.equal(selectionRejected('model gpt-bad is not available'), true);
  assert.equal(selectionRejected('unsupported reasoning effort ultra'), true);
  assert.equal(selectionRejected('thread/start timed out'), false);
  assert.equal(selectionRejected('429 rate limit exceeded'), false);
});

test('Codex answers are returned under protocol question ids', () => {
  const questions = normalizeCodexQuestions([
    { id: 'mode', header: 'Plan', question: 'Proceed?', options: [] },
  ]);
  assert.deepEqual(
    encodeCodexAnswers(questions, {
      allow: true,
      updatedInput: { answers: { mode: 'Review edits' } },
    }),
    { mode: { answers: ['Review edits'] } },
  );
  assert.deepEqual(encodeCodexAnswers(questions, { allow: false }), { mode: { answers: [] } });
});

test('Codex plan mode uses the app-server collaboration-mode contract', () => {
  assert.deepEqual(codexCollaborationMode('plan', 'gpt-5.5', 'xhigh'), {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      developer_instructions: null,
    },
  });
});

test('fresh and resumed Codex threads receive the selected model and effort', () => {
  assert.deepEqual(codexThreadSelection('gpt-6-astra', 'high'), {
    model: 'gpt-6-astra',
    config: { model_reasoning_effort: 'high' },
  });
  assert.deepEqual(codexThreadSelection(), {});
});

test('thread responses and settings notifications report the authoritative runtime choice', () => {
  assert.deepEqual(
    codexThreadSettings({ model: 'gpt-6-astra', reasoningEffort: 'high' }),
    { model: 'gpt-6-astra', effort: 'high' },
  );
  assert.deepEqual(
    codexThreadSettings({
      threadId: 't1',
      threadSettings: { model: 'gpt-5.6-sol', effort: 'medium' },
    }),
    { model: 'gpt-5.6-sol', effort: 'medium' },
  );
});

/**
 * Permission modes, and what they now actually DO.
 *
 * Before this, `approvalPolicy: 'never'` + `sandbox: danger-full-access` were
 * pinned whatever the mode said: every Codex session in the fleet ran what the
 * Claude side calls `bypassPermissions`, under the label «Ask first».
 */
test('each permission mode maps to a posture the runtime honours', () => {
  assert.deepEqual(codexApprovalPosture('default'), {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
  });
  assert.deepEqual(codexApprovalPosture('acceptEdits'), {
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
  });
  assert.deepEqual(codexApprovalPosture('bypassPermissions'), {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
});

test('an unrecognised mode asks rather than assumes', () => {
  // `plan` carries no posture of its own — it is a collaboration mode — so it
  // must land on the asking branch, not on a permissive one.
  assert.equal(codexApprovalPosture('plan').approvalPolicy, 'on-request');
  assert.equal(codexApprovalPosture('dontAsk' as never).approvalPolicy, 'on-request');
});

/**
 * The machine's default posture, which this runtime used to ignore.
 *
 * devbox — the employee sandbox — carries
 * `CC_REMOTE_DEFAULT_PERMISSION_MODE=acceptEdits`, and employees are pinned to
 * Codex by the hub. Reading the env only on the Claude path meant that box
 * asked for a click on every single Bash call, which is the opposite of what
 * its configuration says.
 */
test('the machine default fills a mode nobody picked, and only for real modes', () => {
  assert.equal(machineDefaultPermissionMode('acceptEdits'), 'acceptEdits');
  assert.equal(machineDefaultPermissionMode('bypassPermissions'), 'bypassPermissions');
  // A typo must not be trusted, and must not be read as a permissive mode:
  // it is a restriction somebody misspelt, so it fails closed to `default`
  // (the runtime asks) rather than falling to the no-prompts floor. Unset or
  // empty is «nothing configured» and stays undefined.
  assert.equal(machineDefaultPermissionMode('acceptedits'), 'default');
  assert.equal(machineDefaultPermissionMode('yolo'), 'default');
  assert.equal(machineDefaultPermissionMode(''), undefined);

  // And the env itself is the source, read at call time — asserted by moving
  // it, because the ambient value is real on any box running an agent (this
  // test suite is itself run from one).
  const saved = process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'];
  try {
    delete process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'];
    assert.equal(machineDefaultPermissionMode(), undefined);
    process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'] = 'acceptEdits';
    assert.equal(machineDefaultPermissionMode(), 'acceptEdits');
  } finally {
    if (saved === undefined) delete process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'];
    else process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'] = saved;
  }
});

/**
 * The same sandbox in two shapes, because the app-server wants two. Measured
 * 23.09.2026 against codex-cli 0.154.0: `thread/start` rejects the object
 * (`unknown variant 'type'`) and `turn/start` rejects the string (`expected
 * internally tagged enum SandboxPolicyDeserialize`).
 */
test('the turn-level sandbox is the tagged shape, not the string one', () => {
  assert.deepEqual(codexTurnSandbox('workspace-write'), { type: 'workspaceWrite' });
  assert.deepEqual(codexTurnSandbox('read-only'), { type: 'readOnly' });
  assert.deepEqual(codexTurnSandbox('danger-full-access'), { type: 'dangerFullAccess' });
});

test('workspace-write asks for network, which its own field cannot grant', () => {
  // Verified both ways against the live server: the plain `sandbox` string
  // comes back `networkAccess: false`, and only this override flips it.
  assert.deepEqual(codexSandboxConfig('workspace-write'), {
    config: { sandbox_workspace_write: { network_access: true } },
  });
  assert.deepEqual(codexSandboxConfig('danger-full-access'), {}, 'nothing to widen');
  assert.deepEqual(codexSandboxConfig('read-only'), {});
});

/**
 * Approvals. The decisive measurement: a real command approval from codex-cli
 * 0.154.0 offered `["accept", {acceptWithExecpolicyAmendment: …}, "cancel"]` —
 * no `decline` anywhere — so a hardcoded refusal token would have been wrong on
 * the first refusal anyone made.
 */
test('a refusal uses a word the server actually offered', () => {
  assert.equal(pickCodexDecision(['accept', { acceptWithExecpolicyAmendment: {} }, 'cancel'], false), 'cancel');
  assert.equal(pickCodexDecision(['accept', 'decline'], false), 'decline');
});

test('an approval takes this command, not the whole session', () => {
  assert.equal(pickCodexDecision(['acceptForSession', 'accept', 'cancel'], true), 'accept');
});

test('an amendment object is never chosen on the reader´s behalf', () => {
  // Each object widens policy beyond the single action the human was shown.
  const decision = pickCodexDecision([{ acceptWithExecpolicyAmendment: {} }, 'cancel'], true);
  assert.equal(typeof decision, 'string');
  assert.notEqual(decision, 'cancel');
});

test('a server offering nothing still gets a well-formed answer', () => {
  assert.equal(pickCodexDecision(undefined, true), 'accept');
  assert.equal(pickCodexDecision([], false), 'decline');
});

test('approval requests are recognised by both the new and the legacy names', () => {
  const exec = codexApprovalRequest('item/commandExecution/requestApproval', {
    command: "/bin/bash -lc 'rm -rf /'",
    cwd: '/tmp',
  });
  assert.equal(exec?.tool, 'CodexExec');
  assert.equal(exec?.title, "$ /bin/bash -lc 'rm -rf /'", 'the command IS the question');
  assert.equal(codexApprovalRequest('execCommandApproval', {})?.tool, 'CodexExec');
  assert.equal(codexApprovalRequest('applyPatchApproval', {})?.tool, 'CodexPatch');
  assert.equal(
    codexApprovalRequest('item/permissions/requestApproval', {})?.tool,
    'CodexPermissions',
  );
});

test('a patch approval names the files it would touch', () => {
  const patch = codexApprovalRequest('item/fileChange/requestApproval', {
    changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
  });
  assert.equal(patch?.title, 'edit src/a.ts, src/b.ts');
});

test('anything that is not an approval stays unhandled', () => {
  // The caller answers these with -32601; swallowing them here would hang the
  // turn, since our timeout bounds only OUR outbound calls.
  assert.equal(codexApprovalRequest('turn/completed', {}), undefined);
  assert.equal(codexApprovalRequest('item/tool/requestUserInput', {}), undefined);
});

test('a machine offers Codex only the modes it can honour', () => {
  assert.deepEqual(availableCodexPermissionModes(true, undefined), [
    'default',
    'plan',
    'acceptEdits',
    'bypassPermissions',
  ]);
  assert.deepEqual(availableCodexPermissionModes(false, undefined), ['default', 'plan', 'acceptEdits']);
  // A pinned CODEX_SANDBOX decides the sandbox for every session, so the rows
  // that exist to change it would be controls that do nothing.
  assert.deepEqual(availableCodexPermissionModes(true, 'workspace-write'), ['default', 'plan']);
});

/**
 * The level a turn really runs at.
 *
 * Measured 23.09.2026 against a live codex-cli 0.154.0 app-server: a config
 * naming `model_reasoning_effort` comes back on `thread/start` as a top-level
 * `reasoningEffort`, and a config without one comes back null. The null case is
 * the one that broke the composer — the turn ran at the fallback and nothing on
 * the wire ever said so, leaving the slider to park its thumb on `low`.
 */
test('the effective effort falls through pin, then config, then the fallback', () => {
  assert.equal(codexEffectiveEffort('high', 'low'), 'high', 'the session pin wins');
  assert.equal(codexEffectiveEffort(undefined, 'xhigh'), 'xhigh', "the machine's config is next");
  assert.equal(codexEffectiveEffort(), 'medium', 'and the hole is filled, not left silent');
});

test('the effort told to Codex is the effort told to the hub', () => {
  // One expression feeds both, so a future edit cannot make them disagree
  // without this failing.
  const effort = codexEffectiveEffort(undefined, undefined);
  assert.equal(
    (codexCollaborationMode('default', 'gpt-6-astra', effort)['settings'] as Record<string, unknown>)[
      'reasoning_effort'
    ],
    effort,
  );
});

/**
 * Context metering for Codex. The payloads below are verbatim captures from
 * codex-cli 0.144.1 (`thread/tokenUsage/updated`), not hand-written guesses.
 */
/**
 * The DENOMINATOR, which is the half that was wrong.
 *
 * `models_cache.json` is fetched from ChatGPT's backend, not from the provider,
 * so a model reached through the gateway never enters it and the app-server
 * answers with the gpt-5.x default: `modelContextWindow: 258400`. For Astra
 * that made «Контекст 91%» out of roughly 23% — and 91% is what sends a person
 * to «Сжать контекст».
 *
 * 1,050,000 / 922,000 / 128,000 are the documented figures, not measured ones
 * (developers.openai.com/api/docs/models/gpt-5.6-sol and gpt-6-astra).
 */
test('a model missing or stale in the app-server catalogue gets its documented window', () => {
  // 258400 is the fallback the app-server invents; 922000 is the max input the
  // documentation states. GPT-5.6 is stale and GPT-6 is missing in the fleet
  // cache, so both lines carry the same correction.
  for (const model of [
    'gpt-5.6',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
  ]) {
    assert.equal(codexWindowFor(model, 258_400), 922_000, model);
  }
  const usage = codexContextUsage({ used: 117_000, window: 258_400 }, 'gpt-5.6-sol');
  assert.equal(usage.maxTokens, 922_000);
  assert.equal(usage.percentage, 13, 'the reported 45% session has only filled 13%');
});

test('a model without a documented correction keeps the app-server’s answer', () => {
  assert.equal(codexWindowFor('provider-specific-model', 258_400), 258_400);
  assert.equal(codexWindowFor(undefined, 258_400), 258_400);
});

test('GPT-6.1 Sol does not meter a gateway session against the stale 258k fallback', () => {
  // Live 29.10.2026: Codex 0.165.0 reported this 241,884-token session as 94%
  // full, although the gateway accepted an input of 921,332 tokens.
  const usage = codexContextUsage({ used: 241_884, window: 258_400 }, 'gpt-6.1-sol');
  assert.equal(usage.maxTokens, 922_000);
  assert.equal(usage.percentage, 26);
});

test('catalogue corrections leave explicit or updated runtime windows intact', () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol']) {
    for (const reported of [128_000, 475_000, 500_000, 997_500]) {
      assert.equal(codexWindowFor(model, reported), reported, `${model}: ${reported}`);
    }
  }
  assert.equal(codexContextUsage({ used: 250_000, window: 500_000 }, 'gpt-6.1-sol').percentage, 50);
});

test('the context meter reads `last`, not the lifetime total', () => {
  // Captured live: a fresh thread one turn in.
  const reading = parseCodexTokenUsage({
    total: { totalTokens: 38842, inputTokens: 38584, cachedInputTokens: 3968, outputTokens: 258 },
    last: { totalTokens: 10473, inputTokens: 10220, cachedInputTokens: 0, outputTokens: 253 },
    modelContextWindow: 258400,
  });
  assert.deepEqual(reading, { used: 10473, window: 258400 });
  assert.equal(codexContextUsage(reading!).percentage, 4);
});

test('a long session does not report thousands of percent', () => {
  // Shape of a real week-old session: 57M lifetime tokens, 190k in context.
  const reading = parseCodexTokenUsage({
    total: { totalTokens: 57430425, inputTokens: 57333054 },
    last: { totalTokens: 190388, inputTokens: 190254 },
    modelContextWindow: 258400,
  });
  const usage = codexContextUsage(reading!, 'gpt-6-astra');
  // Against `total` this would read 6234%; the point of the test is that it
  // reads `last`. The denominator is Astra's documented window less its reply
  // room (see `codexWindowFor`) rather than the app-server's 258400 fallback —
  // this assertion said 74% while the session was at a fifth of its context.
  assert.equal(usage.percentage, 21);
  assert.equal(usage.maxTokens, 922000);
  assert.equal(usage.model, 'gpt-6-astra');
  // cc-remote does not compact a Codex thread by itself; saying otherwise would
  // promise the user a rescue that never comes.
  assert.equal(usage.autoCompactEnabled, false);
});

test('a malformed or empty usage payload yields no reading at all', () => {
  assert.equal(parseCodexTokenUsage(undefined), undefined);
  assert.equal(parseCodexTokenUsage({}), undefined);
  assert.equal(parseCodexTokenUsage({ last: { totalTokens: 10 } }), undefined); // no window
  assert.equal(parseCodexTokenUsage({ last: {}, modelContextWindow: 258400 }), undefined);
  assert.equal(parseCodexTokenUsage({ last: { totalTokens: 10 }, modelContextWindow: 0 }), undefined);
});

test('an over-full context clamps at 100% instead of overflowing the bar', () => {
  const usage = codexContextUsage({ used: 300000, window: 258400 });
  assert.equal(usage.percentage, 100);
});

test('the unpinned row names the machine\'s configured model, not the catalog default', () => {
  const answer = { result: { data: [
    { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true },
    { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: false },
  ] } };
  // 29.09.2026: config.toml said Sol, the picker said Astra.
  assert.deepEqual(codexModelsFromList(answer, 'gpt-5.6-sol')[0], { id: 'default', resolved: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' });
  // No config pin: the catalog's own default, as before.
  assert.deepEqual(codexModelsFromList(answer)[0], { id: 'default', resolved: 'gpt-6-astra', name: 'GPT-6-Astra' });
  // A configured model the list does not show is still what runs.
  assert.deepEqual(codexModelsFromList(answer, 'gpt-hidden')[0], { id: 'default', resolved: 'gpt-hidden' });
});

test('a proposed plan is the closed <proposed_plan> block and nothing short of it', () => {
  assert.equal(extractProposedPlan('Готово.\n<proposed_plan>\n# План\n- шаг\n</proposed_plan>'), '# План\n- шаг');
  assert.equal(extractProposedPlan('<proposed_plan>\n# draft'), undefined);
  assert.equal(extractProposedPlan('<proposed_plan>  </proposed_plan>'), undefined);
  assert.equal(extractProposedPlan('no plan here'), undefined);
});

test('an accepted plan continues in the mode before planning, never in a sandbox that blocks git', () => {
  assert.equal(codexModeAfterPlan('default', 'bypassPermissions', 'bypassPermissions'), 'default');
  assert.equal(codexModeAfterPlan('acceptEdits', 'bypassPermissions', 'default'), 'bypassPermissions');
  assert.equal(codexModeAfterPlan('acceptEdits', undefined, 'bypassPermissions'), 'bypassPermissions');
  assert.equal(codexModeAfterPlan(undefined, 'acceptEdits', 'bypassPermissions'), 'acceptEdits');
  assert.equal(codexModeAfterPlan('acceptEdits', 'plan', 'default'), 'acceptEdits');
  assert.equal(codexModeAfterPlan('acceptEdits', 'default', 'default'), 'acceptEdits');
  assert.equal(codexModeAfterPlan('acceptEdits', 'default', 'bypassPermissions'), 'bypassPermissions');
});

// ---- built-in image_gen tool: item/started + item/completed → image_gen events

import { CodexSessionRun } from '../src/codex-run.js';

function imageRun() {
  const events: Array<{ code?: string; text?: string; data?: Record<string, unknown> }> = [];
  const run = Object.create(CodexSessionRun.prototype) as CodexSessionRun;
  Object.assign(run as unknown as Record<string, unknown>, {
    handlers: { onEvent: (e: (typeof events)[number]) => events.push(e) },
    imageGenStarted: new Map<string, number>(),
    imageGenSeen: new Set<string>(),
  });
  const item = (it: Record<string, unknown>, completed: boolean) =>
    (run as unknown as { onItem(i: unknown, c: boolean): void }).onItem({ type: 'imageGeneration', ...it }, completed);
  const rollout = (payload: Record<string, unknown>) =>
    (run as unknown as { onRolloutImage(p: unknown): void }).onRolloutImage(payload);
  return { events, item, rollout };
}

test('imageGeneration: started carries the clock, completed names the gen: ref', () => {
  const { events, item } = imageRun();
  item({ id: 'ig_1', status: 'inProgress', revisedPrompt: 'a cat' }, false);
  item({ id: 'ig_1', status: 'inProgress' }, false); // a repeat adds nothing
  item({ id: 'ig_1', status: 'completed', result: 'AAAA', revisedPrompt: 'a cat' }, true);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.code, 'image_gen');
  assert.equal(events[0]!.data?.['state'], 'started');
  assert.equal(events[0]!.data?.['prompt'], 'a cat');
  assert.equal(typeof events[0]!.data?.['startedAt'], 'number');
  assert.deepEqual(
    { id: events[1]!.data?.['id'], state: events[1]!.data?.['state'], ref: events[1]!.data?.['ref'] },
    { id: 'ig_1', state: 'done', ref: 'gen:ig_1' },
  );
  assert.equal(events[1]!.data?.['startedAt'], events[0]!.data?.['startedAt']);
});

test('imageGeneration: completed without a prior started still gets a startedAt; savedPath/fileId alone cannot be shown', () => {
  const { events, item } = imageRun();
  item({ id: 'ig_2', status: 'completed', result: 'AAAA' }, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.data?.['state'], 'done');
  assert.equal(typeof events[0]!.data?.['startedAt'], 'number');
  // the loader serves only the inline result of the rollout: a path or file id is not a picture
  item({ id: 'ig_2b', status: 'completed', savedPath: '/tmp/x.png' }, true);
  item({ id: 'ig_2c', status: 'completed', fileId: 'file_1' }, true);
  assert.deepEqual(events.slice(1).map((e) => e.data?.['state']), ['failed', 'failed']);
  assert.equal(events[1]!.data?.['error'], 'картинка сохранена, но показать её нельзя');
  assert.equal(events[2]!.data?.['error'], 'картинка сохранена, но показать её нельзя');
  assert.equal(events[1]!.data?.['ref'], undefined);
});

test('imageGeneration: failures say why, usage limit names the reset', () => {
  const { events, item } = imageRun();
  item({ id: 'ig_3', status: 'failed' }, true);
  item({ id: 'ig_4', status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'img', resetsAt: 1_800_000_000 } }, true);
  item({ id: 'ig_5', status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'img', resetsAt: null } }, true);
  item({ id: 'ig_6', status: 'completed' }, true); // completed but nothing to show
  assert.deepEqual(events.map((e) => e.data?.['state']), ['failed', 'failed', 'failed', 'failed']);
  assert.equal(events[0]!.data?.['error'], 'генерация не удалась');
  assert.match(String(events[1]!.data?.['error']), /^лимит генерации исчерпан — сброс /);
  assert.equal(events[2]!.data?.['error'], 'лимит генерации исчерпан');
  assert.equal(events[0]!.data?.['ref'], undefined);
});

test('imageGeneration from the rollout: started then done, a repeat of the id is silent', () => {
  const { events, rollout } = imageRun();
  const payload = { id: 'ig_r1', status: 'completed', revised_prompt: 'a fox', result: 'AAAA' };
  rollout(payload);
  rollout(payload);
  assert.deepEqual(events.map((e) => [e.data?.['state'], e.data?.['ref']]), [['started', undefined], ['done', 'gen:ig_r1']]);
  assert.equal(events[0]!.data?.['prompt'], 'a fox');
});

test('imageGeneration from the rollout: no result or a failed status is a failed card', () => {
  const { events, rollout } = imageRun();
  rollout({ id: 'ig_r2', status: 'completed', result: '' });
  rollout({ id: 'ig_r3', status: 'failed', result: 'AAAA' });
  assert.deepEqual(events.map((e) => e.data?.['state']), ['started', 'failed', 'started', 'failed']);
});

test('imageGeneration: no duplicate when both the live item and the rollout carry one id', () => {
  const a = imageRun();
  a.rollout({ id: 'ig_d', status: 'completed', result: 'AAAA' }); // rollout first
  a.item({ id: 'ig_d', status: 'inProgress' }, false);
  a.item({ id: 'ig_d', status: 'completed', result: 'AAAA' }, true);
  assert.equal(a.events.length, 2);
  const b = imageRun();
  b.item({ id: 'ig_e', status: 'inProgress' }, false); // live first
  b.rollout({ id: 'ig_e', status: 'completed', result: 'AAAA' });
  b.item({ id: 'ig_e', status: 'completed', result: 'AAAA' }, true);
  assert.deepEqual(b.events.map((e) => e.data?.['state']), ['started', 'done']);
});
