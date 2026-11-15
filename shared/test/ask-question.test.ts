import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskQuestion, parseAskQuestions } from '../src/ask-question.js';

/** The hand-written validator the bot used before the schema existed (and the
 *  web's, modulo `preview` and an `undefined` multiSelect). The schema must
 *  accept and reject exactly what this did. */
function legacy(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj['question'] !== 'string') continue;
    const options = Array.isArray(obj['options'])
      ? obj['options']
          .filter(
            (o): o is Record<string, unknown> =>
              !!o && typeof o === 'object' && typeof (o as Record<string, unknown>)['label'] === 'string',
          )
          .map((o) => ({
            label: o['label'] as string,
            ...(typeof o['description'] === 'string' ? { description: o['description'] } : {}),
            ...(typeof o['preview'] === 'string' ? { preview: o['preview'] } : {}),
          }))
      : [];
    out.push({
      ...(typeof obj['id'] === 'string' ? { id: obj['id'] } : {}),
      question: obj['question'],
      ...(typeof obj['header'] === 'string' ? { header: obj['header'] } : {}),
      options,
      multiSelect: obj['multiSelect'] === true,
      isSecret: obj['isSecret'] === true,
    });
  }
  return out;
}

/** A field the schema drops is an `undefined` value, where the legacy code left
 *  the key out. Nothing tells them apart (`??`, JSON), so compare as JSON. */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

test('a full question comes through unchanged', () => {
  const q = {
    id: 'q1',
    question: 'Какой тариф?',
    header: 'Тариф',
    options: [{ label: 'A', description: 'дёшево', preview: '```x```' }, { label: 'B' }],
    multiSelect: true,
    isSecret: true,
  };
  assert.deepEqual(parseAskQuestions([q]), [q]);
});

test('only a string `question` is required; the rest is defaulted', () => {
  assert.deepEqual(parseAskQuestions([{ question: 'q' }]), [
    { question: 'q', options: [], multiSelect: false, isSecret: false },
  ]);
  assert.deepEqual(parseAskQuestions([{ question: '' }]).length, 1, 'an empty question text was accepted');
});

test('malformed entries are skipped, malformed fields are dropped — nothing throws', () => {
  const out = plain(parseAskQuestions([
    null,
    7,
    'x',
    [],
    {},
    { question: 5 },
    {
      question: 'q',
      id: 5,
      header: {},
      multiSelect: 'yes',
      isSecret: 1,
      options: [null, 'a', { label: 1 }, { label: 'ok', description: 3, preview: [] }, { label: 'z', extra: 1 }],
    },
  ]));
  assert.deepEqual(out, [
    {
      question: 'q',
      options: [{ label: 'ok' }, { label: 'z' }],
      multiSelect: false,
      isSecret: false,
    },
  ]);
  assert.deepEqual(parseAskQuestions('nope'), []);
  assert.deepEqual(parseAskQuestions(undefined), []);
  assert.deepEqual(parseAskQuestions({ question: 'q' }), [], 'a lone object is not a list');
  assert.deepEqual(parseAskQuestions([{ question: 'q', options: 'a,b' }])[0]?.options, []);
});

test('the schema agrees with the legacy validator on a corpus of hostile inputs', () => {
  const corpus: unknown[] = [
    [],
    [null],
    [{ question: 'q' }],
    [{ question: 'q', options: [{ label: 'a' }] }],
    [{ question: 'q', options: { label: 'a' } }],
    [{ question: 'q', options: [{ label: 'a', description: 'd', preview: 'p' }, { description: 'no label' }] }],
    [{ question: 'q', multiSelect: true, isSecret: true }],
    [{ question: 'q', multiSelect: 'true', isSecret: 'true' }],
    [{ question: 'q', multiSelect: false, isSecret: false }],
    [{ question: 'q', id: 'a', header: 'h' }, { question: 'r', id: null, header: 3 }],
    [{ question: 'q', unknown: { deep: [1, 2, 3] } }],
    [{ question: ['q'] }, { question: 'ok' }],
    { 0: { question: 'q' } },
    'question',
    null,
  ];
  for (const input of corpus) assert.deepEqual(plain(parseAskQuestions(input)), legacy(input), JSON.stringify(input));
});

test('the exported schema is usable on its own', () => {
  assert.ok(AskQuestion.safeParse({ question: 'q' }).success);
  assert.ok(!AskQuestion.safeParse({ options: [] }).success, 'a question without text is rejected');
  assert.ok(!AskQuestion.safeParse(null).success);
});
