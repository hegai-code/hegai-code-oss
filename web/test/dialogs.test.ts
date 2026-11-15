import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DialogView, dialogKeyAction } from '../src/dialogs.js';

const noop = () => {};
const html = (spec: Parameters<typeof DialogView>[0]['spec']) => renderToStaticMarkup(createElement(DialogView, { spec, id: 't', onClose: noop }));

test('confirm renders an alertdialog with Russian buttons and the danger style', () => {
  const h = html({ kind: 'confirm', message: 'Удалить?\n\nНавсегда', confirmLabel: 'Удалить', danger: true });
  assert.match(h, /role="alertdialog"/);
  assert.match(h, /aria-modal="true"/);
  assert.match(h, />Отмена</);
  assert.match(h, /class="btn danger"[^>]*>Удалить</);
  // line breaks survive: the message is pre-wrap text, newlines intact
  assert.ok(h.includes('Удалить?\n\nНавсегда'));
});

test('text dialog renders a labelled input with the initial value and Сохранить', () => {
  const h = html({ kind: 'text', message: 'Новое название', initial: 'Старое' });
  assert.match(h, /role="dialog"/);
  assert.match(h, /<input[^>]*value="Старое"/);
  assert.match(h, />Сохранить</);
});

test('notice has a single OK button and no cancel', () => {
  const h = html({ kind: 'notice', message: 'Готово' });
  assert.match(h, />OK</);
  assert.doesNotMatch(h, />Отмена</);
});

test('Esc cancels (confirm -> false / text -> null), Enter submits, Enter on a button is left to the button', () => {
  assert.equal(dialogKeyAction('Escape', {}), 'cancel');
  assert.equal(dialogKeyAction('Enter', {}), 'submit');
  assert.equal(dialogKeyAction('Enter', { onButton: true }), null);
  assert.equal(dialogKeyAction('Enter', { composing: true }), null);
  assert.equal(dialogKeyAction('a', {}), null);
});
