import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCounter, createBloom, hashNgram, STOP_KEYS,
} from '../core/ngrams.mjs';
import { stemKey, tokenizeMessage } from '../core/tokenize.mjs';

// --- вспомогательное ---------------------------------------------------------
// Сообщение в тестах — массив сегментов; счётчику отдаются ключи основ, а
// `resolve` получает те же сегменты токенами. Форма по умолчанию совпадает с
// основой: где важна разница, она задаётся явно.

const tok = words => words.map(w => (typeof w === 'string' ? { form: w, stem: w } : w));
const doc = segments => segments.map(tok);
const keys = d => d.map(seg => seg.map(t => t.stem));

/** Кандидаты, приведённые к «текст=частота» — так руками считать проще. */
function named(counter, docs, opts) {
  const cand = counter.candidates(opts);
  counter.resolve(cand, i => docs[i]);
  return cand.map(c => `${c.text}=${c.count}`);
}

test('маленькая выборка: частоты и номера сообщений считаются вручную', () => {
  const docs = [
    doc([['икс', 'игрек', 'зет', 'вэ']]),
    doc([['икс', 'игрек', 'зет']]),
  ];
  const c = createCounter({ nMin: 3, nMax: 4, switchAtWords: Infinity });
  docs.forEach((d, i) => c.add(i, keys(d)));

  assert.equal(c.words, 7);
  assert.equal(c.mode, 'map');

  // Руками: из четырёх слов получаются два трёхсловных оборота и один
  // четырёхсловный; второе сообщение повторяет только первый из них.
  const all = named(c, docs, { minCount: 1, requireTwoMessages: false });
  assert.deepEqual(all.sort(), [
    'игрек зет вэ=1',
    'икс игрек зет вэ=1',
    'икс игрек зет=2',
  ]);

  const top = c.candidates({ minCount: 2 });
  assert.equal(top.length, 1);
  assert.equal(top[0].count, 2);
  assert.equal(top[0].n, 3);
  assert.equal(top[0].firstMessage, 0);
  assert.equal(top[0].lastMessage, 1);
});

test('n-грамма не пересекает границу сегмента', () => {
  const whole = doc([['альфа', 'бета', 'гамма', 'дельта']]);
  const split = doc([['альфа', 'бета'], ['гамма', 'дельта']]);

  const a = createCounter({ nMin: 3, nMax: 3, switchAtWords: Infinity });
  a.add(0, keys(whole));
  assert.deepEqual(named(a, [whole], { minCount: 1, requireTwoMessages: false }).sort(),
    ['альфа бета гамма=1', 'бета гамма дельта=1']);

  // Те же четыре слова, но разорванные точкой: оборотов нет вообще, а не
  // «есть, но другие» — склейка через границу выдумала бы фразу, которой в
  // тексте не было.
  const b = createCounter({ nMin: 3, nMax: 3, switchAtWords: Infinity });
  b.add(0, keys(split));
  assert.deepEqual(b.candidates({ minCount: 1, requireTwoMessages: false }), []);

  // И через границу между двумя длинными сегментами тоже ничего не склеивается.
  const two = doc([['альфа', 'бета', 'гамма'], ['дельта', 'эпсилон', 'дзета']]);
  const d = createCounter({ nMin: 3, nMax: 6, switchAtWords: Infinity });
  d.add(0, keys(two));
  assert.deepEqual(named(d, [two], { minCount: 1, requireTwoMessages: false }).sort(),
    ['альфа бета гамма=1', 'дельта эпсилон дзета=1']);
});

test('requireTwoMessages отсекает повтор внутри одного сообщения', () => {
  // Цитата или перечисление в одном ходе — не самоповтор модели. На корпусе
  // разработки это 9,9% всех повторяющихся оборотов.
  const inner = doc([['кот', 'сел', 'на', 'стул'], ['кот', 'сел', 'на', 'стул'],
    ['кот', 'сел', 'на', 'стул']]);
  const c = createCounter({ nMin: 3, nMax: 3, switchAtWords: Infinity });
  c.add(0, keys(inner));

  assert.deepEqual(c.candidates({ minCount: 3 }), []);
  const loose = c.candidates({ minCount: 3, requireTwoMessages: false });
  assert.equal(loose.length, 2);
  assert.equal(loose[0].count, 3);
  assert.equal(loose[0].firstMessage, loose[0].lastMessage);

  // Те же три вхождения, но в двух сообщениях — это уже находка.
  const spread = createCounter({ nMin: 3, nMax: 3, switchAtWords: Infinity });
  spread.add(0, keys(doc([['кот', 'сел', 'на', 'стул'], ['кот', 'сел', 'на', 'стул']])));
  spread.add(1, keys(doc([['кот', 'сел', 'на', 'стул']])));
  const found = spread.candidates({ minCount: 3 });
  assert.equal(found.length, 2);
  assert.equal(found[0].count, 3);
  assert.equal(found[0].firstMessage, 0);
  assert.equal(found[0].lastMessage, 1);
});

test('оборот целиком из служебных слов не попадает в кандидаты', () => {
  // Обороты из одних предлогов («в на по») отсеиваются этим же правилом:
  // предлоги входят в список служебных целиком.
  const service = ['в', 'на', 'по'].map(w => stemKey(w));
  const content = stemKey('дом');
  assert.ok(service.every(k => STOP_KEYS.has(k)), 'служебные слова должны быть в списке');
  assert.ok(!STOP_KEYS.has(content), '«дом» не служебное слово');

  const c = createCounter({ nMin: 3, nMax: 3, switchAtWords: Infinity });
  c.add(0, [service]);
  c.add(1, [service]);
  c.add(2, [service]);
  assert.deepEqual(c.candidates({ minCount: 1, requireTwoMessages: false }), []);

  // Одно знаменательное слово в окне — и оборот снова считается: «по спине
  // пробежал» обязан находиться.
  const mixed = createCounter({ nMin: 3, nMax: 3, switchAtWords: Infinity });
  const seg = [service[0], service[1], content];
  mixed.add(0, [seg]);
  mixed.add(1, [seg]);
  assert.equal(mixed.candidates({ minCount: 2 }).length, 1);
});

// --- переход Map → таблица ---------------------------------------------------

/** Детерминированный синтетический корпус: маленький словарь, много повторов. */
function synthetic({ messages = 40, len = 30, vocab = 12 } = {}) {
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const words = Array.from({ length: vocab }, (_, i) => 'сл' + i);
  return Array.from({ length: messages }, () =>
    [Array.from({ length: len }, () => words[Math.floor(rnd() * vocab)])]);
}

test('переход в таблицу не меняет частот у повторяющихся оборотов', () => {
  const docs = synthetic();

  const big = createCounter({ nMin: 3, nMax: 5, switchAtWords: Infinity });
  const small = createCounter({ nMin: 3, nMax: 5, switchAtWords: 300 });
  docs.forEach((d, i) => { big.add(i, d); small.add(i, d); });

  assert.equal(big.mode, 'map');
  assert.equal(small.mode, 'table');

  // Одиночки после перехода потеряны намеренно, поэтому сравниваем только то,
  // что встретилось не реже двух раз. Требование двух сообщений здесь снято:
  // блум теряет номер ПЕРВОГО вхождения, а не частоту.
  const opts = { minCount: 2, requireTwoMessages: false };
  const asMap = list => new Map(list.map(c => [c.hash, c.count]));
  const a = asMap(big.candidates(opts));
  const b = asMap(small.candidates(opts));

  assert.ok(a.size > 50, 'выборка должна быть содержательной, а не пустой');
  assert.deepEqual([...b.keys()].sort(), [...a.keys()].sort());
  for (const [h, count] of a) assert.equal(b.get(h), count, 'частота разошлась после перехода');

  // Верхушка совпадает и по порядку.
  const topA = big.candidates({ minCount: 3 }).slice(0, 10).map(c => c.count);
  const topB = small.candidates({ minCount: 3 }).slice(0, 10).map(c => c.count);
  assert.deepEqual(topB, topA);
});

test('сдвиг при переливе не завышает переживших переход относительно новых', () => {
  // Оборот A встречается только до перехода, B — только после, по четыре раза
  // каждый. Без сдвига счётчика при переливе A показался бы пятёркой.
  const filler = i => ['ф' + i + 'а', 'ф' + i + 'б', 'ф' + i + 'в', 'ф' + i + 'г',
    'ф' + i + 'д', 'ф' + i + 'е', 'ф' + i + 'ж'];
  const docs = [];
  for (let i = 0; i < 4; i++) docs.push([['альфа', 'бета', 'гамма', ...filler(i)]]);
  for (let i = 4; i < 8; i++) docs.push([['дельта', 'эпсилон', 'дзета', ...filler(i)]]);

  const c = createCounter({ nMin: 3, nMax: 3, switchAtWords: 40 });
  docs.forEach((d, i) => {
    c.add(i, d);
    // Сообщение по десять слов: сороковое слово приходит с четвёртым из них.
    assert.equal(c.mode, i < 3 ? 'map' : 'table');
  });

  const cand = c.candidates({ minCount: 2, requireTwoMessages: false });
  c.resolve(cand, i => docs[i].map(tok));

  const a = cand.find(x => x.text === 'альфа бета гамма');
  const b = cand.find(x => x.text === 'дельта эпсилон дзета');
  assert.ok(a, 'оборот, переживший переход, потерялся');
  assert.ok(b, 'оборот, заведённый после перехода, потерялся');
  assert.equal(a.count, 4);
  assert.equal(b.count, 4);
  assert.equal(a.count, b.count);
});

// --- восстановление строк ----------------------------------------------------

test('resolve отдаёт живую форму, а не основу', () => {
  // Стемминг сводит «пробежал» и «пробежала» в одну корзину — иначе оборот не
  // всплыл бы вообще. Но пользователю основа не показывается никогда.
  assert.equal(stemKey('пробежал'), stemKey('пробежала'), 'предпосылка теста');

  const texts = [
    'Холодок пробежал по спине.',
    'Холодок пробежал по спине.',
    'Холодок пробежала по спине.',
  ];
  const docs = texts.map(t => tokenizeMessage(t).segments);

  const c = createCounter({ nMin: 4, nMax: 4, switchAtWords: Infinity });
  docs.forEach((d, i) => c.add(i, d.map(seg => seg.map(t => t.stem))));

  const cand = c.candidates({ minCount: 3 });
  assert.equal(cand.length, 1);
  assert.equal(cand[0].count, 3);

  const same = c.resolve(cand, i => docs[i]);
  assert.equal(same, cand, 'resolve обязан вернуть тот же массив');
  assert.equal(cand[0].text, 'холодок пробежал по спине', 'показана не самая частая форма');
  assert.deepEqual(cand[0].stems.length, 4);
  assert.notEqual(cand[0].stems.join(' '), cand[0].text, 'наружу ушла основа');
});

// --- покрытие повторами ------------------------------------------------------

test('coverage: доля слов, накрытых уже известными оборотами', () => {
  const c = createCounter({ nMin: 3, nMax: 3, switchAtWords: Infinity });
  c.add(0, [['раз', 'два', 'три', 'четыре', 'пять']]);

  // Руками: из четырёх слов одно окно известно («раз два три») и накрывает три
  // позиции, второе («два три шесть») счётчику незнакомо.
  const cov = c.coverage([['раз', 'два', 'три', 'шесть']]);
  assert.equal(cov.words, 4);
  assert.equal(cov.covered, 3);
  assert.equal(cov.ratio, 0.75);
  assert.deepEqual(cov.byN, { 3: 3 });
});

test('coverage до add не видит собственных оборотов сообщения', () => {
  const segs = [['новое', 'слово', 'здесь', 'совсем']];
  const c = createCounter({ nMin: 3, nMax: 3, switchAtWords: Infinity });

  const before = c.coverage(segs);
  assert.equal(before.covered, 0, 'сообщение не должно повторять само себя');
  assert.equal(before.ratio, 0);

  c.add(0, segs);
  const after = c.coverage(segs);
  assert.equal(after.covered, 4);
  assert.equal(after.ratio, 1);
});

test('coverage не суммирует пересекающиеся обороты и не вылезает за единицу', () => {
  const docs = synthetic({ messages: 12, len: 25, vocab: 8 });
  const c = createCounter({ nMin: 3, nMax: 6, switchAtWords: Infinity });
  for (const d of docs) {
    const cov = c.coverage(d);
    assert.ok(cov.ratio >= 0 && cov.ratio <= 1, `доля вне диапазона: ${cov.ratio}`);
    assert.ok(cov.covered <= cov.words);
    // Разбивка по длинам может суммарно превышать covered — одна позиция
    // входит в обороты разных длин, — но каждая длина сама по себе не больше.
    for (const n of Object.keys(cov.byN)) assert.ok(cov.byN[n] <= cov.words);
    c.add(docs.indexOf(d), d);
  }
  assert.ok(c.coverage(docs[0]).ratio > 0.5, 'на повторяющемся корпусе покрытие должно расти');
});

test('has: известен ли оборот, в обоих режимах', () => {
  const docs = synthetic({ messages: 20, len: 25, vocab: 8 });
  for (const switchAtWords of [Infinity, 100]) {
    const c = createCounter({ nMin: 3, nMax: 3, switchAtWords });
    docs.forEach((d, i) => c.add(i, d));
    const cand = c.candidates({ minCount: 2, requireTwoMessages: false });
    assert.ok(cand.length > 0);
    for (const x of cand.slice(0, 20)) assert.equal(c.has(x.hash), true);
    // Хеш, которого счётчик не видел. Блум ошибается только в сторону «да»,
    // поэтому проверка честная лишь на заведомо чужом значении.
    assert.equal(c.has(1), false);
  }
});

// --- стенды и вспомогательные функции ---------------------------------------

test('stats отражает режим, наполнение и порядок памяти', () => {
  const docs = synthetic({ messages: 30, len: 30, vocab: 10 });

  const m = createCounter({ nMin: 3, nMax: 5, switchAtWords: Infinity });
  docs.forEach((d, i) => m.add(i, d));
  const sm = m.stats();
  assert.equal(sm.mode, 'map');
  assert.equal(sm.words, 900);
  assert.equal(sm.tableLoad, 0);
  assert.ok(sm.distinct > 0 && sm.singles > 0 && sm.singles <= sm.distinct);
  assert.ok(sm.bytes > 0);

  const t = createCounter({ nMin: 3, nMax: 5, switchAtWords: 200 });
  docs.forEach((d, i) => t.add(i, d));
  const st = t.stats();
  assert.equal(st.mode, 'table');
  assert.equal(st.words, 900);
  assert.ok(st.tableLoad > 0 && st.tableLoad <= 0.7, `наполнение таблицы ${st.tableLoad}`);
  assert.ok(st.bytes > 0);
});

test('хеш оборота: 53 бита, детерминирован и чувствителен к длине', () => {
  assert.equal(hashNgram([1, 2, 3]), hashNgram([0, 1, 2, 3], 1, 3));
  assert.notEqual(hashNgram([1, 2, 3]), hashNgram([1, 2, 4]));
  assert.notEqual(hashNgram([1, 2, 3]), hashNgram([3, 2, 1]));
  // Длина подмешана в финал: окно из трёх слов не совпадёт с окном из четырёх.
  assert.notEqual(hashNgram([1, 2, 3, 4], 0, 3), hashNgram([1, 2, 3, 4], 0, 4));

  for (let i = 0; i < 500; i++) {
    const h = hashNgram([i, i * 7 + 1, i * 13 + 2]);
    assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 53, `хеш вне 53 бит: ${h}`);
  }

  // 32 бит не хватило бы: на десятках тысяч оборотов склейки пошли бы в топ.
  const seen = new Set();
  for (let i = 0; i < 50000; i++) seen.add(hashNgram([i, i >> 3, i >> 7]));
  assert.equal(seen.size, 50000, 'ложная склейка на 53-битном хеше');
});

test('блум-фильтр: ложных отрицаний не бывает', () => {
  const bloom = createBloom({ bits: 1 << 20, hashes: 3 });
  const added = [];
  for (let i = 0; i < 1000; i++) {
    const h = hashNgram([i, i * 31, i * 17 + 5]);
    assert.equal(bloom.has(h), false, `сказал «да» до добавления на ${i}`);
    bloom.add(h);
    added.push(h);
  }
  for (const h of added) assert.equal(bloom.has(h), true, 'ложное отрицание');
  assert.equal(bloom.marks, 1000);
  assert.equal(bloom.bytes, (1 << 20) / 8);
});

test('на пустом входе ничего не падает', () => {
  const c = createCounter();
  c.add(0, []);
  c.add(1, undefined);
  c.add(2, [[]]);
  assert.equal(c.words, 0);
  assert.deepEqual(c.candidates(), []);
  assert.deepEqual(c.coverage([]), { words: 0, covered: 0, ratio: 0, byN: { 3: 0, 4: 0, 5: 0, 6: 0 } });
  assert.deepEqual(c.resolve([], () => []), []);
  assert.equal(c.stats().distinct, 0);
});
