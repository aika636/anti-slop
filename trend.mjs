/**
 * trend — стал ли оборот встречаться реже.
 *
 * Зачем. Общий счётчик оборота (`×17`) накопительный и не уменьшается никогда:
 * даже если модель не писала «холодок пробежал по спине» последние двести
 * ответов, семнадцать вхождений из чата никуда не делись. Поэтому по списку
 * нельзя понять, продолжается штамп прямо сейчас или уже кончился, — а это
 * ровно тот вопрос, который человек задаёт, включив правило в промпт.
 *
 * **Модуль говорит о темпе и только о нём.** Он не утверждает, что помогло
 * расширение: оборот затухает и оттого, что сцена сменилась, что персонажи
 * ушли из локации, к которой он был привязан, что пользователь пересвайпнул.
 * Формулировки в интерфейсе описательные («реже, чем раньше»), а причину
 * достраивает пользователь — он один знает, включал ли он правило. Единственное
 * место, где ссылка на правило честна, — якорь с `reason: 'prompt'`: он
 * поставлен ровно в момент включения галочки, и «до» с «после» разделены именно
 * этим событием.
 *
 * Два независимых способа, и это не дублирование.
 *
 * 1. **Затих** (`cooled`). Считается из полей, которые в записи оборота уже
 *    есть: `count`, `firstMessage`, `lastMessage`. Работает задним числом — на
 *    чате, посчитанном впервые, и вообще без всякой истории. Ничего не хранит.
 * 2. **Реже/чаще** (`slower`/`faster`). Сравнение темпа до и после якоря —
 *    снимка счётчиков, снятого в известный момент. Требует хранилища, зато
 *    отвечает на вопрос «изменилось ли что-то», а не «давно ли не было».
 *
 * Первый способ отвечает всегда, второй — точнее; поэтому при живом якоре
 * показывается он, а `cooled` остаётся запасным.
 *
 * Модуль чистый: где лежит якорь, знают `storage.js` и `index.js`, здесь только
 * правила. Номера сообщений — те же, что у ядра (в расширении это `mesid`
 * таверны, идущие с дырами и включающие реплики пользователя). Единицы у всех
 * величин одни и те же, поэтому дыры не мешают: и шаг, и тишина меряются в них.
 */

import { phraseKey } from './ignore.mjs';

/**
 * Меньше трёх вхождений — темпа нет.
 *
 * По двум точкам «средний шаг» равен единственному промежутку между ними, и
 * любая пауза оказывается вдвое длиннее его с вероятностью около половины. Знак
 * «затих» на таком обороте — это не наблюдение, а подбрасывание монетки.
 */
export const MIN_COUNT = 3;

/**
 * Во сколько раз тишина должна превысить собственный шаг оборота.
 *
 * Двойка — не круглое число ради круглого. Для потока с постоянной
 * интенсивностью ожидание следующего вхождения распределено так, что пауза
 * вдвое длиннее средней случается примерно в одном случае из семи; на полусотне
 * показанных оборотов это единицы ложных знаков, и они гаснут сами со следующим
 * вхождением. Порог в полтора шага давал бы знак почти каждому второму обороту
 * и не значил бы ничего.
 */
export const COOLED_STEPS = 2;

/** Во сколько раз темп должен упасть (вырасти), чтобы об этом стоило говорить. */
export const SLOWER = 0.5;
export const FASTER = 2;

/**
 * Сколько сообщений должно быть по обе стороны якоря.
 *
 * Без этого порога темп «после» считался бы по одному-двум ответам сразу после
 * включения галочки, и первый же ответ без оборота показывал бы «стало реже в
 * бесконечность раз». Двадцать — компромисс: меньше десятка сообщений ни о чём
 * не говорят, а ждать сотню значит не показать знак никогда.
 */
export const MIN_SPAN = 20;

/**
 * Через сколько сообщений двигается автоматический якорь.
 *
 * Якорь, поставленный однажды и навсегда, к трёхсотому сообщению сравнивает
 * «сейчас» с давно прошедшим — это уже история чата, а не текущий темп.
 * Поэтому автоякорь ступенчато догоняет; якорь правила (`reason: 'prompt'`) не
 * двигается никогда, потому что его смысл именно в фиксированной точке.
 */
export const AUTO_GAP = 40;

/** Номер последнего учтённого сообщения. */
export function lastMessageIndex(result) {
    const messages = result?.messages;
    if (!Array.isArray(messages) || !messages.length) return NaN;
    const last = messages[messages.length - 1]?.index;
    return Number.isFinite(last) ? last : NaN;
}

/** Снимок счётчиков: ключ оборота → сколько раз он встретился к этому моменту. */
function snapshot(result) {
    const counts = Object.create(null);
    for (const item of result?.top ?? []) {
        const key = phraseKey(item);
        if (key) counts[key] = item.count;
    }
    return { at: lastMessageIndex(result), counts };
}

/**
 * Якорь по нынешнему итогу.
 *
 * @param {object} result итог анализа (полный, до отсева скрытых: скрытый
 *   оборот можно вернуть обратно, и без его счётчика в снимке сравнивать
 *   было бы не с чем)
 * @param {'prompt'|'auto'} reason откуда взялся якорь; от этого зависит и
 *   формулировка в интерфейсе, и то, будет ли он двигаться
 */
export function makeAnchor(result, reason = 'auto') {
    const shot = snapshot(result);
    return Number.isFinite(shot.at) ? { ...shot, reason } : null;
}

/**
 * Подвинуть автоматический якорь, если пора.
 *
 * Двумя ступенями, а не переустановкой на месте. Если просто пересобирать якорь
 * каждые `AUTO_GAP` сообщений, то сразу после переустановки окно «после»
 * схлопывается в ноль, `MIN_SPAN` не выполняется, и все стрелки в панели разом
 * исчезают на следующие двадцать ответов. Поэтому следующий якорь копится
 * рядом (`next`) и заступает на место прежнего, только когда сам успел
 * состариться: окно сравнения всегда лежит между `AUTO_GAP` и `2 × AUTO_GAP`.
 *
 * @returns {object|null} новый якорь или `null`, если менять нечего
 */
export function advanceAnchor(anchor, result) {
    const last = lastMessageIndex(result);
    if (!Number.isFinite(last)) return null;

    if (!anchor) return makeAnchor(result, 'auto');
    if (anchor.reason === 'prompt') return null;
    if (!Number.isFinite(anchor.at)) return makeAnchor(result, 'auto');

    if (!anchor.next) {
        return last - anchor.at >= AUTO_GAP ? { ...anchor, next: snapshot(result) } : null;
    }
    if (last - anchor.next.at >= AUTO_GAP) {
        return { at: anchor.next.at, counts: anchor.next.counts, reason: 'auto', next: snapshot(result) };
    }
    return null;
}

/**
 * Сравнение темпа по якорю.
 *
 * `before` берётся из снимка, `after` — разностью с нынешним счётчиком. Оборот,
 * которого в снимке не было, пропускается: он завёлся уже после якоря, и «до»
 * у него нет — показывать «стало чаще в бесконечность раз» на обороте, который
 * просто появился, значит врать.
 */
function pace(item, anchor, lastIndex) {
    if (!anchor || !Number.isFinite(anchor.at) || !Number.isFinite(lastIndex)) return null;

    const before = anchor.counts?.[phraseKey(item)];
    if (!Number.isFinite(before) || before <= 0) return null;

    // Окно «до» отсчитывается от первого вхождения, а не от начала чата: до него
    // оборота не существовало, и включать эти сообщения в знаменатель — значит
    // занижать прежний темп и выдавать любое затухание за рост.
    const first = Number.isFinite(item.firstMessage) ? Math.min(item.firstMessage, anchor.at) : anchor.at;
    const spanBefore = anchor.at - first + 1;
    const spanAfter = lastIndex - anchor.at;
    if (spanBefore < MIN_SPAN || spanAfter < MIN_SPAN) return null;

    const after = Math.max(0, (item.count ?? 0) - before);
    const rateBefore = before / spanBefore;
    const rateAfter = after / spanAfter;
    if (!(rateBefore > 0)) return null;

    const ratio = rateAfter / rateBefore;
    const common = { ratio, before, after, spanBefore, spanAfter, reason: anchor.reason ?? 'auto' };

    if (ratio <= SLOWER) return { kind: 'slower', stopped: after === 0, ...common };
    if (ratio >= FASTER) return { kind: 'faster', stopped: false, ...common };
    // Между порогами — молчим. «Примерно так же» это не наблюдение, а шум, и
    // знак на каждой строке списка обесценил бы те, что стоят по делу.
    return null;
}

/**
 * Оборот выпал из собственного ритма.
 *
 * Средний шаг считается по своим же вхождениям, а не по длине чата: у оборота,
 * который встречается раз в сорок ответов, сорок ответов тишины — это норма, а
 * у оборота из каждого второго — уже конец.
 *
 * Оговорка про данные. У оборотов, заведённых после перехода счётчика в режим
 * таблицы, `firstMessage` — это на самом деле второе вхождение (`core/ngrams`).
 * Промежуток «первое–последнее» от этого сужается, средний шаг выходит меньше
 * настоящего, а порог тишины — строже. Знак становится осторожнее, то есть
 * ошибка смещает в безопасную сторону, и компенсировать её нечем: настоящего
 * первого вхождения в данных просто нет.
 */
function cooled(item, lastIndex) {
    if (!Number.isFinite(lastIndex)) return null;

    const first = item?.firstMessage, last = item?.lastMessage, count = item?.count ?? 0;
    if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return null;

    const step = (last - first) / (count - 1);
    const silence = lastIndex - last;
    if (!(step > 0) || silence < COOLED_STEPS * step) return null;

    return { kind: 'cooled', stopped: false, silence, step };
}

/**
 * Знак темпа для одного оборота или `null`, если сказать нечего.
 *
 * Молчание — штатный и самый частый ответ. Знак на каждой строке не несёт
 * информации: если помечено всё, не помечено ничего.
 *
 * @param {{count?: number, firstMessage?: number, lastMessage?: number,
 *          stems?: string[], text?: string}} item запись оборота из топа
 * @param {{lastIndex?: number, anchor?: object|null}} [ctx]
 * @returns {{kind: 'slower'|'faster'|'cooled', stopped: boolean,
 *            ratio?: number, silence?: number, reason?: string}|null}
 */
export function phraseTrend(item, { lastIndex = NaN, anchor = null } = {}) {
    if (!item || !Number.isFinite(item.count) || item.count < MIN_COUNT) return null;
    return pace(item, anchor, lastIndex) ?? cooled(item, lastIndex);
}
