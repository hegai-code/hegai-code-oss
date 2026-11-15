#!/usr/bin/env node
// Validate frames emitted by the real Kotlin tests against the canonical wire contract.
import { readFile } from 'node:fs/promises';
import { BrowserToCentral } from '../../shared/dist/index.js';
const frames = JSON.parse(await readFile(new URL('../core/build/protocol-frames.json', import.meta.url), 'utf8'));
if (!frames.length) throw new Error('Run :core:test first; no Android frames were exported');
for (const [index, frame] of frames.entries()) {
  const parsed = BrowserToCentral.safeParse(frame);
  if (!parsed.success) throw new Error(`Android frame ${index} (${frame.type}): ${parsed.error}`);
}
const kinds = new Set(frames.map(frame => frame.type));
for (const kind of ['hello', 'rpc_request', 'subscribe', 'unsubscribe', 'new_session', 'open', 'input', 'interrupt', 'tool_decision', 'takeover', 'mirror_open', 'mirror_close', 'set_model', 'set_effort', 'set_permission_mode', 'compact', 'memory_list', 'memory_read', 'memory_delete', 'enrich_request', 'register_push', 'unregister_push', 'end_session', 'session_read', 'stats_interest', 'set_stage']) {
  if (!kinds.has(kind)) throw new Error(`Missing Android protocol coverage: ${kind}`);
}
console.log(`${frames.length} Android frames validated against shared (${[...kinds].sort().join(', ')})`);
