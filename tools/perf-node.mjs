// Стенд производительности, часть первая: сколько стоит полный проход в Node.
//
// Это точка отсчёта для замера в браузере. В Node нет
// ни главного потока, ни отрисовки — цифры отсюда не говорят, тормозит интерфейс
// или нет. Они говорят другое: сколько машинного времени вообще стоит проход и
// на что оно уходит по стадиям. Браузерный стенд сравнивается с этим, и разница
// между ними — цена движка и телефона, а не цена алгоритма.
//
// Меряется:
//   · полный проход по каждому чату и по всем четырём как по одному длинному;
//   · время самого дорогого одиночного `push` — на главном потоке это и есть
//     длина заедания, потому что `push` не прерывается;
//   · `result()` отдельно: он делает второй проход по тексту (`resolve`) и
//     считается заново при каждом вызове;
//   · разбивка по стадиям — на копии цикла из `core/analyze.mjs`, сверенной с
//     `analyzeChat` по итогу (как в `verify-core.mjs`: своя реализация рядом,
//     а не вместо).
//
// Запуск: node --expose-gc tools/perf-node.mjs
// Без --expose-gc всё работает, кроме цифр по памяти.

import { readCorpus } from './corpus.mjs';
import { createAnalysis, analyzeChat } from '../core/analyze.mjs';
import { tokenizeMessage, namesFromChat, nameBarriers } from '../core/tokenize.mjs';
import { createCounter } from '../core/ngrams.mjs';
import { createDetector } from '../core/similarity.mjs';
import { diversity } from '../core/diversity.mjs';
import { cvalue } from '../core/cvalue.mjs';
import { messageIndex, chatIndex } from '../core/index.mjs';

const now = () => performance.now();
const ms = v => `${v.toFixed(1)} мс`;
const num = v => v.toLocaleString('ru-RU');

function heap() {
  if (typeof globalThis.gc === 'function') { globalThis.gc(); globalThis.gc(); }
  return process.memoryUsage().heapUsed;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Чат в том виде, в каком его ждёт ядро. */
function asChat(c) {
  return {
    characterName: c.characterName,
    userName: c.userName,
    messages: c.messages,
    extraNames: c.extraNames,
  };
}

/** Четыре чата, склеенные в один длинный: худший случай, 230 тысяч слов. */
function joined(corpus) {
  return {
    title: 'все четыре как один длинный чат',
    characterName: undefined,
    userName: undefined,
    extraNames: corpus.flatMap(c => c.extraNames),
    messages: corpus.flatMap(c => c.messages),
  };
}

// ───────────────────────────────── прогон целиком ─────────────────────────────

/**
 * Полный проход сессией — ровно так, как это делает расширение: `push` на каждое
 * сообщение, `result()` в конце.
 */
function runSession(chat) {
  const names = new Set([...namesFromChat(chat), ...chat.extraNames]);

  const before = heap();
  const t0 = now();

  const session = createAnalysis({
    names,
    readText: i => chat.messages[i]?.mes,
  });

  const pushes = [];
  chat.messages.forEach((m, idx) => {
    const t = now();
    session.push({ index: idx, name: m.name, mes: m.mes });
    pushes.push(now() - t);
  });

  const tPush = now() - t0;
  const tResult0 = now();
  const result = session.result();
  const tResult = now() - tResult0;

  const after = heap();
  const sorted = [...pushes].sort((a, b) => a - b);

  return {
    result,
    pushes,
    total: tPush + tResult,
    push: tPush,
    resultMs: tResult,
    worstPush: sorted[sorted.length - 1],
    medianPush: quantile(sorted, 0.5),
    p95Push: quantile(sorted, 0.95),
    heap: after - before,
  };
}

// ───────────────────────────── разбивка по стадиям ────────────────────────────

/**
 * Копия цикла из `core/analyze.mjs` с секундомером на каждой стадии.
 *
 * Копия, а не хук в ядре: инструментировать боевой путь ради замера — значит
 * оставить в нём мёртвый код навсегда. Расхождение ловится сверкой итога:
 * `check()` ниже сравнивает индекс, топ и словарь с тем, что вернул `analyzeChat`.
 */
function runStages(chat) {
  const names = new Set([...namesFromChat(chat), ...chat.extraNames]);
  const barriers = nameBarriers(names);
  const parse = mes => tokenizeMessage(mes, { barriers, stem: true });

  const counter = createCounter({});
  const detector = createDetector();
  const messages = [];
  const allWords = [];

  const t = { parse: 0, coverage: 0, similarity: 0, count: 0, diversity: 0 };

  chat.messages.forEach((m, index) => {
    let a = now();
    const parsed = parse(m.mes);
    const segments = parsed.segments.map(seg => seg.map(tk => tk.stem));
    const forms = parsed.segments.flat().map(tk => tk.form);
    const stems = segments.flat();
    t.parse += now() - a;

    a = now();
    const cov = counter.coverage(segments);
    t.coverage += now() - a;

    a = now();
    const rep = detector.add({ index, stems, forms });
    t.similarity += now() - a;

    a = now();
    counter.add(index, segments);
    t.count += now() - a;

    a = now();
    const div = diversity(stems);
    t.diversity += now() - a;

    const mi = messageIndex({
      coverage: cov.ratio,
      mattr: div.mattr,
      similarity: rep.best?.containment ?? 0,
      words: parsed.words,
    });
    allWords.push(...stems);
    messages.push({ index, words: parsed.words, value: mi.value });
  });

  // result() по стадиям.
  let a = now();
  const cands = counter.candidates({});
  const tCandidates = now() - a;

  a = now();
  counter.resolve(cands, i => {
    const mes = chat.messages[i]?.mes;
    return mes == null ? [] : parse(mes).segments;
  });
  const tResolve = now() - a;

  a = now();
  const ranked = cvalue(cands, { limit: 50 });
  const tCvalue = now() - a;

  a = now();
  const div = diversity(allWords);
  const tDiversityAll = now() - a;

  a = now();
  const findings = detector.findings();
  const tFindings = now() - a;

  const index = chatIndex(messages.map(x => ({ value: x.value, words: x.words })));

  return {
    stages: {
      'разбор и стемминг': t.parse,
      'покрытие': t.coverage,
      'самоповтор': t.similarity,
      'счётчик оборотов': t.count,
      'разнообразие по сообщениям': t.diversity,
      'кандидаты': tCandidates,
      'восстановление строк (resolve)': tResolve,
      'C-value': tCvalue,
      'разнообразие по чату': tDiversityAll,
      'находки самоповтора': tFindings,
    },
    check: {
      index: index.value,
      top: ranked.top.slice(0, 10).map(x => x.text),
      words: counter.stats().words,
      findings: findings.length,
    },
  };
}

// ─────────────────────────────────── отчёт ────────────────────────────────────

function report(chat) {
  const run = runSession(chat);
  const r = run.result;
  const words = r.stats.words;

  console.log('='.repeat(76));
  console.log(chat.title);
  console.log('='.repeat(76));
  console.log(
    `Сообщений модели: ${num(chat.messages.length)}, слов прозы: ${num(words)}, ` +
    `режим счётчика: ${r.stats.mode}`,
  );
  console.log();
  console.log(`Полный проход:        ${ms(run.total)}   (${(run.total / words * 1000).toFixed(1)} мс на тысячу слов)`);
  console.log(`  цикл push:          ${ms(run.push)}`);
  console.log(`  result():           ${ms(run.resultMs)}`);
  console.log();
  console.log(
    `Одиночный push:       медиана ${ms(run.medianPush)}, 95-й ${ms(run.p95Push)}, ` +
    `худший ${ms(run.worstPush)}`,
  );
  console.log(`  худший push — это и есть длина одного непрерывного заедания главного потока`);
  if (typeof globalThis.gc === 'function') {
    console.log(`Куча после прохода:   ${(run.heap / 1024 / 1024).toFixed(1)} МБ`);
  } else {
    console.log('Куча:                 не мерялась (запусти с --expose-gc)');
  }

  // Разбивка по стадиям — отдельным прогоном, чтобы секундомеры не влияли на
  // цифры выше.
  const st = runStages(chat);
  const sum = Object.values(st.stages).reduce((a, b) => a + b, 0);
  console.log();
  console.log('--- На что уходит время ---');
  const rows = Object.entries(st.stages).sort((a, b) => b[1] - a[1]);
  for (const [name, value] of rows) {
    const share = value / sum * 100;
    const bar = '█'.repeat(Math.max(0, Math.round(share / 2)));
    console.log(`  ${name.padEnd(32)} ${ms(value).padStart(10)}  ${share.toFixed(1).padStart(5)}%  ${bar}`);
  }
  console.log(`  ${'итого'.padEnd(32)} ${ms(sum).padStart(10)}`);

  // Сверка: копия цикла не разошлась с боевым путём.
  const control = analyzeChat(chat, { extraNames: chat.extraNames });
  const same =
    control.index.value === st.check.index &&
    control.stats.words === st.check.words &&
    control.findings.length === st.check.findings &&
    control.top.slice(0, 10).every((x, i) => x.text === st.check.top[i]);
  console.log();
  console.log(
    same
      ? '  сверка: копия цикла считает то же, что analyzeChat (индекс, топ-10, словарь, находки)'
      : `  ВНИМАНИЕ: копия цикла разошлась с analyzeChat — ` +
        `индекс ${st.check.index} против ${control.index.value}, ` +
        `слов ${st.check.words} против ${control.stats.words}`,
  );
  console.log();

  return { words, total: run.total, worstPush: run.worstPush, same };
}

const corpus = readCorpus();
const chats = [...corpus.map(asChat).map((c, i) => ({ ...c, title: corpus[i].title })), joined(corpus)];

const summary = chats.map(report);

console.log('='.repeat(76));
console.log('ИТОГ — точка отсчёта для браузера');
console.log('='.repeat(76));
for (let i = 0; i < chats.length; i++) {
  const s = summary[i];
  console.log(
    `${chats[i].title.slice(0, 46).padEnd(48)} ${num(s.words).padStart(8)} слов  ` +
    `${ms(s.total).padStart(10)}  худший push ${ms(s.worstPush)}`,
  );
}
const bad = summary.filter(s => !s.same).length;
console.log();
console.log(
  bad
    ? `ВНИМАНИЕ: разошлись на ${bad} чатах — цифрам верить нельзя, пока не сойдётся`
    : 'Разбивка по стадиям сверена с боевым путём на всех чатах.',
);
process.exit(bad ? 1 : 0);
