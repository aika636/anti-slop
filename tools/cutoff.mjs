// Стенд: порог отсева и точка его включения («порог отсева адаптивный»).
//
//   node --expose-gc tools/cutoff.mjs
//   node --expose-gc tools/cutoff.mjs --steps 20
//
// Отвечает на три вопроса:
//
//   1. Сколько на самом деле стоит наивный словарь строк. Не по модели в 140
//      байт на запись, а замером кучи: отдельный проход строит только
//      Map<строка, число> и меряет heapUsed до и после. Без `--expose-gc`
//      цифра шумная, поэтому скрипт об этом предупреждает.
//   2. На каком объёме текста наивный словарь перестаёт помещаться в бюджет —
//      это и есть точка включения блум-фильтра.
//   3. Какой порог «встретился не реже N раз» имеет смысл на разном объёме:
//      на коротком чате почти всё — одиночки, и жёсткий порог оставляет пустой
//      экран. Плюс с какого объёма верхушка топа перестаёт скакать.
//
// Порядок проходов важен: замер кучи идёт первым, на чистой куче.

import { readCorpus } from './corpus.mjs';
import { tokenize, splitProse, namesFromChat, nameBarriers, stemKey as stemWord } from '../core/tokenize.mjs';

const NMIN = 3, NMAX = 6;
const MIN_MESSAGES = 2;
const MIN_COUNTS = [2, 3, 4, 5];
const BUDGETS_MB = [16, 32, 64];      // сколько мы готовы отдать под таблицу на телефоне
const TOP_STABLE = 10;                 // по скольким верхним позициям смотрим устойчивость

const STEPS = (() => {
  const i = process.argv.indexOf('--steps');
  return i > 0 ? Number(process.argv[i + 1]) || 12 : 12;
})();

// Тот же список, что в corpus-stats.mjs: оборот целиком из служебных слов — не находка.
const STOP = new Set(('и а но да же ли бы то что как так вот уже еще не ни в во на за по под над о об от до из у к с со для при про без через между том тем тот та те это эта этот эти он она они оно его ее их им ими ему ей себя свой своя свои мой моя мои твой твоя ты я мы вы был была были было быть есть нет очень когда где куда потом просто только лишь если чтобы или либо тоже также сам сама сами один одна одно').split(' '));
const STOP_KEYS = new Set([...STOP].map(w => stemWord(w)));

// --- корпус -----------------------------------------------------------------

const corpus = readCorpus();
const names = new Set();
for (const chat of corpus) {
  for (const n of namesFromChat(chat)) names.add(n);
  for (const n of chat.extraNames) names.add(n);
}
const barriers = nameBarriers(names);
const allMessages = corpus.flatMap(c => c.messages);

const fmt = x => Math.round(x).toLocaleString('ru-RU');
const pct = x => (x * 100).toFixed(1) + '%';

console.log(`Чатов: ${corpus.length}, сообщений модели: ${allMessages.length}`);
console.log('Режим: проза + стемминг (то, что пойдёт в бой).');

/** Сообщение → плоский список сегментов основ. Один раз, дальше только счёт. */
function stemsOf(mes) {
  const { prose } = splitProse(mes);
  return tokenize(prose, { stem: true, barriers }).map(seg => seg.map(t => t.stem));
}

const docs = allMessages.map(m => stemsOf(m.mes));
const wordsPerDoc = docs.map(segs => segs.reduce((a, s) => a + s.length, 0));
const wordsTotal = wordsPerDoc.reduce((a, b) => a + b, 0);
console.log(`Слов прозы: ${fmt(wordsTotal)}`);

// --- 1. Сколько стоит наивный словарь ---------------------------------------
// Меряем кучей, а не моделью. Строим только то, что есть в наивной схеме:
// ключ-строка и счётчик. Ни множества сообщений, ни таблицы живых форм — иначе
// мерили бы не ту схему.

function measureNaive() {
  const gc = globalThis.gc;
  if (!gc) console.log('\n[!] Запущено без --expose-gc: замер кучи будет шумным.');

  gc?.(); gc?.();
  const before = process.memoryUsage().heapUsed;
  const t0 = Date.now();

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

  const ms = Date.now() - t0;
  gc?.(); gc?.();
  const after = process.memoryUsage().heapUsed;
  const size = map.size;
  let keyChars = 0;
  for (const k of map.keys()) keyChars += k.length;

  return { bytes: after - before, size, ms, keyChars };
}

const naive = measureNaive();
globalThis.gc?.();

console.log('\n=== 1. Наивный словарь строк — замер кучи ===');
console.log(`Различных оборотов:      ${fmt(naive.size)}`);
console.log(`Прирост кучи:            ${(naive.bytes / 2 ** 20).toFixed(1)} МБ`);
console.log(`На запись:               ${(naive.bytes / naive.size).toFixed(0)} байт`
  + `  (в модели прогноза стоит 140)`);
console.log(`Из них сам текст ключа:  ${(naive.keyChars / naive.size).toFixed(1)} символов`);
console.log(`Время подсчёта:          ${fmt(naive.ms)} мс`);

const BYTES_PER_ENTRY = naive.bytes > 0 ? naive.bytes / naive.size : 140;

// --- 2. Кривая роста и точка включения --------------------------------------

const counts = new Map();          // ключ → {c, msgs:Set, first, last}
const growth = [];
const snapAt = new Set(Array.from({ length: STEPS }, (_, i) =>
  Math.max(1, Math.round(((i + 1) / STEPS) * docs.length))));

/** C-value поверх снимка счётчиков. Тот же метод, что в corpus-stats.mjs. */
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

const topByCValue = (minCount, limit) => {
  const r = rank(counts, minCount);
  return { candidates: r.candidates, top: r.top.slice(0, limit) };
};
const topOf = (map, minCount, limit) => rank(map, minCount).top.slice(0, limit);

let wordsSeen = 0;
docs.forEach((segs, idx) => {
  for (const t of segs) {
    wordsSeen += t.length;
    for (let n = NMIN; n <= NMAX; n++) {
      for (let i = 0; i + n <= t.length; i++) {
        const key = n + ' ' + t.slice(i, i + n).join(' ');
        let e = counts.get(key);
        if (!e) { e = { c: 0, msgs: new Set(), first: idx, last: idx }; counts.set(key, e); }
        e.c++;
        e.msgs.add(idx);
        e.last = idx;
      }
    }
  }
  if (!snapAt.has(idx + 1)) return;

  const hist = [0, 0, 0, 0, 0, 0];   // c=1..5, дальше в [5]
  for (const e of counts.values()) hist[Math.min(e.c, 5)]++;
  const byMin = {};
  for (const mc of MIN_COUNTS) byMin[mc] = topByCValue(mc, TOP_STABLE);

  growth.push({
    messages: idx + 1, words: wordsSeen, distinct: counts.size,
    hist, byMin,
    naiveMB: counts.size * BYTES_PER_ENTRY / 2 ** 20,
  });
});

const last = growth[growth.length - 1];

console.log('\n=== 2. Кривая роста и стоимость наивной схемы ===');
console.log('сообщ.'.padStart(7), 'слов'.padStart(9), 'различных'.padStart(11),
  'одиночных'.padStart(11), 'c=2'.padStart(8), 'c>=3'.padStart(8), 'наивно, МБ'.padStart(11));
for (const g of growth) {
  console.log(
    String(g.messages).padStart(7), fmt(g.words).padStart(9), fmt(g.distinct).padStart(11),
    pct(g.hist[1] / g.distinct).padStart(11), fmt(g.hist[2]).padStart(8),
    fmt(g.hist[3] + g.hist[4] + g.hist[5]).padStart(8),
    g.naiveMB.toFixed(1).padStart(11));
}

// Закон Хипса по кривой: различных оборотов ~ K * N^beta.
function fitPower(points, key) {
  const n = points.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    const x = Math.log(p.words), y = Math.log(p[key]);
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const beta = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { K: Math.exp((sy - beta * sx) / n), beta };
}
const fit = fitPower(growth, 'distinct');
const distinctAt = N => fit.K * Math.pow(N, fit.beta);
const wordsForDistinct = V => Math.pow(V / fit.K, 1 / fit.beta);

console.log(`\nЗакон Хипса: различных = ${fit.K.toFixed(2)} * N^${fit.beta.toFixed(4)}`);
console.log('\nТочка включения отсева — где наивный словарь упирается в бюджет:');
for (const mb of BUDGETS_MB) {
  const entries = mb * 2 ** 20 / BYTES_PER_ENTRY;
  const words = wordsForDistinct(entries);
  console.log(`  бюджет ${String(mb).padStart(3)} МБ  →  ${fmt(entries)} оборотов  →  `
    + `${fmt(words)} слов прозы  (~${fmt(words / 1500)} сообщений по 1500 слов)`);
}

// --- 3. Что отсев отнимает --------------------------------------------------
// Блум роняет первое вхождение каждого оборота: частоты занижены ровно на 1.
// Значит оборот, встретившийся ровно раз, не попадает в таблицу вообще, а
// остальные приходят с c-1. Считаем, что теряется на самом деле.

const finalByMin = {};
for (const mc of MIN_COUNTS) finalByMin[mc] = topByCValue(mc, 30);

console.log('\n=== 3. Что отсев одиночек отнимает у результата ===');
const totalDistinct = counts.size;
const singles = last.hist[1];
console.log(`Одиночных оборотов: ${fmt(singles)} из ${fmt(totalDistinct)} (${pct(singles / totalDistinct)}).`);
console.log(`Они не могут попасть ни в один топ: порог кандидата — минимум два вхождения.`);
console.log(`Память, которую они занимают в наивной схеме: `
  + `${(singles * BYTES_PER_ENTRY / 2 ** 20).toFixed(1)} МБ из `
  + `${(totalDistinct * BYTES_PER_ENTRY / 2 ** 20).toFixed(1)} МБ.`);

// Отсев с порогом 2 (роняем всё, что встретилось меньше трёх раз) — сколько
// кандидатов он бы стоил, если понадобится ужаться сильнее.
const c2 = last.hist[2];
console.log(`Следующая ступень (ронять и c=2): экономит ещё `
  + `${(c2 * BYTES_PER_ENTRY / 2 ** 20).toFixed(1)} МБ, `
  + `но убивает кандидатов с порогом 2: ${fmt(finalByMin[2].candidates)} → ${fmt(finalByMin[3].candidates)}.`);

console.log('\nЧисло кандидатов при разных порогах, по ходу чата:');
console.log('сообщ.'.padStart(7), 'слов'.padStart(9),
  ...MIN_COUNTS.map(mc => `c>=${mc}`.padStart(9)));
for (const g of growth) {
  console.log(String(g.messages).padStart(7), fmt(g.words).padStart(9),
    ...MIN_COUNTS.map(mc => fmt(g.byMin[mc].candidates).padStart(9)));
}

// --- 4. С какого объёма топ перестаёт скакать -------------------------------
// Устойчивость: доля позиций финального топ-10, уже стоящих в топ-10 снимка.

console.log('\n=== 4. Устойчивость верхушки (совпадение с финальным топ-10) ===');
console.log('сообщ.'.padStart(7), 'слов'.padStart(9),
  ...MIN_COUNTS.map(mc => `c>=${mc}`.padStart(9)));
for (const g of growth) {
  const row = MIN_COUNTS.map(mc => {
    const finalTop = new Set(finalByMin[mc].top.slice(0, TOP_STABLE).map(o => o.key));
    const hit = g.byMin[mc].top.filter(o => finalTop.has(o.key)).length;
    return pct(hit / Math.max(finalTop.size, 1)).padStart(9);
  });
  console.log(String(g.messages).padStart(7), fmt(g.words).padStart(9), ...row);
}

// --- 4-бис. Та же устойчивость, но внутри одного чата -----------------------
// Кривая выше склеена из четырёх чатов подряд, и ранние срезы — это вообще
// другой чат, чем финальный. Поэтому та же проверка отдельно по каждому чату:
// топ снимка против финального топа этого же чата.

console.log('\n=== 4-бис. Устойчивость топ-10 внутри одного чата (порог c>=3) ===');
console.log('чат'.padEnd(30), 'сообщ.'.padStart(7), 'слов'.padStart(8), 'совпало с финалом'.padStart(18));
for (const chat of corpus) {
  const local = new Map();
  const chatDocs = chat.messages.map(m => stemsOf(m.mes));
  const snaps = [];
  const points = new Set([0.25, 0.5, 0.75, 1].map(q => Math.max(1, Math.round(q * chatDocs.length))));
  let w = 0;
  chatDocs.forEach((segs, idx) => {
    for (const t of segs) {
      w += t.length;
      for (let n = NMIN; n <= NMAX; n++) {
        for (let i = 0; i + n <= t.length; i++) {
          const key = n + ' ' + t.slice(i, i + n).join(' ');
          let e = local.get(key);
          if (!e) { e = { c: 0, msgs: new Set() }; local.set(key, e); }
          e.c++; e.msgs.add(idx);
        }
      }
    }
    if (points.has(idx + 1)) snaps.push({ messages: idx + 1, words: w, top: topOf(local, 3, TOP_STABLE) });
  });
  const finalTop = new Set(snaps[snaps.length - 1].top.map(o => o.key));
  for (const s of snaps) {
    const hit = s.top.filter(o => finalTop.has(o.key)).length;
    console.log(chat.title.slice(0, 30).padEnd(30), String(s.messages).padStart(7),
      fmt(s.words).padStart(8), pct(hit / Math.max(finalTop.size, 1)).padStart(18));
  }
}

// --- 5. Чем заменить множество сообщений в компактной схеме -----------------
// Правило «не внутри одного сообщения» сейчас держится на Set с номерами
// сообщений — в таблице на типизированных массивах такого места нет. Проверяем
// подозрение: «встретился в двух разных сообщениях» — это ровно «номер первого
// вхождения не равен номеру последнего», то есть одно 32-битное поле в слоте.

let mismatch = 0, spread = 0, oneMessage = 0;
for (const e of counts.values()) {
  if (e.c < 2) continue;
  const bySet = e.msgs.size >= MIN_MESSAGES;
  const byEdges = e.first !== e.last;
  if (bySet !== byEdges) mismatch++;
  if (bySet) spread++; else oneMessage++;
}

console.log('\n=== 5. Множество сообщений против пары «первое/последнее» ===');
console.log(`Повторяющихся оборотов: ${fmt(spread + oneMessage)}, `
  + `из них внутри одного сообщения ${fmt(oneMessage)} (${pct(oneMessage / (spread + oneMessage))}).`);
console.log(`Расхождений между «msgs.size >= 2» и «first !== last»: ${mismatch}.`);

console.log('\n=== Верхушка при разных порогах (финальный корпус) ===');
for (const mc of MIN_COUNTS) {
  const t = finalByMin[mc].top.slice(0, 5).map(o => `${o.key} (${o.c})`).join(' | ');
  console.log(`c>=${mc}: кандидатов ${fmt(finalByMin[mc].candidates)}`);
  console.log(`      ${t}`);
}
