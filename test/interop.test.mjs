import test from 'node:test';
import assert from 'node:assert/strict';
import { toSlopList, toSlopListJson } from '../interop/prosepolisher.mjs';

const result = {
    top: [
        { text: 'по спине пробежал холодок', count: 12, cvalue: 9.44 },
        { text: 'в воздухе повисла тишина', count: 8, cvalue: 7.06 },
    ],
};

test('формат ровно тот, что читает сосед: phrase, score, type', () => {
    const list = toSlopList(result);

    assert.deepEqual(Object.keys(list[0]).sort(), ['phrase', 'score', 'type']);
    assert.equal(list[0].phrase, 'по спине пробежал холодок');
    assert.equal(list[0].type, 'phrase');
});

test('вес — C-value, а не частота', () => {
    // Частота без поправки на вложенность подняла бы наверх куски длинных
    // оборотов, и сосед получил бы «по спине пробежал» вместо целого оборота.
    assert.equal(toSlopList(result)[0].score, 9.4);
    assert.equal(toSlopList(result)[1].score, 7.1);
});

test('порядок сохраняется, лимит соблюдается', () => {
    const list = toSlopList(result, { limit: 1 });

    assert.equal(list.length, 1);
    assert.equal(list[0].phrase, 'по спине пробежал холодок');
});

test('обороты без строки и повторы не уезжают', () => {
    const messy = {
        top: [
            { text: '   ', count: 3, cvalue: 1 },
            { stems: ['спин'], count: 3, cvalue: 1 },
            { text: 'оборот', count: 3, cvalue: 1 },
            { text: 'ОБОРОТ', count: 2, cvalue: 0.5 },
        ],
    };

    assert.deepEqual(toSlopList(messy).map(x => x.phrase), ['оборот']);
});

test('на выходе разбираемый JSON, а не что-то похожее', () => {
    assert.deepEqual(JSON.parse(toSlopListJson(result)), toSlopList(result));
    assert.deepEqual(JSON.parse(toSlopListJson({ top: [] })), []);
});
