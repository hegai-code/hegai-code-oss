import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FONT_STEPS, getFontScale, setFontScale, stepFontScale } from '../src/fontScale.js';

test('+ and − walk the ladder and stop at its ends; 0 resets', () => {
  setFontScale(1);
  stepFontScale(1);
  assert.equal(getFontScale(), 1.1);
  for (let i = 0; i < 20; i++) stepFontScale(1);
  assert.equal(getFontScale(), FONT_STEPS[FONT_STEPS.length - 1]);
  for (let i = 0; i < 20; i++) stepFontScale(-1);
  assert.equal(getFontScale(), FONT_STEPS[0]);
  stepFontScale(0);
  assert.equal(getFontScale(), 1);
  setFontScale(1.23);
  assert.equal(getFontScale(), 1.2);
});
