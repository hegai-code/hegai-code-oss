// «Способы входа»: every refusal the hub gives a link or an unlink has words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityError, providerName } from '../src/identities.js';

test('link and unlink refusals are worded, and an unknown code leaks nothing', () => {
  assert.match(identityError('identity_owner_has_data'), /перенести его сюда нельзя/);
  assert.match(identityError('last_identity'), /последний способ входа/);
  assert.match(identityError('apple_revoke_failed'), /ничего не отвязано/);
  assert.match(identityError('access_not_active'), /администратор откроет доступ/);
  assert.doesNotMatch(identityError('something_new'), /something_new/);
  assert.equal(providerName('google'), 'Google');
  assert.equal(providerName('hegai'), 'HegAI');
});
