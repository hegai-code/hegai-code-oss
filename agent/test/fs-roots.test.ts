import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import {
  assertRoot,
  rememberRoots,
  setSessionCwdProvider,
  invalidateRoots,
} from '../src/fs-roots.js';

/**
 * `safeResolve` guards a path relative to a cwd; nothing ever guarded the cwd
 * itself, so `cwd: "/"` was accepted. These tests are that boundary.
 *
 * They are guard-rail tests, not sandbox tests: a caller who gets this far has
 * already passed the hub's `can_control` and could open a shell. What is being
 * pinned is that the product's promise — "the file manager opens your projects"
 * — is enforced in the agent rather than only in the browser.
 */

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ccr-roots-'));
}

/** Point the agent's state dir and projects root at throwaway directories. */
function isolate(): { projects: string; state: string } {
  const state = scratch();
  const projects = scratch();
  process.env['CC_REMOTE_STATE_DIR'] = state;
  process.env['CC_REMOTE_PROJECTS_ROOT'] = projects;
  delete process.env['CC_REMOTE_FILES_ROOTS'];
  setSessionCwdProvider(() => []);
  invalidateRoots();
  return { projects, state };
}

test('the projects root and anything inside it are reachable', async () => {
  const { projects } = isolate();
  mkdirSync(path.join(projects, 'app', 'src'), { recursive: true });
  await assertRoot(projects);
  await assertRoot(path.join(projects, 'app'));
  await assertRoot(path.join(projects, 'app', 'src'));
});

test('an unrelated directory is refused — including the filesystem root', async () => {
  isolate();
  const elsewhere = scratch();
  await assert.rejects(() => assertRoot('/'), /project roots/);
  await assert.rejects(() => assertRoot(elsewhere), /project roots/);
  await assert.rejects(() => assertRoot(os.homedir()), /project roots/);
});

test('a session cwd outside the projects root is reachable while the session is known', async () => {
  isolate();
  const project = scratch();
  setSessionCwdProvider(() => [project]);
  invalidateRoots();
  await assertRoot(project);
});

/**
 * The reason the allow-list is persisted instead of derived.
 *
 * `buildInventory` only reports a bounded window of sessions. If reachability
 * were computed from it live, a burst of new sessions would silently evict an
 * older project — and someone three folders deep would get an error and an
 * empty pane for no reason they could see.
 */
test('a root stays reachable after its session ages out of the inventory', async () => {
  isolate();
  const project = scratch();

  setSessionCwdProvider(() => [project]);
  invalidateRoots();
  await rememberRoots([project]);

  // The session is gone from the inventory window entirely.
  setSessionCwdProvider(() => []);
  invalidateRoots();

  await assertRoot(project);
});

/**
 * Found by the live smoke, not by reasoning: this machine had five real
 * sessions recorded with `cwd: "/"` — started from a shell that happened to be
 * there. Admitting one of those as a root admits the whole filesystem and makes
 * every other entry in the allow-list decoration.
 */
test('a session that ran in / never becomes a root', async () => {
  isolate();
  setSessionCwdProvider(() => ['/', '/root', os.homedir()]);
  invalidateRoots();
  await rememberRoots(['/', '/root', os.homedir()]);
  invalidateRoots();

  await assert.rejects(() => assertRoot('/'), /project roots/);
  await assert.rejects(() => assertRoot('/etc'), /project roots/);
  await assert.rejects(() => assertRoot(os.homedir()), /project roots/);
  // And it must not have been written down for next time either.
  await assert.rejects(() => assertRoot('/'), /project roots/);
});

test('an operator can name extra roots explicitly', async () => {
  isolate();
  const extra = scratch();
  process.env['CC_REMOTE_FILES_ROOTS'] = extra;
  invalidateRoots();
  await assertRoot(path.join(extra));
});

test('a freshly created project is admitted without waiting for the cache', async () => {
  const { projects } = isolate();
  // Warm the cache, then create a project underneath it. The check must rebuild
  // once before refusing, or a project made seconds ago looks unreachable.
  await assertRoot(projects);
  const fresh = path.join(projects, 'just-made');
  mkdirSync(fresh, { recursive: true });
  await assertRoot(fresh);
});
