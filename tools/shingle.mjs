// Стенд: длина шингла для детекта самоповтора
// («самоповтор — containment, не Жаккар»).
//
//   node tools/shingle.mjs
//   node tools/shingle.mjs --pairs 8
//
// Что меряется. Сообщение представляется множеством хешей k-словных шинглов по
// основам. Похожесть нового сообщения на старое — вложенность (containment):
// какая доля шинглов нового встречается в старом. Вопрос стенда — какое k.
//
// Слишком короткий шингл ловит совпадения языка вообще («он посмотрел на неё»),
// и пол похожести поднимается у всех: сигнал тонет. Слишком длинный ловит
// только дословную копию и пропускает пересказ своими же словами. Ищем k, при
// котором расстояние между полом (медиана по всем парам) и верхушкой
// наибольшее.
//
// Заодно считается то, что стоит показывать вместо
// коэффициента: длина самого длинного дословно повторённого куска.

import { readCorpus } from './corpus.mjs';
import { tokenize, splitProse, namesFromChat, nameBarriers } from '../core/tokenize.mjs';

const KS = [3, 4, 5, 6, 8];
const PAIRS = (() => {
  const i = process.argv.indexOf('--pairs');
  return i > 0 ? Number(process.argv[i + 1]) || 5 : 5;
})();

const corpus = readCorpus();
const names = new Set();
for (const chat of corpus) {
  for (const n of namesFromChat(chat)) names.add(n);
  for (const n of chat.extraNames) names.add(n);
}
const barriers = nameBarriers(names);

const fmt = x => Math.round(x).toLocaleString('ru-RU');
const pct = x => (x * 100).toFixed(1) + '%';
const pct3 = x => (x * 100).toFixed(3) + '%';

// Сообщения помечены чатом: сравнивать имеет смысл только внутри одного чата,
// иначе меряется сходство разных историй, а не самоповтор модели в чате.
const docs = [];
corpus.forEach((chat, ci) => {
  chat.messages.forEach((m, mi) => {
    const { prose } = splitProse(m.mes);
    const stems = tokenize(prose, { stem: true, barriers }).flat().map(t => t.stem);
    const forms = tokenize(prose, { stem: false, barriers }).flat().map(t => t.form);
    if (stems.length >= 40) docs.push({ chat: ci, chatTitle: chat.title, idx: mi, stems, forms });
  });
});

console.log(`Сообщений в замере: ${docs.length} (короче 40 слов отброшены)`);
console.log(`Слов прозы: ${fmt(docs.reduce((a, d) => a + d.stems.length, 0))}`);

// --- шинглы -----------------------------------------------------------------

function shingles(words, k) {
  const set = new Set();
  for (let i = 0; i + k <= words.length; i++) set.add(words.slice(i, i + k).join(' '));
  return set;
}

/** Доля шинглов a, встречающихся в b. Меряется относительно нового сообщения. */
function containment(a, b) {
  if (!a.size) return 0;
  let hit = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small === a) { for (const s of a) if (b.has(s)) hit++; }
  else { for (const s of a) if (b.has(s)) hit++; }
  void big;
  return hit / a.size;
}

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
};

/** Самый длинный общий кусок подряд, в словах. DP по скользящей строке. */
function longestRun(a, b) {
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

// --- прогон по k ------------------------------------------------------------

const perK = [];

for (const k of KS) {
  const t0 = Date.now();
  const sets = docs.map(d => shingles(d.stems, k));
  const build = Date.now() - t0;

  const t1 = Date.now();
  const allPairs = [];      // все внутричатовые пары — это и есть пол
  const best = [];          // на каждое сообщение: лучшая предыдущая пара
  for (let i = 0; i < docs.length; i++) {
    let bi = -1, bv = 0;
    for (let j = 0; j < i; j++) {
      if (docs[j].chat !== docs[i].chat) continue;
      const c = containment(sets[i], sets[j]);
      allPairs.push(c);
      if (c > bv) { bv = c; bi = j; }
    }
    if (bi >= 0) best.push({ i, j: bi, c: bv });
  }
  const compare = Date.now() - t1;

  const sortedAll = allPairs.slice().sort((a, b) => a - b);
  const sortedBest = best.map(b => b.c).sort((a, b) => a - b);
  const bytes = sets.reduce((a, s) => a + s.size * 4, 0);

  perK.push({
    k, build, compare, pairs: allPairs.length,
    floor: quantile(sortedAll, 0.5),
    floor90: quantile(sortedAll, 0.9),
    bestP50: quantile(sortedBest, 0.5),
    bestP95: quantile(sortedBest, 0.95),
    bestMax: sortedBest[sortedBest.length - 1] ?? 0,
    best: best.sort((a, b) => b.c - a.c).slice(0, PAIRS),
    bytesPerDoc: bytes / docs.length,
  });
}

console.log('\n=== Пол и сигнал при разной длине шингла ===');
console.log('Пол — медиана по всем парам внутри чата. Сигнал — верхушка по лучшей паре сообщения.');
console.log(' k'.padStart(3), 'пол(медиана)'.padStart(13), 'пол(p90)'.padStart(10),
  'лучшая p50'.padStart(11), 'лучшая p95'.padStart(11), 'лучшая max'.padStart(11),
  'отрыв p95/пол'.padStart(14), 'КБ/сообщ.'.padStart(10));
for (const r of perK) {
  const gap = r.floor > 0 ? (r.bestP95 / r.floor).toFixed(1) + '×' : '∞';
  console.log(String(r.k).padStart(3), pct3(r.floor).padStart(13), pct3(r.floor90).padStart(10),
    pct(r.bestP50).padStart(11), pct(r.bestP95).padStart(11), pct(r.bestMax).padStart(11),
    gap.padStart(14), (r.bytesPerDoc / 1024).toFixed(1).padStart(10));
}

console.log('\n=== Время (' + fmt(perK[0].pairs) + ' пар) ===');
for (const r of perK) {
  console.log(` k=${r.k}: построение ${fmt(r.build)} мс, сравнение ${fmt(r.compare)} мс`);
}

console.log('\n=== Верхние пары и что в них на самом деле повторено ===');
for (const r of perK) {
  console.log(`\n--- k = ${r.k}`);
  for (const p of r.best) {
    const a = docs[p.i], b = docs[p.j];
    const run = longestRun(a.stems, b.stems);
    const quote = a.forms.slice(run.start, run.start + Math.min(run.len, 14)).join(' ');
    console.log(`  ${pct(p.c).padStart(6)}  сообщ. #${a.idx} ← #${b.idx}  `
      + `(${a.chatTitle.slice(0, 20)})  дословно подряд: ${run.len} слов`);
    console.log(`          «${quote}${run.len > 14 ? ' …' : ''}»`);
  }
}

// --- длина дословного куска как самостоятельный сигнал ----------------------
// В интерфейсе показывается не коэффициент, а длина повтора.
// Проверяем, насколько одно предсказывает другое — и какой длины повторы
// вообще бывают в обычном чате, чтобы знать, где ставить границу «это уже
// заметно».

console.log('\n=== Длина дословного повтора против containment (k = 4) ===');
const k4 = perK[KS.indexOf(4)];
const setsK4 = docs.map(d => shingles(d.stems, 4));
const rows = [];
for (let i = 0; i < docs.length; i++) {
  let bi = -1, bv = 0;
  for (let j = 0; j < i; j++) {
    if (docs[j].chat !== docs[i].chat) continue;
    const c = containment(setsK4[i], setsK4[j]);
    if (c > bv) { bv = c; bi = j; }
  }
  if (bi < 0) continue;
  rows.push({
    c: bv,
    len: longestRun(docs[i].stems, docs[bi].stems).len,
    lenForms: longestRun(docs[i].forms, docs[bi].forms).len,
  });
}
const runsSorted = rows.map(r => r.len).sort((a, b) => a - b);
const runsForms = rows.map(r => r.lenForms).sort((a, b) => a - b);
console.log(`Самый длинный повторённый кусок в лучшей паре, по всем сообщениям:`);
console.log(`  по основам: медиана ${quantile(runsSorted, 0.5)} слов, p90 ${quantile(runsSorted, 0.9)}, `
  + `p95 ${quantile(runsSorted, 0.95)}, максимум ${runsSorted[runsSorted.length - 1]}`);
console.log(`  по формам:  медиана ${quantile(runsForms, 0.5)} слов, p90 ${quantile(runsForms, 0.9)}, `
  + `p95 ${quantile(runsForms, 0.95)}, максимум ${runsForms[runsForms.length - 1]}`);
const sameLen = rows.filter(r => r.len === r.lenForms).length;
console.log(`  совпало точь-в-точь у ${pct(sameLen / rows.length)} сообщений — `
  + `остальное стеммер склеил по согласованию`);

const corr = (() => {
  const n = rows.length;
  const mx = rows.reduce((a, r) => a + r.c, 0) / n;
  const my = rows.reduce((a, r) => a + r.len, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const r of rows) { const dx = r.c - mx, dy = r.len - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy);
})();
console.log(`Корреляция containment(k=4) и длины дословного куска: ${corr.toFixed(2)}`);
console.log(`Порог «верхние 5%» по containment(k=4): ${pct(k4.bestP95)}`);

// --- дешёвая замена попарному сравнению -------------------------------------
// Попарное сравнение квадратично: 2 665 пар на 141 сообщении — это ещё ничто,
// но на тысяче сообщений будет полмиллиона пар. А таблица n-грамм и так знает
// про каждый четырёхсловный оборот, в каком сообщении он встретился впервые
// (по замеру cutoff.mjs: номер первого вхождения в слоте всё равно есть).
//
// Гипотеза: вместо сравнения со всеми предыдущими достаточно на каждом шингле
// нового сообщения посмотреть, где он встретился впервые, и посчитать голоса.
// Проверяем, тот же ли партнёр находится и та же ли получается цифра.

const firstSeen = new Map();     // шингл → индекс сообщения, где он впервые
let sameCount = 0, total = 0, sumExact = 0, sumApprox = 0;
const approxRows = [];
for (let i = 0; i < docs.length; i++) {
  const tally = new Map();
  const set = setsK4[i];
  for (const s of set) {
    const j = firstSeen.get(s);
    if (j !== undefined && docs[j].chat === docs[i].chat) tally.set(j, (tally.get(j) ?? 0) + 1);
  }
  let bj = -1, bv = 0;
  for (const [j, c] of tally) if (c > bv) { bv = c; bj = j; }
  const approx = set.size ? bv / set.size : 0;

  let ej = -1, ev = 0;
  for (let j = 0; j < i; j++) {
    if (docs[j].chat !== docs[i].chat) continue;
    const c = containment(set, setsK4[j]);
    if (c > ev) { ev = c; ej = j; }
  }
  if (ej >= 0) {
    total++;
    if (ej === bj) sameCount++;
    sumExact += ev; sumApprox += approx;
    approxRows.push({ exact: ev, approx });
  }
  for (const s of set) if (!firstSeen.has(s)) firstSeen.set(s, i);
}

const approxCorr = (() => {
  const n = approxRows.length;
  const mx = sumExact / n, my = sumApprox / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const r of approxRows) {
    const dx = r.exact - mx, dy = r.approx - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
})();

console.log('\n=== Приближение «по первому вхождению» вместо попарного сравнения ===');
console.log(`Тот же партнёр найден у ${pct(sameCount / total)} сообщений (${sameCount} из ${total}).`);
console.log(`Средняя похожесть: точно ${pct(sumExact / total)}, приближённо ${pct(sumApprox / total)}.`);
console.log(`Корреляция значений: ${approxCorr.toFixed(2)}.`);
console.log(`Стоимость: один проход по шинглам сообщения против ${fmt(perK[0].pairs / docs.length)} `
  + `сравнений на сообщение в среднем — и та растёт с длиной чата, а эта нет.`);
