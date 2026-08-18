import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoCount, AUTO_EVERY_DEFAULT } from '../auto.mjs';

/** Чат посчитан, сессия жива, ничего не менялось — состояние покоя. */
const CALM = {
    enabled: true,
    every: 5,
    since: 100,
    chatOpen: true,
    busy: false,
    hasSession: true,
    hasResult: true,
    dirty: false,
};

const at = patch => ({ ...CALM, ...patch });

test('выключенная настройка не считает ничего и никогда', () => {
    assert.equal(shouldAutoCount(at({ enabled: false, dirty: true, hasSession: false })), false);
});

test('живая сессия полного прохода не требует: ответ досчитается сам', () => {
    assert.equal(shouldAutoCount(CALM), false);
});

test('непосчитанный чат считается сразу, ждать нечего', () => {
    assert.equal(shouldAutoCount(at({ hasSession: false, hasResult: false, since: Infinity })), true);
});

test('итог из кеша прохода не стоит: числа верные, сессии просто нет', () => {
    // Открытие длинного чата не должно стоить секунды работы за уже известные
    // числа. Проход оправдается, когда первый новый ответ пометит их устаревшими.
    assert.equal(shouldAutoCount(at({ hasSession: false, hasResult: true, since: Infinity })), false);
});

test('устаревшие после правки числа догоняются сами', () => {
    assert.equal(shouldAutoCount(at({ dirty: true, hasSession: false, since: 5 })), true);
});

test('дроссель держит: пока ответов прошло меньше, второго прохода не будет', () => {
    assert.equal(shouldAutoCount(at({ dirty: true, hasSession: false, since: 4 })), false);
    assert.equal(shouldAutoCount(at({ dirty: true, hasSession: false, since: 5 })), true);
});

test('пока идёт подсчёт, второй не запускается', () => {
    assert.equal(shouldAutoCount(at({ busy: true, dirty: true, hasSession: false })), false);
});

test('без открытого чата считать нечего', () => {
    assert.equal(shouldAutoCount(at({ chatOpen: false, dirty: true, hasSession: false })), false);
});

test('битое или отсутствующее число дросселя откатывается на умолчание', () => {
    const broken = { dirty: true, hasSession: false, hasResult: false };
    assert.equal(shouldAutoCount(at({ ...broken, every: 0, since: AUTO_EVERY_DEFAULT - 1 })), false);
    assert.equal(shouldAutoCount(at({ ...broken, every: null, since: AUTO_EVERY_DEFAULT })), true);
});

test('пустой снимок не роняет и не считает', () => {
    assert.equal(shouldAutoCount(undefined), false);
});
