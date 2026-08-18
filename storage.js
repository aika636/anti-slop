/**
 * storage — кеш анализа по чату.
 *
 * `IndexedDB` и только он. Альтернативы были померены: и
 * `extension_settings`, и `accountStorage` уезжают в один и тот же файл
 * настроек, переписывают его целиком вместе с чужими расширениями и стоят
 * четверть секунды на двух мегабайтах. Таблицы оборотов там жить не могут.
 *
 * Обёртка над `IndexedDB` уже поставляется с таверной — берём её, а не пишем
 * свою.
 */

import { FORMULA_VERSION } from './core/index.mjs';

const STORE = 'antislop-cache';

/**
 * Версия формата самого кеша: меняется, когда меняется то, ЧТО мы кладём.
 *
 * 2 — добавлены основы оборотов (`stems`). Старые записи без них не ломаются, но
 * ключи игнор-листа по ним не сойдутся, а тихо разошедшийся ключ выглядит для
 * пользователя как «скрытие не работает». Дешевле пересчитать один раз.
 */
const SCHEMA = 2;

let store = null;

function db() {
    if (store) return store;
    const lf = globalThis.SillyTavern?.libs?.localforage ?? globalThis.localforage;
    if (!lf) return null;
    store = lf.createInstance({ name: 'SillyTavern', storeName: STORE });
    return store;
}

const key = chatId => `chat:${chatId}`;

/**
 * Якорь темпа лежит ОТДЕЛЬНЫМ ключом, а не внутри записи кеша, и это не
 * аккуратность ради аккуратности.
 *
 * Кеш обесценивается отпечатком чата: правка, удаление или свайп — и
 * `loadCache` возвращает `null`. Якорь при этом терять нельзя. Он и нужен-то
 * затем, чтобы пережить десятки пересчётов и сказать «до включения правила было
 * так, а стало эдак»; якорь, пропадающий от любой правки сообщения, не доживёт
 * до собственного `MIN_SPAN` ни в одном живом чате.
 *
 * По той же причине он не привязан к версии формулы: в нём лежат счётчики
 * оборотов, а не индекс, и смена якорей нормировки их не меняет.
 */
const anchorKey = chatId => `anchor:${chatId}`;

/** Версия формата якоря — своя, потому что меняться он будет отдельно от кеша. */
const ANCHOR_SCHEMA = 1;

/**
 * Итог, обрезанный до того, что показывает панель.
 *
 * Целиком его класть нельзя: в записи сообщения лежат отчёты токенизатора и
 * разложение индекса на слагаемые — на длинном чате это мегабайты, которые
 * никто не прочтёт. Всё, что не сохранено, восстанавливается пересчётом.
 */
function trim(result) {
    return {
        top: result.top.map(t => ({
            text: t.text,
            // Основы кладём вместе со строкой: по ним считается ключ игнор-листа
            // (`ignore.mjs`), и без них скрытый оборот после перезагрузки вкладки
            // всплыл бы обратно — ключ по строке не совпал бы с ключом по основам.
            // Это шесть коротких слов на запись, полсотни записей на чат.
            stems: t.stems,
            count: t.count,
            n: t.n,
            cvalue: t.cvalue,
            firstMessage: t.firstMessage,
            lastMessage: t.lastMessage,
        })),
        preliminary: result.preliminary,
        candidates: result.candidates,
        index: result.index,
        diversity: { words: result.diversity.words, mattr: result.diversity.mattr, mtld: result.diversity.mtld },
        findings: result.findings.map(f => ({
            index: f.index,
            partner: f.partner,
            containment: f.containment,
            runLength: f.runLength,
            notable: f.notable,
        })),
        baseline: result.baseline,
        messages: result.messages.map(m => ({
            index: m.index,
            words: m.words,
            value: m.value,
            coverage: m.coverage,
            mattr: m.diversity?.mattr ?? NaN,
        })),
        stats: {
            words: result.stats.words,
            distinct: result.stats.distinct,
            mode: result.stats.mode,
            names: result.stats.names,
        },
    };
}

/**
 * Прочитать кеш чата.
 *
 * Возвращает null, если кеша нет, он от другой версии формулы или чат с тех пор
 * изменился. Версия формулы — не формальность: смена якорей нормировки делает
 * старые числа несравнимыми с новыми, и показывать их вместе нельзя.
 *
 * @param {string} chatId
 * @param {{count: number, chars: number, last: number}} sig отпечаток из адаптера
 */
export async function loadCache(chatId, sig) {
    const lf = db();
    if (!lf || !chatId) return null;

    let entry = null;
    try {
        entry = await lf.getItem(key(chatId));
    } catch (error) {
        console.warn('[anti-slop] кеш не читается:', error);
        return null;
    }
    if (!entry) return null;

    if (entry.schema !== SCHEMA || entry.formula !== FORMULA_VERSION) return null;
    if (!sig) return entry;
    if (entry.sig?.count !== sig.count || entry.sig?.chars !== sig.chars || entry.sig?.last !== sig.last) {
        return null;
    }
    return entry;
}

/**
 * Сохранить итог. Ошибка записи не должна ронять панель: кеш — ускорение, а не
 * источник правды, и место в браузере может кончиться.
 */
export async function saveCache(chatId, sig, result) {
    const lf = db();
    if (!lf || !chatId) return false;
    try {
        await lf.setItem(key(chatId), {
            schema: SCHEMA,
            formula: FORMULA_VERSION,
            at: Date.now(),
            sig,
            result: trim(result),
        });
        return true;
    } catch (error) {
        console.warn('[anti-slop] кеш не пишется:', error);
        return false;
    }
}

/**
 * Прочитать якорь темпа. Отпечатка чата здесь нет намеренно — см. `anchorKey`.
 */
export async function loadAnchor(chatId) {
    const lf = db();
    if (!lf || !chatId) return null;
    try {
        const entry = await lf.getItem(anchorKey(chatId));
        if (!entry || entry.schema !== ANCHOR_SCHEMA) return null;
        return entry.anchor ?? null;
    } catch (error) {
        console.warn('[anti-slop] якорь не читается:', error);
        return null;
    }
}

/** Сохранить якорь. Как и кеш, он ускорение, а не источник правды. */
export async function saveAnchor(chatId, anchor) {
    const lf = db();
    if (!lf || !chatId || !anchor) return false;
    try {
        await lf.setItem(anchorKey(chatId), { schema: ANCHOR_SCHEMA, at: Date.now(), anchor });
        return true;
    } catch (error) {
        console.warn('[anti-slop] якорь не пишется:', error);
        return false;
    }
}

/** Забыть чат — вместе с якорем: «посчитать заново» должно означать именно заново. */
export async function dropCache(chatId) {
    const lf = db();
    if (!lf || !chatId) return;
    try {
        await lf.removeItem(key(chatId));
        await lf.removeItem(anchorKey(chatId));
    } catch (error) {
        console.warn('[anti-slop] кеш не чистится:', error);
    }
}

/** Забыть всё. Понадобится настройке «пересчитать заново» и смене версии формулы. */
export async function clearCache() {
    const lf = db();
    if (!lf) return;
    try {
        await lf.clear();
    } catch (error) {
        console.warn('[anti-slop] кеш не чистится:', error);
    }
}
