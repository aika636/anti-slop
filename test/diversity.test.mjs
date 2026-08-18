import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATTR_WINDOW, MTLD_THRESHOLD, mattr, createMattr, mtld, yulesK, diversity,
} from '../core/diversity.mjs';

const w = s => s.split(' ');
const ttr = list => new Set(list).size / list.length;

// Детерминированный «случайный» текст: LCG по словарю из `vocab` слов.
// Нужен там, где важна не конкретная цифра, а поведение метрики.
function fakeText(count, vocab) {
  const out = [];
  let s = 12345;
  for (let i = 0; i < count; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(`w${s % vocab}`);
  }
  return out;
}

test('окно MATTR зафиксировано на пятидесяти', () => {
  // Значения при разных окнах несравнимы, окно менять нельзя.
  assert.equal(MATTR_WINDOW, 50);
});

test('MATTR: посчитано вручную', () => {
  // Текст: a b a c a b, окно 3. Окна и их TTR:
  //   a b a → уникальных 2 → 2/3
  //   b a c → 3 → 3/3
  //   a c a → 2 → 2/3
  //   c a b → 3 → 3/3
  // Среднее = (2/3 + 1 + 2/3 + 1) / 4 = (10/3) / 4 = 10/12 = 0.8333…
  const r = mattr(w('a b a c a b'), 3);
  assert.equal(r.short, false);
  assert.equal(r.window, 3);
  assert.ok(Math.abs(r.value - 10 / 12) < 1e-12, `получено ${r.value}`);
});

test('MATTR: одно полное окно совпадает с обычным TTR', () => {
  // Ровно 4 слова при окне 4 — одно окно, среднее равно TTR этого окна: 3/4.
  const r = mattr(w('a b c a'), 4);
  assert.equal(r.short, false);
  assert.equal(r.value, 0.75);
});

test('текст короче окна помечается флагом и отдаёт обычный TTR', () => {
  const r = mattr(w('a b c a'), 10);
  assert.equal(r.short, true, 'окно не набралось, а флага нет');
  assert.equal(r.value, 0.75); // 3 уникальных из 4
  assert.equal(r.window, 10);
});

test('MATTR не зависит от длины текста, а TTR зависит', () => {
  // Конкатенация текста с самим собой удваивает длину, не меняя манеры письма.
  // Честная метрика разнообразия обязана остаться на месте.
  const once = fakeText(300, 40);
  const twice = once.concat(once);

  const a = mattr(once).value;
  const b = mattr(twice).value;
  assert.ok(Math.abs(a - b) < 0.01, `MATTR уехал: ${a} → ${b}`);

  // Контраст: тот же вход, обычный TTR — падает почти вдвое.
  const t1 = ttr(once);
  const t2 = ttr(twice);
  assert.ok(t2 < t1 * 0.6, `TTR должен был обвалиться: ${t1} → ${t2}`);
});

test('вырожденные входы MATTR', () => {
  assert.deepEqual(mattr([]), { value: 0, window: 50, short: true });

  const one = mattr(w('слово'));
  assert.equal(one.value, 1);
  assert.equal(one.short, true);

  // Все слова одинаковые: в каждом окне ровно один тип.
  const same = mattr(Array(200).fill('и'), 50);
  assert.equal(same.short, false);
  assert.ok(Math.abs(same.value - 1 / 50) < 1e-12, `получено ${same.value}`);

  // Все слова разные: каждое окно полностью уникально.
  const all = mattr(fakeText(200, 100000), 50);
  assert.equal(all.value, 1);
});

test('инкрементальный MATTR совпадает с пакетным', () => {
  const words = fakeText(500, 60);
  const acc = createMattr();
  for (const word of words) acc.push(word);
  assert.deepEqual(acc.value(), mattr(words));
  assert.equal(acc.size(), 500);
});

test('инкрементальный MATTR совпадает с пакетным на каждом префиксе', () => {
  // Ради этого он и нужен: график по ходу чата снимается на любой длине.
  const words = fakeText(120, 20);
  const acc = createMattr(10);
  for (let i = 0; i < words.length; i += 1) {
    acc.push(words[i]);
    assert.deepEqual(acc.value(), mattr(words.slice(0, i + 1), 10), `префикс ${i + 1}`);
  }
});

test('инкрементальный MATTR: пустой аккумулятор не падает', () => {
  const acc = createMattr();
  assert.deepEqual(acc.value(), { value: 0, window: 50, short: true });
  acc.pushAll(undefined);
  assert.equal(acc.size(), 0);
});

test('MTLD: посчитано вручную', () => {
  // Порог 0.5, текст «a a». Слово 1: TTR = 1/1 = 1, выше порога.
  // Слово 2: TTR = 1/2 = 0.5, порог достигнут → фактор, сброс, хвоста нет.
  // Факторов 1, слов 2 → 2/1 = 2. Назад то же самое → среднее 2.
  assert.equal(mtld(w('a a'), 0.5), 2);

  // Порог 0.5, текст «a b b a» (палиндром, оба прохода одинаковы):
  //   a   → 1/1 = 1
  //   b   → 2/2 = 1
  //   b   → 2/3 = 0.666… выше порога
  //   a   → 2/4 = 0.5 → фактор, сброс, хвоста нет
  // Факторов 1, слов 4 → 4.
  assert.equal(mtld(w('a b b a'), 0.5), 4);
});

test('MTLD: хвост учитывается частичным фактором', () => {
  // Порог 0.5, текст «a a b». Первый проход: «a a» даёт фактор, дальше «b» —
  // TTR = 1, хвостовой фактор (1 - 1) / (1 - 0.5) = 0, итого 3 / 1 = 3.
  // Обратный проход «b a a»: b → 1, a → 1, a → 2/3 = 0.666 > 0.5, порог не
  // достигнут; хвост даёт (1 - 2/3) / 0.5 = 0.666…, итого 3 / 0.666… = 4.5.
  // Среднее = (3 + 4.5) / 2 = 3.75.
  assert.ok(Math.abs(mtld(w('a a b'), 0.5) - 3.75) < 1e-12);
});

test('MTLD растёт при большем разнообразии', () => {
  const poor = fakeText(600, 15);
  const rich = fakeText(600, 300);
  assert.ok(mtld(poor) < mtld(rich), `${mtld(poor)} должно быть меньше ${mtld(rich)}`);
});

test('MTLD не определён там, где TTR не падает', () => {
  assert.ok(Number.isNaN(mtld([])));
  assert.ok(Number.isNaN(mtld(w('одно'))));
  // Все слова разные — TTR держится на единице, ни одного фактора.
  assert.ok(Number.isNaN(mtld(w('a b c d e'))));
  // Все слова одинаковые — фактор набирается сразу, величина конечна.
  assert.ok(Number.isFinite(mtld(Array(100).fill('и'))));
});

test('порог MTLD — 0.72 по умолчанию', () => {
  // Константа откалибрована на английском; на русском смещена.
  assert.equal(MTLD_THRESHOLD, 0.72);
  const words = fakeText(400, 50);
  assert.equal(mtld(words), mtld(words, 0.72));
});

test("Yule's K: посчитано вручную", () => {
  // «a a b c»: N = 4, частоты 2, 1, 1 → Σf² = 4 + 1 + 1 = 6.
  // K = 10000 · (6 − 4) / 16 = 1250.
  assert.equal(yulesK(w('a a b c')), 1250);

  // Все слова одинаковые: N = 4, Σf² = 16 → 10000 · 12 / 16 = 7500.
  assert.equal(yulesK(w('a a a a')), 7500);

  // Все слова разные: Σf² = N → числитель ноль.
  assert.equal(yulesK(w('a b c d')), 0);

  assert.equal(yulesK([]), 0);
  assert.equal(yulesK(w('одно')), 0);
});

test("Yule's K растёт при падении разнообразия", () => {
  assert.ok(yulesK(fakeText(600, 15)) > yulesK(fakeText(600, 300)));
});

test('diversity собирает всё в один объект', () => {
  const words = fakeText(300, 40);
  const d = diversity(words);
  assert.deepEqual(Object.keys(d).sort(), ['mattr', 'mattrShort', 'mtld', 'words', 'yulesK']);
  assert.equal(d.words, 300);
  assert.equal(d.mattrShort, false);
  assert.equal(d.mattr, mattr(words).value);
  assert.equal(d.mtld, mtld(words));
  assert.equal(d.yulesK, yulesK(words));
  assert.ok(d.mattr > 0 && d.mattr <= 1, 'MATTR отдаётся долей, не процентами');
});

test('diversity на вырожденных входах не падает', () => {
  const empty = diversity([]);
  assert.equal(empty.words, 0);
  assert.equal(empty.mattr, 0);
  assert.equal(empty.mattrShort, true);
  assert.ok(Number.isNaN(empty.mtld));
  assert.equal(empty.yulesK, 0);

  const none = diversity(undefined);
  assert.equal(none.words, 0);

  const short = diversity(w('короткий текст короткий'));
  assert.equal(short.mattrShort, true);
  assert.ok(Math.abs(short.mattr - 2 / 3) < 1e-12);
});
