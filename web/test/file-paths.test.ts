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

test('findFilePaths: videos, pdfs and archives with a slash; pictures are previews', async () => {
  const { findFilePaths, isVideoPath } = await import('../src/render/filePaths.js');
  const t = 'Готово: output/trailer-final/anomalia-story.mp4, отчёт `/srv/x/out/report.pdf` и скрин shots/a.png. Ещё README.md и notes.txt';
  assert.deepEqual(findFilePaths(t), ['output/trailer-final/anomalia-story.mp4', '/srv/x/out/report.pdf']);
  assert.deepEqual(findPreviewPaths(t), ['shots/a.png']);
  assert.equal(isVideoPath('a/b.MP4'), true);
  assert.equal(isVideoPath('a/b.pdf'), false);
});

test('findFilePaths: urls and bare names are not workspace files', async () => {
  const { findFilePaths } = await import('../src/render/filePaths.js');
  assert.deepEqual(findFilePaths('см. https://x.com/a/b.mp4 и video.mp4'), []);
});

test('isMissingFileError: a missing file, a directory or a path outside the readable root hides the chip', async () => {
  const { isMissingFileError } = await import('../src/render/filePaths.js');
  assert.equal(isMissingFileError(new Error("ENOENT: no such file or directory, open 'x'")), true);
  assert.equal(isMissingFileError(new Error('path is a directory')), true);
  assert.equal(isMissingFileError(new Error('socket closed')), false);
  assert.equal(isMissingFileError(new Error('timeout')), false);
  // Outside what this viewer may read is final too: a member of a shared project
  // must not see a chip for a file beyond its root (27.11.2026, /home/agent/data).
  assert.equal(isMissingFileError(new Error('Read-only workspace access.')), true);
  assert.equal(isMissingFileError(new Error('path escapes working directory')), true);
  assert.equal(isMissingFileError(new Error('/x/a.png is outside this project and the temp directory')), true);
});

import { fileLinkTarget, fileOpenErrorText } from '../src/render/filePaths.js';

test('fileLinkTarget: files on the machine', () => {
  const t = fileLinkTarget;
  assert.equal(t('/home/agent/data/a b.pdf'), '/home/agent/data/a b.pdf');
  assert.equal(t('/home/h/%D0%BA.pdf'), '/home/h/к.pdf');
  assert.equal(t('file:///srv/x/%D0%BA%20z.zip'), '/srv/x/к z.zip');
  assert.equal(t('C:\\work\\a.docx'), 'C:\\work\\a.docx');
  assert.equal(t('C:/work/a.docx'), 'C:/work/a.docx');
  assert.equal(t('~/notes/a.md'), null);
  assert.equal(t('content/README.md'), 'content/README.md');
  assert.equal(t('./x.pdf'), './x.pdf');
  assert.equal(t('output/a b/x.zip'), 'output/a b/x.zip');
  assert.equal(t('report.md'), 'report.md');
});

test('fileLinkTarget: line suffixes are cut, the drive colon is not', () => {
  const t = fileLinkTarget;
  assert.equal(t('/home/x/m.mjs:28'), '/home/x/m.mjs');
  assert.equal(t('/home/x/m.mjs:28:3'), '/home/x/m.mjs');
  assert.equal(t('src/a.ts#L12'), 'src/a.ts');
  assert.equal(t('src/a.ts#L12-L20'), 'src/a.ts');
  assert.equal(t('C:/a.ts:5'), 'C:/a.ts');
  assert.equal(t('C:\\a.ts'), 'C:\\a.ts');
  assert.equal(t('/srv/a%zz.txt'), '/srv/a%zz.txt');
});

test('fileLinkTarget: not files', () => {
  const t = fileLinkTarget;
  for (const h of [
    '/w/reports/abc', '/dl/x', 'https://a.com/b.pdf', 'http://x', 'mailto:a@b.c', 'tel:+7',
    'ccremote://connect', '#anchor', '?q=1', '//host/x.pdf', '', 'word', 'www.example.com',
  ]) {
    assert.equal(t(h), null, h);
  }
});

test('fileOpenErrorText', () => {
  const e = fileOpenErrorText;
  const outside = 'Файл вне папки проекта — из приложения его не открыть. Попросите агента выложить файл ссылкой.';
  assert.equal(e(new Error('path escapes working directory'), '/a/b.pdf'), outside);
  assert.equal(e(new Error('Read-only workspace access'), '/a/b.pdf'), outside);
  assert.equal(e(new Error('ENOENT: no such file'), '/a/b.pdf'), 'Файла уже нет: b.pdf');
  assert.equal(e('EISDIR', '/a/dir'), 'Это папка, а не файл: /a/dir');
  assert.match(e(new Error('файл слишком большой для браузера — скопируйте путь'), '/a/b'), /больше 64 МБ/);
  assert.equal(e(new Error('boom'), '/a/b'), 'Не удалось открыть файл: boom');
});

import { resolveFromDir, dirName } from '../src/render/filePaths.js';

test('fileLinkTarget: review fixes', () => {
  const t = fileLinkTarget;
  assert.equal(t('C:%5Cwork%5Ca.docx'), 'C:\\work\\a.docx');
  assert.equal(t('file:///C:/x/a.pdf'), 'C:/x/a.pdf');
  assert.equal(t('report.md:28'), 'report.md');
  assert.equal(t('m-glossary.mjs:28:3'), 'm-glossary.mjs');
  assert.equal(t('example.com:8080'), null);
  assert.equal(t('example.com'), null);
  assert.equal(t('site.ru'), null);
  assert.equal(t('README.md#install'), 'README.md');
  assert.equal(t('docs/README.md#usage'), 'docs/README.md');
  assert.equal(t('/home/u/a.pdf#page=2'), '/home/u/a.pdf');
  assert.equal(t('a.pdf?x=1'), 'a.pdf');
  assert.equal(t('/home/u/a%23b.pdf'), '/home/u/a#b.pdf');
  assert.equal(t('/home/u/a%3Fb.pdf'), '/home/u/a?b.pdf');
});

test('resolveFromDir', () => {
  assert.equal(resolveFromDir('docs/api', 'guide.md'), 'docs/api/guide.md');
  assert.equal(resolveFromDir('docs/api', '../a.md'), 'docs/a.md');
  assert.equal(resolveFromDir('/srv/p/docs', './x.png'), '/srv/p/docs/x.png');
  assert.equal(resolveFromDir('docs', '/home/a.pdf'), '/home/a.pdf');
  assert.equal(resolveFromDir('docs', '~/a.pdf'), '~/a.pdf');
  assert.equal(resolveFromDir('docs', 'C:\\a.pdf'), 'C:\\a.pdf');
  assert.equal(resolveFromDir(null, 'a.md'), 'a.md');
  assert.equal(dirName('docs/api/README.md'), 'docs/api');
  assert.equal(dirName('README.md'), '');
  assert.equal(dirName('/a.md'), '/');
});

test('md urlTransform keeps file hrefs that react-markdown would blank', async () => {
  const { defaultUrlTransform } = await import('react-markdown');
  const { mdUrlTransform } = await import('../src/render/Blocks.js');
  for (const u of ['file:///srv/a.pdf', 'C:\\work\\a.docx', 'C:/work/a.docx', 'm-glossary.mjs:28', 'report.md:12']) {
    assert.equal(defaultUrlTransform(u), '', `default blanks ${u}`);
    assert.equal(mdUrlTransform(u, 'href', defaultUrlTransform), u);
  }
  assert.equal(mdUrlTransform('javascript:alert(1)', 'href', defaultUrlTransform), '');
  assert.equal(mdUrlTransform('https://a.com', 'href', defaultUrlTransform), 'https://a.com');
});
