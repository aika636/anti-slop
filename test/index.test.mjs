import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHORS, WEIGHTS, FORMULA_VERSION, DRAFT_UNTIL_WORDS, messageIndex, chatIndex,
} from '../core/index.mjs';
import { MATTR_WINDOW } from '../core/diversity.mjs';

// Точка отсчёта для проверок монотонности: все три компонента строго внутри
// своих якорей, длина заведомо больше окна MATTR — то есть ни один компонент не
// упирается в обрезку и ни один не выброшен.
const BASE = { coverage: 0.20, mattr: 0.84, similarity: 0.02, words: 200 };

test('индекс посчитан вручную по якорям и весам', () => {
  // покрытие   0.20 → (0.20 − 0.05) / (0.40 − 0.05)   = 0.15 / 0.35  = 0.428571…
  // разнообразие 0.84 → (0.84 − 0.90) / (0.75 − 0.90) = −0.06 / −0.15 = 0.4
  // похожесть  0.02 → (0.02 − 0.0015) / (0.06 − 0.0015) = 0.0185 / 0.0585 = 0.316239…
  // взвешенно: 0.428571·0.5 + 0.4·0.25 + 0.316239·0.25
  //          = 0.214286 + 0.1 + 0.079060 = 0.393346 → 39.33… → 39
  const r = messageIndex(BASE);
  assert.ok(Math.abs(r.parts.coverage - 0.15 / 0.35) < 1e-12, `${r.parts.coverage}`);
  assert.ok(Math.abs(r.parts.diversity - 0.4) < 1e-12, `${r.parts.diversity}`);
  assert.ok(Math.abs(r.parts.similarity - 0.0185 / 0.0585) < 1e-12, `${r.parts.similarity}`);
  assert.equal(r.value, 39);
});

test('рост покрытия поднимает индекс', () => {
  const low = messageIndex(BASE).value;
  const high = messageIndex({ ...BASE, coverage: 0.30 }).value;
  assert.ok(high > low, `${low} → ${high}`);
});

test('рост похожести на предыдущие поднимает индекс', () => {
  const low = messageIndex(BASE).value;
  const high = messageIndex({ ...BASE, similarity: 0.04 }).value;
  assert.ok(high > low, `${low} → ${high}`);
});

test('рост MATTR опускает индекс: якоря разнообразия перевёрнуты', () => {
  // Чем богаче словарь, тем МЕНЬШЕ слопа. Единственный компонент, у которого
  // «ноль баллов» стоит выше «ста».
  assert.ok(ANCHORS.diversity.zero > ANCHORS.diversity.full);
  const worse = messageIndex({ ...BASE, mattr: 0.80 }).value;
  const better = messageIndex({ ...BASE, mattr: 0.88 }).value;
  assert.ok(better < worse, `MATTR вырос, индекс не упал: ${worse} → ${better}`);
});

test('монотонность держится на всём диапазоне каждого компонента', () => {
  const grid = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const seq = key => grid.map(v => messageIndex({ ...BASE, [key]: v }).value);

  const cov = seq('coverage');
  for (let i = 1; i < cov.length; i += 1) {
    assert.ok(cov[i] >= cov[i - 1], `покрытие не монотонно: ${cov}`);
  }

  const sim = grid.map(v => messageIndex({ ...BASE, similarity: v / 10 }).value);
  for (let i = 1; i < sim.length; i += 1) {
    assert.ok(sim[i] >= sim[i - 1], `похожесть не монотонна: ${sim}`);
  }

  // MATTR идёт снизу вверх, индекс обязан идти сверху вниз.
  const div = [0.70, 0.75, 0.80, 0.85, 0.90, 0.95]
    .map(v => messageIndex({ ...BASE, mattr: v }).value);
  for (let i = 1; i < div.length; i += 1) {
    assert.ok(div[i] <= div[i - 1], `разнообразие не монотонно: ${div}`);
  }
});

test('за якорями значения обрезаются ровно в 0 и ровно в 100', () => {
  // Всё лучше «нулевого» якоря — ровно ноль, а не отрицательное число.
  const best = messageIndex({ coverage: 0, mattr: 0.99, similarity: 0, words: 200 });
  assert.equal(best.value, 0);
  assert.deepEqual(best.parts, { coverage: 0, diversity: 0, similarity: 0 });

  // Всё хуже «стобалльного» якоря — ровно сто, шкала не уезжает выше.
  const worst = messageIndex({ coverage: 1, mattr: 0.10, similarity: 1, words: 200 });
  assert.equal(worst.value, 100);
  assert.deepEqual(worst.parts, { coverage: 1, diversity: 1, similarity: 1 });

  // Ровно на якорях — ровно границы.
  const zero = messageIndex({
    coverage: ANCHORS.coverage.zero,
    mattr: ANCHORS.diversity.zero,
    similarity: ANCHORS.similarity.zero,
    words: 200,
  });
  assert.equal(zero.value, 0);
  const full = messageIndex({
    coverage: ANCHORS.coverage.full,
    mattr: ANCHORS.diversity.full,
    similarity: ANCHORS.similarity.full,
    words: 200,
  });
  assert.equal(full.value, 100);
});

test('индекс не зависит от длины сообщения', () => {
  // Требование 2 раздела 3.2: все компоненты — доли, иначе индекс мерил бы
  // многословность. Одинаковые доли при разной длине — одинаковый индекс.
  const short = messageIndex({ ...BASE, words: MATTR_WINDOW }).value;
  const long = messageIndex({ ...BASE, words: 5000 }).value;
  assert.equal(short, long);
});

test('вырожденные входы не ломают шкалу', () => {
  const empty = messageIndex();
  assert.equal(empty.value, 0);
  assert.equal(empty.parts.diversity, 0);

  // NaN у MATTR не должен просочиться в арифметику: компонент выбрасывается.
  const nan = messageIndex({ coverage: 0.40, mattr: NaN, similarity: 0, words: 1000 });
  assert.ok(Number.isFinite(nan.value));
  // Остались покрытие (1) и похожесть (0) с весами 0.5 и 0.25: 0.5 / 0.75 → 67.
  assert.equal(nan.value, 67);
});

test('сообщение короче окна MATTR: компонент разнообразия выброшен, веса перенормированы', () => {
  const parts = { coverage: 0.225, mattr: 0.75, similarity: 0.06, words: MATTR_WINDOW - 1 };

  // покрытие   0.225 → (0.225 − 0.05) / 0.35 = 0.175 / 0.35 = 0.5
  // похожесть  0.06  → упёрлась в «стобалльный» якорь = 1
  // разнообразие 0.75 → тоже 1, но компонент ВЫБРАСЫВАЕТСЯ: 49 слов меньше окна.
  // Веса оставшихся: 0.5 и 0.25, сумма 0.75.
  //   (0.5·0.5 + 1·0.25) / 0.75 = (0.25 + 0.25) / 0.75 = 0.5 / 0.75 = 0.6666… → 67
  const r = messageIndex(parts);
  assert.equal(r.value, 67);

  // Именно перенормировка, а не «третий компонент равен нулю»: тогда вышло бы
  //   (0.25 + 0 + 0.25) / 1 = 0.5 → 50.
  assert.notEqual(r.value, 50);
  // И не «компонент учтён как есть»: тогда (0.25 + 0.25 + 0.25) / 1 = 0.75 → 75.
  assert.notEqual(r.value, 75);

  // Ровно на окне компонент уже честный, и цифра меняется.
  const atWindow = messageIndex({ ...parts, words: MATTR_WINDOW });
  assert.equal(atWindow.value, 75);

  // Сам посчитанный MATTR из ответа не пропадает — выброшен он только из суммы.
  assert.equal(r.parts.diversity, 1);
});

test('короткое сообщение с идеальным MATTR не получает скидку за длину', () => {
  // Ловушка, ради которой компонент и выбрасывается: подставить сюда ноль
  // значило бы выдать «идеальное разнообразие» за счёт короткого текста.
  const short = messageIndex({ coverage: 0.40, mattr: 1, similarity: 0.06, words: 10 });
  assert.equal(short.value, 100, 'короткий текст сбил стопроцентную оценку');
});

test('веса и якоря — те, что записаны в разделе 3.2', () => {
  // Покрытие основное, остальные два средние; в сумме единица.
  assert.equal(WEIGHTS.coverage, 0.5);
  assert.equal(WEIGHTS.diversity, 0.25);
  assert.equal(WEIGHTS.similarity, 0.25);
  const sum = WEIGHTS.coverage + WEIGHTS.diversity + WEIGHTS.similarity;
  assert.ok(Math.abs(sum - 1) < 1e-12);
  assert.ok(WEIGHTS.coverage > WEIGHTS.diversity && WEIGHTS.coverage > WEIGHTS.similarity);
});

test('версия формулы протаскивается в каждый ответ', () => {
  // Без версии два числа сравнивать нельзя, и это единственное, что об этом
  // сообщает наружу.
  assert.equal(messageIndex(BASE).version, FORMULA_VERSION);
  assert.equal(chatIndex([{ value: 10, words: 10 }]).version, FORMULA_VERSION);
  assert.equal(typeof FORMULA_VERSION, 'string');
});

test('индекс сообщения помечен черновым всегда', () => {
  // Формула не откалибрована на размеченных чатах и до релиза не будет.
  assert.equal(messageIndex(BASE).draft, true);
  assert.equal(messageIndex({ coverage: 1, mattr: 0.1, similarity: 1, words: 9999 }).draft, true);
});

test('индекс чата взвешен по словам, а не простое среднее', () => {
  // Длинное плохое сообщение и короткое хорошее:
  //   (80·1000 + 20·100) / 1100 = (80000 + 2000) / 1100 = 82000 / 1100 = 74.545… → 75
  // Простое среднее дало бы (80 + 20) / 2 = 50.
  const r = chatIndex([
    { value: 80, words: 1000 },
    { value: 20, words: 100 },
  ]);
  assert.equal(r.value, 75);
  assert.notEqual(r.value, 50);
  assert.equal(r.messages, 2);
  assert.equal(r.words, 1100);
});

test('нарезка чата на сообщения не влияет на индекс чата', () => {
  // Вес по словам — это «индекс на слово текста». Один ход на 600 слов и три по
  // 200 с тем же индексом обязаны дать одно и то же.
  const coarse = chatIndex([{ value: 40, words: 600 }, { value: 90, words: 200 }]);
  const fine = chatIndex([
    { value: 40, words: 200 }, { value: 40, words: 200 }, { value: 40, words: 200 },
    { value: 90, words: 100 }, { value: 90, words: 100 },
  ]);
  assert.equal(coarse.value, fine.value);
});

test('индекс чата: вырожденные входы', () => {
  const empty = chatIndex([]);
  assert.equal(empty.value, 0);
  assert.equal(empty.messages, 0);
  assert.equal(empty.words, 0);

  // Длины нет ни у одного сообщения — взвешивать нечем, считается простое
  // среднее. Ноль здесь выглядел бы как посчитанный ответ «повторов нет».
  // Смешанный случай проверяется отдельно: там сообщение без прозы не в счёт.
  const noWords = chatIndex([{ value: 50 }, { value: 50 }]);
  assert.equal(noWords.value, 50);
  assert.equal(noWords.words, 2);

  assert.equal(chatIndex().value, 0);
});

test('сообщение без прозы не тянет индекс чата вниз', () => {
  // Ход, состоящий из одного инфоблока или промпта картинки, даёт ноль слов
  // прозы и индекс 0 — не потому, что текст свежий, а потому, что текста нет.
  // У пользователя с инфоблоком такой ход бывает через раз, и если считать их
  // наравне, индекс чата окажется занижен вдвое на ровном месте.
  const withEmpty = chatIndex([
    { value: 60, words: 1000 },
    { value: 0, words: 0 },
    { value: 60, words: 1000 },
  ]);
  assert.equal(withEmpty.value, 60);
  assert.equal(withEmpty.words, 2000);
});

test('черновой ярлык снимается только за границей DRAFT_UNTIL_WORDS', () => {
  // Граница та же, что у переключения счётчика: на меньшем объёме низкий индекс
  // говорит о длине чата, а не о качестве текста.
  assert.equal(DRAFT_UNTIL_WORDS, 50_000);

  const small = chatIndex([{ value: 50, words: 1000 }]);
  assert.equal(small.draft, true);
  assert.equal(small.words, 1000);

  // Объём можно передать отдельно — сумма по сообщениям не всегда весь чат.
  const belowEdge = chatIndex([{ value: 50, words: 10 }], { words: DRAFT_UNTIL_WORDS - 1 });
  assert.equal(belowEdge.draft, true);

  const atEdge = chatIndex([{ value: 50, words: 10 }], { words: DRAFT_UNTIL_WORDS });
  assert.equal(atEdge.draft, false);
  assert.equal(atEdge.words, DRAFT_UNTIL_WORDS);

  // Значение при этом считается по сообщениям, а не по переданному объёму.
  assert.equal(atEdge.value, 50);
});
