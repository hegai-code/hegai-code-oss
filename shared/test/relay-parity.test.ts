/**
 * Guards the one failure this protocol keeps repeating: a field that an agent
 * sends, the hub forwards, and the BROWSER schema never heard of — so
 * `decodeCentralToBrowser` (a zod parse) strips it on arrival and the UI shows
 * a value nobody set. Every layer looks right in review; the value simply is
 * not there at the end.
 *
 * It cost a day on `activeEffort` (19.09.2026): agent read it off the SDK hook,
 * hub relayed and retained it, the picker knew how to draw it — and the field
 * died one line before the UI, because the hub→browser schema listed five
 * fields where the agent→hub schema listed six.
 *
 * So the rule is mechanical, not per-field: for every message type that travels
 * BOTH hops under the same name, the browser-facing object must accept every
 * key the agent-facing object can send. Adding a field to one side and not the
 * other now fails here instead of in someone's eyes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentToCentral, CentralToBrowser } from '../src/index.js';

type Shape = Record<string, unknown>;

/** The object schemas of a discriminated union, keyed by their `type` literal. */
function byType(union: { options: readonly unknown[] }): Map<string, Shape> {
  const out = new Map<string, Shape>();
  for (const option of union.options) {
    const shape = (option as { shape?: Shape }).shape;
    if (!shape) continue;
    const literal = shape['type'] as { value?: unknown } | undefined;
    const name = literal && typeof literal.value === 'string' ? literal.value : undefined;
    if (name) out.set(name, shape);
  }
  return out;
}

/**
 * Keys that legitimately stop at the hub. Each one is a routing detail the
 * browser has no business seeing — NOT a field someone forgot to forward.
 * Adding to this list is a decision; adding to it to silence a failure is the
 * bug this file exists to catch.
 */
const HUB_ONLY: Record<string, string[]> = {
  // The browser is told which run an event belongs to; which machine produced
  // it is resolved by the hub from the run itself.
  stream: ['machineId'],
  // `closing`: «the runtime process may still be exiting» — the hub holds the
  // session's writer guard on it (`writer_released` ends that). It decides
  // nothing in a browser, and an old client must never see a field it cannot
  // read: the hub rebuilds `run_status` field by field and omits it.
  run_status: ['machineId', 'closing'],
  run_settings: ['machineId'],
  run_mode: ['machineId'],
  // `replay` says «this prompt was already announced once»; only the hub acts
  // on it (it decides whether phones and Telegram hear about it again). The
  // browser draws the prompt the same either way — see protocol.ts `replay`.
  tool_request: ['machineId', 'replay'],
  context_usage: ['machineId'],
  // The nudge is addressed by machine + session; the working directory is the
  // agent's evidence for WHICH project committed, and the Flow card has no use
  // for a filesystem path it cannot open.
  session_committed: ['cwd'],
};

test('every field an agent can send survives the browser schema', () => {
  const fromAgent = byType(AgentToCentral as unknown as { options: readonly unknown[] });
  const toBrowser = byType(CentralToBrowser as unknown as { options: readonly unknown[] });

  const missing: string[] = [];
  for (const [type, agentShape] of fromAgent) {
    const browserShape = toBrowser.get(type);
    if (!browserShape) continue; // not relayed under this name — a different contract
    const allowed = new Set(HUB_ONLY[type] ?? []);
    for (const key of Object.keys(agentShape)) {
      if (allowed.has(key)) continue;
      if (!(key in browserShape)) missing.push(`${type}.${key}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `these fields cross the wire and are then stripped by decodeCentralToBrowser: ${missing.join(', ')}`,
  );
});

test('run_settings carries the level actually in force, both ways', () => {
  // The specific regression, named: `effort` is what somebody pinned,
  // `activeEffort` is what the turn is really running at. A picker that gets
  // only the first cannot tell «nobody chose» from «we do not know».
  const fromAgent = byType(AgentToCentral as unknown as { options: readonly unknown[] });
  const toBrowser = byType(CentralToBrowser as unknown as { options: readonly unknown[] });
  for (const [side, shape] of [
    ['agent→hub', fromAgent.get('run_settings')],
    ['hub→browser', toBrowser.get('run_settings')],
  ] as const) {
    assert.ok(shape, `run_settings missing from ${side}`);
    assert.ok('effort' in shape, `${side} run_settings has no 'effort'`);
    assert.ok('activeEffort' in shape, `${side} run_settings has no 'activeEffort'`);
  }
});
