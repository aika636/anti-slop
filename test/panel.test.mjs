// Панель целиком без браузера не проверяется — она рисует. Проверяется то, что
// в ней считается: окно последних ответов.

import test from 'node:test';
import assert from 'node:assert/strict';

import { recentIndex, RECENT_WINDOW } from '../ui/panel.js';

/** Ответы с заданными индексами; длина у всех одинаковая, если не сказано иное. */
const msgs = (values, words = 100) => values.map((value, i) => ({ index: i, value, words }));

test('окно не показывается, пока не набралось', () => {
    assert.equal(recentIndex([]), null);
    assert.equal(recentIndex(msgs(new Array(RECENT_WINDOW - 1).fill(10))), null);
    assert.notEqual(recentIndex(msgs(new Array(RECENT_WINDOW).fill(10))), null);
});

test('считается по последним ответам, а не по всему чату', () => {
    // Длинная спокойная история и двадцать шумных ответов в конце: общий индекс
    // такого чата держится у нуля, окно обязано показать сорок.
    const chat = msgs([...new Array(200).fill(0), ...new Array(RECENT_WINDOW).fill(40)]);
    assert.equal(recentIndex(chat).value, 40);
});

test('отличие считается от предыдущего окна, а не от начала чата', () => {
    const chat = msgs([
        ...new Array(50).fill(90),
        ...new Array(RECENT_WINDOW).fill(10),
        ...new Array(RECENT_WINDOW).fill(30),
    ]);
    const got = recentIndex(chat);
    assert.equal(got.value, 30);
    assert.equal(got.delta, 20);
});

test('предыдущее окно неполное — сравнивать не с чем', () => {
    const chat = msgs(new Array(RECENT_WINDOW + 5).fill(10));
    assert.equal(recentIndex(chat).delta, null);
});

test('окно взвешено по словам так же, как общий индекс', () => {
    // Девятнадцать коротких реплик по десять слов и один ход на тысячу: простое
    // среднее дало бы 15, взвешенное — почти целиком вес длинного хода.
    const chat = [
        ...new Array(RECENT_WINDOW - 1).fill(0).map((_, i) => ({ index: i, value: 10, words: 10 })),
        { index: RECENT_WINDOW - 1, value: 100, words: 1000 },
    ];
    assert.equal(recentIndex(chat).value, 86);
});

test('ответы без прозы в окно не входят вовсе', () => {
    // Инфоблок каждый ход: записей сорок, ответов с прозой двадцать. Окно обязано
    // набраться из них, а не оборваться на середине.
    const chat = [];
    for (let i = 0; i < 2 * RECENT_WINDOW; i++) {
        chat.push(i % 2 === 0
            ? { index: i, value: 0, words: 0 }
            : { index: i, value: 50, words: 100 });
    }
    const got = recentIndex(chat);
    assert.equal(got.value, 50);
    assert.equal(got.delta, null); // предыдущих двадцати с прозой в чате нет
});
