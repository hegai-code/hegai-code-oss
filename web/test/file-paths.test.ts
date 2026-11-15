import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPreviewPaths, isAbsolutePath, isMarkdownPath, fileName } from '../src/render/filePaths.js';

const SHOT = '/tmp/agents-0/-srv-shop-app/296c3cd6-4e13-4628-b670-8e8d7d23976f/scratchpad/mail.png';

test('the screenshot line from an answer', () => {
  assert.deepEqual(findPreviewPaths(`Готово, письмо пришло.\n\nСкриншот: ${SHOT}`), [SHOT]);
});

test('a bare file name is a word, not a path', () => {
  assert.deepEqual(findPreviewPaths('Обновил README.md и CHANGELOG.md'), []);
});

test('relative paths need a slash', () => {
  assert.deepEqual(findPreviewPaths('См. docs/plan.md и web/shots/a.png, ещё ./notes/x.md'), [
    'docs/plan.md',
    'web/shots/a.png',
    './notes/x.md',
  ]);
});

test('backticks, markdown links and brackets', () => {
  assert.deepEqual(findPreviewPaths('Лежит в `/srv/app/out/report.md`.'), ['/srv/app/out/report.md']);
  assert.deepEqual(findPreviewPaths('[скрин](/tmp/a/b.png) и ![x](shots/c.webp)'), ['/tmp/a/b.png', 'shots/c.webp']);
  assert.deepEqual(findPreviewPaths('[Image: source: /tmp/q/p.jpeg]'), ['/tmp/q/p.jpeg']);
});

test('trailing punctuation is not part of the path', () => {
  for (const tail of ['.', ',', ';', ':', ')', '»', '"', "'", '!', '?']) {
    assert.deepEqual(findPreviewPaths(`Смотри /tmp/x/shot.png${tail}`), ['/tmp/x/shot.png'], tail);
  }
  assert.deepEqual(findPreviewPaths('(см. /tmp/x/shot.png).'), ['/tmp/x/shot.png']);
});

test('URLs are not paths', () => {
  assert.deepEqual(findPreviewPaths('https://x.com/a/b.png и http://h/c/d.md'), []);
  assert.deepEqual(findPreviewPaths('[a](https://x.com/a/b.png) но /tmp/ok.png'), ['/tmp/ok.png']);
  assert.deepEqual(findPreviewPaths('www.example.com/a/b.png'), []);
});

test('Windows paths', () => {
  assert.deepEqual(findPreviewPaths('Файл C:\\Users\\p\\shots\\a.PNG готов'), ['C:\\Users\\p\\shots\\a.PNG']);
  assert.deepEqual(findPreviewPaths('D:/out/plan.md.'), ['D:/out/plan.md']);
});

test('only the supported extensions, case-insensitively', () => {
  assert.deepEqual(findPreviewPaths('/a/b.txt /a/b.pdf /a/b.png.bak /a/b.pngx /a/B.MD /a/c.markdown'), [
    '/a/B.MD',
    '/a/c.markdown',
  ]);
});

test('Cyrillic names, dedupe in order, cap at six', () => {
  assert.deepEqual(findPreviewPaths('/tmp/отчёт/итог.md и снова /tmp/отчёт/итог.md'), ['/tmp/отчёт/итог.md']);
  const many = Array.from({ length: 9 }, (_, i) => `/t/${i}.png`).join(' ');
  assert.equal(findPreviewPaths(many).length, 6);
  assert.equal(findPreviewPaths(many)[0], '/t/0.png');
});

test('path kinds', () => {
  assert.ok(isAbsolutePath('/a/b.png') && isAbsolutePath('C:\\a\\b.png') && !isAbsolutePath('a/b.png'));
  assert.ok(isMarkdownPath('x/Y.MD') && isMarkdownPath('a/b.markdown') && !isMarkdownPath('a/b.png'));
  assert.equal(fileName('/a/b/c.png'), 'c.png');
  assert.equal(fileName('C:\\a\\b.png'), 'b.png');
});

test('paths with spaces: delimited spans take the whole span', () => {
  assert.deepEqual(findPreviewPaths('Лежит в `/srv/my dir/скрин 1.png`.'), ['/srv/my dir/скрин 1.png']);
  assert.deepEqual(findPreviewPaths('[скрин](</tmp/a b/c.png>)'), ['/tmp/a b/c.png']);
  assert.deepEqual(findPreviewPaths('Файл «/tmp/a b/plan.md» и "docs/my notes/x.md"'), [
    '/tmp/a b/plan.md',
    'docs/my notes/x.md',
  ]);
  // A quoted sentence that merely ends in a path is not one path.
  assert.deepEqual(findPreviewPaths('«смотри /tmp/x.png»'), ['/tmp/x.png']);
  assert.deepEqual(findPreviewPaths('`npm run shot -- out/a.png`'), ['out/a.png']);
});

test('paths with spaces: one space after a rooted fragment is bridged in plain text', () => {
  assert.deepEqual(findPreviewPaths('Скриншот: /srv/my dir/a.png'), ['/srv/my dir/a.png']);
  // Prose between them is not bridged.
  assert.deepEqual(findPreviewPaths('в /srv/x и docs/a.png'), ['docs/a.png']);
  // A finished file before the space is its own thing.
  assert.deepEqual(findPreviewPaths('/tmp/a.png docs/b.png'), ['/tmp/a.png', 'docs/b.png']);
  assert.deepEqual(findPreviewPaths('см. /srv/x, docs/a.png'), ['docs/a.png']);
});

test('bridging needs a whole rooted word and exactly one space', () => {
  assert.deepEqual(findPreviewPaths('Сохранил в web/dist screenshots/home.png'), ['screenshots/home.png']);
  assert.deepEqual(findPreviewPaths('Папка: /srv/app\ndocs/plan.md'), ['docs/plan.md']);
  assert.deepEqual(findPreviewPaths('`//host/a b.png`'), []);
  assert.deepEqual(findPreviewPaths('Скрин C:\\Users\\John Doe\\shot.png'), ['C:\\Users\\John Doe\\shot.png']);
});
