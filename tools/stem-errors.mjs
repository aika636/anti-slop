// Задача: собрать список исключений стеммера по его ошибкам
// на РП-лексике. Составить его можно только глядя на живой вывод, поэтому здесь
// не проверка, а смотровое окно: три отчёта, которые просматриваются
// глазами и по которым заполняется STEM_EXCEPTIONS в core/tokenize.mjs.
//
//   node tools/stem-errors.mjs           основные отчёты
//   node tools/stem-errors.mjs --limit 60
//
// Что ищем:
//   1. Склейки — одна основа собрала слова с разным смыслом («холод»/«холодно»
//      Snowball не различает, а вот «стон»/«стонать» склеить — это находка).
//   2. Промахи — две основы, отличающиеся на одну букву: беглая гласная
//      («холодок» / «холодк»), чередование в корне. Стеммер их не сводит.
//   3. Пересушенные основы — три буквы и меньше при заметной частоте.

import { readCorpus } from './corpus.mjs';
import { splitProse, tokenize, stemKey, STEM_EXCEPTIONS } from '../core/tokenize.mjs';

// Корзины, собранные вручную, отчёт о склейках пропускает: они и должны
// выглядеть как склейка — на то и заведены.
const DECLARED = new Set(STEM_EXCEPTIONS.values());

const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > 0 ? Number(process.argv[i + 1]) || 40 : 40;
})();

const MIN_FREQ = 5;

// --- сбор форм по основам ---------------------------------------------------

const groups = new Map();   // основа -> Map(форма -> частота)

for (const chat of readCorpus()) {
  for (const m of chat.messages) {
    const { prose } = splitProse(m.mes);
    for (const seg of tokenize(prose)) {
      for (const { form } of seg) {
        const key = stemKey(form);
        let g = groups.get(key);
        if (!g) { g = new Map(); groups.set(key, g); }
        g.set(form, (g.get(form) ?? 0) + 1);
      }
    }
  }
}

const total = g => [...g.values()].reduce((a, b) => a + b, 0);
const sorted = g => [...g.entries()].sort((a, b) => b[1] - a[1]);
const freq = new Map([...groups].map(([k, g]) => [k, total(g)]));

console.log(`Различных основ: ${groups.size.toLocaleString('ru-RU')}`);
console.log(`Различных словоформ: ${[...groups.values()].reduce((a, g) => a + g.size, 0).toLocaleString('ru-RU')}`);

// --- 1. Подозрительные склейки ----------------------------------------------
// Признак: в одной корзине формы, расходящиеся раньше конца основы. Приставка
// или чередование в корне — значит, слились разные слова.

function divergence(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

const merges = [];
for (const [key, g] of groups) {
  if (g.size < 2 || freq.get(key) < MIN_FREQ || DECLARED.has(key)) continue;
  const forms = sorted(g);
  let worst = Infinity, pair = null;
  for (let i = 0; i < forms.length; i++) {
    for (let j = i + 1; j < forms.length; j++) {
      const d = divergence(forms[i][0], forms[j][0]);
      if (d < worst) { worst = d; pair = [forms[i][0], forms[j][0]]; }
    }
  }
  if (worst < key.length) merges.push({ key, worst, pair, freq: freq.get(key), forms });
}
merges.sort((a, b) => (a.worst - b.worst) || (b.freq - a.freq));

console.log(`\n=== 1. Возможные склейки (формы расходятся внутри основы) — ${merges.length} ===`);
for (const m of merges.slice(0, LIMIT)) {
  const list = m.forms.slice(0, 6).map(([f, c]) => `${f}×${c}`).join(', ');
  console.log(`  ${m.key.padEnd(14)} частота ${String(m.freq).padStart(5)}  ${m.pair[0]} / ${m.pair[1]}  →  ${list}`);
}

// --- 2. Промахи: основы на расстоянии одной буквы ----------------------------
// Беглая гласная и чередование дают именно такую картину: «холодок»/«холодк»,
// «сон»/«сн». Ловим вставку или замену одной буквы.

function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (s.length === l.length) { i++; j++; } else j++;
  }
  return true;
}

const frequent = [...freq].filter(([k, c]) => c >= MIN_FREQ && k.length >= 3)
  .sort((a, b) => b[1] - a[1]);

// Раскладываем по «скелету» без гласных: у пары, различающейся беглой гласной,
// он совпадает. Полный перебор пар здесь не нужен и был бы квадратичным.
const skeletons = new Map();
for (const [key] of frequent) {
  const sk = key.replace(/[аеиоуыэюя]/g, '');
  if (!skeletons.has(sk)) skeletons.set(sk, []);
  skeletons.get(sk).push(key);
}

const misses = [];
for (const bucket of skeletons.values()) {
  if (bucket.length < 2) continue;
  for (let i = 0; i < bucket.length; i++) {
    for (let j = i + 1; j < bucket.length; j++) {
      if (!withinOneEdit(bucket[i], bucket[j])) continue;
      const a = bucket[i], b = bucket[j];
      misses.push({ a, b, fa: freq.get(a), fb: freq.get(b) });
    }
  }
}
misses.sort((x, y) => Math.min(y.fa, y.fb) - Math.min(x.fa, x.fb));

console.log(`\n=== 2. Возможные промахи (две основы на одну букву) — ${misses.length} ===`);
for (const m of misses.slice(0, LIMIT)) {
  const ex = a => sorted(groups.get(a))[0][0];
  console.log(`  ${m.a}×${m.fa} / ${m.b}×${m.fb}    (${ex(m.a)} / ${ex(m.b)})`);
}

// --- 3. Пересушенные основы -------------------------------------------------

const short = [...freq].filter(([k, c]) => k.length <= 3 && c >= MIN_FREQ * 4)
  .sort((a, b) => b[1] - a[1]);

console.log(`\n=== 3. Короткие основы (3 буквы и меньше) — ${short.length} ===`);
for (const [key, c] of short.slice(0, LIMIT)) {
  const forms = sorted(groups.get(key)).slice(0, 8).map(([f, n]) => `${f}×${n}`).join(', ');
  console.log(`  ${key.padEnd(6)} ${String(c).padStart(5)}  ${forms}`);
}
