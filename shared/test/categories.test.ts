/**
 * The category↔skill mapping lives in four places on purpose — TypeScript for
 * the web and the agent, Rust for the hub, Swift for the Apple clients, and a
 * `skills/<name>/SKILL.md` body that has to exist for any of it to mean
 * anything. Nothing at build time makes them agree; a category whose skill is
 * missing on one side fails SILENTLY, by leaving a stray `/sync` in the first
 * turn of a real session.
 *
 * These tests read the other three from disk and compare. Run: `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SESSION_CATEGORIES,
  LEGACY_CATEGORIES,
  INTAKE_CATEGORIES,
  SessionCategory,
  categoryRunnable,
} from '../src/categories.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** All THREE lists. A retired category is still persisted on hundreds of
 *  sessions and still resolvable by the hub, so it has to stay in step across
 *  the languages exactly like a pickable one — it just is not offered. */
const all = [...SESSION_CATEGORIES, ...LEGACY_CATEGORIES, ...INTAKE_CATEGORIES];

/** Source as LF-only text. Checkouts on Windows carry CRLF, and every pattern
 *  below anchors on `\n`. */
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

test('every category id is a member of the SessionCategory enum', () => {
  for (const c of all) assert.equal(SessionCategory.safeParse(c.id).success, true, c.id);
  // And nothing in the enum is left without metadata — an id that parses but
  // has no entry resolves to no label and no chip anywhere it is displayed.
  const known = new Set(all.map((c) => c.id));
  for (const id of SessionCategory.options) assert.equal(known.has(id), true, `${id} has no entry`);
});

test('the hub mirrors the same id -> skill pairs', () => {
  const rust = read('server-rs', 'src', 'hub.rs');
  const block = rust.match(/const CATEGORY_SKILLS: &\[\(&str, &str\)\] = &\[([\s\S]*?)\n\];/);
  assert.ok(block, 'CATEGORY_SKILLS not found in server-rs/src/hub.rs');
  const pairs = [...block[1].matchAll(/\("([a-z-]+)",\s*"([a-z-]+)"\)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(
    Object.fromEntries(pairs),
    Object.fromEntries(all.map((c) => [c.id, c.skill])),
    'server-rs/src/hub.rs CATEGORY_SKILLS disagrees with shared/src/categories.ts',
  );
});

test('the Apple clients mirror the same id -> skill pairs', () => {
  const swift = read('ios', 'CCRemoteKit', 'Sources', 'CCRemoteKit', 'Protocol', 'Models.swift');
  const cases = swift.match(/public enum SessionCategory[\s\S]*?\n\s*case ([a-z, ]+)\n/);
  assert.ok(cases, 'SessionCategory enum not found in Models.swift');
  const ids = cases[1].split(',').map((s) => s.trim());
  assert.deepEqual(
    new Set(ids),
    new Set(all.map((c) => c.id)),
    'Models.swift SessionCategory disagrees with shared/src/categories.ts',
  );

  // The Swift `skill` property is a switch with a `default: return rawValue`,
  // so only the ids whose skill differs from the id are spelled out. Those are
  // exactly the pairs that can drift without anyone noticing.
  const renamed = all.filter((c) => c.skill !== c.id);
  for (const c of renamed) {
    assert.match(
      swift,
      new RegExp(`case \\.${c.id}: return "${c.skill}"`),
      `Models.swift is missing the ${c.id} -> ${c.skill} skill mapping`,
    );
  }
});

test('every bundled skill has a body, and the bundle covers the pickable list', () => {
  const skillsDir = join(repoRoot, 'skills');
  const onDisk = new Set(
    readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))
      .map((e) => e.name),
  );

  // Only what a start screen OFFERS must travel with the agent — otherwise the
  // chip is a promise the machine cannot keep. LEGACY_CATEGORIES keep their
  // label and chip for the sessions that carry them, but their skills left the
  // fleet bundle on 24.09.2026 (Owner: the dev-process skills — bugs, feature,
  // raskatai, … — are this repo's harness, `.claude/skills/`, not a product
  // feature on every machine); `webpage` and `text` never were bundled.
  for (const c of SESSION_CATEGORIES) {
    assert.equal(onDisk.has(c.skill), true, `skills/${c.skill}/SKILL.md is missing`);
  }
});

test('categoryRunnable treats an unknown skill list as unknown, not as none', () => {
  const sync = LEGACY_CATEGORIES.find((c) => c.id === 'sync')!;
  // An agent older than the skill bundle reports no `skills` at all. Reading
  // that as "runs nothing" would blank every chip in the fleet on upgrade day,
  // before a single agent has restarted.
  assert.equal(categoryRunnable(sync, undefined), true);
  assert.equal(categoryRunnable(sync, ['sync', 'verify']), true);
  assert.equal(categoryRunnable(sync, ['verify']), false);
  assert.equal(categoryRunnable(sync, []), false);

  // The id and the skill are not the same string for every category, so a
  // client comparing against the id would wrongly hide these two.
  const ship = LEGACY_CATEGORIES.find((c) => c.id === 'ship')!;
  assert.equal(categoryRunnable(ship, ['raskatai']), true);
  assert.equal(categoryRunnable(ship, ['ship']), false);
});
