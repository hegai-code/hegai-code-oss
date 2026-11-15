import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptTitle, sessionTitleOf } from '../src/sessions.js';

test('английское резюме уступает русской первой реплике', () => {
  assert.equal(
    sessionTitleOf({ sessionId: 'x', summary: 'Session response times and timeout check', firstPrompt: 'почему сессия зависла?' }),
    'почему сессия зависла?',
  );
});

test('переименование и русское резюме не трогаются, английский разговор тоже', () => {
  assert.equal(sessionTitleOf({ sessionId: 'x', customTitle: 'Design review', firstPrompt: 'привет' }), 'Design review');
  assert.equal(sessionTitleOf({ sessionId: 'x', summary: 'Анализ сессий', firstPrompt: 'hi' }), 'Анализ сессий');
  assert.equal(sessionTitleOf({ sessionId: 'x', summary: 'Fix the build', firstPrompt: 'the build is red' }), 'Fix the build');
  assert.equal(sessionTitleOf({ sessionId: 'abc' }), 'abc');
});

// The SDK flattens newlines and cuts to 200 — test the shape it actually hands over.
test('заголовок — первая фраза: вставленное после двоеточия не попадает', () => {
  assert.equal(promptTitle('вот конфиг: sk-live-abc123 и ещё что-то'), 'вот конфиг');
  assert.equal(promptTitle('Посмотри лог. Там ошибка в хабе'), 'Посмотри лог');
  assert.equal(promptTitle('почему сессия зависла? вот скрин'), 'почему сессия зависла?');
});

test('длинная фраза режется по слову и не рвёт эмодзи', () => {
  const t = promptTitle('слово '.repeat(40));
  assert.ok(t.length <= 81 && t.endsWith('…'), t);
  const e = promptTitle('а' + '😀'.repeat(50));
  assert.ok(e.isWellFormed(), 'no lone surrogate');
});
