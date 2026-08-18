import test from 'node:test';
import assert from 'node:assert/strict';
import {
    phraseTrend, makeAnchor, advanceAnchor, lastMessageIndex,
    MIN_COUNT, MIN_SPAN, AUTO_GAP,
} from '../trend.mjs';

/** Запись оборота — только те поля, которые модуль читает. */
const phrase = (over = {}) => ({
    text: 'холодок пробежал по спине',
    stems: ['холодок', 'пробеж', 'спин'],
    count: 10,
    firstMessage: 10,
    lastMessage: 100,
    ...over,
});

const KEY = 'холодок пробеж спин';

const resultOf = (top, indices) => ({
    top,
    messages: indices.map(index => ({ index, value: 0, words: 100 })),
});

// --- «затих»: считается из полей записи, без всякой истории ------------------

test('оборот, молчащий вдвое дольше собственного шага, помечается затихшим', () => {
    // Десять вхождений с 10-го по 100-е: средний шаг 10 сообщений.
    const item = phrase({ count: 10, firstMessage: 10, lastMessage: 100 });

    // 19 сообщений тишины — меньше двух шагов, молчим.
    assert.equal(phraseTrend(item, { lastIndex: 119 }), null);
    // 20 — ровно порог.
    assert.equal(phraseTrend(item, { lastIndex: 120 })?.kind, 'cooled');
    assert.equal(phraseTrend(item, { lastIndex: 200 })?.silence, 100);
});

test('редкий оборот не считается затихшим от той же паузы, что частый', () => {
    // Три вхождения на 300 сообщений: шаг 150, и 200 тишины — ещё не срок.
    const rare = phrase({ count: 3, firstMessage: 0, lastMessage: 300 });
    assert.equal(phraseTrend(rare, { lastIndex: 500 }), null);
    assert.equal(phraseTrend(rare, { lastIndex: 601 })?.kind, 'cooled');
});

test('по двум вхождениям темпа нет — знака тоже', () => {
    const thin = phrase({ count: MIN_COUNT - 1, firstMessage: 10, lastMessage: 20 });
    assert.equal(phraseTrend(thin, { lastIndex: 500 }), null);
});

test('без номера последнего сообщения знака нет, а не «затих навсегда»', () => {
    assert.equal(phraseTrend(phrase(), { lastIndex: NaN }), null);
    assert.equal(phraseTrend(phrase(), {}), null);
});

// --- сравнение темпа по якорю ------------------------------------------------

const anchorAt = (at, count, reason = 'prompt') => ({ at, reason, counts: { [KEY]: count } });

test('темп упал вдвое и ниже — «реже», и якорь правила говорит об этом прямо', () => {
    // До якоря: 20 вхождений на 100 сообщений — раз в пять.
    // После: 2 на 100 — раз в пятьдесят. Вдесятеро реже.
    const item = phrase({ count: 22, firstMessage: 1, lastMessage: 180 });
    const trend = phraseTrend(item, { lastIndex: 200, anchor: anchorAt(100, 20) });

    assert.equal(trend.kind, 'slower');
    assert.equal(trend.reason, 'prompt');
    assert.equal(trend.before, 20);
    assert.equal(trend.after, 2);
    assert.ok(Math.abs(trend.ratio - 0.1) < 1e-9);
    assert.equal(trend.stopped, false);
});

test('после якоря оборот не встречался ни разу — это отдельный случай', () => {
    const item = phrase({ count: 20, firstMessage: 1, lastMessage: 90 });
    const trend = phraseTrend(item, { lastIndex: 200, anchor: anchorAt(100, 20) });
    assert.equal(trend.kind, 'slower');
    assert.equal(trend.stopped, true);
    assert.equal(trend.ratio, 0);
});

test('темп вырос вдвое и выше — «чаще»: молчать об этом было бы удобно, но нечестно', () => {
    // До: 10 на 100 сообщений. После: 30 на 100.
    const item = phrase({ count: 40, firstMessage: 1, lastMessage: 199 });
    const trend = phraseTrend(item, { lastIndex: 200, anchor: anchorAt(100, 10) });
    assert.equal(trend.kind, 'faster');
    assert.ok(trend.ratio >= 2);
});

test('темп примерно тот же — молчим, а не рисуем знак на каждой строке', () => {
    // До: 10 на 100. После: 9 на 100. Разница есть, наблюдения нет.
    const item = phrase({ count: 19, firstMessage: 1, lastMessage: 199 });
    assert.equal(phraseTrend(item, { lastIndex: 200, anchor: anchorAt(100, 10) }), null);
});

test('оборот, которого в снимке не было, по якорю не судится', () => {
    // Завёлся после якоря: «до» у него нет, и рост из ничего — не рост.
    const item = phrase({ count: 8, firstMessage: 120, lastMessage: 190 });
    const anchor = { at: 100, reason: 'prompt', counts: { 'друг оборот': 5 } };
    // Ответ может прийти только от `cooled`, а он на этих числах молчит.
    assert.equal(phraseTrend(item, { lastIndex: 200, anchor }), null);
});

test('узкое окно по любую сторону якоря — сравнивать рано', () => {
    const item = phrase({ count: 22, firstMessage: 1, lastMessage: 100 });
    // «После» короче MIN_SPAN.
    const early = phraseTrend(item, { lastIndex: 100 + MIN_SPAN - 1, anchor: anchorAt(100, 20) });
    assert.notEqual(early?.kind, 'slower');

    // «До» короче MIN_SPAN: оборот завёлся прямо перед якорем.
    const fresh = phrase({ count: 22, firstMessage: 95, lastMessage: 300 });
    const trend = phraseTrend(fresh, { lastIndex: 400, anchor: anchorAt(100, 20) });
    assert.notEqual(trend?.kind, 'slower');
});

test('окно «до» считается от первого вхождения, а не от начала чата', () => {
    // Оборот появился на 900-м сообщении и до якоря шёл часто: 20 раз за 100
    // сообщений. После якоря — 2 за 100. Если бы знаменатель брался от начала
    // чата, прежний темп вышел бы вдесятеро ниже и падение стало бы «ростом».
    const item = phrase({ count: 22, firstMessage: 900, lastMessage: 1080 });
    const trend = phraseTrend(item, { lastIndex: 1100, anchor: anchorAt(1000, 20) });
    assert.equal(trend.kind, 'slower');
    assert.equal(trend.spanBefore, 101);
});

test('сравнение по якорю сильнее «затих»: оба верны, показывается точное', () => {
    const item = phrase({ count: 20, firstMessage: 1, lastMessage: 90 });
    const trend = phraseTrend(item, { lastIndex: 300, anchor: anchorAt(100, 20) });
    assert.equal(trend.kind, 'slower');
});

// --- якорь -------------------------------------------------------------------

test('снимок берёт счётчики топа и номер последнего сообщения', () => {
    const result = resultOf([phrase({ count: 7 })], [0, 5, 40]);
    const anchor = makeAnchor(result, 'prompt');
    assert.equal(anchor.at, 40);
    assert.equal(anchor.reason, 'prompt');
    assert.equal(anchor.counts[KEY], 7);
    assert.equal(lastMessageIndex(result), 40);
});

test('чат без сообщений якоря не даёт', () => {
    assert.equal(makeAnchor({ top: [], messages: [] }), null);
    assert.ok(Number.isNaN(lastMessageIndex({ messages: [] })));
});

test('автоякорь ставится с нуля, потом копит следующий и заступает ступенью', () => {
    const at = n => resultOf([phrase({ count: n })], [0, n]);

    const first = advanceAnchor(null, at(10));
    assert.equal(first.reason, 'auto');
    assert.equal(first.at, 10);
    assert.equal(first.next, undefined);

    // Ещё не отстояли AUTO_GAP — не трогаем.
    assert.equal(advanceAnchor(first, at(10 + AUTO_GAP - 1)), null);

    // Отстояли: следующий якорь начинает копиться, нынешний остаётся на месте.
    const armed = advanceAnchor(first, at(10 + AUTO_GAP));
    assert.equal(armed.at, 10);
    assert.equal(armed.next.at, 10 + AUTO_GAP);

    // И только когда состарился он — заступает. Окно сравнения не схлопывается.
    assert.equal(advanceAnchor(armed, at(10 + AUTO_GAP + 1)), null);
    const moved = advanceAnchor(armed, at(10 + 2 * AUTO_GAP));
    assert.equal(moved.at, 10 + AUTO_GAP);
    assert.equal(moved.next.at, 10 + 2 * AUTO_GAP);
    assert.equal(moved.reason, 'auto');
});

test('якорь правила не двигается никогда — в фиксированной точке весь его смысл', () => {
    const anchor = anchorAt(10, 5, 'prompt');
    const far = resultOf([phrase({ count: 9 })], [0, 10 + 10 * AUTO_GAP]);
    assert.equal(advanceAnchor(anchor, far), null);
});
