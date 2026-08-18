import test from 'node:test';
import assert from 'node:assert/strict';
import { phraseKey, ignoreEntry, splitIgnored, withoutIgnored } from '../ignore.mjs';

const item = (text, stems) => ({ text, stems, count: 3, cvalue: 1 });

test('ключ считается по основам, а не по показанной форме', () => {
    const a = item('по спине пробежал холодок', ['спин', 'пробеж', 'холодок']);
    const b = item('по спине пробежала дрожь', ['спин', 'пробеж', 'холодок']);

    // Разные живые формы одного оборота обязаны скрываться вместе: иначе завтра
    // тот же оборот всплывёт в другом падеже, и человек решит, что скрытие не работает.
    assert.equal(phraseKey(a), phraseKey(b));
});

test('без основ ключ берётся из строки и не зависит от регистра', () => {
    assert.equal(phraseKey({ text: 'Уголки Губ' }), phraseKey({ text: 'уголки губ ' }));
});

test('в запись игнора попадает и ключ, и то, что показать', () => {
    const entry = ignoreEntry(item('уголки губ дрогнули', ['уголк', 'губ', 'дрогнул']));

    assert.equal(entry.key, 'уголк губ дрогнул');
    assert.equal(entry.text, 'уголки губ дрогнули');
});

test('скрытое не выбрасывается, а откладывается отдельно', () => {
    const result = {
        top: [
            item('первый оборот', ['перв', 'оборот']),
            item('второй оборот', ['втор', 'оборот']),
        ],
    };

    const { top, hidden } = splitIgnored(result, ['втор оборот']);

    assert.equal(top.length, 1);
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0].text, 'второй оборот');
});

test('исходный итог не меняется — по нему считает кеш и карточка', () => {
    const original = { top: [item('оборот', ['оборот'])], stats: { words: 10 } };
    const shown = withoutIgnored(original, ['оборот']);

    assert.equal(original.top.length, 1, 'исходный топ тронут');
    assert.equal(shown.top.length, 0);
    assert.equal(shown.stats, original.stats, 'всё, кроме топа, должно остаться тем же объектом');
});

test('пустой игнор-лист не заставляет копировать итог', () => {
    const original = { top: [item('оборот', ['оборот'])] };

    assert.equal(withoutIgnored(original, []), original);
});
