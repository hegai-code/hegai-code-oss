/**
 * image-smoke: verify image attachments survive the wire schemas end to end —
 * browser->central (Open / Input) and central->agent (Input / Takeover).
 * Run: tsx server/src/cli/image-smoke.ts
 */
import { decodeBrowserToCentral, decodeCentralToAgent } from '@cc-remote/shared';

// 1x1 transparent PNG
const DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const img = { media_type: 'image/png' as const, data: DATA };

let failed = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failed++;
}

// browser -> central: input with images
{
  const m = decodeBrowserToCentral(JSON.stringify({ type: 'input', runId: 'r1', text: 'look', images: [img] }));
  check('browser input carries images', m.type === 'input' && m.images?.[0]?.data === DATA);
}
// browser -> central: open with images
{
  const m = decodeBrowserToCentral(
    JSON.stringify({ type: 'open', machineId: 'm1', sessionId: 's1', message: 'hi', images: [img] }),
  );
  check('browser open carries images', m.type === 'open' && m.images?.[0]?.media_type === 'image/png');
}
// central -> agent: input with images
{
  const m = decodeCentralToAgent(JSON.stringify({ type: 'input', runId: 'r1', text: 'look', images: [img] }));
  check('agent input carries images', m.type === 'input' && m.images?.[0]?.data === DATA);
}
// central -> agent: takeover with images
{
  const m = decodeCentralToAgent(
    JSON.stringify({ type: 'takeover', sessionId: 's1', cwd: '/x', runId: 'r1', message: 'hi', images: [img] }),
  );
  check('agent takeover carries images', m.type === 'takeover' && m.images?.[0]?.data === DATA);
}
// absence stays optional (no images field)
{
  const m = decodeCentralToAgent(JSON.stringify({ type: 'input', runId: 'r1', text: 'plain' }));
  check('images optional when absent', m.type === 'input' && m.images === undefined);
}
// bad media type is rejected
{
  let threw = false;
  try {
    decodeBrowserToCentral(JSON.stringify({ type: 'input', runId: 'r1', text: 'x', images: [{ media_type: 'image/tiff', data: DATA }] }));
  } catch {
    threw = true;
  }
  check('bad media_type rejected', threw);
}

// --- SEVERAL attachments at once ----------------------------------------
// The composer staged exactly one image for a long time, so every check above
// happened to pass with a one-element array and could not tell "carries images"
// from "carries AN image". Drop three at once and the difference shows.
const three = [img, img, img];
const file = { name: 'notes.txt', media_type: 'text/plain', data: 'aGVsbG8=' };
{
  const m = decodeBrowserToCentral(
    JSON.stringify({ type: 'input', runId: 'r1', text: 'compare these', images: three }),
  );
  check('browser input keeps ALL images, in order', m.type === 'input' && m.images?.length === 3);
}
{
  const m = decodeCentralToAgent(
    JSON.stringify({ type: 'input', runId: 'r1', text: 'compare these', images: three }),
  );
  check('agent input keeps ALL images', m.type === 'input' && m.images?.length === 3);
}
// Images AND files in one turn: two different transports (inlined into the
// prompt vs written to the machine) riding the same message.
{
  const m = decodeBrowserToCentral(
    JSON.stringify({ type: 'input', runId: 'r1', text: 'both', images: three, files: [file, file] }),
  );
  check(
    'browser input carries images AND files together',
    m.type === 'input' && m.images?.length === 3 && m.files?.length === 2 && m.files?.[0]?.name === 'notes.txt',
  );
}
// Takeover is the Mirror composer's send. The schema allowed attachments all
// along; the browser never sent any until now, so nothing exercised this.
{
  const m = decodeBrowserToCentral(
    JSON.stringify({
      type: 'takeover',
      machineId: 'm1',
      sessionId: 's1',
      message: 'taking over',
      images: three,
      files: [file],
    }),
  );
  check(
    'browser takeover carries images and files',
    m.type === 'takeover' && m.images?.length === 3 && m.files?.length === 1,
  );
}
{
  const m = decodeCentralToAgent(
    JSON.stringify({
      type: 'new_session',
      runId: 'r1',
      cwd: '/x',
      message: 'start with these',
      images: three,
      files: [file, file],
    }),
  );
  check(
    'agent new_session carries images and files',
    m.type === 'new_session' && m.images?.length === 3 && m.files?.length === 2,
  );
}
// A file needs a name — that is what the agent writes it to disk as.
{
  let threw = false;
  try {
    decodeBrowserToCentral(
      JSON.stringify({ type: 'input', runId: 'r1', text: 'x', files: [{ name: '', data: 'aGk=' }] }),
    );
  } catch {
    threw = true;
  }
  check('nameless file rejected', threw);
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nimage-smoke: all checks passed');
