/**
 * Phase 0 test CLI: resume a dormant session, stream its output, and send one
 * message — proving the resume + stream + input + interrupt loop end-to-end
 * with no network involved.
 *
 * Usage:
 *   npm run resume-test --workspace agent -- --session <id> --message "say hi"
 *   npm run resume-test --workspace agent                 # lists dormant sessions
 *
 * Safety: refuses sessions that are currently LIVE (open in VSCode) unless
 * --force is passed. Tools are DENIED by default (read-only-ish); pass
 * --allow-tools to let the model actually run tools in that project.
 */
import { parseArgs } from 'node:util';
import { buildInventory } from '../sessions.js';
import { ClaudeSessionRun } from '../claude-session.js';

const { values } = parseArgs({
  options: {
    session: { type: 'string' },
    cwd: { type: 'string' },
    message: { type: 'string' },
    'allow-tools': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});

const inventory = await buildInventory({ limit: 50 });

if (!values.session) {
  const dormant = inventory.filter((s) => !s.livePid).slice(0, 15);
  console.log('Pick a session to resume with --session <id>. Dormant sessions:\n');
  for (const s of dormant) {
    console.log(`  ${s.sessionId}  [${s.project ?? '?'}]  ${s.title.replace(/\s+/g, ' ').slice(0, 50)}`);
  }
  process.exit(0);
}

const target = inventory.find((s) => s.sessionId === values.session);
const cwd = values.cwd ?? target?.cwd;
if (!cwd) {
  console.error(`Session ${values.session} not found in inventory and no --cwd given.`);
  process.exit(1);
}
if (target?.livePid && !values.force) {
  console.error(
    `⛔ Session ${values.session} is LIVE (pid=${target.livePid}${target.entrypoint ? `, ${target.entrypoint}` : ''}). ` +
      `Resuming it now would corrupt the transcript. Close it in VSCode or pass --force.`,
  );
  process.exit(1);
}

const message = values.message ?? 'Briefly summarize what this session was about in one sentence.';
console.log(`▶ Resuming ${values.session} in ${cwd}`);
console.log(`  message: ${message}`);
console.log(`  tools: ${values['allow-tools'] ? 'ALLOWED' : 'denied'}\n`);

let settled = false;
function finish(code = 0): void {
  if (settled) return;
  settled = true;
  run.close();
  console.log('\n✔ done');
  process.exit(code);
}

const run = new ClaudeSessionRun({
  sessionId: values.session,
  cwd,
  firstMessage: message,
  handlers: {
    onEvent: (e) => {
      if (e.kind === 'partial') process.stdout.write(e.text ?? '');
      else if (e.kind === 'assistant') {
        /* full text already streamed via partials; skip to avoid dup */
      } else if (e.kind === 'result') {
        console.log(`\n\n■ result: ${e.text}`);
        // Turn finished. In streaming mode the query stays open for more
        // input, so close it explicitly to end the one-shot test.
        finish();
      } else if (e.kind === 'error') {
        console.log(`\n[error] ${e.text ?? ''}`);
        finish(1);
      } else {
        console.log(`\n[${e.kind}] ${e.text ?? ''}`);
      }
    },
    approveTool: async (req) => {
      if (values['allow-tools']) {
        console.log(`\n[tool ✓] ${req.tool} ${JSON.stringify(req.input).slice(0, 120)}`);
        return { allow: true };
      }
      console.log(`\n[tool ✗ denied] ${req.tool}`);
      return { allow: false, message: 'Tools denied in resume-test (pass --allow-tools to enable).' };
    },
  },
});

// Ctrl-C => interrupt the current turn, then close.
process.on('SIGINT', () => {
  console.log('\n^C interrupting…');
  void run.interrupt().finally(() => finish(130));
});

// Safety net so the test never hangs if no result arrives.
setTimeout(() => {
  console.error('\n[timeout] no result within 90s');
  finish(1);
}, 90_000).unref();
