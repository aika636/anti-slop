// Стенд: прямая сверка боевого счётчика `core/ngrams.mjs` с наивным подсчётом
// стендов.
//
//   node --expose-gc tools/verify-core.mjs
//   node --expose-gc tools/verify-core.mjs --bloom-stress
//
// ЗАЧЕМ. `tools/cutoff.mjs` и `tools/corpus-stats.mjs` считают обороты наивно —
// `Map<строка, число>` — и именно поэтому их цифрам можно верить: там нечему
// ломаться. Боевой счётчик считает то же самое поверх интернирования, 53-битного
// хеша, таблицы на типизированных массивах и блум-фильтра. Стенды НЕ переписаны
// на ядро намеренно: если бы обе стороны считали одним кодом, сверять было бы не
// с чем. Здесь наивный метод скопирован из `cutoff.mjs` дословно и прогоняется
// на том же корпусе, что и ядро, сообщение в сообщение.
//
// Что сверяется:
//   1. Режим `map` (порог перехода задран) — обязан совпасть с наивным ТОЧНО,
//      без всяких поблажек: это тот же алгоритм, только с хешем вместо строки.
//   2. Режим `table` (порог перехода занижен, переход гарантирован) — обязан
//      совпасть с точностью до задокументированных следствий схемы:
//        - частоты после компенсации точны;
//        - одиночки, впервые увиденные после перехода, теряются насовсем;
//        - у оборота, заведённого после перехода, `firstMessage` — это номер
//          ВТОРОГО вхождения, потому что первое съел блум;
//        - ложное срабатывание блума заводит лишний слот и завышает частоту
//          ровно на единицу.
//      Всё, что не объясняется этим списком, — баг, и таких должно быть ноль.
//   3. C-value: наивный `rank` из `cutoff.mjs` против `cvalue` из ядра НА ОДНИХ
//      И ТЕХ ЖЕ счётчиках. Расхождение здесь означает, что перенос метода в ядро
//      что-то изменил.
//   4. Самоповтор: строковые шинглы `tools/shingle.mjs` против хешированных
//      шинглов `core/similarity.mjs`.
//
// Про хеши. Чтобы сопоставить наивный ключ-строку с 53-битным хешем ядра, здесь
// повторяется интернирование основ: ядро раздаёт идентификаторы в порядке
// первого появления основы при обходе сегментов длиной не меньше nMin, и тот же
// порядок воспроизводится ниже. Предположение не берётся на веру — оно
// проверяется отдельно, через `resolve` боевого счётчика (пункт 0 вывода стенда).

import { readCorpus } from './corpus.mjs';
import { tokenize, splitProse, namesFromChat, nameBarriers, stemKey as stemWord } from '../core/tokenize.mjs';
import { createCounter, hashNgram, STOP_WORDS } from '../core/ngrams.mjs';
import { cvalue } from '../core/cvalue.mjs';
import {
  fingerprint, containment as coreContainment, longestRun as coreLongestRun,
  createDetector, SHINGLE_K, MIN_WORDS,
} from '../core/similarity.mjs';

const NMIN = 3, NMAX = 6;
const MIN_MESSAGES = 2;
const TOP = 20;
const BLOOM_STRESS = process.argv.includes('--bloom-stress');

const fmt = x => Math.round(x).toLocaleString('ru-RU');
const pct = x => (x * 100).toFixed(1) + '%';
// Доля ложных срабатываний блума меряется тысячными долями процента — на
// одном знаке после запятой она превращается в «0,0%» и перестаёт что-либо
// значить.
const pct3 = x => (x * 100).toFixed(3) + '%';
const mb = b => (b / 2 ** 20).toFixed(1) + ' МБ';

// Все расхождения, которые стенд не смог объяснить устройством схемы. Пустой
// список в конце — и есть «сошлось».
const problems = [];
const expected = [];      // задокументированные следствия, найденные на деле

// --- корпус -----------------------------------------------------------------
// Слово в слово как в cutoff.mjs: тот же отбор имён, та же токенизация. Иначе
// сверялись бы разные входы, а не разные счётчики.

const corpus = readCorpus();
const names = new Set();
for (const chat of corpus) {
  for (const n of namesFromChat(chat)) names.add(n);
  for (const n of chat.extraNames) names.add(n);
}
const barriers = nameBarriers(names);
const allMessages = corpus.flatMap(c => c.messages);

/** Сообщение → сегменты основ. Ровно `stemsOf` из cutoff.mjs. */
function stemsOf(mes) {
  const { prose } = splitProse(mes);
  return tokenize(prose, { stem: true, barriers }).map(seg => seg.map(t => t.stem));
}

/** То же, но с живыми формами: нужно `resolve` и метрикам самоповтора. */
function tokensOf(mes) {
  const { prose } = splitProse(mes);
  return tokenize(prose, { stem: true, barriers })
    .map(seg => seg.map(t => ({ form: t.form, stem: t.stem })));
}

const docs = allMessages.map(m => stemsOf(m.mes));
const wordsTotal = docs.reduce((a, segs) => a + segs.reduce((b, s) => b + s.length, 0), 0);

console.log(`Чатов: ${corpus.length}, сообщений модели: ${allMessages.length}, `
  + `слов прозы: ${fmt(wordsTotal)}`);
console.log(`n от ${NMIN} до ${NMAX}, режим «проза + стемминг» — как в cutoff.mjs.`);
if (!globalThis.gc) console.log('\n[!] Запущено без --expose-gc: замеры памяти будут шумными.');

// Список служебных слов у стенда и у ядра обязан быть один и тот же, иначе
// «оборот целиком из служебных» отсеется в разных местах по-разному и вся
// сверка поедет на ровном месте.
const STOP = new Set(('и а но да же ли бы то что как так вот уже еще не ни в во на за по под над о об от до из у к с со для при про без через между том тем тот та те это эта этот эти он она они оно его ее их им ими ему ей себя свой своя свои мой моя мои твой твоя ты я мы вы был была были было быть есть нет очень когда где куда потом просто только лишь если чтобы или либо тоже также сам сама сами один одна одно').split(' '));
const STOP_KEYS = new Set([...STOP].map(w => stemWord(w)));
{
  const same = STOP.size === STOP_WORDS.size && [...STOP].every(w => STOP_WORDS.has(w));
  if (!same) problems.push('Список служебных слов в стенде и в core/ngrams разошёлся.');
  console.log(`Служебных слов: ${STOP.size}, совпадает с ядром: ${same ? 'да' : 'НЕТ'}`);
}

// ---------------------------------------------------------------------------
// 1. Три схемы: память и время
// ---------------------------------------------------------------------------
// Замеры идут первыми и по очереди, на как можно более чистой куче: наивный
// словарь строк меряется ровно тем же кодом, что в cutoff.mjs (`Map<строка,
// число>` и ничего больше), иначе мерилась бы не та схема.

function measureHeap(build) {
  const gc = globalThis.gc;
  gc?.(); gc?.();
  const before = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  const value = build();
  const ms = Date.now() - t0;
  gc?.(); gc?.();
  const bytes = process.memoryUsage().heapUsed - before;
  return { value, ms, bytes };
}

const naiveRun = measureHeap(() => {
  const map = new Map();
  for (const segs of docs) {
    for (const t of segs) {
      for (let n = NMIN; n <= NMAX; n++) {
        for (let i = 0; i + n <= t.length; i++) {
          const key = n + ' ' + t.slice(i, i + n).join(' ');
          map.set(key, (map.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return map;
});
const naiveDistinct = naiveRun.value.size;
naiveRun.value = null;    // дальше он не нужен: сверка идёт по богатому счётчику

// Порог перехода. В режиме `map` он задран так, чтобы перехода не случилось
// никогда; в режиме `table` посажен на четверть корпуса, чтобы переход точно
// произошёл и при этом по обе стороны от него осталось заметно текста.
const SWITCH_AT = Math.max(1, Math.round(wordsTotal * 0.25));

let mapFlushed = false;
const mapRun = measureHeap(() => {
  const c = createCounter({ nMin: NMIN, nMax: NMAX, switchAtWords: Number.MAX_SAFE_INTEGER });
  docs.forEach((segs, i) => c.add(i, segs));
  mapFlushed = c.mode !== 'map';
  return c;
});
const counterMap = mapRun.value;

let flushAfter = -1;
const tableRun = measureHeap(() => {
  const c = createCounter({ nMin: NMIN, nMax: NMAX, switchAtWords: SWITCH_AT });
  docs.forEach((segs, i) => {
    c.add(i, segs);
    if (flushAfter < 0 && c.mode === 'table') flushAfter = i;
  });
  return c;
});
const counterTable = tableRun.value;

if (mapFlushed) problems.push('Режим map всё-таки перешёл в таблицу — сверка «точно так же» невалидна.');
if (counterTable.mode !== 'table') problems.push('Режим table не перешёл в таблицу — порог перехода не сработал.');

const statMap = counterMap.stats();
const statTable = counterTable.stats();

console.log('\n=== 1. Память и время трёх схем ===');
console.log('схема'.padEnd(34), 'различных'.padStart(11), 'куча'.padStart(10),
  'по stats()'.padStart(12), 'время'.padStart(9));
const row = (name, distinct, heap, own, ms) => console.log(
  name.padEnd(34), fmt(distinct).padStart(11), mb(heap).padStart(10),
  (own === null ? '—' : mb(own)).padStart(12), (fmt(ms) + ' мс').padStart(9));
row('наивный Map<строка, число>', naiveDistinct, naiveRun.bytes, null, naiveRun.ms);
row('core, режим map', statMap.distinct, mapRun.bytes, statMap.bytes, mapRun.ms);
row(`core, режим table (переход на ${fmt(SWITCH_AT)} сл.)`, statTable.distinct, tableRun.bytes, statTable.bytes, tableRun.ms);
console.log(`Переход в таблицу случился после сообщения #${flushAfter} из ${docs.length}.`);
console.log(`Наполнение таблицы: ${pct(statTable.tableLoad)}, помечено одиночек: ${fmt(statTable.singles)}.`);
console.log(`На запись: наивно ${(naiveRun.bytes / naiveDistinct).toFixed(0)} байт, `
  + `core/map ${(mapRun.bytes / Math.max(1, statMap.distinct)).toFixed(0)} байт, `
  + `core/table ${(tableRun.bytes / Math.max(1, statTable.distinct)).toFixed(0)} байт на дожившую запись.`);

// ---------------------------------------------------------------------------
// 2. Наивный счётчик для сверки
// ---------------------------------------------------------------------------
// Тот же обход, но с полями, которых требует сверка: множество сообщений (как в
// cutoff.mjs, для `rank`), номер первого и последнего вхождения и отдельно —
// номер сообщения ВТОРОГО вхождения. Последнее нужно только здесь: именно на
// втором вхождении боевой счётчик заводит слот после перехода, и без этого
// числа нельзя отличить задокументированную потерю первого вхождения от бага.

const naive = new Map();     // "n основы" → запись
for (let idx = 0; idx < docs.length; idx++) {
  for (const t of docs[idx]) {
    for (let n = NMIN; n <= NMAX; n++) {
      for (let i = 0; i + n <= t.length; i++) {
        const key = n + ' ' + t.slice(i, i + n).join(' ');
        let e = naive.get(key);
        if (!e) {
          e = { n, c: 0, msgs: new Set(), first: idx, second: -1, last: idx };
          naive.set(key, e);
        }
        e.c++;
        if (e.c === 2) e.second = idx;
        e.msgs.add(idx);
        e.last = idx;
      }
    }
  }
}

// Повторение интернирования ядра: идентификаторы раздаются в порядке первого
// появления основы при обходе сегментов длиной не меньше nMin — ровно как в
// `createCounter.add`.
const stemIds = new Map();
for (const segs of docs) {
  for (const seg of segs) {
    if (seg.length < NMIN) continue;
    for (const s of seg) if (!stemIds.has(s)) stemIds.set(s, stemIds.size);
  }
}

// Наивные записи, приведённые к виду кандидата ядра. Обороты целиком из
// служебных слов выброшены здесь, потому что ядро их не считает вовсе (в
// cutoff.mjs тот же отсев стоит в `rank`, то есть позже — на результат это не
// влияет, но сравнивать надо сравнимое).
const naiveByHash = new Map();   // хеш → {key, parts, n, c, first, second, last, msgs}
let allStopDropped = 0;
let hashCollisions = 0;
const idBuf = new Int32Array(NMAX);
for (const [key, e] of naive) {
  const parts = key.slice(2).split(' ');
  if (parts.every(w => STOP_KEYS.has(w))) { allStopDropped++; continue; }
  for (let i = 0; i < e.n; i++) idBuf[i] = stemIds.get(parts[i]);
  const h = hashNgram(idBuf, 0, e.n);
  if (naiveByHash.has(h)) hashCollisions++;
  naiveByHash.set(h, { key, parts, ...e });
}

console.log('\n=== 2. Наивный счётчик, приведённый к виду ядра ===');
console.log(`Различных оборотов всего:              ${fmt(naive.size)}`);
console.log(`Из них целиком из служебных слов:      ${fmt(allStopDropped)} `
  + `(${pct(allStopDropped / naive.size)}) — ядро их не считает вовсе`);
console.log(`Остаётся для сверки:                   ${fmt(naiveByHash.size)}`);
console.log(`Столкновений 53-битного хеша:          ${hashCollisions}`);
if (hashCollisions > 0) {
  // Это не баг ядра, а свойство хеша, но знать о нём надо: столкнувшиеся
  // обороты в сверке неотличимы друг от друга.
  expected.push(`53-битный хеш дал ${hashCollisions} столкновений на ${fmt(naiveByHash.size)} оборотах `
    + `(ожидание при случайном хеше — ${(naiveByHash.size ** 2 / 2 / 2 ** 53).toFixed(3)}).`);
}

// ---------------------------------------------------------------------------
// 0-бис. Проверка допущения про интернирование
// ---------------------------------------------------------------------------
// Всё сопоставление держится на том, что идентификаторы основ у стенда и у ядра
// совпадают. Проверяем это не рассуждением, а боевым `resolve`: он восстановит
// основы по хешам сам, своим внутренним словарём. Если наши хеши построены
// неправильно, `resolve` вернёт пустые основы или чужие.

{
  const probe = counterMap.candidates({ minCount: 3 }).slice(0, 200);
  counterMap.resolve(probe, i => (i >= 0 && i < allMessages.length ? tokensOf(allMessages[i].mes) : null));
  let ok = 0, bad = 0;
  for (const c of probe) {
    const mine = naiveByHash.get(c.hash);
    if (mine && c.stems.length && mine.parts.join(' ') === c.stems.join(' ')) ok++;
    else bad++;
  }
  console.log(`\nПроверка сопоставления хешей через боевой resolve: ${ok} совпало, ${bad} нет `
    + `(из ${probe.length} верхних кандидатов).`);
  if (bad > 0) problems.push(`resolve вернул чужие основы для ${bad} кандидатов — сопоставление хешей неверно.`);
}

// ---------------------------------------------------------------------------
// 3. Режим map против наивного
// ---------------------------------------------------------------------------
// Здесь поблажек нет: это тот же алгоритм с хешем вместо строки, и разойтись он
// не имеет права ни в одной записи.

function compareExact(candidates, title) {
  const seen = new Set();
  let same = 0, countBad = 0, firstBad = 0, lastBad = 0, extra = 0;
  const samples = [];
  for (const c of candidates) {
    const mine = naiveByHash.get(c.hash);
    if (!mine) {
      extra++;
      if (samples.length < 5) samples.push(`лишний хеш ${c.hash} (n=${c.n}, c=${c.count})`);
      continue;
    }
    seen.add(c.hash);
    let bad = false;
    if (c.count !== mine.c) { countBad++; bad = true; }
    if (c.firstMessage !== mine.first) { firstBad++; bad = true; }
    if (c.lastMessage !== mine.last) { lastBad++; bad = true; }
    if (bad) {
      if (samples.length < 5) {
        samples.push(`«${mine.key}»: наивно c=${mine.c} [${mine.first}..${mine.last}], `
          + `ядро c=${c.count} [${c.firstMessage}..${c.lastMessage}]`);
      }
    } else same++;
  }
  const missing = naiveByHash.size - seen.size;
  console.log(`\n=== 3. ${title} ===`);
  console.log(`Кандидатов у ядра: ${fmt(candidates.length)}, у наивного: ${fmt(naiveByHash.size)}`);
  console.log(`Совпало полностью (частота + первое + последнее): ${fmt(same)}`);
  console.log(`Расхождений по частоте: ${countBad}, по firstMessage: ${firstBad}, по lastMessage: ${lastBad}`);
  console.log(`Ядро нашло лишних: ${extra}, потеряло: ${missing}`);
  for (const s of samples) console.log(`  ${s}`);
  if (countBad || firstBad || lastBad || extra || missing) {
    problems.push(`${title}: ${countBad} частот, ${firstBad} first, ${lastBad} last, `
      + `${extra} лишних, ${missing} потерянных.`);
  } else {
    console.log('Расхождений нет.');
  }
}

const candMap = counterMap.candidates({ minCount: 1, requireTwoMessages: false });
compareExact(candMap, 'Режим map против наивного подсчёта');

// ---------------------------------------------------------------------------
// 4. Режим table против наивного
// ---------------------------------------------------------------------------
// Здесь расхождения ЗАКОНОМЕРНЫ, и задача стенда — разложить их по названным в
// шапке `core/ngrams.mjs` причинам и убедиться, что необъяснённых нет.

function compareTable(counter, title, note) {
  const cands = counter.candidates({ minCount: 1, requireTwoMessages: false });
  const seen = new Set();

  let exact = 0;              // всё сошлось
  let lostFirst = 0;          // частота верна, first — номер второго вхождения
  let bloomFP = 0;            // частота завышена ровно на 1, first не тронут
  let unexplained = 0;
  let lastBad = 0;
  let extraHash = 0;          // хеша нет у наивного вовсе — такого быть не может
  const samples = [];

  for (const c of cands) {
    const mine = naiveByHash.get(c.hash);
    if (!mine) {
      extraHash++;
      if (samples.length < 5) samples.push(`НЕИЗВЕСТНЫЙ хеш ${c.hash} (n=${c.n}, c=${c.count})`);
      continue;
    }
    seen.add(c.hash);

    if (c.lastMessage !== mine.last) {
      lastBad++;
      if (samples.length < 5) {
        samples.push(`«${mine.key}»: last наивно ${mine.last}, ядро ${c.lastMessage}`);
      }
    }

    if (c.count === mine.c && c.firstMessage === mine.first) { exact++; continue; }
    if (c.count === mine.c && c.firstMessage === mine.second) { lostFirst++; continue; }
    if (c.count === mine.c + 1 && c.firstMessage === mine.first) { bloomFP++; continue; }

    unexplained++;
    if (samples.length < 5) {
      samples.push(`«${mine.key}»: наивно c=${mine.c} first=${mine.first} second=${mine.second} last=${mine.last}, `
        + `ядро c=${c.count} first=${c.firstMessage} last=${c.lastMessage}`);
    }
  }

  // Потери. Потерять ядро имеет право только настоящую одиночку: у оборота с
  // двумя и более вхождениями второе вхождение обязано завести слот.
  let lostSingles = 0, lostReal = 0;
  const lostSamples = [];
  for (const [h, mine] of naiveByHash) {
    if (seen.has(h)) continue;
    if (mine.c === 1) lostSingles++;
    else {
      lostReal++;
      if (lostSamples.length < 5) {
        lostSamples.push(`«${mine.key}» c=${mine.c} [${mine.first}..${mine.last}]`);
      }
    }
  }

  // Знаменатель для оценки блума — все обороты, ПЕРВОЕ вхождение которых
  // пришлось уже на режим таблицы: именно на них блум и отвечает, и только у
  // них ложное «да» может завести лишний слот. Одиночки считаются отдельно:
  // это то, что схема теряет намеренно.
  let firstAfterFlush = 0, singlesTotal = 0;
  for (const mine of naiveByHash.values()) {
    if (mine.c === 1) singlesTotal++;
    if (mine.first > flushAfter) firstAfterFlush++;
  }

  console.log(`\n=== 4. ${title} ===`);
  if (note) console.log(note);
  console.log(`Кандидатов у ядра: ${fmt(cands.length)}, у наивного: ${fmt(naiveByHash.size)}`);
  console.log(`Совпало точь-в-точь:                                   ${fmt(exact)}`);
  console.log(`Частота верна, first — номер ВТОРОГО вхождения:        ${fmt(lostFirst)}  (следствие схемы)`);
  console.log(`Частота завышена ровно на 1 — ложное срабатывание блума: ${fmt(bloomFP)}  (следствие схемы)`);
  console.log(`Необъяснённых расхождений:                             ${unexplained}`);
  console.log(`Расхождений по lastMessage:                            ${lastBad}`);
  console.log(`Хешей, которых нет у наивного:                         ${extraHash}`);
  console.log(`Потеряно одиночек (c=1):                               ${fmt(lostSingles)} `
    + `из ${fmt(singlesTotal)} — по устройству`);
  console.log(`Потеряно настоящих повторов (c>=2):                    ${lostReal}`);
  for (const s of samples) console.log(`  ${s}`);
  for (const s of lostSamples) console.log(`  ПОТЕРЯ: ${s}`);

  const fpRate = firstAfterFlush ? bloomFP / firstAfterFlush : 0;
  console.log(`Оборотов, впервые увиденных ПОСЛЕ перехода: ${fmt(firstAfterFlush)}; `
    + `на них блум ложно сказал «да» ${fmt(bloomFP)} раз (${pct3(fpRate)}).`);

  if (unexplained || lastBad || extraHash || lostReal) {
    problems.push(`${title}: необъяснённых ${unexplained}, last ${lastBad}, `
      + `чужих хешей ${extraHash}, потерянных повторов ${lostReal}.`);
  } else {
    console.log('Необъяснённых расхождений нет: всё сводится к задокументированным следствиям схемы.');
    if (lostFirst) {
      expected.push(`${title}: у ${fmt(lostFirst)} оборотов firstMessage — номер второго вхождения `
        + `(первое съел блум). Задокументировано в core/ngrams.mjs.`);
    }
    if (lostSingles) {
      expected.push(`${title}: потеряно ${fmt(lostSingles)} одиночек из ${fmt(singlesTotal)} — `
        + `в топ они попасть не могут, порог кандидата ${'>='} 3 вхождений.`);
    }
    if (bloomFP) {
      expected.push(`${title}: ${fmt(bloomFP)} ложных срабатываний блума (${pct3(fpRate)} от оборотов, `
        + `впервые увиденных после перехода), каждое завышает частоту ровно на 1.`);
    }
  }
  return { exact, lostFirst, bloomFP, unexplained, lostSingles, lostReal, cands };
}

const tableCmp = compareTable(counterTable, 'Режим table против наивного подсчёта',
  `Переход после сообщения #${flushAfter}, блум по умолчанию (2 МБ, 3 хеша).`);

// Отдельный прогон с заведомо тесным блумом. На этом корпусе блум по умолчанию
// почти пуст и ложных срабатываний не даёт вовсе — а проверить надо ИМЕННО
// направление ошибки: ложное «да» обязано только заводить лишний слот и
// завышать частоту на единицу, но никогда не терять настоящий повтор.
if (BLOOM_STRESS) {
  const stress = createCounter({
    nMin: NMIN, nMax: NMAX, switchAtWords: SWITCH_AT,
    bloomBits: 1 << 13, bloomHashes: 3,
  });
  docs.forEach((segs, i) => stress.add(i, segs));
  compareTable(stress, 'Режим table с заведомо тесным блумом (8 Кбит)',
    'Нагрузочная проверка направления ошибки блума, а не боевая настройка.');
}

// ---------------------------------------------------------------------------
// 5. C-value: наивный rank против ядра
// ---------------------------------------------------------------------------
// Обе стороны получают ОДНИ И ТЕ ЖЕ счётчики (наивные), чтобы отделить разницу
// метода от разницы подсчёта. Всё, что здесь разойдётся, — след переноса метода
// из стенда в ядро.

/** C-value поверх снимка счётчиков. Дословная копия `rank` из cutoff.mjs. */
function rank(map, minCount) {
  const cand = [];
  for (const [k, e] of map) {
    if (e.c < minCount || e.msgs.size < MIN_MESSAGES) continue;
    const key = k.slice(2);
    const parts = key.split(' ');
    if (parts.every(w => STOP_KEYS.has(w))) continue;
    cand.push({ key, parts, n: +k[0], c: e.c, nestSum: 0, nestCount: 0 });
  }
  const byKey = new Map(cand.map(o => [o.key, o]));
  for (const o of cand) {
    if (o.n <= NMIN) continue;
    for (const sub of [o.parts.slice(0, -1).join(' '), o.parts.slice(1).join(' ')]) {
      const p = byKey.get(sub);
      if (p) { p.nestSum += o.c; p.nestCount++; }
    }
  }
  for (const o of cand) {
    const bonus = Math.log2(o.n);
    o.cvalue = o.nestCount === 0 ? bonus * o.c : bonus * (o.c - o.nestSum / o.nestCount);
  }
  const top = cand.filter(o => o.cvalue > 0).sort((a, b) => b.cvalue - a.cvalue);
  return { candidates: cand.length, top };
}

const naiveRank = rank(naive, 3);

// Те же счётчики в форме кандидатов ядра. `hash` даём настоящий — ядро им
// пользуется как ключом тождества.
const asCandidates = [];
for (const [h, e] of naiveByHash) {
  asCandidates.push({
    hash: h, n: e.n, count: e.c,
    firstMessage: e.first, lastMessage: e.last, stems: e.parts, key: e.key,
  });
}

// Без фильтра закрытости — это ровно метод стенда.
const coreRaw = cvalue(asCandidates, { minCount: 3, closedness: false });
// С фильтром — то, что ядро делает по умолчанию: закрытость это ДОБАВЛЕННАЯ
// первая ступень, которой в стенде не было.
const coreFull = cvalue(asCandidates, { minCount: 3 });

console.log('\n=== 5. C-value: наивный rank против core/cvalue ===');
console.log(`Кандидатов: наивно ${fmt(naiveRank.candidates)}, ядро ${fmt(coreRaw.candidates)} `
  + `(порог 3 вхождения и минимум два сообщения с обеих сторон)`);
if (naiveRank.candidates !== coreRaw.candidates) {
  // Стенд отбирает по `msgs.size >= 2`, ядро — по `first !== last`. cutoff.mjs
  // померил, что это одно и то же; расхождение здесь означало бы,
  // что на этом корпусе больше не одно и то же.
  problems.push(`Число кандидатов разошлось: наивно ${naiveRank.candidates}, ядро ${coreRaw.candidates}.`);
}

{
  const a = naiveRank.top.slice(0, TOP);
  const b = coreRaw.top.slice(0, TOP);
  let posSame = 0, scoreBad = 0;
  const rows = [];
  for (let i = 0; i < TOP; i++) {
    const x = a[i], y = b[i];
    const xk = x ? x.key : '—';
    const yk = y ? y.stems.join(' ') : '—';
    if (xk === yk) posSame++;
    if (x && y && Math.abs(x.cvalue - y.cvalue) > 1e-9) scoreBad++;
    rows.push({ i: i + 1, xk, xv: x?.cvalue ?? 0, yk, yv: y?.cvalue ?? 0 });
  }
  const setA = new Set(a.map(o => o.key));
  const setB = new Set(b.map(o => o.stems.join(' ')));
  const inBoth = [...setA].filter(k => setB.has(k)).length;

  console.log(`Топ-${TOP} без фильтра закрытости: позиция в позицию ${posSame} из ${TOP}, `
    + `состав совпал на ${inBoth} из ${TOP}, очков разошлось ${scoreBad}.`);
  if (posSame !== TOP) {
    console.log('поз.'.padStart(4), 'наивный rank'.padEnd(42), 'очки'.padStart(8),
      'core/cvalue'.padEnd(42), 'очки'.padStart(8));
    for (const r of rows) {
      if (r.xk === r.yk) continue;
      console.log(String(r.i).padStart(4), r.xk.slice(0, 42).padEnd(42), r.xv.toFixed(3).padStart(8),
        r.yk.slice(0, 42).padEnd(42), r.yv.toFixed(3).padStart(8));
    }
  }
  if (inBoth !== TOP || scoreBad > 0) {
    problems.push(`Топ-${TOP} по C-value разошёлся: состав ${inBoth}/${TOP}, очков не сошлось ${scoreBad}.`);
  } else if (posSame !== TOP) {
    // Состав тот же и очки те же — значит разъехались только позиции с равными
    // очками: у ядра к сортировке добавлены разрывы ничьих, у стенда их нет.
    expected.push(`Топ-${TOP}: состав и очки совпали полностью, `
      + `${TOP - posSame} позиций переставлены из-за разрыва ничьих в ядре (у стенда порядок при равных очках не определён).`);
  } else {
    console.log('Расхождений нет.');
  }
}

{
  // Фильтр закрытости — единственное, что ядро добавило к методу стенда.
  // Показываем, что именно он убирает, чтобы отличие было видно, а не скрыто.
  const rawTop = coreRaw.top.slice(0, TOP).map(o => o.stems.join(' '));
  const fullTop = coreFull.top.slice(0, TOP).map(o => o.stems.join(' '));
  const dropped = rawTop.filter(k => !fullTop.includes(k));
  console.log(`\nФильтр закрытости (${'>='}0,8 вхождений объясняет один родитель) — ступень, `
    + `добавленная в ядре сверх метода стенда:`);
  console.log(`  кандидатов до фильтра ${fmt(coreRaw.top.length)}, после ${fmt(coreFull.top.length)}; `
    + `из топ-${TOP} убрано ${dropped.length}.`);
  for (const k of dropped.slice(0, 5)) console.log(`  убрано: «${k}»`);
  console.log('Это не расхождение, а осознанная разница: так задумано схлопывание вложенных.');
}

console.log(`\nВерхушка (core/cvalue, всё как в бою):`);
for (const o of coreFull.top.slice(0, 10)) {
  console.log(`  ${o.cvalue.toFixed(2).padStart(8)}  c=${String(o.count).padStart(3)}  `
    + `n=${o.n}  ${o.stems.join(' ')}`);
}

// ---------------------------------------------------------------------------
// 6. Самоповтор: строковые шинглы стенда против хешированных шинглов ядра
// ---------------------------------------------------------------------------
// Стенд `tools/shingle.mjs` держит шинглы строками и потому не ошибается вовсе.
// Ядро хеширует их в 32 бита ради памяти — значит имеет право на редкие ложные
// совпадения. Задача: измерить, сколько их на самом деле, и понять, шум это или
// ошибка.

console.log('\n=== 6. Самоповтор: shingle.mjs против core/similarity ===');

/** Множество строковых шинглов. Дословно из shingle.mjs. */
function shinglesStr(words, k) {
  const set = new Set();
  for (let i = 0; i + k <= words.length; i++) set.add(words.slice(i, i + k).join(' '));
  return set;
}

/** Доля шинглов a, встречающихся в b. Дословно из shingle.mjs. */
function containmentStr(a, b) {
  if (!a.size) return 0;
  let hit = 0;
  for (const s of a) if (b.has(s)) hit++;
  return hit / a.size;
}

/** Самый длинный общий кусок подряд. Дословно из shingle.mjs. */
function longestRunStr(a, b) {
  const prev = new Int32Array(b.length + 1);
  const cur = new Int32Array(b.length + 1);
  let best = 0, endA = 0;
  for (let i = 1; i <= a.length; i++) {
    cur.fill(0);
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      if (ai === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) { best = cur[j]; endA = i; }
      }
    }
    prev.set(cur);
  }
  return { len: best, start: endA - best };
}

let simPairs = 0, partnerSame = 0, partnerDiff = 0, scoredTotal = 0;
let maxAbsDiff = 0, sumAbsDiff = 0, diffPairs = 0;
let runSame = 0, runDiff = 0;
let expectedFalse = 0, observedFalse = 0, shingleComparisons = 0;
const partnerSamples = [];

for (const chat of corpus) {
  // Порог 40 слов — тот же, что в стенде и в ядре (MIN_WORDS). Стенд коротких
  // сообщений не держит вовсе, поэтому и детектору они не даются: иначе
  // сравнивались бы разные наборы партнёров, а не две реализации метрики.
  const list = [];
  for (const m of chat.messages) {
    const { prose } = splitProse(m.mes);
    const stems = tokenize(prose, { stem: true, barriers }).flat().map(t => t.stem);
    const forms = tokenize(prose, { stem: false, barriers }).flat().map(t => t.form);
    if (stems.length >= MIN_WORDS) list.push({ stems, forms });
  }
  if (list.length < 2) continue;

  const sets = list.map(d => shinglesStr(d.stems, SHINGLE_K));
  const fps = list.map(d => fingerprint(d.stems, SHINGLE_K));
  const det = createDetector();

  for (let i = 0; i < list.length; i++) {
    // Ядро: сравнение с уже добавленными — ровно то же, что делает стенд.
    // Формы даём настоящие, но длину дословного куска сверяем отдельно, по
    // основам, чтобы сравнивать одинаковый вход.
    const res = det.add({ index: i, stems: list[i].stems, forms: list[i].forms });

    let bj = -1, bv = 0;
    for (let j = 0; j < i; j++) {
      const c = containmentStr(sets[i], sets[j]);
      const ch = coreContainment(fps[i], fps[j]);
      simPairs++;
      shingleComparisons += fps[i].length * fps[j].length;
      // Ложное совпадение шингла тянет хешированное значение только ВВЕРХ.
      if (ch > c + 1e-9) observedFalse++;
      const d = Math.abs(c - ch);
      if (d > 1e-9) { diffPairs++; sumAbsDiff += d; if (d > maxAbsDiff) maxAbsDiff = d; }
      if (c > bv) { bv = c; bj = j; }
    }
    if (bj < 0) continue;
    scoredTotal++;

    const coreBest = res.best;
    if (coreBest && coreBest.index === bj) partnerSame++;
    else {
      partnerDiff++;
      if (partnerSamples.length < 5) {
        partnerSamples.push(`${chat.title.slice(0, 22)} #${i}: стенд → #${bj} (${pct(bv)}), `
          + `ядро → #${coreBest ? coreBest.index : -1} (${coreBest ? pct(coreBest.containment) : '—'})`);
      }
    }

    // Длина дословного куска: у обеих сторон один и тот же вход (основы).
    const a = longestRunStr(list[i].stems, list[bj].stems);
    const b = coreLongestRun(list[i].stems, list[bj].stems);
    if (a.len === b.length && a.start === b.startA) runSame++;
    else {
      runDiff++;
      if (partnerSamples.length < 8) {
        partnerSamples.push(`${chat.title.slice(0, 22)} #${i}: кусок стенд ${a.len}@${a.start}, `
          + `ядро ${b.length}@${b.startA}`);
      }
    }
  }
}

// Ожидание по теории: на пару сообщений приходится |a|*|b| сравнений хешей в
// пространстве 2^32, и каждое может дать ложное совпадение.
expectedFalse = shingleComparisons / 2 ** 32;

console.log(`Пар внутри чатов: ${fmt(simPairs)}, оценённых сообщений: ${fmt(scoredTotal)}`);
console.log(`Лучший партнёр совпал: ${fmt(partnerSame)} из ${fmt(scoredTotal)} `
  + `(${pct(partnerSame / Math.max(1, scoredTotal))}), разошёлся: ${partnerDiff}`);
console.log(`Пар с разным containment: ${fmt(diffPairs)} (${pct(diffPairs / Math.max(1, simPairs))}), `
  + `максимум расхождения ${(maxAbsDiff * 100).toFixed(4)} п.п., `
  + `среднее по разошедшимся ${(diffPairs ? sumAbsDiff / diffPairs * 100 : 0).toFixed(4)} п.п.`);
console.log(`Из них в сторону завышения (ложное совпадение хеша): ${fmt(observedFalse)}; `
  + `случаев занижения: ${fmt(diffPairs - observedFalse)}`);
console.log(`Ожидание по теории: сравнений хешей ${fmt(shingleComparisons)}, `
  + `ложных совпадений шинглов ~${expectedFalse.toFixed(1)} на весь корпус.`);
console.log(`Считать надо по столкнувшимся ПАРАМ ШИНГЛОВ, а не по парам сообщений: `
  + `одна склейка двух разных шинглов всплывает во всех парах, где встретился любой из них.`);
console.log(`Длина дословного куска: совпала у ${fmt(runSame)}, разошлась у ${runDiff}`);
for (const s of partnerSamples) console.log(`  ${s}`);

if (runDiff > 0) {
  // Здесь хешей нет вообще — обе стороны сравнивают строки. Расхождение может
  // быть только ошибкой переноса DP в ядро.
  problems.push(`Длина дословного куска разошлась на ${runDiff} парах — хеши тут ни при чём, это ошибка переноса.`);
}
if (diffPairs - observedFalse > 0) {
  // Занижение хешированной метрики невозможно: коллизия склеивает разные
  // шинглы в один хеш и может только добавить совпадений, но не убрать.
  problems.push(`Хешированный containment оказался НИЖЕ строкового на ${diffPairs - observedFalse} парах — `
    + `коллизии так себя вести не могут.`);
}
if (partnerDiff > 0) {
  const noisy = maxAbsDiff < 0.01;
  console.log(noisy
    ? 'Партнёр разошёлся на парах, где значения отличаются в третьем знаке, — это шум коллизий, а не ошибка.'
    : 'Партнёр разошёлся при заметной разнице значений — это надо разбирать.');
  if (noisy) {
    expected.push(`Самоповтор: у ${partnerDiff} сообщений лучший партнёр разошёлся на коллизиях `
      + `32-битного хеша шингла (разница значений в третьем знаке).`);
  } else {
    problems.push(`Самоповтор: лучший партнёр разошёлся у ${partnerDiff} сообщений при разнице значений `
      + `до ${(maxAbsDiff * 100).toFixed(2)} п.п. — на шум коллизий не похоже.`);
  }
} else if (diffPairs === 0) {
  console.log('Расхождений нет вовсе: на этом корпусе хеширование шинглов не потеряло ничего.');
}

// ---------------------------------------------------------------------------
// Итог
// ---------------------------------------------------------------------------

console.log('\n================ ИТОГ ================');
if (expected.length) {
  console.log('Расхождения, объяснённые устройством схемы (чинить нечего):');
  for (const e of expected) console.log(`  · ${e}`);
}
if (problems.length === 0) {
  console.log('\nРАСХОЖДЕНИЙ НЕТ: боевой счётчик считает то же, что наивный подсчёт стендов.');
} else {
  console.log('\nЕСТЬ РАСХОЖДЕНИЯ:');
  for (const p of problems) console.log(`  ! ${p}`);
  process.exitCode = 1;
}
