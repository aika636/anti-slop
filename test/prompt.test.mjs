import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPrompt, buildList, pickPhrases, fillTemplate, defaultTemplate,
    promptParts, promptHits, FRESH_SPAN, ROTATE_SLOTS, ROTATE_EVERY, ROTATE_POOL,
} from '../prompt.mjs';

const result = {
    top: [
        { text: 'по спине пробежал холодок', stems: ['спин', 'пробеж', 'холодок'], count: 12, cvalue: 9.4 },
        { text: 'в воздухе повисла тишина', stems: ['воздух', 'повисл', 'тишин'], count: 8, cvalue: 7.1 },
        { text: 'уголки губ дрогнули', stems: ['уголк', 'губ', 'дрогнул'], count: 5, cvalue: 4.2 },
    ],
};

test('правило несёт обороты живыми формами, а не основами', () => {
    const text = buildPrompt(result, { limit: 2 });

    assert.match(text, /по спине пробежал холодок/);
    assert.match(text, /в воздухе повисла тишина/);
    // Третий за пределом лимита.
    assert.doesNotMatch(text, /уголки губ/);
    // Основа в правиле выглядит как опечатка и учит модель не тому.
    assert.doesNotMatch(text, /пробеж[^а]/);
});

test('подстановок три, и каждая на своём месте', () => {
    const phrases = pickPhrases(result.top, 3);
    const filled = fillTemplate('{{count}}|{{phrases}}|{{list}}', phrases);
    const [count, inline, list] = filled.split('|');

    assert.equal(count, '3');
    assert.equal(inline, 'по спине пробежал холодок, в воздухе повисла тишина, уголки губ дрогнули');
    assert.equal(list.split('\n').length, 3);
    assert.ok(list.startsWith('- по спине'));
});

test('без оборотов вставлять нечего — пустая строка, а не шаблон с дырой', () => {
    assert.equal(buildPrompt({ top: [] }), '');
    assert.equal(buildPrompt(null), '');
    // Шаблон с пустым списком был бы хуже отсутствия правила: модель получила бы
    // указание сверяться с пустотой.
    assert.equal(fillTemplate('обороты: {{phrases}}', []), '');
});

test('обороты не повторяются, даже если топ отдал их дважды', () => {
    const twice = { top: [...result.top, { text: 'По спине пробежал холодок', count: 3, cvalue: 1 }] };
    const picked = pickPhrases(twice.top, 10);

    assert.equal(picked.length, 3);
});

test('оборот без восстановленной строки в правило не попадает', () => {
    const broken = { top: [{ stems: ['спин', 'холодок'], count: 4, cvalue: 2 }, ...result.top] };

    assert.equal(pickPhrases(broken.top, 10).length, 3);
});

test('шаблон по умолчанию есть на обоих языках и оба несут подстановку', () => {
    for (const locale of ['ru', 'en']) {
        for (const format of ['rule', 'list']) {
            assert.match(defaultTemplate(format, locale), /\{\{phrases\}\}/);
        }
    }
    // Незнакомый язык откатывается на исходный русский, а не на пустоту.
    assert.equal(defaultTemplate('rule', 'de'), defaultTemplate('rule', 'ru'));
});

test('голый список — только строки, без обёртки', () => {
    const list = buildList(result, 2).split('\n');

    assert.deepEqual(list, ['по спине пробежал холодок', 'в воздухе повисла тишина']);
});

test('свой шаблон побеждает умолчание', () => {
    const text = buildPrompt(result, { template: 'СВОЁ: {{phrases}}', limit: 1 });

    assert.equal(text, 'СВОЁ: по спине пробежал холодок');
});

// --- отбор по темпу, свежести и ротация -------------------------------------

/** Оборот с заданным весом и последним вхождением. */
const phrase = (text, cvalue, lastMessage) => ({ text, count: 5, cvalue, lastMessage });

test('затихший оборот в правило не кладётся, а его место отдаётся следующему', () => {
    const top = [phrase('первый', 9), phrase('второй', 8), phrase('третий', 7)];
    const quiet = item => (item.text === 'первый' ? { kind: 'cooled', stopped: false } : null);

    const picked = pickPhrases(top, 2, { trend: quiet });

    // Место не пропадает — иначе правило худело бы на каждом затихшем обороте.
    assert.deepEqual(picked.map(p => p.text), ['второй', 'третий']);
});

test('«стало реже», но оборот идёт — в правиле ему место', () => {
    const top = [phrase('первый', 9), phrase('второй', 8)];
    const slower = () => ({ kind: 'slower', stopped: false, ratio: 0.4 });
    const stopped = () => ({ kind: 'slower', stopped: true, ratio: 0 });

    assert.equal(pickPhrases(top, 2, { trend: slower }).length, 2);
    assert.equal(pickPhrases(top, 2, { trend: stopped }).length, 0);
});

test('свежий оборот идёт вперёд тяжёлого, но давнего', () => {
    const lastIndex = 200;
    const top = [
        phrase('чемпион начала чата', 9.9, 10),
        phrase('идёт прямо сейчас', 2.1, lastIndex - 1),
        phrase('тоже давний', 9.5, 20),
    ];

    const picked = pickPhrases(top, 3, { lastIndex });
    assert.equal(picked[0].text, 'идёт прямо сейчас');
    // Внутри групп порядок остаётся по C-value, а не перемешивается.
    assert.deepEqual(picked.slice(1).map(p => p.text), ['чемпион начала чата', 'тоже давний']);

    // На границе окна оборот ещё считается свежим, за ней — уже нет.
    assert.equal(pickPhrases([phrase('на границе', 1, lastIndex - FRESH_SPAN), phrase('давний', 9, 0)],
        2, { lastIndex })[0].text, 'на границе');
});

test('без номера последнего сообщения порядок остаётся прежним', () => {
    const top = [phrase('первый', 9, 10), phrase('второй', 8, 999)];

    assert.deepEqual(pickPhrases(top, 2).map(p => p.text), ['первый', 'второй']);
});

const many = n => Array.from({ length: n }, (_, i) => phrase('оборот ' + i, 100 - i, 500));

test('ротация меняет хвост, но не голову — и не каждый ход', () => {
    const top = many(ROTATE_POOL);
    const limit = 8;
    const at = step => pickPhrases(top, limit, { lastIndex: step, rotate: true }).map(p => p.text);

    const head = at(0).slice(0, limit - ROTATE_SLOTS);
    assert.deepEqual(at(ROTATE_EVERY).slice(0, limit - ROTATE_SLOTS), head);

    // Внутри одного шага список не шевелится: меняющийся префикс обнуляет кеш
    // промпта на стороне API, и делать это каждым запросом нельзя.
    assert.deepEqual(at(0), at(ROTATE_EVERY - 1));
    assert.notDeepEqual(at(0).slice(-ROTATE_SLOTS), at(ROTATE_EVERY).slice(-ROTATE_SLOTS));

    // Длина не плавает: сколько попросили, столько и отдали.
    assert.equal(at(ROTATE_EVERY * 3).length, limit);
});

test('ротация обходит весь пул и возвращается', () => {
    const top = many(ROTATE_POOL);
    const limit = 8;
    const pool = ROTATE_POOL - (limit - ROTATE_SLOTS);
    const tail = step => pickPhrases(top, limit, { lastIndex: step * ROTATE_EVERY, rotate: true })
        .slice(-ROTATE_SLOTS).map(p => p.text);

    const seen = new Set();
    for (let step = 0; step < pool; step++) for (const text of tail(step)) seen.add(text);
    assert.equal(seen.size, pool);
    // Круг замкнулся: шаг, кратный длине пула, повторяет нулевой.
    assert.deepEqual(tail(pool), tail(0));
});

test('ротировать нечего — отдаётся простая верхушка', () => {
    // Оборотов ровно на лимит: подмешивать неоткуда, и хвост не должен
    // повторять голову.
    const top = many(8);
    const picked = pickPhrases(top, 8, { lastIndex: 100, rotate: true });

    assert.equal(new Set(picked.map(p => p.text)).size, 8);
});

test('голый список ничего не фильтрует и не ротирует', () => {
    // Там не промпт, а данные: человек копирует их в чужое поле и ждёт полный
    // список в том же порядке, что в панели.
    const top = [phrase('первый', 9, 0), phrase('второй', 8, 100)];

    assert.deepEqual(buildList({ top }, 2).split('\n'), ['первый', 'второй']);
});

test('попадание считается по тому же списку, что уехал в промпт', () => {
    const lastIndex = 100;
    const top = [phrase('идёт', 9, 95), phrase('давний', 8, 5), phrase('тоже идёт', 7, 80)];
    const parts = promptParts({ top }, { limit: 3, lastIndex });

    const hits = promptHits(parts.phrases, { lastIndex, span: FRESH_SPAN });
    assert.deepEqual(hits, { hits: 2, total: 3, span: FRESH_SPAN });

    // Считать не из чего — молчим, а не показываем ноль из нуля.
    assert.equal(promptHits([], { lastIndex }), null);
    assert.equal(promptHits(parts.phrases, {}), null);
});
