// Стенд: упорядочивает ли индекс заведомо разное.
//
//   node tools/degrade.mjs                 весь корпус, три сорта порчи, четыре ступени
//   node tools/degrade.mjs --chat Ilya      только чаты, чьё имя содержит подстроку
//   node tools/degrade.mjs --messages 120   первые N ответов каждого чата (быстрый прогон)
//   node tools/degrade.mjs --steps 10,40    свои ступени порчи в процентах
//
// **Зачем он есть.** В шапке `core/index.mjs` записано:
// проверка «плохой чат даёт заметно большую цифру, чем хороший» невозможна без
// чатов, размеченных человеком, и таких не будет. Это верно для абсолютной
// шкалы — сколько именно баллов заслуживает данный чат. Но вопрос попроще —
// **если текст испортить заведомым образом, вырастет ли цифра** — проверяется на
// том корпусе, который есть.
//
// **Чем он не является.** Это не калибровка и не должна ею притворяться. Порча
// делается механически, а не моделью, и «плохой текст» в ней — не то же самое,
// что штампованный отыгрыш: живая модель повторяет смысл, а не строки. Стенд
// отвечает ровно на один вопрос: упорядочивает ли индекс заведомо разное и на
// каком размахе он ещё различает. Правка якорей или весов по его итогам — смена
// `FORMULA_VERSION` со всеми последствиями для кеша.
//
// Размножение текста копированием тут не запрещено, в отличие от замеров памяти
// (там оно давало заведомо оптимистичную картину: одиночки становились
// повторами). Здесь повторы и есть предмет измерения, а сила порчи задана.
//
// Смотреть надо на три вещи, и все три печатаются ниже:
//   1) растёт ли итог ступенями вместе с силой порчи;
//   2) на какой ступени компонент упирается в потолок якоря (столбец «в потолке»);
//   3) реагирует ли каждый компонент на СВОЙ сорт порчи сильнее, чем на чужой
//      (последняя таблица; если нет — вес в `WEIGHTS` подобран неудачно).

import { readCorpus } from './corpus.mjs';
import { analyzeChat } from '../core/analyze.mjs';
import { ANCHORS, WEIGHTS, FORMULA_VERSION } from '../core/index.mjs';

// --- аргументы --------------------------------------------------------------

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const CHAT_FILTER = arg('chat');
const MESSAGE_LIMIT = Number(arg('messages', 0)) || 0;
const STEPS = (arg('steps', '5,10,20,40')).split(',')
  .map(s => Number(s.trim()) / 100).filter(x => x > 0 && x <= 1);

// --- случайность ------------------------------------------------------------

/**
 * Свой генератор с явным зерном, а не `Math.random`.
 *
 * Прогон обязан повторяться: цифры из отчёта иначе нельзя ни перепроверить, ни
 * сравнить с завтрашними после правки якорей. Зерно фиксировано в коде и одно на
 * все ступени — сила порчи отличается только долей, а не выбором мест.
 */
function rng(seed = 20260812) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- порча ------------------------------------------------------------------

/**
 * Предложения сообщения.
 *
 * Нарочно грубо, по точке-восклицанию-многоточию с сохранением разделителя:
 * задача — разрезать текст на куски, которые можно тасовать, а не разобрать
 * пунктуацию. Тонкая сегментация живёт в `core/tokenize` и здесь не нужна.
 */
const sentences = text => text.split(/(?<=[.!?…])\s+/).filter(s => s.trim());

/**
 * Повтор фраз — бьёт в покрытие.
 *
 * Доля предложений заменяется копией более раннего предложения из этого же чата.
 * Именно более раннего: покрытие считается против словаря на момент ДО
 * сообщения (`core/analyze`), и копия из будущего не дала бы ничего.
 */
function degradeRepeat(messages, share, rand) {
  const pool = [];
  return messages.map(m => {
    const parts = sentences(m.mes);
    const out = parts.map(s => {
      const take = pool.length > 0 && rand() < share;
      return take ? pool[Math.floor(rand() * pool.length)] : s;
    });
    // Пул набирается ИСХОДНЫМИ предложениями и после подстановки: иначе
    // подставленная копия сама попадала бы в пул и порча множилась бы сама.
    for (const s of parts) if (s.trim().length > 30) pool.push(s);
    return { ...m, mes: out.join(' ') };
  });
}

/**
 * Обеднение словаря — бьёт в MATTR.
 *
 * Настоящих синонимов у стенда нет и взяться им неоткуда: словаря синонимов в
 * проекте не будет, а склеивать по основе — это стемминг, который в ядре и так
 * сделан. Схлопывание поэтому механическое: редкие слова отображаются на частые
 * слова той же длины. Текст становится бессмысленным, но MATTR меряет долю
 * разных слов в окне, а не смысл, — а именно на него порча и нацелена.
 *
 * **Сила порчи считается по словам текста, а не по словарю.** Редкие типы — это
 * девять десятых словаря и лишь малая доля слов, и «схлопнуть 20% словаря»
 * означало бы тронуть проценты текста: ступени лесенки оказались бы несравнимы
 * со ступенями двух других сортов. Поэтому типы берутся от более частых к более
 * редким, пока накопленная доля слов не дойдёт до `share`.
 *
 * Отсюда же граница честности стенда: обеднение словаря в живом тексте
 * выглядит иначе, и совпадение цифр тут ничего не доказывает сверх «компонент
 * реагирует на то, на что должен».
 */
function degradeVocabulary(messages, share, rand) {
  const freq = new Map();
  let total = 0;
  for (const m of messages) {
    for (const w of m.mes.toLowerCase().match(/[\p{L}\p{M}-]+/gu) ?? []) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
      total++;
    }
  }

  const byFreq = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  // Верхняя десятая часть словаря — то, во что схлопывают; она сама не трогается,
  // иначе замены пошли бы по кругу и словарь не сузился бы.
  const commonCount = Math.max(1, Math.floor(byFreq.length * 0.1));
  const common = byFreq.slice(0, commonCount).map(([w]) => w);

  // Отображение строится один раз на чат и не зависит от порядка обхода:
  // слово, схлопнутое в первом сообщении, обязано схлопнуться и в последнем,
  // иначе словарь не обеднеет, а просто перемешается.
  const map = new Map();
  let touched = 0;
  for (const [w, n] of byFreq.slice(commonCount)) {
    if (touched / total >= share) break;
    // Замена подбирается по длине: слово того же размера не сбивает ни счёт
    // слов, ни длину предложения, а значит и не трогает соседние метрики.
    const near = common.filter(c => Math.abs(c.length - w.length) <= 1);
    const from = near.length ? near : common;
    map.set(w, from[Math.floor(rand() * from.length)]);
    touched += n;
  }

  const swap = text => text.replace(/[\p{L}\p{M}-]+/gu, word => {
    const to = map.get(word.toLowerCase());
    if (!to) return word;
    // Заглавная в начале слова сохраняется: иначе порча заодно съела бы границы
    // предложений, а по ним стенд режет текст.
    return /^\p{Lu}/u.test(word) ? to[0].toUpperCase() + to.slice(1) : to;
  });

  return messages.map(m => ({ ...m, mes: swap(m.mes) }));
}

/**
 * Пересказ — бьёт в похожесть.
 *
 * Доля сообщений заменяется перефразировкой соседнего: берутся его предложения,
 * часть выбрасывается, остальные идут в прежнем порядке. Порядок сохраняется
 * намеренно — самоповтор ищет общие цепочки слов (`core/similarity`), и
 * перетасованные предложения он поймал бы ровно так же, а вот выброшенные
 * делают пересказ пересказом, а не копией.
 */
function degradeParaphrase(messages, share, rand) {
  const KEEP = 0.7;
  return messages.map((m, i) => {
    if (i === 0 || rand() >= share) return m;
    const source = sentences(messages[i - 1].mes);
    if (source.length < 3) return m;
    const kept = source.filter(() => rand() < KEEP);
    if (!kept.length) return m;
    return { ...m, mes: kept.join(' ') };
  });
}

const KINDS = [
  { key: 'repeat', label: 'повтор фраз', target: 'coverage', fn: degradeRepeat },
  { key: 'vocab', label: 'обеднение словаря', target: 'diversity', fn: degradeVocabulary },
  { key: 'para', label: 'пересказ', target: 'similarity', fn: degradeParaphrase },
];

// --- замер ------------------------------------------------------------------

const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '—');

/**
 * Индекс и компоненты одного варианта чата.
 *
 * Компоненты берутся УЖЕ НОРМИРОВАННЫМИ (`m.slop.parts`), то есть в тех же
 * единицах, в которых они складываются в индекс: сравнивать сырое покрытие с
 * сырым MATTR бессмысленно, а нормированные доли сравнимы между собой. Заодно
 * по ним видно, что упёрлось в потолок якоря: нормированная единица — это и
 * есть потолок.
 */
function measure(chat) {
  const r = analyzeChat(chat, { extraNames: chat.extraNames, topLimit: 1 });
  const keys = ['coverage', 'diversity', 'similarity'];
  const parts = {}, ceiling = {};

  for (const key of keys) {
    let sum = 0, weight = 0, atTop = 0;
    for (const m of r.messages) {
      const w = m.words ?? 0;
      if (w <= 0) continue;
      const v = m.slop.parts[key];
      sum += v * w;
      weight += w;
      if (v >= 1) atTop += w;
    }
    parts[key] = weight ? sum / weight : NaN;
    ceiling[key] = weight ? atTop / weight : NaN;
  }

  return { index: r.index.value, words: r.stats.words, parts, ceiling };
}

// --- прогон -----------------------------------------------------------------

let corpus = readCorpus();
if (!corpus.length) {
  console.log('Корпуса нет: задайте ANTISLOP_CORPUS или tools/corpus.local.mjs (см. corpus.mjs).');
  process.exit(0);
}
if (CHAT_FILTER) corpus = corpus.filter(c => c.title.includes(CHAT_FILTER));
if (MESSAGE_LIMIT) {
  corpus = corpus.map(c => ({ ...c, messages: c.messages.slice(0, MESSAGE_LIMIT) }));
}

console.log(`Формула ${FORMULA_VERSION}. Чатов ${corpus.length}, ступени порчи: `
  + STEPS.map(s => Math.round(s * 100) + '%').join(', '));
console.log('Веса: ' + Object.entries(WEIGHTS).map(([k, v]) => `${k} ${v}`).join(', '));
console.log('Якоря: ' + Object.entries(ANCHORS)
  .map(([k, a]) => `${k} ${a.zero}→${a.full}`).join(', '));

const head = ['вариант'.padEnd(26), 'индекс'.padStart(7), 'покрытие'.padStart(10),
  'разнообр.'.padStart(10), 'похожесть'.padStart(10), 'в потолке'.padStart(10)].join(' ');

/** Сколько текста упёрлось в потолок якоря — по тому компоненту, в который бьёт порча. */
const row = (label, m, key) => [label.padEnd(26), String(m.index).padStart(7),
  pct(m.parts.coverage).padStart(10), pct(m.parts.diversity).padStart(10),
  pct(m.parts.similarity).padStart(10), (key ? pct(m.ceiling[key]) : '—').padStart(10)].join(' ');

/** Отклик: насколько выросла нормированная доля компонента против исходного чата. */
const response = {};

for (const chat of corpus) {
  const base = measure(chat);
  console.log(`\n=== ${chat.title} ===`);
  console.log(`${chat.messages.length} ответов, ${base.words} слов прозы`);
  console.log(head);
  console.log(row('исходный', base, null));
  // У исходного чата столбец «в потолке» пуст: целевого компонента у него нет.
  // А знать про запас якоря надо именно по исходному тексту — если он упирается
  // в потолок ещё до всякой порчи, шкала кончилась там, где начинается работа.
  console.log('  в потолке на исходном: '
    + ['coverage', 'diversity', 'similarity'].map(k => `${k} ${pct(base.ceiling[k])}`).join(', '));

  for (const kind of KINDS) {
    for (const share of STEPS) {
      // Зерно одно на все ступени: места порчи выбираются в одном и том же
      // порядке, и лесенка получается вложенной, а не четырьмя разными порчами.
      const spoiled = { ...chat, messages: kind.fn(chat.messages, share, rng()) };
      const m = measure(spoiled);
      console.log(row(`${kind.label} ${Math.round(share * 100)}%`, m, kind.target));

      if (share === STEPS[STEPS.length - 1]) {
        for (const key of ['coverage', 'diversity', 'similarity']) {
          (response[kind.key] ??= {})[key] = ((response[kind.key][key] ?? 0)
            + (m.parts[key] - base.parts[key]) / corpus.length);
        }
      }
    }
  }
}

console.log('\n=== Отклик компонентов на сорт порчи (на самой сильной ступени) ===');
console.log('Каждый сорт бьёт в свой компонент. Если по строке наибольшее число');
console.log('стоит не на своей диагонали — компонент ловит не то, ради чего заведён.');
console.log('порча'.padEnd(22), 'покрытие'.padStart(10), 'разнообр.'.padStart(10), 'похожесть'.padStart(10));
for (const kind of KINDS) {
  const r = response[kind.key] ?? {};
  const mark = key => (key === kind.target ? '*' : ' ');
  console.log(kind.label.padEnd(22),
    (pct(r.coverage) + mark('coverage')).padStart(10),
    (pct(r.diversity) + mark('diversity')).padStart(10),
    (pct(r.similarity) + mark('similarity')).padStart(10));
}
console.log('\n* — компонент, в который порча целит.');
