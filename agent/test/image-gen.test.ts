import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Generated pictures, both runtimes: Codex `image_generation_call` and Claude's
 * `hegai-image` CLI through Bash. Synthetic fixtures only.
 */

const HOME = await mkdtemp(join(tmpdir(), 'image-gen-home-'));
process.env['HOME'] = HOME;
const codexHome = join(HOME, 'codex');
process.env['CODEX_HOME'] = codexHome;

const {
  ImageGenLedger,
  ImageGenLiveTracker,
  isImageGenCommand,
  lastMeaningfulLine,
  MAX_IMAGES_PER_CALL,
  parseGenRef,
  parseImageGenCall,
  parseImageGenCalls,
  parseImageOutputs,
  shellWords,
} = await import('../src/image-gen.js');
const { parseCodexLines, loadCodexImage } = await import('../src/codex.js');
const { loadImage, readClaudeHistory, resetClaudeParseCache, readClaudeTranscript } = await import('../src/history.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
const PNG_B64 = PNG.toString('base64');

// ---------------------------------------------------------------- command parsing

test('hegai-image generation is recognised, health and look-alikes are not', () => {
  assert.equal(isImageGenCommand('hegai-image "кот" out.png'), true);
  assert.equal(isImageGenCommand('cd /x && /usr/local/bin/hegai-image "cat" out.png --size 1088x1360'), true);
  assert.equal(isImageGenCommand('for i in 1 2; do hegai-image "p" o$i.png; done'), true);
  assert.equal(isImageGenCommand('(hegai-image "p" a.png)'), true);
  assert.equal(isImageGenCommand('hegai-image health'), false);
  assert.equal(isImageGenCommand('echo hegai-imagery "x"'), false);
  assert.equal(isImageGenCommand('ls'), false);
  assert.equal(isImageGenCommand(undefined), false);
});

test('shellWords honours quotes and keeps operators apart', () => {
  assert.deepEqual(shellWords(`a "b c" 'd e' f\\ g;h&&i`), ['a', 'b c', 'd e', 'f g', ';', 'h', '&&', 'i']);
  assert.deepEqual(shellWords(`x "say \\"hi\\"" ''`), ['x', 'say "hi"', '']);
});

test('prompt and output argument are the first two positionals, options skipped', () => {
  assert.deepEqual(parseImageGenCall('hegai-image "Рыжий кот на крыше" out.png --size 1088x1360'), {
    prompt: 'Рыжий кот на крыше',
    out: 'out.png',
  });
  assert.deepEqual(parseImageGenCall(`cd /w && hegai-image --size 1x1 'a b' x.png --ref s.png --ref t.png`), {
    prompt: 'a b',
    out: 'x.png',
    dir: '/w',
  });
  assert.deepEqual(parseImageGenCall('/usr/local/bin/hegai-image "p" /tmp/o.png | tee log'), { prompt: 'p', out: '/tmp/o.png' });
  // a variable prompt is unknowable — no caption rather than a wrong one
  assert.deepEqual(parseImageGenCall('hegai-image "$P" o.png'), { out: 'o.png' });
  // health first, a real generation later
  assert.deepEqual(parseImageGenCall('hegai-image health && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png' });
  // one level into bash -c
  assert.deepEqual(parseImageGenCall(`bash -c 'hegai-image "deep" d.png'`), { prompt: 'deep', out: 'd.png' });
  assert.equal(parseImageGenCall('ls -la'), undefined);
});

test('a hegai-image line inside a here-document is script text, not a call', () => {
  // 11.11.2026: `cat > gen.sh <<'EOF' … hegai-image … gen/$n.png … EOF` drew two
  // cards that could never resolve.
  const script = [
    "mkdir -p gen && cat > gen.sh <<'EOF'",
    '#!/bin/bash',
    'hegai-image "$BASE" gen/$n.png --size 1024x1024 && echo "$n ok"',
    'EOF',
    'chmod +x gen.sh; ./gen.sh front > gen/log.txt',
  ].join('\n');
  assert.deepEqual(parseImageGenCalls(script), []);
  for (const open of ['<<EOF', '<< "EOF"', '<<-EOF', '<<\\EOF']) {
    const body = open === '<<-EOF' ? '\thegai-image "p" a.png\n\tEOF' : 'hegai-image "p" a.png\nEOF';
    assert.deepEqual(parseImageGenCalls(`cat > x.sh ${open}\n${body}\nhegai-image "q" b.png`), [{ prompt: 'q', out: 'b.png' }], open);
  }
  // a delimiter that never closes swallows the rest, as bash does
  assert.deepEqual(parseImageGenCalls('cat <<EOF\nhegai-image "p" a.png'), []);
  // `<<<` is a here-string, and a quoted `<<` is text: neither opens a body
  assert.deepEqual(parseImageGenCalls('cat <<< x\nhegai-image "p" a.png'), [{ prompt: 'p', out: 'a.png' }]);
  assert.deepEqual(parseImageGenCalls('echo "<<EOF"\nhegai-image "p" a.png'), [{ prompt: 'p', out: 'a.png' }]);
  // a shell reading the here-document runs it; a script file reading it does not
  assert.deepEqual(parseImageGenCalls("cd /w && bash <<'EOF'\nhegai-image \"p\" a.png\nEOF"), [{ prompt: 'p', out: 'a.png', dir: '/w' }]);
  assert.deepEqual(parseImageGenCalls('bash run.sh <<EOF\nhegai-image "p" a.png\nEOF'), []);
  // empty and ANSI-C quoted delimiters
  assert.deepEqual(parseImageGenCalls("cat <<''\nhegai-image \"p\" a.png\n\nhegai-image \"q\" b.png"), [{ prompt: 'q', out: 'b.png' }]);
  assert.deepEqual(parseImageGenCalls("cat <<$'EOF'\nhegai-image \"p\" a.png\nEOF\nhegai-image \"q\" b.png"), [{ prompt: 'q', out: 'b.png' }]);
  // an arithmetic shift and a comment are not here-documents either
  assert.deepEqual(parseImageGenCalls('n=$((1<<3))\nhegai-image "p" a.png'), [{ prompt: 'p', out: 'a.png' }]);
  assert.deepEqual(parseImageGenCalls('# like cat <<EOF)\nhegai-image "p" a.png'), [{ prompt: 'p', out: 'a.png' }]);
});

test('only a command-position generation counts; mentions, health and help do not', () => {
  const no = [
    'grep hegai-image notes.md',
    'echo hegai-image "x" o.png',
    'which hegai-image',
    'cat /usr/local/bin/hegai-image',
    'hegai-image health',
    'hegai-image --help',
    'hegai-image -h',
    'hegai-image generate --help',
    'hegai-image generate "only a prompt"',
    'hegai-image "only a prompt"',
    'hegai-image',
    'hegai-image generate',
    'xargs hegai-image "p" o.png',
    "echo 'hegai-image \"p\" o.png'",
  ];
  for (const c of no) {
    assert.equal(parseImageGenCall(c), undefined, c);
    assert.equal(isImageGenCommand(c), false, c);
  }
  // the real CLI grammar: optional `generate`, value options, --opt=value, flags
  assert.deepEqual(parseImageGenCall('hegai-image generate "p" o.png --quality high --force'), { prompt: 'p', out: 'o.png' });
  assert.deepEqual(parseImageGenCall('hegai-image --quality low --size=1x1 --force "p" o.png'), { prompt: 'p', out: 'o.png' });
  assert.deepEqual(parseImageGenCall('hegai-image "p" o.png --ref a.png --ref b.png'), { prompt: 'p', out: 'o.png' });
  assert.deepEqual(parseImageGenCall('FOO=1 timeout 300 hegai-image "p" o.png'), { prompt: 'p', out: 'o.png' });
  assert.deepEqual(parseImageGenCall('if true; then hegai-image "p" o.png; fi'), { prompt: 'p', out: 'o.png' });
  assert.deepEqual(parseImageGenCall('x=$(hegai-image "p" o.png)'), { prompt: 'p', out: 'o.png' });
});

test('cd before the call is recorded; ~ expands, $var is unknowable', () => {
  assert.deepEqual(parseImageGenCall('cd /a && cd b && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dir: '/a/b' });
  assert.deepEqual(parseImageGenCall('cd sub && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dir: 'sub' });
  assert.deepEqual(parseImageGenCall('cd ~/pics && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dir: join(HOME, 'pics') });
  assert.deepEqual(parseImageGenCall('cd "$OUT" && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('cd /a; cd $X; hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  // a cd AFTER the call does not apply to it
  assert.deepEqual(parseImageGenCall('hegai-image "p" o.png && cd /late'), { prompt: 'p', out: 'o.png' });
  assert.deepEqual(parseImageGenCall(`cd /w && bash -c 'hegai-image "p" o.png'`), { prompt: 'p', out: 'o.png', dir: '/w' });
});

test('variables the command set itself are expanded in cd and the output path', () => {
  // the shape that lost pictures on 07.11.2026
  assert.deepEqual(parseImageGenCall('S=/tmp/x/scratchpad; cd $S && hegai-image "p" mock/a.png'), { prompt: 'p', out: 'mock/a.png', dir: '/tmp/x/scratchpad' });
  assert.deepEqual(parseImageGenCall('S=/w; cd "${S}/sub" && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dir: '/w/sub' });
  assert.deepEqual(parseImageGenCall('export D=/w; cd $D; hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dir: '/w' });
  assert.deepEqual(parseImageGenCall('A=/w; B=$A/b; cd $B && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dir: '/w/b' });
  assert.deepEqual(parseImageGenCall('S=~/pics; cd $S && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dir: join(HOME, 'pics') });
  assert.deepEqual(parseImageGenCall('cd $HOME && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dir: HOME });
  assert.deepEqual(parseImageGenCall('S=/w; hegai-image "p" "$S/mock/a.png"'), { prompt: 'p', out: '/w/mock/a.png' });
  // two calls in one command keep their own output paths
  assert.deepEqual(
    parseImageGenCalls('S=/w; cd $S && hegai-image "a" mock/a.png && hegai-image "b" mock/b.png').map((c) => [c.out, c.dir]),
    [['mock/a.png', '/w'], ['mock/b.png', '/w']],
  );
  // still unknowable: a prefix assignment is the command's env, not ours; command
  // substitution; a name reassigned to something we cannot know; a partial word
  assert.deepEqual(parseImageGenCall('S=/w cd $S && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('S=$(mktemp -d); cd $S && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('S=/w; S=$Q; cd $S && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('cd a$X && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('S=`mktemp -d`; cd $S && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('S=; cd $S && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('P=/w; P+=/sub; cd $P && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('S=/w; for S in /a /b; do cd $S && hegai-image "p" o.png; done'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('S=/w; read S; cd $S && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('unset HOME; cd $HOME && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  assert.deepEqual(parseImageGenCall('S=/w; export S+=/sub; cd $S && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dirUnknown: true });
  // export expands every value first; a subshell keeps its assignments and cd
  assert.deepEqual(parseImageGenCall('A=/old; export A=/new B=$A/sub; cd $B && hegai-image "p" o.png'), { prompt: 'p', out: 'o.png', dir: '/old/sub' });
  assert.deepEqual(
    parseImageGenCalls('S=/o; (S=/i; cd /x; hegai-image "a" "$S/a.png"); hegai-image "b" "$S/b.png"').map((c) => [c.out, c.dir]),
    [['/i/a.png', '/x'], ['/o/b.png', undefined]],
  );
  // an unknown variable in the output path stays as typed
  assert.deepEqual(parseImageGenCall('for f in a b; do hegai-image "p" $f.png; done'), { prompt: 'p', out: '$f.png' });
});

test('output lines: every match, in order; noise ignored', () => {
  const out = [
    'rendering…',
    'out.png 1122x1402 1834 KB 47s',
    'my dir/b.JPG 1024x1024 12 KB 3s',
    'saved to /tmp/zzz.png',
    'c.webp 10x10 1KB 1s',
  ].join('\n');
  assert.deepEqual(parseImageOutputs(out), ['out.png', 'my dir/b.JPG', 'c.webp']);
  assert.deepEqual(parseImageOutputs('429 image generator is busy'), []);
});

test('lastMeaningfulLine takes the last real line and truncates', () => {
  assert.equal(lastMeaningfulLine('a\nboom: 502\n\n  \n'), 'boom: 502');
  assert.equal(lastMeaningfulLine('x'.repeat(500)).length, 300);
  assert.equal(lastMeaningfulLine(''), '');
});

test('gen refs parse strictly', () => {
  assert.deepEqual(parseGenRef('gen:toolu_01AbC#2'), { toolUseId: 'toolu_01AbC', n: 2 });
  assert.equal(parseGenRef('gen:../etc#0'), null);
  assert.equal(parseGenRef('gen:toolu_1'), null);
  assert.equal(parseGenRef('msg_1#0'), null);
});

// ---------------------------------------------------------------- live tracker

test('live: started on the call, done per output line on the result', () => {
  const t = new ImageGenLiveTracker();
  assert.deepEqual(t.toolUse('t0', 'Read', { command: 'hegai-image "x" a.png' }), []);
  assert.deepEqual(t.toolUse('t0', 'Bash', { command: 'ls' }), []);
  const started = t.toolUse('t1', 'Bash', { command: 'hegai-image "cat" a.png && hegai-image "dog" b.png' }, 1000);
  assert.equal(started.length, 1);
  assert.equal(started[0]!.code, 'image_gen');
  assert.deepEqual(started[0]!.data, { id: 't1#0', state: 'started', startedAt: 1000, prompt: 'cat' });
  const done = t.toolResult('t1', 'a.png 1x1 5 KB 2s\nb.png 1x1 6 KB 3s', false);
  assert.deepEqual(
    done.map((e) => [e.data.id, e.data.state, e.data.ref, e.data.startedAt]),
    [
      ['t1#0', 'done', 'gen:t1#0', 1000],
      ['t1#1', 'done', 'gen:t1#1', 1000],
    ],
  );
  assert.deepEqual(t.toolResult('t1', 'a.png 1x1 5 KB 2s', false), [], 'a result is consumed once');
  assert.deepEqual(t.toolResult('unknown', 'a.png 1x1 5 KB 2s', false), []);
});

test('several calls in one command: each picture gets its own prompt; unmatched gets none', () => {
  const t = new ImageGenLiveTracker();
  t.toolUse('t5', 'Bash', { command: 'cd a && hegai-image "cat" a.png; cd ../b && hegai-image "dog" b.png' }, 1);
  const done = t.toolResult('t5', 'a.png 1x1 5 KB 2s\nb.png 1x1 6 KB 3s\nzzz.png 1x1 1 KB 1s', false);
  assert.deepEqual(done.map((e) => e.data.prompt), ['cat', 'dog', undefined]);
});

test('output parsing is bounded: untrusted stdout cannot fan out', () => {
  const many = Array.from({ length: 500 }, (_, i) => `f${i}.png 1x1 1 KB 1s`).join('\n');
  assert.equal(parseImageOutputs(many).length, MAX_IMAGES_PER_CALL);
});

test('live: a turn that ends with a call still open closes its card as failed', () => {
  const t = new ImageGenLiveTracker();
  t.toolUse('t9', 'Bash', { command: 'hegai-image "fox" f.png' }, 500);
  const closed = t.abandon();
  assert.deepEqual(
    closed.map((e) => [e.data.id, e.data.state, e.data.error, e.data.startedAt]),
    [['t9#0', 'failed', 'генерация прервана', 500]],
  );
  assert.deepEqual(t.abandon(), [], 'abandoned once');
  assert.deepEqual(t.toolResult('t9', 'f.png 1x1 5 KB 2s', false), [], 'a late result opens nothing');
});

test('live and ledger: a background Bash call and a mere mention are ignored entirely', () => {
  const t = new ImageGenLiveTracker();
  assert.deepEqual(t.toolUse('b1', 'Bash', { command: 'hegai-image "p" a.png', run_in_background: true }), []);
  assert.deepEqual(t.toolResult('b1', 'a.png 1x1 5 KB 2s', false), [], 'no started, so no done and no failed');
  assert.deepEqual(t.toolUse('b2', 'Bash', { command: 'grep hegai-image notes.md' }), []);
  assert.deepEqual(t.toolResult('b2', 'nothing', false), []);
  assert.deepEqual(t.toolUse('b3', 'Bash', { command: 'hegai-image health' }), []);
  assert.equal(t.toolUse('b4', 'Bash', { command: 'hegai-image "p" a.png', run_in_background: false }).length, 1);

  const ledger = new ImageGenLedger();
  const bg = JSON.parse(call('/w', 'a1', 'bg1', 'hegai-image "p" a.png'));
  bg.message.content[0].input.run_in_background = true;
  ledger.observe(bg);
  assert.deepEqual(ledger.observe(JSON.parse(result('/w', 'u1', 'bg1', 'a.png 1x1 5 KB 2s'))), []);
  ledger.observe(JSON.parse(call('/w', 'a2', 'm1', 'echo hegai-image "p" a.png')));
  assert.deepEqual(ledger.observe(JSON.parse(result('/w', 'u2', 'm1', 'a.png 1x1 5 KB 2s'))), []);
});

test('live: no output line or an error is a failure of #0 with the last line', () => {
  const t = new ImageGenLiveTracker();
  t.toolUse('t2', 'Bash', { command: 'hegai-image "p" a.png' }, 5);
  const [failed] = t.toolResult('t2', 'working\nhegai-image: 502 render failed', true);
  assert.equal(failed!.data.state, 'failed');
  assert.equal(failed!.data.id, 't2#0');
  assert.equal(failed!.data.error, 'hegai-image: 502 render failed');
  assert.equal(failed!.data.ref, undefined);
  t.toolUse('t3', 'Bash', { command: 'hegai-image "p" a.png' });
  assert.equal(t.toolResult('t3', 'nothing useful', false)[0]!.data.state, 'failed');
});

// ---------------------------------------------------------------- Claude history

const at = (s: number) => new Date(Date.UTC(2026, 9, 24, 12, 0, s)).toISOString();
const row = (cwd: string, r: Record<string, unknown>) => JSON.stringify({ isSidechain: false, sessionId: 's', cwd, ...r });
const call = (cwd: string, uuid: string, id: string, command: string) =>
  row(cwd, {
    type: 'assistant', uuid, parentUuid: null, timestamp: at(1),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
const result = (cwd: string, uuid: string, id: string, text: string, isError = false) =>
  row(cwd, {
    type: 'user', uuid, parentUuid: null, timestamp: at(2),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] },
  });

test('history: a hegai-image result is followed by a synthetic assistant picture message', () => {
  const ledger = new ImageGenLedger();
  assert.deepEqual(ledger.observe(JSON.parse(call('/w', 'a1', 'tu1', 'hegai-image "cat" a.png')), 1), []);
  const out = ledger.observe(JSON.parse(result('/w', 'u1', 'tu1', 'a.png 10x10 5 KB 2s\nb.png 10x10 5 KB 2s')), 2);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    type: 'assistant',
    uuid: 'u1:gen:tu1',
    ts: 2,
    blocks: [
      { kind: 'image', ref: 'gen:tu1#0', generated: true, prompt: 'cat' },
      { kind: 'image', ref: 'gen:tu1#1', generated: true, prompt: 'cat' },
    ],
  });
  // a result whose call was never seen is NOT guessed from its text
  assert.deepEqual(new ImageGenLedger().observe(JSON.parse(result('/w', 'u2', 'zz', 'a.png 10x10 5 KB 2s')), 2), []);
  // errors and plain Bash calls make nothing
  const l2 = new ImageGenLedger();
  l2.observe(JSON.parse(call('/w', 'a3', 'tu3', 'hegai-image "p" a.png')));
  assert.deepEqual(l2.observe(JSON.parse(result('/w', 'u3', 'tu3', 'a.png 10x10 5 KB 2s', true))), []);
  l2.observe(JSON.parse(call('/w', 'a4', 'tu4', 'ls')));
  assert.deepEqual(l2.observe(JSON.parse(result('/w', 'u4', 'tu4', 'a.png 10x10 5 KB 2s'))), []);
});

/** Set a file's mtime to second `sec` of the fixtures' clock (`at`). */
const stamp = (file: string, sec: number) => {
  const d = new Date(Date.UTC(2026, 9, 24, 12, 0, 0) + sec * 1000);
  return utimes(file, d, d);
};

const SESSION = '00000000-0000-4000-8000-0000000000aa';
const PROJECT = join(HOME, '.claude', 'projects', '-tmp-gen');

async function withTranscript(lines: string[], fn: (file: string) => Promise<void>): Promise<void> {
  await mkdir(PROJECT, { recursive: true });
  resetClaudeParseCache();
  const file = join(PROJECT, `${SESSION}.jsonl`);
  await writeFile(file, `${lines.join('\n')}\n`);
  try {
    await fn(file);
  } finally {
    resetClaudeParseCache();
    await rm(PROJECT, { recursive: true, force: true });
  }
}

test('history reader inserts the picture message right after the result, stably', async () => {
  const work = await mkdtemp(join(tmpdir(), 'gen-work-'));
  try {
    await writeFile(join(work, 'out.png'), PNG);
    await stamp(join(work, 'out.png'), 1.5);
    const lines = [
      call(work, 'a1', 'toolu_X1', 'hegai-image "cat" out.png'),
      result(work, 'u1', 'toolu_X1', 'out.png 10x10 5 KB 2s'),
    ];
    await withTranscript(lines, async (file) => {
      const one = await readClaudeHistory(file, Infinity);
      assert.deepEqual(one.map((m) => m.uuid), ['a1', 'u1', 'u1:gen:toolu_X1']);
      assert.equal(one[2]!.type, 'assistant');
      assert.deepEqual(one[2]!.blocks, [{ kind: 'image', ref: 'gen:toolu_X1#0', generated: true, prompt: 'cat' }]);
      assert.deepEqual(await readClaudeHistory(file, Infinity), one, 'same bytes, same messages');
      assert.deepEqual((await readClaudeTranscript(SESSION))?.messages, one, 'incremental parse equals the one-shot');
      // the loader resolves the ref from the transcript, relative to the call's cwd
      const img = await loadImage(SESSION, 'gen:toolu_X1#0');
      assert.deepEqual(img, { mediaType: 'image/png', dataB64: PNG_B64 });
      assert.equal(await loadImage(SESSION, 'gen:toolu_X1#1'), null, 'no such output line');
      assert.equal(await loadImage(SESSION, 'gen:toolu_nope#0'), null);
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('loader: before the result exists it falls back to the command output argument', async () => {
  const work = await mkdtemp(join(tmpdir(), 'gen-work-'));
  try {
    await writeFile(join(work, 'early.png'), PNG);
    await stamp(join(work, 'early.png'), 2);
    await withTranscript([call(work, 'a1', 'toolu_E1', 'hegai-image "p" early.png')], async () => {
      assert.deepEqual(await loadImage(SESSION, 'gen:toolu_E1#0'), { mediaType: 'image/png', dataB64: PNG_B64 });
      assert.equal(await loadImage(SESSION, 'gen:toolu_E1#1'), null);
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('loader: cd before the call decides where a relative output lives', async () => {
  const work = await mkdtemp(join(tmpdir(), 'gen-work-'));
  try {
    await mkdir(join(work, 'sub'));
    await writeFile(join(work, 'sub', 'o.png'), PNG);
    await stamp(join(work, 'sub', 'o.png'), 1.5);
    await writeFile(join(work, 'o.png'), 'a decoy in the record cwd, not an image');
    await stamp(join(work, 'o.png'), 1.5);
    const lines = [
      call(work, 'a1', 'toolu_C1', 'cd sub && hegai-image "p" o.png'),
      result(work, 'u1', 'toolu_C1', 'o.png 1x1 1 KB 1s'),
      call(work, 'a2', 'toolu_C2', 'cd "$WHERE" && hegai-image "p" o.png'),
      result(work, 'u2', 'toolu_C2', 'o.png 1x1 1 KB 1s'),
      call(work, 'a3', 'toolu_C3', `cd "$WHERE" && hegai-image "p" ${join(work, 'sub', 'o.png')}`),
      result(work, 'u3', 'toolu_C3', `${join(work, 'sub', 'o.png')} 1x1 1 KB 1s`),
    ];
    await withTranscript(lines, async () => {
      assert.deepEqual(await loadImage(SESSION, 'gen:toolu_C1#0'), { mediaType: 'image/png', dataB64: PNG_B64 });
      assert.equal(await loadImage(SESSION, 'gen:toolu_C2#0'), null, 'unresolvable dir + relative path');
      assert.deepEqual(await loadImage(SESSION, 'gen:toolu_C3#0'), { mediaType: 'image/png', dataB64: PNG_B64 }, 'absolute path needs no dir');
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('loader: a stale file (older than the call, or long after its result) is not served', async () => {
  const work = await mkdtemp(join(tmpdir(), 'gen-work-'));
  try {
    for (const f of ['old.png', 'fresh.png', 'late.png', 'skew.png']) await writeFile(join(work, f), PNG);
    await stamp(join(work, 'old.png'), -3600); // an earlier run under the same name
    await stamp(join(work, 'fresh.png'), 1.5);
    await stamp(join(work, 'late.png'), 2 + 121); // rewritten by something else long after
    await stamp(join(work, 'skew.png'), 1 - 4); // within the 5 s margin
    const lines = [
      call(work, 'a1', 'toolu_S1', 'hegai-image "p" old.png'),
      result(work, 'u1', 'toolu_S1', 'old.png 1x1 1 KB 1s'),
      call(work, 'a2', 'toolu_S2', 'hegai-image "p" fresh.png'),
      result(work, 'u2', 'toolu_S2', 'fresh.png 1x1 1 KB 1s'),
      call(work, 'a3', 'toolu_S3', 'hegai-image "p" late.png'),
      result(work, 'u3', 'toolu_S3', 'late.png 1x1 1 KB 1s'),
      call(work, 'a4', 'toolu_S4', 'hegai-image "p" skew.png'),
      result(work, 'u4', 'toolu_S4', 'skew.png 1x1 1 KB 1s'),
      // no result record yet: only the lower bound applies
      call(work, 'a5', 'toolu_S5', 'hegai-image "p" old.png'),
    ];
    await withTranscript(lines, async () => {
      assert.equal(await loadImage(SESSION, 'gen:toolu_S1#0'), null, 'older than the call');
      assert.ok(await loadImage(SESSION, 'gen:toolu_S2#0'));
      assert.equal(await loadImage(SESSION, 'gen:toolu_S3#0'), null, 'more than 120 s after the result');
      assert.ok(await loadImage(SESSION, 'gen:toolu_S4#0'), '5 s clock margin');
      assert.equal(await loadImage(SESSION, 'gen:toolu_S5#0'), null, 'pending call, stale file');
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('loader: a background call is not a generation', async () => {
  const work = await mkdtemp(join(tmpdir(), 'gen-work-'));
  try {
    await writeFile(join(work, 'o.png'), PNG);
    await stamp(join(work, 'o.png'), 1.5);
    const bg = JSON.parse(call(work, 'a1', 'toolu_B1', 'hegai-image "p" o.png'));
    bg.message.content[0].input.run_in_background = true;
    await withTranscript([JSON.stringify(bg), result(work, 'u1', 'toolu_B1', 'o.png 1x1 1 KB 1s')], async () => {
      assert.equal(await loadImage(SESSION, 'gen:toolu_B1#0'), null);
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('loader refuses a file that is not an image, is too odd, or a non-generation call', async () => {
  const work = await mkdtemp(join(tmpdir(), 'gen-work-'));
  try {
    await writeFile(join(work, 'fake.png'), 'this is a text file, not a picture');
    await writeFile(join(work, 'empty.png'), '');
    await mkdir(join(work, 'dir.png'));
    await symlink('/etc/passwd', join(work, 'link.png'));
    // even a link to a genuine fresh PNG: the name is opened without following
    await writeFile(join(work, 'real.png'), PNG);
    await stamp(join(work, 'real.png'), 1.5);
    await symlink(join(work, 'real.png'), join(work, 'alias.png'));
    const lines = [
      call(work, 'a1', 'toolu_F1', 'hegai-image "p" fake.png'),
      result(work, 'u1', 'toolu_F1', 'fake.png 1x1 1 KB 1s'),
      call(work, 'a2', 'toolu_F2', 'hegai-image "p" empty.png'),
      result(work, 'u2', 'toolu_F2', 'empty.png 1x1 1 KB 1s'),
      call(work, 'a3', 'toolu_F3', 'hegai-image "p" dir.png'),
      result(work, 'u3', 'toolu_F3', 'dir.png 1x1 1 KB 1s'),
      call(work, 'a4', 'toolu_F4', 'hegai-image "p" link.png'),
      result(work, 'u4', 'toolu_F4', 'link.png 1x1 1 KB 1s'),
      // the model printing an arbitrary absolute path does not make a plain Bash call a generation
      call(work, 'a5', 'toolu_F5', 'echo "/etc/passwd.png 1x1 1 KB 1s"'),
      result(work, 'u5', 'toolu_F5', '/etc/passwd.png 1x1 1 KB 1s'),
      call(work, 'a6', 'toolu_F6', 'hegai-image "p" out.png'),
      result(work, 'u6', 'toolu_F6', 'boom', true),
      call(work, 'a7', 'toolu_F7', 'hegai-image "p" alias.png'),
      result(work, 'u7', 'toolu_F7', 'alias.png 1x1 1 KB 1s'),
    ];
    await withTranscript(lines, async () => {
      for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']) {
        assert.equal(await loadImage(SESSION, `gen:toolu_${id}#0`), null, id);
      }
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Codex

const igLine = (over: Record<string, unknown> = {}, meta?: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: '2026-10-24T10:00:00.000Z',
    type: 'response_item',
    ...(meta ? { metadata: meta } : {}),
    payload: {
      type: 'image_generation_call',
      id: 'ig_abc123',
      status: 'completed',
      revised_prompt: 'A red cat on a roof',
      result: PNG_B64,
      ...over,
    },
  });

test('codex: a completed image_generation_call becomes one generated image block', () => {
  const [m] = parseCodexLines(igLine());
  assert.equal(m!.type, 'assistant');
  assert.match(m!.uuid, /^codex-[0-9a-f]{32}$/);
  assert.deepEqual(m!.blocks, [{ kind: 'image', ref: 'gen:ig_abc123', generated: true, prompt: 'A red cat on a roof' }]);
  assert.equal(m!.ts, Date.parse('2026-10-24T10:00:00.000Z'));
  assert.equal(JSON.stringify(m).includes(PNG_B64), false, 'the bytes never enter the history');
});

test('codex: junk prompt omitted; incomplete, empty, fileId-only and compaction records yield nothing', () => {
  assert.deepEqual(parseCodexLines(igLine({ revised_prompt: 'No image requested' }))[0]!.blocks, [
    { kind: 'image', ref: 'gen:ig_abc123', generated: true },
  ]);
  assert.deepEqual(parseCodexLines(igLine({ revised_prompt: '' }))[0]!.blocks, [
    { kind: 'image', ref: 'gen:ig_abc123', generated: true },
  ]);
  assert.deepEqual(parseCodexLines(igLine({ status: 'generating' })), []);
  assert.deepEqual(parseCodexLines(igLine({ result: '', fileId: 'file_1' })), []);
  assert.deepEqual(parseCodexLines(igLine({ id: undefined })), []);
  assert.deepEqual(parseCodexLines(igLine({}, { compaction_output: true })), []);
  assert.equal(parseCodexLines(igLine({}, { compaction_output: false })).length, 1);
});

test('codex loader streams the rollout for gen:<id>, sniffs the type, skips compaction scratch', async () => {
  const dir = join(codexHome, 'sessions', '2026', '10', '24');
  await mkdir(dir, { recursive: true });
  const sessionId = '22222222-2222-2222-2222-222222222222';
  const JPEG_B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg body')]).toString('base64');
  const big = Buffer.concat([PNG, Buffer.alloc(1_500_000, 7)]).toString('base64'); // a >1 MB line
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/p' } }),
    igLine({ id: 'ig_scratch', result: PNG_B64 }, { compaction_output: true }),
    igLine({ id: 'ig_big', result: big }),
    igLine({ id: 'ig_jpeg', result: JPEG_B64 }),
    igLine({ id: 'ig_file', result: '', fileId: 'file_9' }),
  ];
  await writeFile(join(dir, `rollout-2026-10-24T10-00-00-${sessionId}.jsonl`), `${lines.join('\n')}\n`);
  try {
    assert.deepEqual(await loadCodexImage(sessionId, 'gen:ig_big'), { mediaType: 'image/png', dataB64: big });
    assert.deepEqual(await loadCodexImage(sessionId, 'gen:ig_jpeg'), { mediaType: 'image/jpeg', dataB64: JPEG_B64 });
    assert.equal(await loadCodexImage(sessionId, 'gen:ig_file'), null);
    assert.equal(await loadCodexImage(sessionId, 'gen:ig_scratch'), null);
    assert.equal(await loadCodexImage(sessionId, 'gen:ig_missing'), null);
    assert.equal(await loadCodexImage(sessionId, 'gen:../x'), null);
  } finally {
    await rm(join(codexHome, 'sessions'), { recursive: true, force: true });
  }
});

test('codex loader: leaving the rollout early does not leak file descriptors', async () => {
  const dir = join(codexHome, 'sessions', '2026', '10', '25');
  await mkdir(dir, { recursive: true });
  const sessionId = '33333333-3333-3333-3333-333333333333';
  const filler = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: 'event_msg', payload: { n: i, pad: 'x'.repeat(200) } }));
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/p' } }),
    igLine({ id: 'ig_early', result: PNG_B64 }),
    ...filler, // read but never reached: the loader returns at the line above
  ];
  await writeFile(join(dir, `rollout-2026-10-25T10-00-00-${sessionId}.jsonl`), `${lines.join('\n')}\n`);
  try {
    const fds = async () => (await readdir('/proc/self/fd')).length;
    await loadCodexImage(sessionId, 'gen:ig_early'); // warm up
    await new Promise((r) => setTimeout(r, 50));
    const before = await fds();
    for (let i = 0; i < 40; i++) {
      assert.ok(await loadCodexImage(sessionId, 'gen:ig_early'));
      assert.equal(await loadCodexImage(sessionId, 'gen:ig_nope'), null);
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.ok((await fds()) - before < 5, `fds grew from ${before} to ${await fds()}`);
  } finally {
    await rm(join(codexHome, 'sessions'), { recursive: true, force: true });
  }
});
