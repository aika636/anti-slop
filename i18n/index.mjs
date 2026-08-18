/**
 * i18n — строки интерфейса на двух языках.
 *
 * Русский здесь исходный, а не перевод, и это осознанно: расширение делается для
 * русскоязычной сцены, и формулировки вроде «прозы мало» или «стоп-лист имён
 * промахнулся» сначала пишутся по-русски, а потом переводятся. Обратный порядок
 * дал бы кальку с английского в основном языке продукта.
 *
 * Модуль ничего не знает ни про SillyTavern, ни про браузер — язык ему сообщают
 * снаружи (`setLocale`), как и всему остальному в `core`. Иначе тесты на Node
 * пришлось бы запускать с подделанной таверной.
 *
 * Своя система, а не `addLocaleData` таверны. Причина простая: таверна кладёт
 * данные локали только для СВОЕГО текущего языка и молча игнорирует остальные,
 * ключом там служит английская строка целиком, и переопределять чужие ключи она
 * запрещает. Для расширения, у которого русский — исходный язык, это не работает
 * ни в одну сторону.
 */

/**
 * Строки. Значение — либо строка с подстановками `{имя}`, либо массив форм
 * множественного числа: для русского три (один/два/пять), для английского две.
 */
const STRINGS = {
    ru: {
        // Заголовок — имя расширения, и только оно. В списке расширений человек
        // ищет то название, по которому расширение ему посоветовали; «Анализ
        // повторов» под этим именем не находится. Пояснение живёт подзаголовком.
        'panel.title': 'anti-slop',
        'panel.subtitle': 'анализ повторов',
        'panel.analyze': 'Проанализировать чат',

        'status.noChat': 'Чат не открыт.',
        'status.reading': 'Читаю чат…',
        'status.counting': 'Считаю…',
        'status.countingN': 'Считаю {n} {word}…',
        'status.dirty': 'Чат изменился после подсчёта — числа устарели.',
        'status.cache': 'Показан сохранённый подсчёт.',
        'status.noMessages': 'В чате нет ответов модели — считать нечего.',
        'status.failed': 'Подсчёт сорвался — подробности в консоли.',
        'status.leaked': 'Имя «{name}» попало в обороты — похоже, стоп-лист имён промахнулся.',
        'status.fallback': 'Воркер недоступен — считаю на главном потоке, интерфейс может подтормаживать.',
        'status.progress': 'посчитано {done} из {total}',

        'word.answer': ['ответ', 'ответа', 'ответов'],
        'word.word': ['слово', 'слова', 'слов'],
        'word.phrase': ['оборот', 'оборота', 'оборотов'],

        'tile.index': 'индекс',
        'tile.indexDraft': 'индекс (черновой)',
        'tile.index.hint': 'Сводная оценка: чем больше, тем больше повторов.',
        'tile.indexDraft.hint': 'Формула ещё не откалибрована: прозы в чате меньше порога. Число годится для сравнения сообщений между собой, но не с другими чатами.',
        // Плитка окна. Подпись отвечает на «за какой срок», приписка — на «по
        // сравнению с чем»; ни там, ни там нет и не должно быть слова о причине.
        'tile.recent': 'за {n} последних {word}',
        'tile.recent.hint': 'Индекс за последние {n} ответов, взвешенный по словам так же, как общий. Общий — среднее по всему чату, и на длинном чате новый ответ двигает его на доли балла. Ответы без прозы в окно не входят. Почему окно сдвинулось, расширение не знает: могла смениться сцена.',
        'tile.recent.up': 'на {d} больше, чем за предыдущие {n}',
        'tile.recent.down': 'на {d} меньше, чем за предыдущие {n}',
        'tile.recent.same': 'столько же, сколько за предыдущие {n}',
        'tile.diversity': 'разнообразие',
        'tile.diversity.hint': 'Доля разных слов в скользящем окне. Падает, когда модель ходит по кругу.',
        'tile.words': 'слов прозы',
        'tile.words.hint': 'Служебный текст — инфоблоки, картинки, разметка — в счёт не идёт.',
        'tile.messages': 'ответов модели',

        'top.title': 'Повторяющиеся обороты',
        'top.preliminary': 'список предварительный: прозы мало',
        'top.empty': 'Повторов не нашлось. Для чата в начале это нормально.',
        'top.allHidden': 'Все найденные обороты скрыты. Список скрытых — ниже.',
        'top.meta': 'сообщ. {first}–{last} · вес {weight}',
        'top.jump': 'Перейти к сообщению {n}',
        'top.hide': 'Не считать этот оборот',
        'top.count.hint': 'Сколько раз оборот встретился за весь чат. Это число не уменьшается — обороты только накапливаются. Идёт ли оборот прямо сейчас, показывает знак слева.',

        // Знак темпа. Формулировки описательные: расширение видит, что оборот
        // пошёл реже, но не видит, почему, — сцена могла просто смениться.
        // Единственное место, где ссылка на правило честна, — якорь, поставленный
        // в момент включения галочки.
        'trend.chip.slower': 'реже',
        'trend.chip.faster': 'чаще',
        'trend.chip.cooled': 'затих',
        'trend.slower.prompt': 'с правилом реже в {times} раз',
        'trend.slower.auto': 'реже прежнего в {times} раз',
        'trend.stopped.prompt': 'после включения правила не встречался',
        'trend.stopped.auto': 'больше не встречается',
        'trend.faster.prompt': 'с правилом чаще в {times} раз',
        'trend.faster.auto': 'чаще прежнего в {times} раз',
        'trend.cooled': 'тихо {n} {word}',
        'trend.hint.pace': 'Считано по темпу: {before} за {spanBefore} сообщ. до этой точки, {after} за {spanAfter} после. Почему стало реже, расширение не знает — сцена могла и просто смениться.',
        'trend.hint.cooled': 'Оборот шёл примерно раз в {step} сообщ., а последний раз был {n} назад.',

        'findings.title': 'Сообщения, повторяющие прежние',
        'findings.empty': 'Ни одно сообщение заметно не повторяет прежние.',
        'findings.row': 'Сообщение {index} повторяет {partner}',
        'findings.run': 'дословно подряд {n} {word}',
        'findings.noRun': 'дословных кусков нет, совпадение по смыслу',

        'graph.title': 'Индекс по сообщениям',
        'graph.hint': 'Каждый столбик — один ответ модели. Нажмите, чтобы перейти к нему.',
        'graph.point': 'Сообщение {index}: индекс {value}',
        'graph.short': 'Ответов пока мало — график появится, когда их станет хотя бы три.',
        'graph.axis': 'от {first} до {last}',

        'hidden.title': 'Скрытые обороты',
        'hidden.count': 'скрыто {n}',
        'hidden.empty': 'Ничего не скрыто.',
        'hidden.restore': 'Вернуть в список',
        'hidden.clear': 'Вернуть все',

        'first.hint': 'Чат ещё не считался. Нажмите кнопку — расширение прочитает ответы модели и найдёт, что в них повторяется.',

        'settings.title': 'Настройки',
        'settings.lang': 'Язык расширения',
        'settings.lang.auto': 'как в таверне',
        'settings.badges': 'Значок индекса у каждого ответа в чате',
        'settings.graph': 'График индекса по сообщениям',
        'settings.auto': 'Считать сам, без кнопки',
        'settings.auto.hint': 'Новые ответы досчитываются на лету и без этой галочки. Она нужна для случаев, когда досчитать нельзя: чат открыт впервые, числа устарели после правки, свайпа или удаления. Тогда расширение прогонит чат заново само. Токенов это не тратит — счёт идёт в браузере.',
        'settings.auto.every': 'Не чаще, чем раз в столько ответов',
        'settings.auto.every.hint': 'Это дроссель, а не расписание: между двумя полными проходами должно пройти столько ответов модели. Меньше — числа догоняют чат быстрее, но на длинном чате проход занимает секунду-другую и на телефоне это заметно.',
        'settings.prompt': 'Добавлять правило про повторы в промпт',
        'settings.prompt.cost': 'Это единственная функция расширения, которая тратит токены: правило уходит в запрос вместе с чатом. Всё остальное считается в браузере.',
        'settings.prompt.count': 'Сколько оборотов включать',
        'settings.prompt.depth': 'На какой глубине вставлять',
        'settings.prompt.format': 'Формат',
        'settings.prompt.format.rule': 'правило (рекомендуется)',
        'settings.prompt.format.list': 'голый список',
        'settings.prompt.format.hint': 'Голый перечень запрещённых фраз работает как подсказка: перечислив оборот, его же и напоминаешь модели. Правило этого не делает — оно говорит не «не пиши так», а чем заменить.',
        'settings.prompt.template': 'Шаблон правила',
        'settings.prompt.template.hint': 'Подстановки: {{phrases}} — обороты через запятую, {{list}} — списком по строкам, {{count}} — сколько их.',
        'settings.prompt.reset': 'Вернуть шаблон по умолчанию',
        'settings.prompt.hits': 'Попадание правила',
        'settings.prompt.hits.value': '{hits} из {total} оборотов правила встречались в последних {span} ответах.',
        'settings.prompt.hits.hint': 'Наблюдение, а не заслуга правила: оборот затихает и оттого, что сменилась сцена. Но если из списка не встречается почти ничто, правило занимает токены впустую.',
        'settings.prompt.preview': 'Что уйдёт в промпт',
        'settings.prompt.nothing': 'Пока нечего вставлять: оборотов не найдено.',

        'export.title': 'Отдать наружу',
        'export.copyPrompt': 'Скопировать правило',
        'export.copyList': 'Скопировать список',
        'export.copyJson': 'Скопировать JSON для ProsePolisher',
        'export.card': 'Карточка PNG',
        'export.copied': 'Скопировано.',
        'export.copyFailed': 'Скопировать не вышло — буфер обмена недоступен.',
        'export.nothing': 'Пока нечего отдавать: сначала посчитайте чат.',

        'card.title': 'Слоп-профиль чата',
        'card.index': 'индекс повторов',
        'card.diversity': 'разнообразие',
        'card.words': 'слов прозы',
        'card.messages': 'ответов',
        'card.top': 'Чаще всего повторяется',
        'card.draft': 'формула черновая: прозы меньше порога',
        'card.footer': 'anti-slop · посчитано в браузере, без единого запроса к модели',
        'card.share': 'Карточка чата',
        'card.failed': 'Карточку нарисовать не вышло — подробности в консоли.',
        'card.saving': 'Рисую карточку…',

        'badge.title': 'Индекс повторов этого ответа: {value}',
        'badge.coverage': 'покрытие повторами {coverage}',
    },

    en: {
        'panel.title': 'anti-slop',
        'panel.subtitle': 'repetition analysis',
        'panel.analyze': 'Analyse this chat',

        'status.noChat': 'No chat is open.',
        'status.reading': 'Reading the chat…',
        'status.counting': 'Counting…',
        'status.countingN': 'Counting {n} {word}…',
        'status.dirty': 'The chat changed after the count — these numbers are stale.',
        'status.cache': 'Showing a saved count.',
        'status.noMessages': 'No model replies in this chat — nothing to count.',
        'status.failed': 'The count failed — see the console.',
        'status.leaked': 'The name “{name}” ended up inside phrases — the name stop-list seems to have missed it.',
        'status.fallback': 'Worker unavailable — counting on the main thread, the interface may stutter.',
        'status.progress': 'counted {done} of {total}',

        'word.answer': ['reply', 'replies'],
        'word.word': ['word', 'words'],
        'word.phrase': ['phrase', 'phrases'],

        'tile.index': 'index',
        'tile.indexDraft': 'index (draft)',
        'tile.index.hint': 'Overall score: the higher, the more repetition.',
        'tile.indexDraft.hint': 'The formula is not calibrated yet: this chat has less prose than the threshold. The number compares messages to each other, not chats to chats.',
        'tile.recent': 'last {n} {word}',
        'tile.recent.hint': 'The index over the last {n} replies, weighted by words the same way as the overall one. The overall index averages the whole chat, and on a long chat a new reply moves it by a fraction of a point. Replies without prose stay out of the window. Why the window moved the extension cannot know — the scene may have simply changed.',
        'tile.recent.up': '{d} higher than the previous {n}',
        'tile.recent.down': '{d} lower than the previous {n}',
        'tile.recent.same': 'same as the previous {n}',
        'tile.diversity': 'diversity',
        'tile.diversity.hint': 'Share of distinct words in a sliding window. Drops when the model goes in circles.',
        'tile.words': 'words of prose',
        'tile.words.hint': 'Service text — info blocks, image prompts, markup — is not counted.',
        'tile.messages': 'model replies',

        'top.title': 'Repeated phrases',
        'top.preliminary': 'preliminary list: not much prose yet',
        'top.empty': 'No repetition found. Early in a chat that is normal.',
        'top.allHidden': 'Every phrase found is hidden. The hidden list is below.',
        'top.meta': 'msg {first}–{last} · weight {weight}',
        'top.jump': 'Go to message {n}',
        'top.hide': 'Stop counting this phrase',
        'top.count.hint': 'How many times the phrase occurred in the whole chat. This number never goes down — phrases only accumulate. Whether it is still going is what the mark on the left shows.',

        'trend.chip.slower': 'rarer',
        'trend.chip.faster': 'more often',
        'trend.chip.cooled': 'quiet',
        'trend.slower.prompt': '{times}× rarer with the rule',
        'trend.slower.auto': '{times}× rarer than before',
        'trend.stopped.prompt': 'not seen since the rule was turned on',
        'trend.stopped.auto': 'not seen any more',
        'trend.faster.prompt': '{times}× more often with the rule',
        'trend.faster.auto': '{times}× more often than before',
        'trend.cooled': 'quiet for {n} {word}',
        'trend.hint.pace': 'Measured by pace: {before} in {spanBefore} msgs before this point, {after} in {spanAfter} after. Why it slowed down the extension cannot know — the scene may have simply changed.',
        'trend.hint.cooled': 'The phrase ran about once every {step} msgs, and its last occurrence was {n} ago.',

        'findings.title': 'Replies that repeat earlier ones',
        'findings.empty': 'No reply noticeably repeats an earlier one.',
        'findings.row': 'Message {index} repeats {partner}',
        'findings.run': '{n} {word} verbatim in a row',
        'findings.noRun': 'no verbatim runs, overlap by meaning',

        'graph.title': 'Index by message',
        'graph.hint': 'Each bar is one model reply. Tap to jump to it.',
        'graph.point': 'Message {index}: index {value}',
        'graph.short': 'Too few replies yet — the graph appears from three onwards.',
        'graph.axis': 'from {first} to {last}',

        'hidden.title': 'Hidden phrases',
        'hidden.count': '{n} hidden',
        'hidden.empty': 'Nothing is hidden.',
        'hidden.restore': 'Bring back',
        'hidden.clear': 'Bring all back',

        'first.hint': 'This chat has not been counted yet. Press the button — the extension will read the model replies and find what repeats.',

        'settings.title': 'Settings',
        'settings.lang': 'Extension language',
        'settings.lang.auto': 'same as SillyTavern',
        'settings.badges': 'Index badge on every reply in the chat',
        'settings.graph': 'Index graph by message',
        'settings.auto': 'Count on its own, without the button',
        'settings.auto.hint': 'New replies are added on the fly without this box too. It covers the cases where they cannot be: the chat is opened for the first time, or the numbers went stale after an edit, a swipe or a deletion. Then the extension re-reads the chat by itself. It spends no tokens — counting happens in the browser.',
        'settings.auto.every': 'No more often than once per this many replies',
        'settings.auto.every.hint': 'A throttle, not a schedule: this many model replies must pass between two full passes. Lower means the numbers catch up sooner, but on a long chat a pass takes a second or two, and on a phone that shows.',
        'settings.prompt': 'Add a repetition rule to the prompt',
        'settings.prompt.cost': 'This is the only feature that spends tokens: the rule travels with the request. Everything else is counted in the browser.',
        'settings.prompt.count': 'How many phrases to include',
        'settings.prompt.depth': 'Injection depth',
        'settings.prompt.format': 'Format',
        'settings.prompt.format.rule': 'rule (recommended)',
        'settings.prompt.format.list': 'bare list',
        'settings.prompt.format.hint': 'A bare list of banned phrases works as a prompt: naming a phrase reminds the model of it. A rule does not — it says what to write instead.',
        'settings.prompt.template': 'Rule template',
        'settings.prompt.template.hint': 'Placeholders: {{phrases}} — phrases separated by commas, {{list}} — one per line, {{count}} — how many.',
        'settings.prompt.reset': 'Reset the template',
        'settings.prompt.hits': 'Rule hit rate',
        'settings.prompt.hits.value': '{hits} of the {total} phrases in the rule occurred in the last {span} replies.',
        'settings.prompt.hits.hint': 'An observation, not a merit of the rule: a phrase also goes quiet because the scene changed. But if almost nothing from the list occurs, the rule is spending tokens for nothing.',
        'settings.prompt.preview': 'What goes into the prompt',
        'settings.prompt.nothing': 'Nothing to inject yet: no phrases found.',

        'export.title': 'Send elsewhere',
        'export.copyPrompt': 'Copy the rule',
        'export.copyList': 'Copy the list',
        'export.copyJson': 'Copy JSON for ProsePolisher',
        'export.card': 'PNG card',
        'export.copied': 'Copied.',
        'export.copyFailed': 'Copying failed — the clipboard is unavailable.',
        'export.nothing': 'Nothing to give away yet: count the chat first.',

        'card.title': 'Chat slop profile',
        'card.index': 'repetition index',
        'card.diversity': 'diversity',
        'card.words': 'words of prose',
        'card.messages': 'replies',
        'card.top': 'Repeated most often',
        'card.draft': 'draft formula: less prose than the threshold',
        'card.footer': 'anti-slop · counted in the browser, without a single model request',
        'card.share': 'Chat card',
        'card.failed': 'Drawing the card failed — see the console.',
        'card.saving': 'Drawing the card…',

        'badge.title': 'Repetition index of this reply: {value}',
        'badge.coverage': 'covered by repeats {coverage}',
    },
};

/**
 * Таблицы наружу — только для теста, который сверяет, что ни одна строка не
 * забыта во втором языке. Проверить это через `t` нельзя: незнакомый ключ там
 * откатывается на русский, то есть забытый перевод вернул бы русскую строку и
 * выглядел бы как исправный.
 */
export const TABLES = STRINGS;

/** Языки, на которых расширение говорит. Первый — исходный. */
export const LOCALES = ['ru', 'en'];

let locale = 'ru';

/**
 * Выбрать язык.
 *
 * На вход годится всё, что отдают браузер и таверна: `ru`, `ru-RU`, `ru-ru`.
 * Незнакомый язык — английский: он понятнее большинству, чем незнакомая
 * кириллица, а придумывать третий язык из ничего мы не умеем.
 *
 * @param {string|null|undefined} code
 * @returns {string} выбранный язык
 */
export function setLocale(code) {
    const head = String(code ?? '').toLowerCase().split(/[-_]/)[0];
    locale = LOCALES.includes(head) ? head : 'en';
    return locale;
}

/** Текущий язык. */
export const getLocale = () => locale;

/**
 * Выбор формы множественного числа.
 *
 * Русское правило записано целиком, а не взято из `Intl.PluralRules`: правило
 * это школьное, живёт в трёх строках, и тащить ради него объект, который в
 * старых вебвью Android бывает урезан, незачем.
 */
function pluralForm(n, forms) {
    if (locale !== 'ru') return forms[n === 1 ? 0 : 1] ?? forms[forms.length - 1];
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
}

/**
 * Строка по ключу с подстановками `{имя}`.
 *
 * Отсутствующий ключ возвращается как есть, а не пустой строкой: пустое место в
 * интерфейсе выглядит как поломка вёрстки и ищется часами, а видимый ключ сразу
 * говорит, чего не хватает.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
export function t(key, params) {
    const table = STRINGS[locale] ?? STRINGS.ru;
    let value = table[key];
    if (value === undefined) value = STRINGS.ru[key];
    if (value === undefined) return key;
    if (Array.isArray(value)) return value.join('/'); // ключ множественного числа взят напрямую — см. `plural`
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, (whole, name) =>
        (params[name] === undefined ? whole : String(params[name])));
}

/**
 * Существительное при числе: `plural(3, 'word.answer')` → «ответа».
 *
 * Само число не подставляется — его вставляет вызывающий через `t`, потому что
 * порядок «число, потом слово» есть не во всех языках, а в шаблоне он виден.
 */
export function plural(n, key) {
    const table = STRINGS[locale] ?? STRINGS.ru;
    const forms = table[key] ?? STRINGS.ru[key];
    return Array.isArray(forms) ? pluralForm(n, forms) : t(key);
}

/** Число с разделителями разрядов по текущему языку. */
export function formatNumber(x) {
    if (!Number.isFinite(x)) return '—';
    return Math.round(x).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US');
}

/**
 * Во сколько раз: «в 2,5 раза», «в 12 раз».
 *
 * В отличие от `formatNumber`, один знак после запятой оставлен: округление
 * «в 1,5 раза» до «в 2 раза» здесь заметно врёт, а разница между 1,5 и 2 — это
 * ровно граница между «показалось» и «правда стало реже». От десяти и выше
 * дробь отбрасывается: там она уже не значит ничего.
 */
export function formatTimes(x) {
    if (!Number.isFinite(x) || x <= 0) return '—';
    return x.toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', {
        maximumFractionDigits: x >= 10 ? 0 : 1,
    });
}

/** Доля в процентах. Дробей нет намеренно: точность здесь мнимая. */
export function formatPercent(x) {
    return Number.isFinite(x) ? Math.round(x * 100) + '%' : '—';
}
