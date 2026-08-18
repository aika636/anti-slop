import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_COUNT, MIN_COUNT_SHORT, SHORT_CHAT_CANDIDATES, CLOSEDNESS,
  nestingMap, closedness, cvalue,
} from '../core/cvalue.mjs';

/** Кандидат в том виде, в каком его отдаёт core/ngrams.mjs. */
let seq = 0;
const cand = (text, count, opts = {}) => {
  const stems = text.split(' ');
  return {
    hash: `h${seq++}`,
    n: stems.length,
    count,
    firstMessage: opts.first ?? 1,
    lastMessage: opts.last ?? 2,
    stems,
    text,
  };
};

const texts = top => top.map(o => o.text);
const round = x => Math.round(x * 100) / 100;

// --- случай, посчитанный вручную --------------------------------------------
//
// «по спине пробежал» — 20 раз, из них 11 с «холодок» и 9 с «озноб».
//
// Порог «родитель набрал 80%»: 11/20 = 55%, 9/20 = 45%. Ни один родитель до 80%
// не дотягивает — порог пропускает в топ все три строки, одну находку тремя
// обрезками. Ровно этот провал C-value и закрывает.
//
// C-value:
//   «по спине пробежал холодок»  n=4, родителей нет  → log2(4) * 11 = 2 * 11 = 22
//   «по спине пробежал озноб»    n=4, родителей нет  → log2(4) *  9 = 2 *  9 = 18
//   «по спине пробежал»          n=3, два родителя (11 и 9), средняя 10
//                                → log2(3) * (20 - 10) = 1,58496 * 10 = 15,8496
//
// Обрезок уходит вниз, оба живых варианта — наверх, порядок правильный.

test('случай раздела 3.3: порог 80% пропускает всех троих, C-value ранжирует', () => {
  const list = [
    cand('по спине пробежал', 20),
    cand('по спине пробежал холодок', 11),
    cand('по спине пробежал озноб', 9),
  ];

  // Первая ступень никого не трогает — порог закрытости до 80% не дотянул.
  assert.equal(closedness(list).length, 3);

  const { top, preliminary, candidates } = cvalue(list);
  assert.equal(candidates, 3);
  assert.equal(preliminary, false);
  assert.deepEqual(texts(top), [
    'по спине пробежал холодок',
    'по спине пробежал озноб',
    'по спине пробежал',
  ]);
  assert.equal(round(top[0].cvalue), 22);
  assert.equal(round(top[1].cvalue), 18);
  assert.equal(round(top[2].cvalue), 15.85);
  assert.deepEqual(top[2].nested, { sum: 20, count: 2 });
});

test('живая форма и прочие поля протаскиваются нетронутыми', () => {
  const list = [cand('его голос был', 7)];
  const [o] = cvalue(list).top;
  assert.equal(o.text, 'его голос был');
  assert.equal(o.hash, list[0].hash);
  assert.equal(o.firstMessage, 1);
  assert.equal(o.lastMessage, 2);
});

// --- бонус за длину ---------------------------------------------------------

test('при равной частоте длинный оборот выше короткого', () => {
  const list = [
    cand('он посмотрел', 10),
    cand('она молча закрыла дверь', 10),
  ];
  const { top } = cvalue(list);
  assert.deepEqual(texts(top), ['она молча закрыла дверь', 'он посмотрел']);
  assert.equal(round(top[0].cvalue), 20);   // log2(4) * 10
  assert.equal(round(top[1].cvalue), 10);   // log2(2) * 10
});

// --- штраф за вложенность ---------------------------------------------------

test('вложенный оборот с частотой родителя штрафуется до нуля и в топ не попадает', () => {
  const list = [
    cand('его голос', 5),
    cand('его голос был', 5),
  ];
  // Считаем без первой ступени, чтобы увидеть работу самой формулы:
  // log2(2) * (5 - 5/1) = 0, а всё с cvalue <= 0 из топа выброшено.
  const { top } = cvalue(list, { closedness: false });
  assert.deepEqual(texts(top), ['его голос был']);

  // С первой ступенью результат тот же — обрезок отсеян ещё раньше.
  assert.deepEqual(texts(cvalue(list).top), ['его голос был']);
});

test('вложенность считается по сдвигу 0 и 1', () => {
  const list = [
    cand('спине пробежал', 8),
    cand('по спине', 8),
    cand('по спине пробежал', 4),
  ];
  const nesting = nestingMap(list);
  const parents = id => nesting.get(id).parents;
  assert.deepEqual(parents(list[0].hash), [list[2].hash]);  // сдвиг 1
  assert.deepEqual(parents(list[1].hash), [list[2].hash]);  // сдвиг 0
  assert.deepEqual(parents(list[2].hash), []);              // родителей нет
});

test('учитываются только непосредственные родители длины n+1', () => {
  const list = [
    cand('его голос', 9),
    cand('его голос был', 6),
    cand('его голос был наполнен', 4),
  ];
  const nesting = nestingMap(list);
  // У двусловного — только трёхсловный родитель, четырёхсловный не в счёт.
  assert.deepEqual(nesting.get(list[0].hash), {
    sum: 6, count: 1, max: 6, parents: [list[1].hash],
  });
});

// --- первая ступень: фильтр закрытости --------------------------------------

test('фильтр закрытости отсекает обрезок, у которого один родитель объясняет почти всё', () => {
  const list = [
    cand('криминальной организации', 51),
    cand('глава криминальной организации', 50),   // 50/51 = 0,98 >= 0,8
  ];
  assert.deepEqual(
    closedness(list).map(o => o.text),
    ['глава криминальной организации'],
  );
});

test('фильтр закрытости не трогает самостоятельные обороты', () => {
  const list = [
    cand('по спине пробежал', 20),
    cand('по спине пробежал холодок', 11),        // 11/20 = 0,55 < 0,8
    cand('он смотрел на', 30),                    // родителей нет вообще
  ];
  assert.equal(closedness(list).length, 3);
});

test('порог фильтра закрытости — параметр', () => {
  const list = [
    cand('по спине пробежал', 20),
    cand('по спине пробежал холодок', 11),
  ];
  assert.equal(CLOSEDNESS, 0.8);
  assert.equal(closedness(list, { threshold: 0.5 }).length, 1);
  assert.equal(closedness(list, 0.5).length, 1);
  assert.equal(cvalue(list, { closedness: 0.5 }).top.length, 1);
});

// --- порог кандидата --------------------------------------------------------

test('порог по умолчанию — три вхождения', () => {
  assert.equal(MIN_COUNT, 3);
  const list = [
    cand('он смотрел', 2),
    ...Array.from({ length: SHORT_CHAT_CANDIDATES }, (_, i) => cand(`оборот${i} тут`, 5)),
  ];
  const { top, candidates, preliminary } = cvalue(list);
  assert.equal(candidates, SHORT_CHAT_CANDIDATES);
  assert.equal(preliminary, false);
  assert.equal(top.some(o => o.text === 'он смотрел'), false);
});

test('на бедном чате порог опускается до двух, список предварительный', () => {
  assert.equal(MIN_COUNT_SHORT, 2);
  const list = [
    cand('он смотрел', 2),
    cand('она молчала', 2),
    cand('дверь скрипнула', 4),
  ];
  const { top, candidates, preliminary } = cvalue(list);
  assert.equal(preliminary, true);
  assert.equal(candidates, 3);
  assert.equal(top.length, 3);
});

test('послабление не применяется, если оно ничего не добавляет', () => {
  const list = [cand('дверь скрипнула', 4), cand('он молчал', 3)];
  assert.equal(cvalue(list).preliminary, false);
});

test('явный minCount отключает послабление', () => {
  const list = [cand('он смотрел', 2), cand('дверь скрипнула', 4)];
  const r = cvalue(list, { minCount: 4 });
  assert.equal(r.preliminary, false);
  assert.equal(r.candidates, 1);
});

test('требование двух разных сообщений отсекает повтор внутри одного хода', () => {
  const list = [
    cand('он смотрел', 9, { first: 7, last: 7 }),
    cand('она ушла', 9, { first: 7, last: 12 }),
  ];
  assert.deepEqual(texts(cvalue(list).top), ['она ушла']);
  assert.equal(cvalue(list).candidates, 1);

  // Требование отключаемо.
  const off = cvalue(list, { requireTwoMessages: false });
  assert.equal(off.candidates, 2);
});

test('limit обрезает топ, но не число кандидатов', () => {
  const list = [cand('он смотрел', 9), cand('она ушла', 5), cand('дверь скрипнула', 4)];
  const r = cvalue(list, { limit: 2 });
  assert.equal(r.top.length, 2);
  assert.equal(r.candidates, 3);
});

// --- вырожденные входы ------------------------------------------------------

test('пустой вход', () => {
  assert.deepEqual(cvalue([]), { top: [], preliminary: false, candidates: 0 });
  assert.deepEqual(closedness([]), []);
  assert.equal(nestingMap([]).size, 0);
});

test('единственный кандидат', () => {
  const list = [cand('его голос был', 6)];
  const { top, candidates, preliminary } = cvalue(list);
  assert.equal(candidates, 1);
  assert.equal(preliminary, false);
  assert.equal(top.length, 1);
  assert.equal(round(top[0].cvalue), round(Math.log2(3) * 6));
  assert.deepEqual(top[0].nested, { sum: 0, count: 0 });
});

test('единственный кандидат ниже порога — пустой топ', () => {
  assert.deepEqual(cvalue([cand('его голос', 1)]).top, []);
});
