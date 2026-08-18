// Стенд: якоря нормировки сводного индекса — таблица `ANCHORS` в `core/index`.
//
//   node tools/calibrate.mjs
//
// Индекс обязан быть сопоставимым между чатами, поэтому нормируется по
// фиксированным якорям, а не по распределению внутри текущего чата.
// Якоря надо откуда-то взять. Взять их из головы — значит получить
// шкалу, на которой все реальные сообщения окажутся в одном узком куске.
//
// Этот стенд печатает распределение каждого компонента по реальному корпусу:
// медиану, квартили, p90, максимум. Медиана идёт в якорь «ноль баллов»,
// наблюдаемая верхняя граница — в якорь «сто баллов».
//
// **Чего этот стенд НЕ делает: он не калибрует формулу.** Калибровка — это
// проверка, что «плохой» чат получает цифру заметно больше, чем «хороший», а
// для неё нужны чаты, размеченные человеком. Их нет.
// Здесь только приведение шкалы к тому диапазону, в котором
// реальные значения вообще живут, — чтобы черновая цифра различала сообщения
// между собой, а не выдавала всем подряд четвёрку из ста.

import { readCorpus } from './corpus.mjs';
import { analyzeChat } from '../core/analyze.mjs';
import { ANCHORS, WEIGHTS, FORMULA_VERSION } from '../core/index.mjs';

const corpus = readCorpus();
const pct = x => (x * 100).toFixed(2) + '%';

const rows = [];
for (const chat of corpus) {
  const r = analyzeChat(chat, { extraNames: chat.extraNames, topLimit: 1 });
  for (const m of r.messages) {
    rows.push({
      chat: chat.title,
      words: m.words,
      coverage: m.coverage,
      mattr: m.diversity.mattr,
      similarity: m.repeat?.containment ?? 0,
      value: m.value,
    });
  }
}

const quantile = (values, q) => {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

const QS = [0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1];

console.log(`Сообщений: ${rows.length}, чатов: ${corpus.length}. Формула ${FORMULA_VERSION}.`);
console.log(`Веса: ${Object.entries(WEIGHTS).map(([k, v]) => `${k} ${v}`).join(', ')}`);

console.log('\n=== Распределение компонентов по сообщениям ===');
console.log('компонент'.padEnd(12), ...QS.map(q => `p${Math.round(q * 100)}`.padStart(9)));
for (const key of ['coverage', 'mattr', 'similarity']) {
  // Сообщения короче окна MATTR исключаются из его распределения: на них
  // метрика вырождается в обычный TTR и тянет квантили вверх.
  const src = key === 'mattr' ? rows.filter(r => r.words >= 50) : rows;
  const vals = src.map(r => r[key]);
  console.log(key.padEnd(12), ...QS.map(q => pct(quantile(vals, q)).padStart(9)));
}

console.log('\nЯкоря сейчас (`core/index.mjs`, ANCHORS):');
for (const [k, a] of Object.entries(ANCHORS)) {
  console.log(`  ${k.padEnd(11)} 0 баллов при ${pct(a.zero).padStart(8)}, `
    + `100 баллов при ${pct(a.full).padStart(8)}`);
}

console.log('\n=== Что получается с этими якорями ===');
const idx = rows.map(r => r.value);
console.log('индекс'.padEnd(12), ...QS.map(q => String(quantile(idx, q)).padStart(9)));
console.log('\nРазмах индекса по сообщениям — главное, на что тут надо смотреть.');
console.log('Если p10 и p90 отличаются на единицы, шкала бесполезна: цифра не');
console.log('различает сообщения, и якоря надо двигать к медиане.');

console.log('\n=== По чатам ===');
console.log('чат'.padEnd(34), 'сообщ.'.padStart(7), 'индекс'.padStart(7),
  'покрытие'.padStart(10), 'MATTR'.padStart(9));
for (const chat of corpus) {
  const own = rows.filter(r => r.chat === chat.title);
  console.log(chat.title.slice(0, 34).padEnd(34), String(own.length).padStart(7),
    String(quantile(own.map(r => r.value), 0.5)).padStart(7),
    pct(quantile(own.map(r => r.coverage), 0.5)).padStart(10),
    pct(quantile(own.filter(r => r.words >= 50).map(r => r.mattr), 0.5)).padStart(9));
}
