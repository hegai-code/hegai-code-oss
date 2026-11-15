import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessRow, PublicConfig, ViewerAccess } from '@cc-remote/shared';
import { accountAge, githubStartHref } from '../src/lib.js';

/**
 * GitHub sign-in and the registration/grant fields ride the existing wire
 * schemas, and zod strips unknown fields: a field the hub sends and the schema
 * does not name never reaches a screen. Pinned here.
 */

test('the GitHub button is a plain top-level hop', () => {
  assert.equal(githubStartHref(), '/api/auth/github/start');
});

test('public config carries github, and an older hub without it still parses', () => {
  const base = {
    edition: 'internal', brandName: 'Hegai Code', publicUrl: 'https://code.acme.test',
    auth: { local: false, google: true, telegram: true, apple: false, hegaiSso: false },
  };
  assert.equal(PublicConfig.parse(base).auth.github, undefined);
  assert.equal(PublicConfig.parse({ ...base, auth: { ...base.auth, github: true } }).auth.github, true);
});

test('viewer access keeps registered and the repository grant', () => {
  const got = ViewerAccess.parse({
    state: 'waitlist', plan: 'community', registered: false,
    githubGrant: { status: 'invited', repo: 'hegai-code/hegai-code' },
  });
  assert.equal(ViewerAccess.parse({ state: 'suspended', plan: 'community', githubGrant: { status: 'revoking', repo: 'o/r' } }).githubGrant?.status, 'revoking');
  assert.equal(got.registered, false);
  assert.equal(got.githubGrant?.status, 'invited');
  assert.equal(ViewerAccess.safeParse({ state: 'waitlist', plan: 'community', githubGrant: { status: 'weird', repo: 'x' } }).success, false);
});

test('an admin row keeps the registration answers, the GitHub profile and the grant', () => {
  const row = AccessRow.parse({
    userId: 'gh-1', state: 'waitlist', plan: 'community', requestedAt: 1,
    seat: { status: 'none' }, sandbox: { status: 'none' },
    registration: { role: 'dev', purpose: 'self-host', telegram: '@abcd', updatedAt: 2 },
    github: { id: '42', login: 'octo', createdAt: '2015-01-02T03:04:05Z', publicRepos: 7, followers: 3 },
    githubGrant: { status: 'failed', repo: 'o/r', attempts: 5, error: 'GitHub HTTP 422: nope' },
  });
  assert.equal(row.registration?.purpose, 'self-host');
  assert.equal(row.github?.publicRepos, 7);
  assert.equal(row.githubGrant?.error, 'GitHub HTTP 422: nope');
});

test('the age of a GitHub account reads in years and months', () => {
  const now = Date.parse('2026-11-12T00:00:00Z');
  assert.equal(accountAge('2026-11-01T00:00:00Z', now), 'меньше месяца');
  assert.equal(accountAge('2026-05-01T00:00:00Z', now), '6 мес.');
  assert.equal(accountAge('2023-09-01T00:00:00Z', now), '3 г. 2 мес.');
  assert.equal(accountAge('2024-11-01T00:00:00Z', now), '2 г.');
  assert.equal(accountAge(undefined, now), undefined);
  assert.equal(accountAge('not a date', now), undefined);
});
