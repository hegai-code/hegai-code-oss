import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInviteTarget } from '../src/inviteTarget.js';

test('only an @username is a Telegram invite, lowercased', () => {
  assert.deepEqual(parseInviteTarget('@Vasya_Pupkin'), { telegram: 'vasya_pupkin' });
  assert.equal(parseInviteTarget('@abc'), null);
  assert.equal(parseInviteTarget('@ab-cde'), null);
});

test('everything else must look like an e-mail', () => {
  assert.deepEqual(parseInviteTarget(' colleague@example.com '), { email: 'colleague@example.com' });
  assert.equal(parseInviteTarget('vasya_pupkin'), null, 'a bare name is not Telegram');
  assert.equal(parseInviteTarget('a@b'), null);
  assert.equal(parseInviteTarget('a b@c.ru'), null);
  assert.equal(parseInviteTarget('a@@c.ru'), null);
});
