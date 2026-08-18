import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHINGLE_K, MIN_WORDS, fingerprint, containment, longestRun, createDetector,
} from '../core/similarity.mjs';

const words = s => s.split(' ');

/** Жаккар — только для теста, показать, почему в ядре его нет. */
function jaccard(aFp, bFp) {
  let i = 0, j = 0, hit = 0;
  while (i < aFp.length && j < bFp.length) {
    if (aFp[i] === bFp[j]) { hit++; i++; j++; }
    else if (aFp[i] < bFp[j]) i++;
    else j++;
  }
  return hit / (aFp.length + bFp.length - hit);
}

/** Сообщение из непохожих ни на что слов: w0 w1 w2 … */
const filler = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => prefix + i);

test('шингл — четырёхсловный', () => {
  assert.equal(SHINGLE_K, 4);
});

test('отпечаток: число шинглов, сортировка, отсутствие повторов', () => {
  const fp = fingerprint(words('один два три четыре пять шесть семь'));
  assert.equal(fp.length, 4);            // 7 слов − 4 + 1
  assert.ok(fp instanceof Uint32Array);
  for (let i = 1; i < fp.length; i++) assert.ok(fp[i] > fp[i - 1]);
});

test('повторённый оборот внутри сообщения даёт один шингл, а не два', () => {
  const fp = fingerprint(words('а б в г д а б в г'));
  // окна: абвг, бвгд, вгда, гдаб, даб в, абвг(повтор) → 6 окон, 5 различных
  assert.equal(fp.length, 5);
});

test('containment посчитан вручную и несимметричен', () => {
  const a = fingerprint(words('один два три четыре пять шесть семь'));  // 4 шингла
  const b = fingerprint(words('один два три четыре девять'));           // 2 шингла
  // общий шингл ровно один: «один два три четыре»
  assert.equal(containment(a, b), 1 / 4);
  assert.equal(containment(b, a), 1 / 2);
});

test('два одинаковых сообщения — containment ровно 1', () => {
  const text = words('она посмотрела на него и ничего не сказала совсем');
  const a = fingerprint(text);
  const b = fingerprint(text.slice());
  assert.equal(containment(a, b), 1);
  assert.equal(containment(b, a), 1);
});

test('ключевой случай раздела 3.5: Жаккар даёт ложное «непохоже», containment — нет', () => {
  // Длинное старое сообщение и короткое новое, в котором дословно повторены
  // две трети старого текста.
  const long = filler(5000);
  const short = long.slice(1000, 1200).concat(filler(100, 'n'));

  const fpLong = fingerprint(long);
  const fpShort = fingerprint(short);

  const c = containment(fpShort, fpLong);
  const j = jaccard(fpShort, fpLong);

  // 197 общих шинглов из 297 шинглов нового сообщения
  assert.equal(fpShort.length, 297);
  assert.equal(Math.round(c * 297), 197);
  assert.ok(c > 0.6, `containment ${c}`);

  // Жаккар делит те же 197 на объединение в 5097 шинглов — около 0,04,
  // то есть «непохоже», хотя две трети нового текста списаны дословно.
  assert.ok(j < 0.05, `Жаккар ${j}`);
  assert.ok(c / j > 15, `отрыв ${c / j}`);
});

test('longestRun находит точную длину и позиции в обоих сообщениях', () => {
  const a = words('он открыл дверь и вошёл в тёмный зал');
  const b = words('она уже вошла тогда и вошёл в тёмный зал совсем не так');
  const r = longestRun(a, b);
  // «и вошёл в тёмный зал» — 5 слов, начинаются в сообщениях на разных местах
  assert.equal(r.length, 5);
  assert.equal(r.startA, 3);
  assert.equal(r.startB, 4);
  assert.deepEqual(a.slice(r.startA, r.startA + r.length), b.slice(r.startB, r.startB + r.length));
});

test('longestRun по формам короче, чем по основам, там где стеммер склеил формы', () => {
  const stemsA = words('она посмотр на него');
  const stemsB = words('она посмотр на него');
  const formsA = words('она посмотрела на него');
  const formsB = words('она посмотрел на него');
  assert.equal(longestRun(stemsA, stemsB).length, 4);
  const byForms = longestRun(formsA, formsB);
  assert.equal(byForms.length, 2);            // «на него»
  assert.equal(byForms.startA, 2);
  // Отсюда правило: подсвечивать по формам, иначе выделение не сойдётся с
  // текстом на экране.
});

test('вырожденные входы: пусто и короче шингла', () => {
  assert.equal(fingerprint([]).length, 0);
  assert.equal(fingerprint(undefined).length, 0);
  assert.equal(fingerprint(words('три коротких слова')).length, 0);
  assert.equal(fingerprint(words('ровно четыре слова тут')).length, 1);
  assert.equal(containment(fingerprint([]), fingerprint(words('а б в г'))), 0);
  assert.equal(containment(fingerprint(words('а б в г')), fingerprint([])), 0);
  assert.equal(longestRun([], ['а']).length, 0);
});

test('детектор сравнивает только с предыдущими сообщениями', () => {
  const d = createDetector();
  const body = filler(60);
  const first = d.add({ index: 0, stems: body, forms: body });
  assert.equal(first.best, null);           // сравнивать не с чем
  const second = d.add({ index: 1, stems: body, forms: body });
  assert.equal(second.best.index, 0);
  assert.equal(second.best.containment, 1);
  assert.equal(second.best.run.length, 60);
  assert.equal(second.containmentToPrev, 1);
});

test('короткое сообщение подозреваемым не становится, но партнёром быть может', () => {
  const d = createDetector();
  const short = filler(MIN_WORDS - 10);
  const long = short.concat(filler(60, 'x'));

  const a = d.add({ index: 0, stems: short, forms: short });
  assert.equal(a.best, null);

  const b = d.add({ index: 1, stems: short.slice(), forms: short.slice() });
  assert.equal(b.best, null, 'короткое не оценивается, хотя совпало полностью');

  const c = d.add({ index: 2, stems: long, forms: long });
  assert.equal(c.best.index, 0, 'длинное нашло короткое партнёром');
  assert.ok(c.best.containment > 0);
});

test('порог от распределения: шаблонное обрамление поднимает пол и не даёт ложных находок', () => {
  const frame = filler(20, 'f');                 // одинаковая шапка в каждом сообщении
  const d = createDetector();
  for (let i = 0; i < 12; i++) {
    const body = frame.concat(filler(45, `u${i}_`));
    d.add({ index: i, stems: body, forms: body });
  }
  const base = d.baseline();
  assert.ok(base.median > 0, 'обрамление подняло базовую линию');
  assert.equal(base.pairs, 66);                  // 12·11/2
  assert.deepEqual(d.findings(), [], 'одно только обрамление находкой быть не должно');
});

test('порог от распределения: настоящий повтор на том же фоне находится', () => {
  const frame = filler(20, 'f');
  const d = createDetector();
  const bodies = [];
  for (let i = 0; i < 12; i++) {
    const body = frame.concat(filler(45, `u${i}_`));
    bodies.push(body);
    d.add({ index: i, stems: body, forms: body });
  }
  // Сообщение №12 дословно переписывает середину сообщения №5.
  const copy = frame.concat(bodies[5].slice(25, 55), filler(15, 'z'));
  d.add({ index: 12, stems: copy, forms: copy });

  const found = d.findings();
  assert.equal(found.length, 1);
  assert.equal(found[0].index, 12);
  assert.equal(found[0].partner, 5);
  assert.ok(found[0].containment > d.baseline().median);
  assert.ok(found[0].runLength >= 30, `дословно подряд ${found[0].runLength}`);
  // Позиции указывают на один и тот же текст в обоих сообщениях.
  assert.deepEqual(
    copy.slice(found[0].startA, found[0].startA + found[0].runLength),
    bodies[5].slice(found[0].startB, found[0].startB + found[0].runLength),
  );
});

test('находки отсортированы по убыванию похожести', () => {
  const d = createDetector({ quantile: 0.5 });
  const base = filler(80);
  d.add({ index: 0, stems: base, forms: base });
  const half = base.slice(0, 40).concat(filler(40, 'a'));
  const most = base.slice(0, 70).concat(filler(10, 'b'));
  d.add({ index: 1, stems: half, forms: half });
  d.add({ index: 2, stems: most, forms: most });
  const found = d.findings();
  assert.ok(found.length >= 1);
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i - 1].containment >= found[i].containment);
  }
  assert.equal(found[0].index, 2);
});

test('stats отдаёт память и число пар', () => {
  const d = createDetector();
  const body = filler(60);
  d.add({ index: 0, stems: body, forms: body });
  d.add({ index: 1, stems: body.slice(), forms: body.slice() });
  const s = d.stats();
  assert.equal(s.messages, 2);
  assert.equal(s.pairs, 1);
  assert.equal(s.shingles, 57 * 2);
  assert.ok(s.bytes > 0);
});
