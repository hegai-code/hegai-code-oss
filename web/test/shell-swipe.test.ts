import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM, DIST, FLICK, SLOP, STRAIGHTNESS, isHorizontal, isSwipe, settle } from '../src/shell/shellSwipe.js';

/**
 * Арифметика жеста шторки — та же, что проверяет `ShellSwipeTests.swift`.
 *
 * Тест здесь затем, что числа теперь живут в ДВУХ файлах, и разъехаться они
 * могут молча: подобрать их заново нечем — ни того корпуса сессий, ни тех рук.
 * Сторона приложения падает на `testThresholdsMatchTheWeb`, эта — здесь.
 */

test('прямая длинная тяга — жест', () => {
  assert.equal(isSwipe(120, 10), true);
  assert.equal(isSwipe(-120, -10), true);
});

test('короткая тяга — промах, и порог включающий', () => {
  assert.equal(isSwipe(63, 0), false);
  assert.equal(isSwipe(64, 0), true);
});

test('диагональ остаётся прокруткой — два независимых условия', () => {
  // Вертикали больше, чем прощается.
  assert.equal(isSwipe(100, 45), false);
  // Вертикали прощается, но горизонталь не перевесила её вдвое.
  assert.equal(isSwipe(70, 40), false);
  assert.equal(isSwipe(90, 40), true);
});

test('пороги совпадают с ShellSwipe.swift', () => {
  assert.equal(DIST, 64, 'distance в ShellSwipe.swift');
  assert.equal(SLOP, 44, 'slop в ShellSwipe.swift');
  assert.equal(STRAIGHTNESS, 2, 'straightness в ShellSwipe.swift');
  assert.equal(CLAIM, 6, 'claim в ShellSwipe.swift');
  assert.equal(FLICK, 320, 'flick в ShellSwipe.swift');
});

test('claim решается прямизной и только ей', () => {
  // Шесть пикселей вбок и ни одного вниз — наш, хотя до 64 далеко.
  assert.equal(isHorizontal(6, 0), true);
  assert.equal(isHorizontal(-6, 0), true);
  // Столько же вниз — прокрутка.
  assert.equal(isHorizontal(0, 6), false);
  // По диагонали горизонталь обязана перевесить вертикаль вдвое — тем же
  // отношением, что и в `isSwipe`.
  assert.equal(isHorizontal(7, 4), false);
  assert.equal(isHorizontal(9, 4), true);
});

test('claim НЕ пользуется абсолютным slop', () => {
  // 44 пикселя допуска на жесте длиной шесть пропускают вообще всё.
  assert.equal(isHorizontal(8, 20), false);
});

test('медленная тяга встаёт по расстоянию', () => {
  assert.equal(settle(64, 0, false), true);
  assert.equal(settle(63, 0, false), false);
  assert.equal(settle(-64, 0, true), false);
  // Закрывают тем же расстоянием, которым открывали, — порог односторонний.
  assert.equal(settle(-63, 0, true), true);
});

test('бросок встаёт по скорости, не пройдя расстояния', () => {
  assert.equal(settle(20, 900, false), true);
  assert.equal(settle(-20, -900, true), false);
  // Утащили далеко и швырнули обратно — это «обратно».
  assert.equal(settle(200, -900, false), false);
});

test('отпущенная на полпути без скорости возвращается', () => {
  assert.equal(settle(30, 0, false), false);
  assert.equal(settle(-30, 0, true), true);
});
