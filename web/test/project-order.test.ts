import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangeProjects,
  compareByAttention,
  NO_PROJECT,
  panelProjectKey,
  RECENT_PROJECT_MAX,
  RECENT_PROJECT_MS,
  sessionUrgency,
} from '../src/lib.js';

/**
 * The side panel's project order (30.09.2026): newest change first, and only
 * work that is running or waiting for you outranks it. It used to float any
 * «live» session, which included a VS Code window left open for a week.
 */

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const p = (key: string, agoDays: number, urgency = 0, createdAgoDays = agoDays) => ({
  key,
  urgency,
  lastModified: NOW - agoDays * DAY,
  created: NOW - createdAgoDays * DAY,
});

test('an idle run and an open editor are not urgent; working and waiting are', () => {
  assert.equal(sessionUrgency(undefined), 0);
  assert.equal(sessionUrgency({ state: 'idle' }), 0);
  assert.equal(sessionUrgency({ state: 'working' }), 1);
  assert.equal(sessionUrgency({ state: 'needs_attention' }), 2);
  assert.equal(sessionUrgency({ state: 'error' }), 2);
});

test('projects: waiting, then working, then quiet — each by the newest created', () => {
  const { recent } = arrangeProjects([p('old', 3), p('fresh', 0.1), p('waits', 5, 2), p('runs', 6, 1)], NOW);
  assert.deepEqual(recent.map((x) => x.key), ['waits', 'runs', 'fresh', 'old']);
});

test('project order follows created, not lastModified', () => {
  const { recent } = arrangeProjects([p('touched', 0.1, 0, 9), p('newer', 2, 0, 1)], NOW);
  assert.deepEqual(recent.map((x) => x.key), ['newer', 'touched']);
});

test('sessions: waiting, then working, then idle by created — not by last change', () => {
  const s = (id: string, urgency: number, agoDays: number) => ({ id, urgency, created: NOW - agoDays * DAY });
  const rows = [s('working-old', 1, 5), s('idle-new', 0, 1), s('waits-oldest', 2, 9), s('idle-mid', 0, 3)];
  rows.sort(compareByAttention);
  assert.deepEqual(rows.map((r) => r.id), ['waits-oldest', 'working-old', 'idle-new', 'idle-mid']);
});

test('stale, overflowing and project-less go to the folded tail; urgent never does', () => {
  const many = Array.from({ length: RECENT_PROJECT_MAX + 2 }, (_, i) => p(`p${i}`, i * 0.1));
  const { recent, older } = arrangeProjects(
    [...many, p('stale', RECENT_PROJECT_MS / DAY + 1), p(NO_PROJECT, 0), p('stale-but-waits', 30, 2)],
    NOW,
  );
  assert.equal(recent[0]!.key, 'stale-but-waits');
  assert.equal(recent.filter((x) => x.urgency === 0).length, RECENT_PROJECT_MAX);
  assert.ok(older.some((x) => x.key === 'stale'));
  assert.ok(older.some((x) => x.key === NO_PROJECT));
  assert.ok(older.some((x) => x.key === `p${RECENT_PROJECT_MAX}`));
});

test('a root or home dir is not a project', () => {
  assert.equal(panelProjectKey({ cwd: '/', project: undefined }), NO_PROJECT);
  assert.equal(panelProjectKey({ cwd: '/root', project: 'root' }), NO_PROJECT);
  assert.equal(panelProjectKey({ cwd: '/home/owner', project: 'owner' }), NO_PROJECT);
  assert.equal(panelProjectKey({ cwd: 'C:\\Users\\buildbox', project: 'buildbox' }), NO_PROJECT);
  assert.equal(panelProjectKey({ cwd: '/srv/main-source', project: 'remotehegai' }), 'remotehegai');
  assert.equal(panelProjectKey({ project: 'x' }), 'x');
  // A project at the root of a second Windows drive is a project.
  assert.equal(panelProjectKey({ cwd: 'D:\\hegai', project: 'hegai' }), 'hegai');
  assert.equal(panelProjectKey({ cwd: 'C:\\', project: undefined }), NO_PROJECT);
});
