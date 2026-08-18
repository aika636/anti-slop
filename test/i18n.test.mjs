import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, getLocale, t, plural, formatNumber, formatPercent, formatTimes, LOCALES, TABLES } from '../i18n/index.mjs';

test('язык берётся из чего угодно, что отдают браузер и таверна', () => {
    assert.equal(setLocale('ru-RU'), 'ru');
    assert.equal(setLocale('ru_ru'), 'ru');
    assert.equal(setLocale('en-US'), 'en');
    // Незнакомый язык — английский: незнакомая кириллица понятнее не станет.
    assert.equal(setLocale('de-DE'), 'en');
    assert.equal(setLocale(null), 'en');
    assert.equal(getLocale(), 'en');
});

test('подстановки заполняются, лишние фигурные скобки остаются на месте', () => {
    setLocale('ru');
    assert.equal(t('top.jump', { n: 42 }), 'Перейти к сообщению 42');
    // Неизвестное имя не должно вычищаться: пропавшая подстановка — это ошибка,
    // и она обязана быть видна.
    assert.match(t('status.leaked', {}), /\{name\}/);
});

test('незнакомый ключ виден в интерфейсе, а не превращается в пустоту', () => {
    assert.equal(t('нет.такого.ключа'), 'нет.такого.ключа');
});

test('русские формы множественного числа', () => {
    setLocale('ru');
    assert.equal(plural(1, 'word.answer'), 'ответ');
    assert.equal(plural(2, 'word.answer'), 'ответа');
    assert.equal(plural(5, 'word.answer'), 'ответов');
    assert.equal(plural(11, 'word.answer'), 'ответов');
    assert.equal(plural(21, 'word.answer'), 'ответ');
    assert.equal(plural(112, 'word.answer'), 'ответов');
});

test('английские формы — две', () => {
    setLocale('en');
    assert.equal(plural(1, 'word.answer'), 'reply');
    assert.equal(plural(2, 'word.answer'), 'replies');
    assert.equal(plural(0, 'word.answer'), 'replies');
});

test('ни один ключ не потерян при переводе', () => {
    const ru = Object.keys(TABLES.ru);
    const en = Object.keys(TABLES.en);

    assert.deepEqual(ru.filter(k => !TABLES.en[k]), [], 'нет английского перевода');
    assert.deepEqual(en.filter(k => !TABLES.ru[k]), [], 'нет русского оригинала');
});

test('все ключи, которые зовёт интерфейс, в таблицах есть', () => {
    // Список написан руками намеренно: сверка таблицы с самой собой не поймает
    // ключ, который зовут из панели, но не завели ни в одном языке.
    assert.deepEqual(KEYS.filter(k => !TABLES.ru[k]), []);
});

test('формы множественного числа — массивы нужной длины', () => {
    for (const key of ['word.answer', 'word.word', 'word.phrase']) {
        assert.equal(TABLES.ru[key].length, 3, key);
        assert.equal(TABLES.en[key].length, 2, key);
    }
});

test('числа форматируются по языку', () => {
    setLocale('en');
    assert.equal(formatNumber(1234), '1,234');
    assert.equal(formatNumber(NaN), '—');
    assert.equal(formatPercent(0.867), '87%');
    assert.equal(formatPercent(undefined), '—');
});

test('«во сколько раз» — с дробью, пока она что-то значит', () => {
    setLocale('ru');
    // Полтора округлились бы до двух, а это ровно граница между «показалось» и
    // «правда стало реже».
    assert.equal(formatTimes(1.5), '1,5');
    assert.equal(formatTimes(12.4), '12');
    assert.equal(formatTimes(Infinity), '—');
    assert.equal(formatTimes(0), '—');

    setLocale('en');
    assert.equal(formatTimes(1.5), '1.5');
});

test('языков ровно два, и русский первый', () => {
    assert.deepEqual(LOCALES, ['ru', 'en']);
});

/**
 * Список ключей, которые обязаны быть на обоих языках. Пишется руками намеренно:
 * сверка таблицы с самой собой ничего не проверяет, а этот список ломается ровно
 * тогда, когда строку добавили в один язык и забыли во втором.
 */
const KEYS = [
    'panel.title', 'panel.subtitle', 'panel.analyze',
    'status.noChat', 'status.reading', 'status.counting', 'status.countingN', 'status.dirty',
    'status.cache', 'status.noMessages', 'status.failed', 'status.leaked', 'status.fallback',
    'status.progress',
    'word.answer', 'word.word', 'word.phrase',
    'tile.index', 'tile.indexDraft', 'tile.index.hint', 'tile.indexDraft.hint',
    'tile.diversity', 'tile.diversity.hint', 'tile.words', 'tile.words.hint', 'tile.messages',
    'top.title', 'top.preliminary', 'top.empty', 'top.allHidden', 'top.meta', 'top.jump', 'top.hide',
    'top.count.hint',
    'trend.chip.slower', 'trend.chip.faster', 'trend.chip.cooled',
    'trend.slower.prompt', 'trend.slower.auto', 'trend.stopped.prompt', 'trend.stopped.auto',
    'trend.faster.prompt', 'trend.faster.auto', 'trend.cooled',
    'trend.hint.pace', 'trend.hint.cooled',
    'findings.title', 'findings.empty', 'findings.row', 'findings.run', 'findings.noRun',
    'graph.title', 'graph.hint', 'graph.point', 'graph.short', 'graph.axis',
    'hidden.title', 'hidden.count', 'hidden.empty', 'hidden.restore', 'hidden.clear',
    'first.hint',
    'settings.title', 'settings.lang', 'settings.lang.auto', 'settings.badges', 'settings.graph',
    'settings.auto', 'settings.auto.hint', 'settings.auto.every', 'settings.auto.every.hint',
    'settings.prompt', 'settings.prompt.cost', 'settings.prompt.count', 'settings.prompt.depth',
    'settings.prompt.format', 'settings.prompt.format.rule', 'settings.prompt.format.list',
    'settings.prompt.format.hint', 'settings.prompt.template', 'settings.prompt.template.hint',
    'settings.prompt.reset', 'settings.prompt.preview', 'settings.prompt.nothing',
    'export.title', 'export.copyPrompt', 'export.copyList', 'export.copyJson', 'export.card',
    'export.copied', 'export.copyFailed', 'export.nothing',
    'card.title', 'card.index', 'card.diversity', 'card.words', 'card.messages', 'card.top',
    'card.draft', 'card.footer', 'card.share', 'card.failed', 'card.saving',
    'badge.title', 'badge.coverage',
];
