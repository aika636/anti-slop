import test from 'node:test';
import assert from 'node:assert/strict';
import { stemEn } from '../core/stemmer-en.mjs';

// Примеры из описания Porter2 и его таблицы исключений.
const CASES = [
  ['consign', 'consign'], ['consigned', 'consign'], ['consigning', 'consign'],
  ['consignment', 'consign'],
  ['knavish', 'knavish'], ['knife', 'knife'], ['knives', 'knive'],
  ['looked', 'look'], ['looking', 'look'], ['looks', 'look'],
  ['hopping', 'hop'], ['hoping', 'hope'],
  ['national', 'nation'], ['nationalism', 'nation'], ['nationalities', 'nation'],
  ['generate', 'generat'], ['generously', 'generous'],
  ['happy', 'happi'], ['happiness', 'happi'],
  ['agreed', 'agre'], ['feed', 'feed'],
  ['ties', 'tie'], ['cries', 'cri'],
  ['skies', 'sky'], ['dying', 'die'], ['news', 'news'],
  ['inning', 'inning'], ['proceed', 'proceed'],
  ['ugly', 'ugli'], ['early', 'earli'],
  ['say', 'say'], ['says', 'say'],
];

test('Porter2 сводит английские формы', () => {
  for (const [word, expected] of CASES) {
    assert.equal(stemEn(word), expected, `${word} → ${stemEn(word)}, ожидалось ${expected}`);
  }
});

test('латиница внутри русского чата не ломается', () => {
  assert.equal(stemEn('ok'), 'ok');
  assert.equal(stemEn(''), '');
});
