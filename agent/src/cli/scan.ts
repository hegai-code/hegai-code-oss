/**
 * Phase 0 test CLI: print this machine's Claude Code session inventory,
 * flagging sessions that are currently live (held by a running process such
 * as the VSCode extension) — those must not be resumed.
 *
 * Usage: npm run scan --workspace agent [-- --limit 30 --all]
 */
import { parseArgs } from 'node:util';
import { buildInventory } from '../sessions.js';

const { values } = parseArgs({
  options: {
    limit: { type: 'string' },
    all: { type: 'boolean', default: false }, // include programmatic/headless
  },
});

const limit = values.limit ? Number(values.limit) : 40;
const sessions = await buildInventory({
  limit,
  includeProgrammatic: values.all,
  includeEphemeral: values.all,
});

if (sessions.length === 0) {
  console.log('No sessions found under ~/.claude/projects');
  process.exit(0);
}

console.log(`Found ${sessions.length} session(s) (most recent first):\n`);
for (const s of sessions) {
  const when = new Date(s.lastModified).toISOString().replace('T', ' ').slice(0, 19);
  const liveFlag = s.livePid
    ? `  ⛔ LIVE pid=${s.livePid}${s.entrypoint ? ` (${s.entrypoint})` : ''}`
    : '';
  const title = s.title.replace(/\s+/g, ' ').slice(0, 64);
  console.log(`${when}  ${s.sessionId}`);
  console.log(`   ${s.project ?? '?'}  ${title}${liveFlag}`);
}
