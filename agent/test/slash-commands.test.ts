import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frontmatter, listDiskCommands } from '../src/slash-commands.js';

test('frontmatter reads plain, quoted and folded values', () => {
  const fm = frontmatter(
    ['---', 'name: bugs', 'description: "Fix it"', 'argument-hint: <file>', 'long: >', '  one', '  two', '---', 'body'].join('\n'),
  );
  assert.equal(fm['description'], 'Fix it');
  assert.equal(fm['argument-hint'], '<file>');
  assert.equal(fm['long'], 'one two');
  assert.deepEqual(frontmatter('no frontmatter'), {});
});

test('the user skills and commands on disk, namespaced, plus /compact', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'slash-'));
  mkdirSync(path.join(dir, 'skills', 'raskatai'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', 'raskatai', 'SKILL.md'), '---\ndescription: Ship it\n---\n');
  mkdirSync(path.join(dir, 'skills', 'no-skill-file'), { recursive: true });
  mkdirSync(path.join(dir, 'commands', 'git'), { recursive: true });
  writeFileSync(path.join(dir, 'commands', 'git', 'pr.md'), '---\nargument-hint: <branch>\n---\n');
  const prev = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = dir;
  try {
    const cmds = await listDiskCommands();
    assert.deepEqual(cmds, [
      { name: 'raskatai', description: 'Ship it' },
      { name: 'git:pr', argumentHint: '<branch>' },
      { name: 'compact', description: 'Сжать контекст сессии' },
    ]);
  } finally {
    if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = prev;
  }
});

test('a cwd outside the project roots is not read', async () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'slash-out-'));
  mkdirSync(path.join(outside, '.claude', 'skills', 'secret'), { recursive: true });
  writeFileSync(path.join(outside, '.claude', 'skills', 'secret', 'SKILL.md'), '---\ndescription: x\n---\n');
  const cfg = mkdtempSync(path.join(os.tmpdir(), 'slash-cfg-'));
  const prev = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = cfg;
  try {
    const cmds = await listDiskCommands(outside);
    assert.ok(!cmds.some((c) => c.name === 'secret'));
  } finally {
    if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = prev;
  }
});

test('a SKILL.md that is a FIFO or points outside the project is skipped, not waited on', async () => {
  const { execFileSync } = await import('node:child_process');
  const { symlinkSync } = await import('node:fs');
  const cfg = mkdtempSync(path.join(os.tmpdir(), 'slash-fifo-'));
  mkdirSync(path.join(cfg, 'skills', 'pipe'), { recursive: true });
  execFileSync('mkfifo', [path.join(cfg, 'skills', 'pipe', 'SKILL.md')]);
  mkdirSync(path.join(cfg, 'skills', 'ok'), { recursive: true });
  writeFileSync(path.join(cfg, 'skills', 'ok', 'SKILL.md'), '---\ndescription: fine\n---\n');
  mkdirSync(path.join(cfg, 'skills', 'link'), { recursive: true });
  symlinkSync(path.join(cfg, 'skills', 'pipe', 'SKILL.md'), path.join(cfg, 'skills', 'link', 'SKILL.md'));
  const prev = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = cfg;
  try {
    const cmds = await listDiskCommands();
    assert.deepEqual(cmds.map((c) => c.name), ['ok', 'compact']);
  } finally {
    if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = prev;
  }
});
