/**
 * adapter — единственный модуль, который знает про SillyTavern.
 *
 * Всё, что ниже, взято не из документации, а из проверок на живой таверне:
 * половина результатов противоречит тому, что можно было предположить, читая
 * исходники.
 *
 * Правило модуля: наружу отдаются простые объекты `{index, name, mes}` и голые
 * числа. Ни `core`, ни панель не должны знать ни про `getContext`, ни про
 * `mesid`, ни про свайпы.
 */

// В контексте таверны этой функции нет, а без неё нельзя доскроллить до старого
// сообщения: разметка обрезана порогом, и нужного блока в DOM просто не будет
// (проверено на живой таверне). Прямой импорт — единственный способ.
import { showMoreMessages } from '../../../../script.js';

/** @returns {any} контекст SillyTavern */
export function ctx() {
    return globalThis.SillyTavern.getContext();
}

/** Идентификатор текущего чата, или null, если чат не открыт. */
export function chatId() {
    return ctx().getCurrentChatId() ?? null;
}

/**
 * Имена, которые не должны становиться частью оборота.
 *
 * Три источника: персона, карточка и все
 * различные `chat[i].name`. Промах одного из них не смертелен, но если имя
 * карточки не встретилось в прозе ни разу — об этом надо сказать вслух, поэтому
 * список отдаётся вместе с именем карточки отдельным полем.
 */
export function chatNames() {
    const context = ctx();
    const names = new Set();
    const add = n => { if (typeof n === 'string' && n.trim()) names.add(n.trim()); };

    add(context.name1);
    add(context.name2);
    for (const m of context.chat ?? []) add(m?.name);

    return { names: [...names], characterName: context.name2 ?? null, userName: context.name1 ?? null };
}

/**
 * Сообщение ли это модели.
 *
 * Правило намеренно «`!is_user`», а НЕ «`!is_user && !is_system`»: на реальных
 * длинных чатах флагом `is_system` бывает помечено от 55 до 85 процентов
 * сообщений модели: так таверна метит не только служебные вставки, но и
 * отыгрыш, скрытый пользователем через призрак ради экономии токенов. По
 * короткому правилу расширение считало бы красивую цифру по четверти чата.
 *
 * Настоящие служебные вставки отличаются от скрытого отыгрыша именем
 * говорящего: у отыгрыша это персонаж из заголовка чата.
 */
export function isModelMessage(m, names) {
    if (!m || m.is_user) return false;
    if (!m.is_system) return true;
    return !!m.name && names.includes(m.name);
}

/**
 * Текст сообщения для подсчёта.
 *
 * `swipes[swipe_id]` при наличии свайпов и `mes` иначе: на живой установке они
 * сходятся везде, но страховка бесплатна, а на старых и
 * импортированных чатах поля расходятся. Заодно это единственный способ не
 * посчитать выброшенный вариант.
 *
 * Перевод не берётся никогда: при включённом переводчике таверна кладёт его в
 * `extra.display_text`, оставляя оригинал в `mes`, и считать по
 * переводу значило бы мерить повторы переводчика, а не модели.
 */
export function messageText(m) {
    const swipe = Array.isArray(m?.swipes) ? m.swipes[m.swipe_id] : null;
    const text = typeof swipe === 'string' ? swipe : m?.mes;
    return typeof text === 'string' ? text : '';
}

/** Показан ли на экране перевод, а не оригинал. Подсветке это запрещает работать. */
export function hasTranslation(m) {
    return typeof m?.extra?.display_text === 'string' && m.extra.display_text.length > 0;
}

/**
 * Все сообщения модели текущего чата, по возрастанию номера.
 *
 * `index` — это `mesid` таверны, а не позиция в списке: по нему потом идёт
 * переход к сообщению, и по нему же ядро восстанавливает строки оборотов.
 * Номера идут с дырами (между ответами стоят реплики пользователя) — ядро это
 * умеет.
 *
 * История берётся одним чтением: `context.chat` заполнен целиком сразу, лениво
 * только рисуется.
 */
export function modelMessages(names = chatNames().names) {
    const chat = ctx().chat ?? [];
    const out = [];
    for (let i = 0; i < chat.length; i++) {
        if (!isModelMessage(chat[i], names)) continue;
        out.push({ index: i, name: chat[i].name, mes: messageText(chat[i]) });
    }
    return out;
}

/** Текст сообщения по номеру — то, чем ядро восстанавливает строки, не копируя чат. */
export function textAt(index) {
    const m = ctx().chat?.[index];
    return m ? messageText(m) : null;
}

/**
 * Отпечаток состояния чата: по нему кеш понимает, что его пора выбросить.
 *
 * Считается по числу сообщений модели, номеру последнего и суммарной длине
 * текстов. Длина ловит правку, сделанную мимо наших событий, — в другой
 * вкладке, другим расширением или руками в файле чата.
 */
export function signature(names = chatNames().names) {
    const chat = ctx().chat ?? [];
    let count = 0, chars = 0, last = -1;
    for (let i = 0; i < chat.length; i++) {
        if (!isModelMessage(chat[i], names)) continue;
        count++;
        chars += messageText(chat[i]).length;
        last = i;
    }
    return { count, chars, last };
}

// --- события ----------------------------------------------------------------

// Метода `off` в эмиттере таверны нет, есть `removeListener`, и ему нужна та же
// ссылка на функцию. Держим её сами.
const listeners = [];

/**
 * Подписка на событие. Все события отдают номер сообщения, а не само сообщение
 * — текст всегда читаем сами из `context.chat`.
 */
export function on(event, fn) {
    const { eventSource, eventTypes } = ctx();
    const name = eventTypes[event] ?? event;
    eventSource.on(name, fn);
    listeners.push([name, fn]);
}

/** Снять все подписки. Нужно на выгрузке расширения. */
export function offAll() {
    const { eventSource } = ctx();
    for (const [name, fn] of listeners) eventSource.removeListener(name, fn);
    listeners.length = 0;
}

// --- разметка ---------------------------------------------------------------

/**
 * Прокрутить к сообщению и мигнуть им.
 *
 * Сообщения может не быть в разметке: `context.chat` заполнен целиком, но в DOM
 * попадает только хвост. Догружаем порциями, пока блок не появится — или пока
 * догружать нечего.
 */
export async function scrollToMessage(index, attempts = 12) {
    const find = () => document.querySelector(`#chat .mes[mesid="${index}"]`);

    for (let i = 0; i < attempts && !find(); i++) {
        const before = document.querySelectorAll('#chat .mes').length;
        await showMoreMessages();
        if (document.querySelectorAll('#chat .mes').length === before) break;
    }

    const block = find();
    if (!block) return false;

    block.scrollIntoView({ behavior: 'smooth', block: 'center' });
    block.classList.remove('antislop-flash');
    // Перезапуск анимации: без чтения раскладки браузер склеит снятие и возврат
    // класса в один кадр и ничего не мигнёт.
    void block.offsetWidth;
    block.classList.add('antislop-flash');
    setTimeout(() => block.classList.remove('antislop-flash'), 1600);
    return true;
}

// --- настройки --------------------------------------------------------------

const MODULE = 'antislop';

/** Настройки расширения. Только настройки: данные анализа сюда нельзя. */
export function settings(defaults = {}) {
    const context = ctx();
    const all = context.extensionSettings;
    if (!all[MODULE]) all[MODULE] = {};
    for (const [k, v] of Object.entries(defaults)) {
        if (!(k in all[MODULE])) all[MODULE][k] = v;
    }
    return all[MODULE];
}

/** Сохранение отложенное: каждая запись переписывает файл настроек целиком. */
export function saveSettings() {
    ctx().saveSettingsDebounced();
}

/**
 * Язык таверны — `ru-ru`, `en-us` и подобное.
 *
 * Функция появилась в контексте не сразу, поэтому проверяем: на установке
 * постарше расширение обязано не падать, а откатиться на язык браузера.
 */
export function locale() {
    return ctx().getCurrentLocale?.() ?? globalThis.navigator?.language ?? 'en';
}

/**
 * Как назвать чат в карточке.
 *
 * Имя персонажа, а не имя файла чата: файл называется датой с секундами, и на
 * картинке, которой делятся, это выглядит как ошибка. Групповой чат отдаёт своё
 * имя, одиночный — карточку персонажа.
 */
export function chatTitle() {
    const context = ctx();
    const group = context.groups?.find?.(g => g.id === context.groupId);
    return group?.name ?? context.name2 ?? context.getCurrentChatId?.() ?? '';
}

// --- вставка в промпт ---------------------------------------------------------

/** Ключ нашей вставки. Он же виден в отладчике промпта таверны. */
const PROMPT_KEY = 'antislop';

/**
 * Положить или убрать нашу вставку.
 *
 * Позиция — `IN_CHAT` с глубиной: правило про повторы должно стоять близко к
 * концу разговора, иначе на длинном контексте модель до него не дочитает. Роль —
 * системная; пользовательская выглядела бы как реплика человека и портила бы
 * ролевой отыгрыш.
 *
 * Пустой текст — это снятие вставки, а не пустая вставка: таверна хранит запись
 * по ключу, и оставленная пустышка продолжала бы занимать место в отладчике
 * промпта, сбивая с толку при разборе чужих жалоб.
 *
 * Числа записаны здесь, а не взяты из контекста: `extension_prompt_types` наружу
 * таверна не отдаёт, а значения её собственного перечисления публичны и стабильны
 * (`IN_CHAT = 1`, роль `SYSTEM = 0`).
 */
export function setPrompt(text, depth = 4) {
    ctx().setExtensionPrompt(PROMPT_KEY, text ?? '', 1, Math.max(0, Number(depth) || 0), false, 0);
}
