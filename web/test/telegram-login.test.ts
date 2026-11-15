// «Войти через Telegram» on the web: the words a person sees for each way a
// login ends, and the contract the poll is parsed with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramLoginPoll } from '@cc-remote/shared';
import { ApiError } from '../src/teamApi.js';
import { readTelegramSignIn, telegramLoginError, telegramPollEnd } from '../src/telegramLogin.js';

test('every refusal the hub can give has words, and nothing leaks a code', () => {
  assert.match(telegramLoginError(new ApiError('telegram sign-in is not configured on this hub', 404)), /выключен/);
  assert.match(telegramLoginError(new ApiError('too many sign-in attempts from this address', 429)), /Слишком много/);
  assert.match(telegramLoginError(new ApiError('access_not_active', 403)), /администратор откроет доступ/);
  assert.match(telegramLoginError(new ApiError('identity_owner_has_data', 409)), /перенести его сюда нельзя/);
  assert.match(telegramLoginError(new ApiError('account_deleting', 409)), /удаляется/);
  assert.match(telegramLoginError(new ApiError('telegram_linked_elsewhere', 409)), /другой учётке/);
  assert.match(telegramLoginError(new TypeError('fetch failed')), /Нет связи/);
  assert.doesNotMatch(telegramLoginError(new ApiError('something_new', 500)), /something_new/);
  assert.match(telegramPollEnd('denied'), /не то число/);
  assert.match(telegramPollEnd('expired'), /10 минут/);
});

test('the poll is parsed strictly: an approval says who signed in', () => {
  const ok = TelegramLoginPoll.parse({
    status: 'approved', userId: 'tg-1', telegram: '@danis', created: true,
    account: { userId: 'tg-1', displayName: 'Данис', state: 'waitlist' },
  });
  assert.equal(ok.status, 'approved');
  assert.equal(TelegramLoginPoll.parse({ status: 'confirm_link', telegram: '@x' }).status, 'confirm_link');
  assert.equal(TelegramLoginPoll.safeParse({ status: 'approved', userId: 'tg-1' }).success, false,
    'an approval without who-signed-in is a contract break, not a silent sign-in');
});

test('without sessionStorage (private mode) the banner is simply absent', () => {
  assert.equal(readTelegramSignIn(), null);
});
