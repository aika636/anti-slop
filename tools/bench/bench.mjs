// Браузерный стенд производительности anti-slop.
//
// Продолжение `tools/perf-node.mjs`. В Node нет ни
// главного потока, ни отрисовки — цифры оттуда говорят, сколько машинного
// времени стоит проход и на что оно уходит по стадиям, но не говорят, тормозит
// ли от этого интерфейс. Здесь то же самое (часть 1, для сверки чисел напрямую
// с Node), плюс то, чего в Node нет в принципе: счётчик кадров главного потока
// (часть 2) и та же работа в модульном воркере (часть 3).
//
// Своя страница, не расширение: сюда нельзя тащить `index.js`, `adapter.js`,
// `storage.js` или `ui/` — только ядро из `../../core/*.mjs`.

import { createAnalysis, analyzeChat } from '../../core/analyze.mjs';
import { tokenizeMessage, namesFromChat, nameBarriers } from '../../core/tokenize.mjs';
import { createCounter } from '../../core/ngrams.mjs';
import { createDetector } from '../../core/similarity.mjs';
import { diversity } from '../../core/diversity.mjs';
import { cvalue } from '../../core/cvalue.mjs';
import { messageIndex, chatIndex } from '../../core/index.mjs';

// ─────────────────────────────── мелкие помощники ─────────────────────────────

const now = () => performance.now();
const ms = v => `${v.toFixed(1)} мс`;
const num = v => v.toLocaleString('ru-RU');

/** Отдать управление интерфейсу между тяжёлыми шагами, иначе на телефоне страница
 *  повиснет до конца замера и отчёт никто не увидит. */
const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Куча JS, если браузер её отдаёт (Chromium — да, Firefox и Safari — нет). */
function heap() {
  return performance.memory ? performance.memory.usedJSHeapSize : null;
}

// ─────────────────────────────────── корпус ───────────────────────────────────

/**
 * Разбор одного файла `.jsonl`, уже прочитанного в строку через `File.text()`.
 * Правило отбора сообщений — то же самое, что в `tools/corpus.mjs`: первая
 * строка — заголовок экспорта, дальше по сообщению на строку, пропускаются
 * реплики пользователя и пустые `mes`.
 *
 * Имена персонажей нигде не зашиты: имя персоны берётся из самих реплик
 * пользователя, а всё, чего в файле нет (обычно — имя карточки кириллицей,
 * когда сама карточка названа латиницей), дописывается полем на странице.
 * Без имён стенд мерил бы поблажку, которой в бою не будет: они держат
 * стоп-лист, а тот заметно меняет поток токенов.
 */
function parseChatText(text, fileName, extraNames = []) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  let header = {};
  try { header = JSON.parse(lines[0]); } catch { /* заголовка нет — не беда */ }

  const messages = [];
  const personaNames = new Set();
  for (let i = 1; i < lines.length; i++) {
    let m;
    try { m = JSON.parse(lines[i]); } catch { continue; }
    // Имя персоны снимаем до отсева: в репликах пользователя оно записано так же,
    // как персонаж зовётся в тексте.
    if (m.is_user) { if (m.name) personaNames.add(m.name); continue; }
    if (typeof m.mes !== 'string' || !m.mes.trim()) continue;
    messages.push({ name: m.name, mes: m.mes, isSystem: !!m.is_system });
  }

  return {
    title: fileName,
    characterName: header.character_name,
    userName: header.user_name,
    extraNames: [...new Set([...personaNames, ...extraNames])],
    messages,
  };
}

/** Имена из поля на странице: через запятую, пустые и повторы отбрасываются. */
function extraNamesFromInput() {
  const raw = els.extraNames?.value ?? '';
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

/** Читает все выбранные файлы, уступая интерфейсу между ними. */
async function readChatsFromFiles(fileList) {
  const extra = extraNamesFromInput();
  const chats = [];
  for (const file of fileList) {
    const text = await file.text();
    chats.push(parseChatText(text, file.name, extra));
    await yieldToUI();
  }
  return chats;
}

/**
 * Запасной источник для десктопа: папка `tools/bench/chats/` рядом со стендом.
 *
 * Нужна, чтобы прогонять замер без ручного выбора файлов — на десктопе это
 * экономит полминуты на каждый прогон, а сравнивать браузер с Node приходится
 * часто. Папки в репозитории нет и быть не должно: чаты личные.
 * Кладутся копиями на время замера и убираются после, а
 * список имён — в `chats/index.json` рядом с ними. Если папки нет — берётся то,
 * что выбрано в поле файлов, и это основной путь, единственный работающий на
 * телефоне.
 */
async function readChatsFromFolder() {
  let names = [];
  try {
    const list = await fetch('./chats/index.json');
    if (list.ok) names = await list.json();
  } catch { /* папки нет — так и задумано */ }
  if (!Array.isArray(names)) return [];

  const extra = extraNamesFromInput();
  const chats = [];
  for (const name of names) {
    let response;
    try {
      response = await fetch(`./chats/${encodeURIComponent(name)}`);
    } catch { continue; }
    if (!response.ok) continue;
    chats.push(parseChatText(await response.text(), name, extra));
    await yieldToUI();
  }
  return chats;
}

/** Чат в том виде, в каком его ждёт ядро (без служебных полей вроде `isSystem`). */
function asChat(c) {
  return { characterName: c.characterName, userName: c.userName, messages: c.messages, extraNames: c.extraNames };
}

/** Все выбранные чаты, склеенные в один длинный — худший случай по объёму. */
function joined(corpus) {
  return {
    title: `все ${corpus.length} как один длинный чат`,
    characterName: undefined,
    userName: undefined,
    extraNames: corpus.flatMap(c => c.extraNames),
    messages: corpus.flatMap(c => c.messages),
  };
}

/** Список чатов для замера: каждый по отдельности плюс (если их больше одного) все вместе. */
function buildChatList(corpus) {
  const named = corpus.map((c, i) => ({ ...asChat(c), title: corpus[i].title }));
  return corpus.length > 1 ? [...named, joined(corpus)] : named;
}

// ──────────────────────────────── часть 1: прогон ─────────────────────────────
// Дословно `runSession` из `tools/perf-node.mjs`, только куча читается через
// `performance.memory`, если браузер её отдаёт.

function runSession(chat) {
  const names = new Set([...namesFromChat(chat), ...chat.extraNames]);

  const before = heap();
  const t0 = now();

  const session = createAnalysis({ names, readText: i => chat.messages[i]?.mes });

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
    heapBefore: before,
    heapAfter: after,
  };
}

// ───────────────────────── разбивка по стадиям (без изменений) ───────────────
// Дословная копия `runStages` из `tools/perf-node.mjs` — она чистая и уже не
// зависит от Node, менять в ней нечего.

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

function sameAsControl(control, check) {
  return (
    control.index.value === check.index &&
    control.stats.words === check.words &&
    control.findings.length === check.findings &&
    control.top.slice(0, 10).every((x, i) => x.text === check.top[i])
  );
}

// ────────────────────────── часть 2: кадры главного потока ────────────────────
// Счётчик кадров на requestAnimationFrame, включённый на всё время тяжёлого
// шага. Пока `push` крутится синхронно, кадры вообще не приходят — именно эта
// дыра между двумя тиками rAF и есть заедание интерфейса.
//
// Оба конца асинхронные, и это не украшательство. Первая версия и заводилась,
// и останавливалась синхронно, вокруг синхронного же `runSession`, — то есть
// вся её жизнь укладывалась в одну задачу, ни один кадр за это время прийти
// не успевал, и стенд бодро печатал «пропущено кадров 0» на проходе в полторы
// секунды. Поэтому: `startFrameMonitor` ждёт первый кадр (он и станет точкой
// отсчёта), а `stop` — ещё один, тот самый, который придёт уже после
// разблокировки потока и принесёт длину дыры.

async function startFrameMonitor() {
  const gaps = [];
  let last = 0;
  let raf = 0;
  let running = true;

  function tick(t) {
    if (last) gaps.push(t - last);
    last = t;
    if (running) raf = requestAnimationFrame(tick);
  }

  // Точка отсчёта: дождаться первого кадра, и только потом отдать монитор
  // вызывающему — иначе в первый промежуток попадёт время до него.
  await new Promise(resolve => {
    raf = requestAnimationFrame(t => { last = t; resolve(); raf = requestAnimationFrame(tick); });
  });

  return {
    async stop() {
      // Кадр, который придёт после тяжёлой работы: он и несёт длину заедания.
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      running = false;
      cancelAnimationFrame(raf);

      const target = 1000 / 60;
      const dropped = gaps.reduce((sum, g) => sum + Math.max(0, Math.round(g / target) - 1), 0);
      const longest = gaps.length ? Math.max(...gaps) : 0;
      const over50 = gaps.filter(g => g > 50).reduce((a, b) => a + b, 0);
      return { frames: gaps.length + 1, dropped, longest, over50 };
    },
  };
}

function framesLines(frames) {
  return [
    `Кадров учтено: ${num(frames.frames)}`,
    `Пропущено кадров (грубая оценка, по 16.7 мс на кадр): ${num(frames.dropped)}`,
    `Самый длинный промежуток между кадрами: ${ms(frames.longest)}`,
    `Сумма промежутков длиннее 50 мс: ${ms(frames.over50)}`,
  ];
}

// ───────────────────────────────── часть 3: воркер ────────────────────────────

/** Клиент модульного воркера: очередь запросов по id, каждый со своим ack и итогом. */
function createWorkerClient() {
  const url = new URL('./worker.mjs', import.meta.url);
  const worker = new Worker(url, { type: 'module' });
  const pending = new Map();
  let nextId = 1;

  worker.addEventListener('message', e => {
    const { type, id } = e.data ?? {};
    const entry = pending.get(id);
    if (!entry) return;
    if (type === 'ack') {
      entry.ackAt = now();
    } else if (type === 'done') {
      pending.delete(id);
      entry.resolve({ ackMs: entry.ackAt - entry.startedAt, passMs: e.data.passMs, totalMs: now() - entry.startedAt, summary: e.data.summary });
    } else if (type === 'error') {
      pending.delete(id);
      entry.reject(new Error(e.data.message));
    }
  });
  worker.addEventListener('error', e => {
    for (const entry of pending.values()) entry.reject(e.error ?? new Error(e.message ?? 'ошибка воркера'));
    pending.clear();
  });

  return {
    run(chat) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, startedAt: now(), ackAt: now() });
        worker.postMessage({ id, chat });
      });
    },
    terminate: () => worker.terminate(),
  };
}

// ──────────────────────────────── сборка отчёта ───────────────────────────────

function deviceHeaderLines() {
  const lines = [];
  lines.push('='.repeat(76));
  lines.push('Устройство');
  lines.push('='.repeat(76));
  lines.push(`User-Agent: ${navigator.userAgent}`);
  lines.push(`Логических ядер (hardwareConcurrency): ${navigator.hardwareConcurrency ?? 'не сообщается браузером'}`);
  lines.push(
    `Память устройства (deviceMemory): ${navigator.deviceMemory != null ? navigator.deviceMemory + ' ГБ (грубая оценка браузера)' : 'не сообщается этим браузером'}`,
  );
  lines.push(`devicePixelRatio: ${window.devicePixelRatio}`);
  lines.push(`Ширина окна: ${window.innerWidth} px`);
  lines.push(
    `performance.memory: ${performance.memory ? 'доступен — куча будет измерена' : 'недоступен в этом браузере — цифр по куче не будет'}`,
  );
  lines.push('');
  return lines;
}

function chatMainBlock(chat, run, st, control, same, frames) {
  const words = run.result.stats.words;
  const lines = [];
  lines.push('='.repeat(76));
  lines.push(chat.title);
  lines.push('='.repeat(76));
  lines.push(
    `Сообщений модели: ${num(chat.messages.length)}, слов прозы: ${num(words)}, ` +
    `режим счётчика: ${run.result.stats.mode}`,
  );
  lines.push('');
  lines.push(`Полный проход:        ${ms(run.total)}   (${(run.total / words * 1000).toFixed(1)} мс на тысячу слов)`);
  lines.push(`  цикл push:          ${ms(run.push)}`);
  lines.push(`  result():           ${ms(run.resultMs)}`);
  lines.push('');
  lines.push(
    `Одиночный push:       медиана ${ms(run.medianPush)}, 95-й ${ms(run.p95Push)}, ` +
    `худший ${ms(run.worstPush)}`,
  );
  lines.push('  худший push — это и есть длина одного непрерывного заедания главного потока');
  if (run.heapBefore != null && run.heapAfter != null) {
    lines.push(`Куча после прохода:   ${((run.heapAfter - run.heapBefore) / 1024 / 1024).toFixed(1)} МБ`);
  } else {
    lines.push('Куча:                 не мерялась — в этом браузере нет performance.memory');
  }

  lines.push('');
  lines.push('--- На что уходит время ---');
  const sum = Object.values(st.stages).reduce((a, b) => a + b, 0);
  const rows = Object.entries(st.stages).sort((a, b) => b[1] - a[1]);
  for (const [name, value] of rows) {
    const share = value / sum * 100;
    const bar = '█'.repeat(Math.max(0, Math.round(share / 2)));
    lines.push(`  ${name.padEnd(32)} ${ms(value).padStart(10)}  ${share.toFixed(1).padStart(5)}%  ${bar}`);
  }
  lines.push(`  ${'итого'.padEnd(32)} ${ms(sum).padStart(10)}`);

  lines.push('');
  lines.push(
    same
      ? '  сверка: копия цикла считает то же, что analyzeChat (индекс, топ-10, словарь, находки)'
      : `  ВНИМАНИЕ: копия цикла разошлась с analyzeChat — ` +
        `индекс ${st.check.index} против ${control.index.value}, ` +
        `слов ${st.check.words} против ${control.stats.words}`,
  );

  lines.push('');
  lines.push('--- Кадры главного потока во время прохода (часть 2) ---');
  lines.push(...framesLines(frames));
  lines.push('  это и есть честная мера «интерфейс не отвечает»');
  lines.push('');
  return lines;
}

function chatWorkerBlock(chat, data, control, frames) {
  const { ackMs, passMs, totalMs, summary } = data;
  const topMatches = control.top.slice(0, 10).every((x, i) => x.text === summary.top[i]);
  const same =
    control.index.value === summary.index &&
    control.stats.words === summary.words &&
    control.findings.length === summary.findings &&
    topMatches;

  const lines = [];
  lines.push('-'.repeat(76));
  lines.push(`Воркер: ${chat.title}`);
  lines.push('-'.repeat(76));
  lines.push(`Передача текста в воркер (postMessage → ack от воркера): ${ms(ackMs)}`);
  lines.push(`Полный проход внутри воркера (по часам самого воркера): ${ms(passMs)}`);
  lines.push(`Всего от отправки до готового результата: ${ms(totalMs)}`);
  lines.push('');
  lines.push(
    same
      ? '  сверка: воркер посчитал то же самое, что главный поток (индекс, топ-10, слова, находки)'
      : `  ВНИМАНИЕ: воркер разошёлся с главным потоком — ` +
        `индекс ${summary.index} против ${control.index.value}, ` +
        `слов ${summary.words} против ${control.stats.words}`,
  );
  lines.push('');
  lines.push('--- Кадры главного потока, пока считал воркер (часть 3, сравнить с частью 2) ---');
  lines.push(...framesLines(frames));
  lines.push('  здесь интерфейс должен оставаться ровным — вся тяжёлая работа ушла в воркер');
  lines.push('');
  return { lines, same };
}

// ─────────────────────────────────── интерфейс ────────────────────────────────

const els = {};
let workerClient = null;

function setStatus(text) {
  els.status.textContent = text;
}

function appendReport(lines) {
  els.report.textContent += (els.report.textContent ? '\n' : '') + lines.join('\n');
  // Автопрокрутка отчёта вниз, чтобы на телефоне не искать глазами свежий кусок.
  els.report.scrollTop = els.report.scrollHeight;
}

function clearReport() {
  els.report.textContent = '';
}

async function getChats() {
  if (els.fileInput.files.length) return readChatsFromFiles(els.fileInput.files);
  // Ничего не выбрано — пробуем папку `chats/` рядом со стендом.
  return readChatsFromFolder();
}

async function runMainThreadPart(chats) {
  appendReport(deviceHeaderLines());
  const summary = [];

  for (const chat of chats) {
    setStatus(`Главный поток: считается «${chat.title}»`);
    await yieldToUI();

    const monitor = await startFrameMonitor();
    const run = runSession(chat);
    const frames = await monitor.stop();
    await yieldToUI();

    const st = runStages(chat);
    const control = analyzeChat(chat, { extraNames: chat.extraNames });
    const same = sameAsControl(control, st.check);

    appendReport(chatMainBlock(chat, run, st, control, same, frames));
    summary.push({ title: chat.title, words: run.result.stats.words, total: run.total, worstPush: run.worstPush, same, frames });
    await yieldToUI();
  }

  appendReport(['='.repeat(76), 'ИТОГ — главный поток', '='.repeat(76)]);
  for (const s of summary) {
    appendReport([
      `${s.title.slice(0, 46).padEnd(48)} ${num(s.words).padStart(8)} слов  ` +
      `${ms(s.total).padStart(10)}  худший push ${ms(s.worstPush)}  ` +
      `пропущено кадров ${num(s.frames.dropped)}`,
    ]);
  }
  const bad = summary.filter(s => !s.same).length;
  appendReport([
    '',
    bad
      ? `ВНИМАНИЕ: разошлись на ${bad} чатах — цифрам верить нельзя, пока не сойдётся`
      : 'Разбивка по стадиям сверена с боевым путём на всех чатах.',
    '',
  ]);

  return summary;
}

async function runWorkerPart(chats) {
  appendReport(['='.repeat(76), 'Часть 3 — воркер', '='.repeat(76), '']);

  if (typeof Worker === 'undefined') {
    appendReport(['Worker недоступен в этом браузере — часть 3 пропущена.', '']);
    return [];
  }

  const client = workerClient ?? (workerClient = createWorkerClient());
  const summary = [];

  for (const chat of chats) {
    setStatus(`Воркер: считается «${chat.title}»`);
    await yieldToUI();

    // Опорный результат — тот же analyzeChat, что выполняет главный поток
    // в части 1; с ним сверяется итог воркера.
    const control = analyzeChat(chat, { extraNames: chat.extraNames });
    await yieldToUI();

    const monitor = await startFrameMonitor();
    let data;
    try {
      data = await client.run(chat);
    } catch (error) {
      const frames = await monitor.stop();
      appendReport([`ВНИМАНИЕ: воркер упал на «${chat.title}»: ${error.message ?? error}`, '']);
      summary.push({ title: chat.title, same: false, frames });
      await yieldToUI();
      continue;
    }
    const frames = await monitor.stop();

    const { lines, same } = chatWorkerBlock(chat, data, control, frames);
    appendReport(lines);
    summary.push({ title: chat.title, passMs: data.passMs, ackMs: data.ackMs, same, frames });
    await yieldToUI();
  }

  appendReport(['='.repeat(76), 'ИТОГ — воркер', '='.repeat(76)]);
  for (const s of summary) {
    appendReport([
      `${s.title.slice(0, 46).padEnd(48)} проход ${ms(s.passMs ?? 0).padStart(10)}  ` +
      `передача ${ms(s.ackMs ?? 0).padStart(8)}  пропущено кадров ${num(s.frames.dropped)}`,
    ]);
  }
  const bad = summary.filter(s => !s.same).length;
  appendReport([
    '',
    bad
      ? `ВНИМАНИЕ: воркер разошёлся с главным потоком на ${bad} чатах`
      : 'Итог воркера сверен с главным потоком на всех чатах — совпадает.',
    '',
  ]);

  return summary;
}

async function withButtonsDisabled(fn) {
  for (const b of [els.btnMain, els.btnWorker, els.btnBoth]) b.disabled = true;
  try {
    await fn();
  } finally {
    for (const b of [els.btnMain, els.btnWorker, els.btnBoth]) b.disabled = false;
    setStatus('Готово.');
  }
}

async function onRunMain() {
  await withButtonsDisabled(async () => {
    clearReport();
    setStatus('Читаю файлы…');
    const raw = await getChats();
    if (!raw.length) { setStatus('Файлы не выбраны, и папки chats/ рядом со стендом нет.'); return; }
    const chats = buildChatList(raw);
    await runMainThreadPart(chats);
  });
}

async function onRunWorker() {
  await withButtonsDisabled(async () => {
    clearReport();
    setStatus('Читаю файлы…');
    const raw = await getChats();
    if (!raw.length) { setStatus('Файлы не выбраны, и папки chats/ рядом со стендом нет.'); return; }
    const chats = buildChatList(raw);
    appendReport(deviceHeaderLines());
    await runWorkerPart(chats);
  });
}

async function onRunBoth() {
  await withButtonsDisabled(async () => {
    clearReport();
    setStatus('Читаю файлы…');
    const raw = await getChats();
    if (!raw.length) { setStatus('Файлы не выбраны, и папки chats/ рядом со стендом нет.'); return; }
    const chats = buildChatList(raw);
    const mainSummary = await runMainThreadPart(chats);
    await yieldToUI();
    const workerSummary = await runWorkerPart(chats);

    appendReport(['='.repeat(76), 'Сравнение: главный поток против воркера', '='.repeat(76)]);
    for (let i = 0; i < chats.length; i++) {
      const m = mainSummary[i];
      const w = workerSummary[i];
      if (!m || !w) continue;
      appendReport([
        `${chats[i].title.slice(0, 40).padEnd(42)} пропущено кадров: главный поток ${num(m.frames.dropped)}, воркер ${num(w.frames.dropped)}`,
      ]);
    }
    appendReport(['']);
  });
}

async function copyReport() {
  const text = els.report.textContent;
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Отчёт скопирован в буфер обмена.');
  } catch {
    // На http без localhost Clipboard API часто недоступен — выделяем текст,
    // чтобы можно было скопировать вручную (Ctrl/Cmd+C или через меню на телефоне).
    const range = document.createRange();
    range.selectNodeContents(els.report);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    setStatus('Автокопирование недоступно в этом браузере — текст выделен, скопируйте вручную.');
  }
}

function init() {
  els.fileInput = document.getElementById('fileInput');
  els.extraNames = document.getElementById('extraNames');
  els.btnMain = document.getElementById('btnMain');
  els.btnWorker = document.getElementById('btnWorker');
  els.btnBoth = document.getElementById('btnBoth');
  els.btnCopy = document.getElementById('btnCopy');
  els.status = document.getElementById('status');
  els.report = document.getElementById('report');

  els.fileInput.addEventListener('change', () => {
    const chosen = els.fileInput.files.length;
    if (chosen) setStatus(`Выбрано файлов: ${chosen}. Нажмите «И то и другое».`);
  });

  els.btnMain.addEventListener('click', () => void onRunMain());
  els.btnWorker.addEventListener('click', () => void onRunWorker());
  els.btnBoth.addEventListener('click', () => void onRunBoth());
  els.btnCopy.addEventListener('click', () => void copyReport());

  setStatus('Выберите файлы .jsonl (или положите их в папку chats/ рядом со стендом) и нажмите одну из кнопок.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
