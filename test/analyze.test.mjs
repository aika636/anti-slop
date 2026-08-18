import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChat, createAnalysis } from '../core/analyze.mjs';
import { FORMULA_VERSION } from '../core/index.mjs';

// Весь материал — синтетический и живёт прямо здесь. Ядро ничего не знает ни про
// файлы, ни про SillyTavern: на вход приходят уже вытащенные сообщения.

/** Оборот, который обязан всплыть в топе. Четыре слова, все знаменательные. */
const PHRASE = 'По спине пробежал холодок';

/** Инфоблок из тестов strip: разметка, а не проза. */
const MEMO = '<memo><small><div style="background:#2c2c34;padding:8px;font:14px system-ui">'
  + '<div style="color:#f7cac9">Текущая обстановка</div>'
  + '<span style="color:#ffe0b2">Одежда:</span> строгий черный костюм'
  + '</div></small></memo>';

/** Промпт генерации картинки — тоже служебный текст. */
const IMG = '<img src="https://image.pollinations.ai/prompt/'
  + 'retro%2090s%20anime%20cow%20girl?width=1024&height=1024&nologo=true'
  + '&negative_prompt=blurry,text,watermark,ugly" style="width:50px">';

/**
 * Кусок, который потом будет переписан дословно в другое сообщение. Длиннее
 * MIN_WORDS детектора, иначе повторяющее сообщение не станет подозреваемым.
 */
const LONG = 'Она стояла у окна и смотрела, как редкие капли ползут по стеклу вниз, '
  + 'оставляя за собой мутные дорожки, и думала о том, что этот дом никогда не станет '
  + 'по-настоящему тёплым, сколько ни топи печь и сколько ни жги свечей на подоконнике, '
  + 'потому что холод здесь живёт не в стенах, а где-то гораздо глубже.';

// Оборот, идущий ЧЕРЕЗ имя персонажа: «посмотрел на Илью и» в тексте есть,
// оборотом стать не должен — имя рвёт сегмент.
const THROUGH_NAME = 'Он медленно посмотрел на Илью и тихо кивнул.';

const MESSAGES = [
  // 0. Оборот повторён ТРИЖДЫ внутри самого сообщения. Это ключевой случай:
  //    к моменту разбора словарь пуст, и покрытие обязано быть нулевым.
  [
    `${PHRASE}, и он застыл у самого окна.`,
    `${PHRASE}, когда за стеной снова скрипнула тяжёлая дверь.`,
    THROUGH_NAME,
    `${PHRASE}, но он молчал и продолжал смотреть в темноту двора.`,
    MEMO,
  ].join('\n'),

  // 1. Тот же оборот в новом окружении — покрытие уже не ноль.
  [
    'Вечер тянулся медленно, лампа над столом гудела и мигала.',
    `${PHRASE}, ветер задувал в раскрытое окно.`,
    THROUGH_NAME,
    'Где-то внизу хлопнула калитка, и всё опять затихло.',
    MEMO,
  ].join('\n'),

  // 2. И ещё раз, чтобы оборот прошёл порог «в двух разных сообщениях».
  [
    'Утро выдалось серым, дождь стучал по жестяному подоконнику.',
    `${PHRASE}, хотя в комнате было душно.`,
    THROUGH_NAME,
    IMG,
    MEMO,
  ].join('\n'),

  // 3. Длинный кусок, который потом перепишут дословно.
  `Дверь закрылась. ${LONG} Он ничего не ответил на это.`,

  // 4. Короткая реплика.
  [
    'Прошло три дня, и снег наконец лёг на крыши плотным слоем.',
    `${PHRASE}, когда он вспомнил тот разговор.`,
  ].join('\n'),

  // 5. Дословный повтор куска из сообщения 3.
  `Он вернулся под вечер. ${LONG} Больше сказать было нечего.`,
];

/** Свежий чат на каждый тест: анализ ничего не должен уносить между вызовами. */
const makeChat = () => ({
  characterName: 'Илья',
  userName: 'Рената',
  messages: MESSAGES.map(mes => ({ name: 'Илья', mes })),
});

const texts = result => result.top.map(t => t.text);

test('сквозной проход возвращает все обещанные поля', () => {
  const r = analyzeChat(makeChat());

  for (const key of ['top', 'messages', 'findings', 'diversity', 'index', 'stats']) {
    assert.ok(key in r, `нет поля ${key}`);
  }
  assert.ok(Array.isArray(r.top));
  assert.ok(Array.isArray(r.findings));
  assert.equal(r.messages.length, MESSAGES.length);

  for (const m of r.messages) {
    assert.equal(typeof m.index, 'number');
    assert.equal(m.name, 'Илья');
    assert.ok(m.words > 0, `сообщение ${m.index} осталось без слов`);
    assert.ok(m.coverage >= 0 && m.coverage <= 1);
    assert.ok(m.value >= 0 && m.value <= 100);
    assert.equal(m.slop.version, FORMULA_VERSION);
    assert.equal(m.diversity.words, m.words);
  }

  assert.ok(r.diversity.words > 0);
  assert.equal(r.index.messages, MESSAGES.length);
  assert.equal(r.index.version, FORMULA_VERSION);
  assert.equal(r.stats.mode, 'map');
  assert.deepEqual(r.stats.names.sort(), ['Илья', 'Рената']);
});

test('сообщение не считается повторяющим само себя', () => {
  // Инвариант ядра: покрытие считается ПРОТИВ словаря на момент ДО
  // добавления сообщения. В первом сообщении оборот повторён трижды внутри себя
  // же — и всё равно покрытие обязано быть ровно нулевым.
  const r = analyzeChat(makeChat());

  assert.equal(r.messages[0].coverage, 0,
    'первое сообщение оказалось повторяющим само себя');

  // А дальше тот же оборот уже известен, и покрытие ненулевое.
  assert.ok(r.messages[1].coverage > 0, `покрытие второго: ${r.messages[1].coverage}`);
  assert.ok(r.messages[2].coverage > 0, `покрытие третьего: ${r.messages[2].coverage}`);
  assert.ok(r.messages[4].coverage > 0, `покрытие пятого: ${r.messages[4].coverage}`);

  // Сообщение 3 — новый текст, ничего из прежнего в нём нет.
  assert.equal(r.messages[3].coverage, 0);
  // Сообщение 5 переписывает его дословно — покрытие высокое.
  assert.ok(r.messages[5].coverage > 0.5, `покрытие шестого: ${r.messages[5].coverage}`);
});

test('порядок «покрытие → сравнение → добавление» не зависит от длины сообщения', () => {
  // Если бы сообщение попадало в словарь до подсчёта покрытия, длинный текст
  // накрывал бы сам себя тем сильнее, чем он длиннее. Проверяем на чате из
  // одного-единственного сообщения: накрывать его нечем.
  const solo = analyzeChat({ messages: [{ name: 'Илья', mes: MESSAGES[0] }] });
  assert.equal(solo.messages[0].coverage, 0);

  const longSolo = analyzeChat({
    messages: [{ name: 'Илья', mes: [MESSAGES[0], MESSAGES[0], MESSAGES[0]].join('\n') }],
  });
  assert.equal(longSolo.messages[0].coverage, 0,
    'втрое более длинное сообщение накрыло само себя');
});

test('повторённый оборот попадает в топ живой словоформой', () => {
  const r = analyzeChat(makeChat());

  const found = r.top.find(t => t.text === 'по спине пробежал холодок');
  assert.ok(found, `оборота нет в топе: ${JSON.stringify(texts(r))}`);
  assert.equal(found.n, 4);
  assert.equal(found.count, 6, 'три вхождения в первом сообщении и по одному в трёх других');
  assert.equal(found.firstMessage, 0);
  assert.equal(found.lastMessage, 4);
  assert.ok(found.cvalue > 0);

  // Пользователю показывается форма, а не внутренний ключ основы.
  assert.match(found.text, /пробежал/, 'в топе основа вместо словоформы');
  assert.equal(found.stems.length, 4);
  assert.notEqual(found.stems.join(' '), found.text,
    'основы совпали с формами — тест ничего не проверяет');
  for (const t of r.top) {
    assert.equal(typeof t.text, 'string');
    assert.ok(t.text.length > 0, `оборот без восстановленной строки: ${t.stems}`);
  }
});

test('имя персонажа рвёт оборот, и через имя он в топ не попадает', () => {
  const r = analyzeChat(makeChat());

  // «посмотрел на Илью и тихо кивнул» стоит в трёх сообщениях дословно, но
  // сквозного оборота из него не получается: имя обрывает сегмент.
  for (const t of texts(r)) {
    assert.doesNotMatch(t, /иль/, `оборот прошёл через имя: «${t}»`);
  }
  for (const t of r.top) {
    assert.ok(!t.stems.some(s => 'илья'.startsWith(s) && s.length >= 2),
      `основа имени в обороте: ${t.stems.join(' ')}`);
  }

  // При этом куски по обе стороны имени сами по себе оборотами остаются —
  // барьер режет текст, а не выбрасывает его.
  assert.ok(texts(r).some(t => t.includes('посмотрел на')), JSON.stringify(texts(r)));
  assert.ok(texts(r).some(t => t.includes('тихо кивнул')), JSON.stringify(texts(r)));
});

test('имя из карточки отсекается, даже если его нет в поле name', () => {
  // Экспорты, где имя карточки латиницей или «unused»:
  // имя приходится передавать отдельно.
  const chat = {
    characterName: 'unused',
    messages: MESSAGES.map(mes => ({ name: 'unused', mes })),
  };

  const without = analyzeChat(chat);
  assert.ok(texts(without).some(t => /иль/.test(t)),
    'без имени оборот через имя обязан появиться — иначе тест ничего не ловит');

  const withName = analyzeChat(chat, { extraNames: ['Илья'] });
  for (const t of texts(withName)) {
    assert.doesNotMatch(t, /иль/, `extraNames не сработал: «${t}»`);
  }
  assert.ok(withName.stats.names.includes('Илья'));
  assert.ok(!withName.stats.names.includes('unused'));
});

test('служебный текст не доходит до топа', () => {
  // Инфоблок стоит дословно в трёх сообщениях подряд — по частоте он был бы
  // первым в списке. Его не должно быть там вовсе.
  const r = analyzeChat(makeChat());

  for (const t of texts(r)) {
    assert.doesNotMatch(t, /обстановка|одежда|костюм/, `инфоблок в топе: «${t}»`);
    assert.doesNotMatch(t, /pollinations|prompt|nologo|watermark|width|style/,
      `промпт картинки в топе: «${t}»`);
  }

  // И он честно посчитан выброшенным, а не молча потерян.
  assert.equal(r.stats.droppedBlocks, 3, 'выброшенные блоки не сосчитаны');
  assert.ok(r.messages[0].dropped.blocks > 0);
  assert.ok(r.messages[0].dropped.share > 0);
  assert.equal(r.messages[3].dropped.total, 0, 'чистая проза не должна ничего терять');
});

test('дословно переписанный кусок попадает в findings с правильным партнёром', () => {
  const r = analyzeChat(makeChat());

  assert.equal(r.findings.length, 1, JSON.stringify(r.findings));
  const [f] = r.findings;
  assert.equal(f.index, 5, 'находкой должно быть сообщение, которое повторяет');
  assert.equal(f.partner, 3, 'партнёром — то, откуда повторили');
  assert.ok(f.containment > 0.5, `вложенность ${f.containment}`);

  // Длина дословного куска считается по живым формам и соответствует LONG.
  const longWords = LONG.match(/\p{L}[\p{L}\p{M}-]*/gu).length;
  assert.ok(f.runLength >= longWords - 4,
    `дословный кусок ${f.runLength} слов, а переписано ${longWords}`);
  assert.ok(f.startA >= 0 && f.startB >= 0);

  // Похожесть попала и в индекс повторяющего сообщения.
  assert.ok(r.messages[5].repeat, 'у сообщения нет лучшего партнёра');
  assert.equal(r.messages[5].repeat.index, 3);
  assert.ok(r.messages[5].slop.parts.similarity > 0);

  assert.ok(r.baseline.pairs > 0);
});

test('пустой и вырожденный чат не роняют конвейер', () => {
  const empty = analyzeChat({ messages: [] });
  assert.deepEqual(empty.top, []);
  assert.deepEqual(empty.messages, []);
  assert.deepEqual(empty.findings, []);
  assert.equal(empty.index.value, 0);
  assert.equal(empty.diversity.words, 0);
  assert.equal(empty.stats.words, 0);

  // Сообщение из одной разметки: прозы нет, но и падения нет.
  const junk = analyzeChat({ messages: [{ name: 'Илья', mes: MEMO }] });
  assert.equal(junk.messages[0].words, 0);
  assert.equal(junk.messages[0].coverage, 0);
  assert.equal(junk.messages[0].value, 0);
});

test('topLimit обрезает выдачу, не меняя порядок', () => {
  const full = analyzeChat(makeChat());
  const cut = analyzeChat(makeChat(), { topLimit: 2 });
  assert.equal(cut.top.length, 2);
  assert.deepEqual(texts(cut), texts(full).slice(0, 2));
});

test('анализ детерминирован: два прогона одного чата совпадают', () => {
  const a = analyzeChat(makeChat());
  const b = analyzeChat(makeChat());
  assert.deepEqual(texts(a), texts(b));
  assert.deepEqual(a.messages.map(m => m.value), b.messages.map(m => m.value));
  assert.deepEqual(a.findings, b.findings);
  assert.equal(a.index.value, b.index.value);
});

test('индекс чата собран из индексов сообщений', () => {
  const r = analyzeChat(makeChat());
  const words = r.messages.reduce((s, m) => s + Math.max(1, m.words), 0);
  const weighted = r.messages.reduce((s, m) => s + m.value * Math.max(1, m.words), 0);
  assert.equal(r.index.value, Math.round(weighted / words));
  assert.equal(r.index.words, words);
  assert.equal(r.index.draft, true, 'на таком объёме индекс обязан быть черновым');
});

// --- сессия -----------------------------------------------------------------
// Сессия — то же ядро, растянутое во времени: расширение досчитывает пришедший
// ответ, а не гоняет заново весь чат. Проверяем ровно это: что «по одному» даёт
// тот же результат, что «разом», и что номера сообщений могут быть не подряд.

test('сессия по одному сообщению совпадает с разовым проходом', () => {
  const chat = makeChat();
  const once = analyzeChat(chat);

  const session = createAnalysis({
    names: ['Илья', 'Рената'],
    readText: i => chat.messages[i]?.mes,
  });
  chat.messages.forEach((m, i) => session.push({ index: i, name: m.name, mes: m.mes }));
  const step = session.result();

  assert.deepEqual(texts(step), texts(once));
  assert.deepEqual(step.messages.map(m => m.value), once.messages.map(m => m.value));
  assert.deepEqual(step.findings, once.findings);
  assert.equal(step.index.value, once.index.value);
  assert.equal(step.stats.words, once.stats.words);
});

test('итог сессии можно снимать посреди чата, не ломая продолжение', () => {
  const chat = makeChat();
  const session = createAnalysis({
    names: ['Илья', 'Рената'],
    readText: i => chat.messages[i]?.mes,
  });

  chat.messages.slice(0, 3).forEach((m, i) => session.push({ index: i, name: m.name, mes: m.mes }));
  const half = session.result();
  assert.equal(half.messages.length, 3);

  // Снятый посреди итог не должен ничего сдвинуть: продолжаем и сверяем с разовым.
  chat.messages.slice(3).forEach((m, i) => session.push({ index: i + 3, name: m.name, mes: m.mes }));
  const full = session.result();
  assert.deepEqual(texts(full), texts(analyzeChat(chat)));
  assert.equal(session.size, chat.messages.length);
  assert.equal(session.lastIndex, chat.messages.length - 1);
});

test('номера сообщений не обязаны идти подряд', () => {
  // В таверне между ответами модели стоят реплики пользователя, и их номера
  // выпадают. Восстановление строк ходит по диапазону номеров — на дырах оно
  // обязано просто ничего не находить, а не падать.
  const chat = makeChat();
  const byMesId = new Map(chat.messages.map((m, i) => [i * 2 + 1, m.mes]));

  const session = createAnalysis({
    names: ['Илья', 'Рената'],
    readText: i => byMesId.get(i) ?? null,
  });
  for (const [mesid, mes] of byMesId) session.push({ index: mesid, name: 'Илья', mes });

  const r = session.result();
  assert.deepEqual(texts(r), texts(analyzeChat(chat)));
  assert.equal(r.messages[0].index, 1);
  assert.equal(r.top[0].firstMessage % 2, 1, 'номера должны остаться теми, что дали снаружи');
});
