/**
 * Anti-slop — точка входа расширения.
 *
 * Здесь живут `adapter`, `storage`, панель, кнопка «проанализировать чат»,
 * список оборотов, переход к сообщению, инкрементальность и кеш. Сам счёт
 * уехал в `worker.js` — замер (`tools/bench/`) показал,
 * что на десктопном чате в 166 тысяч слов прозы
 * полный проход на главном потоке занимает 1274 мс ОДНИМ куском и на это время
 * убивает интерфейс таверны, а тот же проход в модульном воркере не роняет ни
 * одного кадра. На телефоне разница будет только больше. Поверх этого — график,
 * бейджи, карточка, игнор-лист, правило для промпта, экспорт и два языка.
 *
 * Здесь только сборка: считает `core` (через `worker.js` или, в запасном
 * режиме, напрямую), про таверну знает `adapter`, рисует `ui/panel`. Модуль
 * держит состояние — сессию анализа текущего чата — и решает, когда
 * досчитывать, когда пересчитывать заново и когда верить кешу.
 */

import { createAnalysis } from './core/analyze.mjs';
import * as st from './adapter.js';
import { loadCache, saveCache, dropCache, loadAnchor, saveAnchor } from './storage.js';
import { mountPanel } from './ui/panel.js';
import { mountBadges } from './ui/badges.js';
import { setLocale, getLocale, t } from './i18n/index.mjs';
import { ignoreEntry, splitIgnored, withoutIgnored } from './ignore.mjs';
import { promptParts, buildList, defaultTemplate, promptHits } from './prompt.mjs';
import { toSlopListJson } from './interop/prosepolisher.mjs';
import { drawCard, shareCard, cardFilename } from './card/index.mjs';
import { makeAnchor, advanceAnchor, lastMessageIndex, phraseTrend } from './trend.mjs';
import { shouldAutoCount, AUTO_EVERY_DEFAULT } from './auto.mjs';

/** Сколько оборотов показывать. Больше в панели всё равно никто не пролистает. */
const TOP_LIMIT = 50;

/**
 * Настройки и их умолчания.
 *
 * `promptEnabled` выключен, и это не осторожность, а обещание: первая строка
 * анонса — «не делает ни одного запроса к API и ничего не добавляет в промпт».
 * Расширение, включающее вставку само, эту строку опровергает.
 *
 * `promptTemplates` пустые: пустой шаблон означает «взять умолчание текущего
 * языка», и при смене языка интерфейса правило переезжает вместе с ним. Как
 * только пользователь правит шаблон руками, здесь оказывается его текст, и
 * больше мы в него не лезем.
 */
const DEFAULTS = {
    lang: 'auto',
    badges: true,
    graph: true,
    /**
     * Считать без кнопки. Выключено по той же причине, что и вставка в промпт, —
     * но причина другая: счёт ничего не стоит в токенах, зато на телефоне и на
     * длинном чате полный проход слышен. Расширение, начинающее считать само на
     * первом же открытом чате, решает это за человека.
     */
    autoEnabled: false,
    autoEvery: AUTO_EVERY_DEFAULT,
    promptEnabled: false,
    promptFormat: 'rule',
    promptCount: 8,
    promptDepth: 4,
    promptTemplates: { rule: '', list: '' },
    ignored: [],
};

const state = {
    /**
     * Идентификатор чата — ключ кеша. У временного чата его нет: таверна не
     * пишет его на диск и номера ему не даёт. Считать это причиной не работать
     * нельзя — временный чат такой же чат, просто без кеша.
     */
    chatId: null,
    /** Есть ли вообще открытый чат. Не то же самое, что `chatId`. */
    hasChat: false,
    names: [],
    /**
     * Поколение счёта. Смена чата и повторное нажатие кнопки увеличивают его —
     * это и есть отмена: любой ответ воркера или шаг запасного цикла, который
     * несёт на себе устаревшее поколение, молча отбрасывается. Заодно `gen` —
     * это тот же `id`, которым запрос адресуется воркеру: одно поколение —
     * одна сессия воркера.
     */
    gen: 0,
    /**
     * Живая сессия счёта. `null`, пока не считали или пока числа не подлежат
     * досчёту (кеш, `dirty`). `kind` — где именно живёт сессия: в воркере (сам
     * счётчик и детектор остались там, `index.js` их не видит) или на главном
     * потоке в запасном режиме (тогда есть ещё модульная переменная
     * `coreSession` — настоящий объект ядра). `lastIndex` — номер последнего
     * учтённого сообщения; хранится здесь, а не в объекте ядра, ровно потому,
     * что для воркера такого объекта на главном потоке просто нет.
     */
    session: null,
    result: null,
    fromCache: false,
    /** Чат изменился так, что досчитать нельзя: правка, удаление, свайп. */
    dirty: false,
    busy: false,
    /** Что именно делаем: `reading` или `counting`. Строку соберёт панель. */
    stage: null,
    stageCount: 0,
    /** Пока идёт полный подсчёт: {done, total} или null — панель рисует полосу. */
    progress: null,
    /** Ключ строки ошибки, а не готовая строка: переводит панель. */
    error: null,
    /** Имя карточки, просочившееся в обороты, — оговорка к показанным числам. */
    notice: null,
    /** Не молчим о деградации: воркер недоступен, считаем на главном потоке. */
    fallbackNotice: false,
    /**
     * Сколько ответов модели прошло с последнего полного подсчёта — дроссель
     * автоподсчёта (`auto.mjs`). `Infinity` означает «в этом чате прохода ещё не
     * было»: открытый чат ничего не ждёт, ждать ему нечего.
     */
    sinceCount: Infinity,
    /**
     * Якорь темпа: снимок счётчиков в известной точке прошлого. Живёт своим
     * ключом в хранилище и НЕ обесценивается вместе с кешем — иначе первая же
     * правка сообщения стёрла бы всю историю сравнения (см. `storage.js`).
     */
    anchor: null,
};

/**
 * Поставить якорь правила, как только будет чем.
 *
 * Галочку можно включить на непосчитанном чате — снимать тогда нечего, а
 * молча превращать якорь правила в автоматический нельзя: человек включил
 * правило и вправе ждать, что отсчёт пойдёт отсюда.
 */
let wantPromptAnchor = false;

/**
 * Настоящий объект ядра для запасного режима (`state.session.kind === 'main'`).
 * Не часть `state`: это живой объект с методами, а не данные для панели, и в
 * воркер-режиме его попросту нет.
 */
let coreSession = null;

let panel = null;
let badges = null;
let settings = { ...DEFAULTS };

const chatOpen = () => state.hasChat;

/** Ключи скрытых оборотов — множеством, потому что спрашивают их на каждой строке. */
const ignoredKeys = () => new Set((settings.ignored ?? []).map(e => e.key));

/**
 * То, что видит пользователь: итог без скрытых оборотов.
 *
 * Скрытие — это показ, а не пересчёт. Сам итог остаётся полным: его сохраняет
 * кеш и по нему считается индекс. Иначе снятие галочки со скрытого оборота
 * требовало бы полного пересчёта чата, а сам оборот исчез бы из сохранённых
 * данных навсегда.
 */
function visibleResult() {
    return state.result ? withoutIgnored(state.result, ignoredKeys()) : null;
}

function draw() {
    if (!panel) return;
    const result = visibleResult();
    const hiddenHere = state.result ? splitIgnored(state.result, ignoredKeys()).hidden.length : 0;
    const format = settings.promptFormat ?? 'rule';
    const prompt = result ? promptForResult(result) : null;

    panel.render({
        ...state,
        chatOpen: chatOpen(),
        result,
        hiddenHere,
        settings,
        promptTemplate: settings.promptTemplates?.[format] || defaultTemplate(format, getLocale()),
        promptText: prompt?.text ?? '',
        // Попадание правила считается по тому же списку, что показан в
        // предпросмотре, — иначе при ротации число относилось бы к другому набору.
        promptHits: promptHits(prompt?.phrases, { lastIndex: lastMessageIndex(state.result) }),
        // Знак темпа панель считает сама на каждой строке: это чистая функция от
        // записи оборота, и держать её итог в состоянии значило бы синхронизировать
        // ещё одну копию данных. Отсюда — только то, чего в записи нет.
        trend: trendContext(),
    });
}

// --- клиент воркера -----------------------------------------------------

/**
 * Клиент модульного воркера: очередь запросов по id, ответы адресные.
 * Протокол воркера подробно описан в шапке `worker.js`.
 */
function createWorkerClient(onFatal) {
    const url = new URL('./worker.js', import.meta.url);
    const worker = new Worker(url, { type: 'module' });
    const pending = new Map();

    worker.addEventListener('message', e => {
        const { type, id } = e.data ?? {};
        if (type === 'progress') {
            pending.get(id)?.onProgress?.(e.data.done, e.data.total);
            return;
        }
        const entry = pending.get(id);
        if (!entry) return; // ответ на уже отменённый или чужой запрос
        pending.delete(id);
        if (type === 'done') entry.resolve(e.data.result);
        else entry.reject(new Error(e.data.message ?? 'ошибка воркера'));
    });

    // Фатальная ошибка воркера (например, модуль не загрузился) — воркер в
    // этом сеансе больше не поднимется, дальше только запасной путь.
    worker.addEventListener('error', event => {
        const error = event.error ?? new Error(event.message || 'воркер упал');
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
        onFatal();
    });

    return {
        start(id, names, topLimit, messages, onProgress) {
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject, onProgress });
                worker.postMessage({ type: 'start', id, names, topLimit, messages });
            });
        },
        append(id, message) {
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                worker.postMessage({ type: 'append', id, message });
            });
        },
        drop(id) {
            worker.postMessage({ type: 'drop', id });
        },
    };
}

let workerClient = null;
// Раз воркер не поднялся или упал — не пытаться снова в этом сеансе: молчаливые
// повторные попытки только прячут проблему, а панель уже сказала о запасном режиме.
let workerBroken = false;

/** Воркер создаётся лениво, при первом подсчёте — не поднимать поток тем, кто панель не открывал. */
function getWorker() {
    if (workerBroken) return null;
    if (workerClient) return workerClient;
    try {
        workerClient = createWorkerClient(() => { workerBroken = true; });
        return workerClient;
    } catch (error) {
        console.error('[anti-slop] воркер не поднялся — считаю на главном потоке:', error);
        workerBroken = true;
        return null;
    }
}

// --- счёт -----------------------------------------------------------------

/**
 * Посчитать самому, если настройка это разрешает и есть что считать.
 *
 * Правило целиком живёт в `auto.mjs` — здесь только снимок состояния для него.
 * Вызывается отовсюду, где состояние могло стать «досчитать больше нельзя»:
 * открытие чата, новый ответ, устаревание чисел, включение самой галочки.
 * Лишний вызов безвреден: правило отвечает «нет» на всё, что в порядке.
 */
function maybeAuto() {
    const go = shouldAutoCount({
        enabled: !!settings.autoEnabled,
        every: settings.autoEvery,
        since: state.sinceCount,
        chatOpen: chatOpen(),
        busy: state.busy,
        hasSession: !!state.session,
        hasResult: !!state.result,
        dirty: state.dirty,
    });
    if (go) void recount();
}

/** Отменить то, что сейчас живёт как сессия счёта (не сам подсчёт — см. `gen`). */
function cancelRunning() {
    if (state.session?.kind === 'worker' && workerClient) workerClient.drop(state.gen);
    state.session = null;
    coreSession = null;
}

/**
 * Досчитать чат в воркере, а если он недоступен — на главном потоке.
 *
 * Возвращает готовый итог или `null`, если счёт отменили (сменили чат или
 * нажали кнопку ещё раз) прежде, чем он завершился.
 */
async function countChat(gen, names, messages) {
    const client = getWorker();
    if (client) {
        try {
            const result = await client.start(gen, names, TOP_LIMIT, messages, (done, total) => {
                if (gen !== state.gen) return; // досчитанное больше никого не интересует
                state.progress = { done, total };
                draw();
            });
            if (gen !== state.gen) {
                client.drop(gen); // чат сменился, пока считал воркер, — сессия там больше не нужна
                return null;
            }
            state.session = { kind: 'worker', lastIndex: messages[messages.length - 1].index };
            return result;
        } catch (error) {
            console.error('[anti-slop] воркер сорвался — считаю на главном потоке:', error);
            workerBroken = true;
        }
    }
    return countOnMainThread(gen, names, messages);
}

/**
 * Запасной путь: считаем прямо здесь. Уступка интерфейсу — раз в ~50 мс
 * работы, не на каждом сообщении: `await` тоже стоит денег, а сплошной проход
 * без единой уступки на длинном чате (`tools/bench`: 1274 мс) вешает вкладку
 * ровно так, как воркер и должен был предотвратить.
 *
 * `session.result()` уступки не имеет — разорвать один проход по кандидатам
 * нельзя, и это принимается как есть: на длинном чате он стоит около 390 мс.
 */
async function countOnMainThread(gen, names, messages) {
    if (gen === state.gen) state.fallbackNotice = true;

    const session = createAnalysis({
        names,
        topLimit: TOP_LIMIT,
        // Тексты уже лежат в `context.chat` — второй копии в памяти не заводим.
        readText: i => st.textAt(i),
    });

    let sliceStart = performance.now();
    for (let i = 0; i < messages.length; i++) {
        session.push(messages[i]);

        if (performance.now() - sliceStart >= 50) {
            if (gen === state.gen) {
                state.progress = { done: i + 1, total: messages.length };
                draw();
            }
            await new Promise(resolve => setTimeout(resolve, 0));
            if (gen !== state.gen) return null; // отменили посреди счёта
            sliceStart = performance.now();
        }
    }
    if (gen !== state.gen) return null;

    const result = session.result();
    if (gen !== state.gen) return null;

    state.session = { kind: 'main', lastIndex: session.lastIndex };
    coreSession = session;
    return result;
}

/**
 * Собрать сессию и прогнать по ней весь чат.
 *
 * Повторное нажатие кнопки во время счёта — не второй параллельный подсчёт, а
 * отмена текущего и счёт заново: `cancelRunning()` роняет прежнюю сессию,
 * `gen` увеличивается, и всё, что несёт на себе старое поколение (ответы
 * воркера, шаги запасного цикла), дальше игнорируется.
 */
async function recount() {
    if (!chatOpen()) return;

    cancelRunning();
    const gen = ++state.gen;

    state.busy = true;
    state.error = null;
    state.progress = null;
    state.fallbackNotice = false;
    state.stage = 'reading';
    draw();

    try {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (gen !== state.gen) return; // отменили, пока ждали кадр отрисовки

        const { names, characterName } = st.chatNames();
        const messages = st.modelMessages(names);
        state.names = names;

        if (!messages.length) {
            state.session = null;
            state.result = null;
            state.dirty = false;
            state.error = 'status.noMessages';
            return;
        }

        state.stage = 'counting';
        state.stageCount = messages.length;
        state.progress = { done: 0, total: messages.length };
        draw();

        const result = await countChat(gen, names, messages);
        if (gen !== state.gen || result == null) return; // отменили, пока считали

        // Страховка: имена собираются сами, но если имя
        // карточки всё же просочилось в обороты — стоп-лист промахнулся, и топ
        // будет забит оборотами с именем. Молчать об этом нельзя.
        const leaked = characterName && result.stats.words
            && result.top.some(item => (item.text ?? '').toLowerCase().includes(characterName.toLowerCase()));
        state.notice = leaked ? characterName : null;

        state.result = result;
        state.fromCache = false;
        state.dirty = false;
        afterResult();

        await saveCache(state.chatId, st.signature(names), result);
    } catch (error) {
        if (gen !== state.gen) return;
        console.error('[anti-slop] подсчёт сорвался:', error);
        state.error = 'status.failed';
        state.session = null;
        coreSession = null;
    } finally {
        if (gen === state.gen) {
            state.busy = false;
            state.stage = null;
            state.progress = null;
            // Дроссель отсчитывается и от сорвавшегося прохода тоже: иначе
            // расширение, у которого счёт падает, ломилось бы пересчитывать на
            // каждый ответ, и консоль заполнялась бы одной и той же ошибкой.
            state.sinceCount = 0;
            draw();

            // Ответы, пришедшие пока считали, — теперь их есть куда досчитать.
            if (missedWhileBusy) {
                missedWhileBusy = false;
                catchUp();
            }
        }
    }
}

// Кеш пишется не на каждый ответ: на длинном чате запись стоит дороже, чем
// досчёт одного сообщения, а потерять её не страшно — она восстановится.
let saveTimer = null;
function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        if (state.result && !state.dirty) saveCache(state.chatId, st.signature(state.names), state.result);
    }, 3000);
}

/** Очередь досчётов: следующий `append` не уходит воркеру, пока не вернулся предыдущий. */
let appendChain = Promise.resolve();

/** Приходил ли ответ, пока шёл полный подсчёт. См. `append` и `catchUp`. */
let missedWhileBusy = false;

/**
 * Досчитать всё, что появилось в чате, пока шёл полный подсчёт.
 *
 * Номера не запоминаются: их могло прийти несколько, а событие о каждом уже
 * прошло. Проще посмотреть, что в чате есть сейчас, и досчитать всё, чего нет
 * в сессии, — тем же путём, что и обычный ответ, то есть через очередь и с той
 * же проверкой порядка.
 */
function catchUp() {
    if (!state.session) return;
    for (const m of st.modelMessages(state.names)) {
        if (m.index > state.session.lastIndex) append(m.index);
    }
}

/**
 * Досчитать один пришедший ответ.
 *
 * Ради этого сессия и живёт (в воркере или, в запасном режиме, в
 * `coreSession`): счётчик и детектор накопительные, и новый ответ добавляется
 * к посчитанному. Условие одно — номер должен быть больше последнего
 * учтённого; в воркер-режиме это единственное, что вообще знает о сессии
 * главный поток, и хранится оно в `state.session.lastIndex`. Всё, что
 * нарушает порядок (правка, удаление, свайп), помечает чат как требующий
 * полного пересчёта.
 */
function append(index) {
    // Ответ пришёл, пока идёт полный подсчёт. Список сообщений для него уже
    // снят, и этого ответа в нём нет — досчитать его сейчас некуда, а
    // промолчать нельзя: он навсегда выпал бы из статистики, потому что
    // следующий ответ пройдёт проверку «номер больше последнего» и закроет
    // дыру собой. Запоминаем номер и досчитываем, когда подсчёт кончится.
    if (state.busy) {
        missedWhileBusy = true;
        return;
    }
    const chat = st.ctx().chat ?? [];
    const m = chat[index];
    if (!st.isModelMessage(m, state.names)) return;

    // Чат мог быть пуст в момент открытия — теперь в нём есть что считать.
    state.hasChat = true;

    // Дроссель автоподсчёта считает ответы модели, а не события: реплики
    // пользователя и служебные вставки сюда не доходят, и «раз в пять ответов»
    // означает пять ответов модели, а не пять строк в чате. Счётчик растёт и
    // тогда, когда досчитать нельзя, — иначе устаревшие числа не догнали бы чат
    // никогда: догонять их и есть работа дросселя.
    state.sinceCount++;

    if (state.dirty) {
        maybeAuto();
        return;
    }

    // Сессии нет — значит, показанные числа пришли из кеша прошлого сеанса.
    // Досчитать не к чему: говорим, что числа устарели, и ждём кнопки (или,
    // если автоподсчёт включён, считаем сами — за нас это решит `maybeAuto`
    // внутри `invalidate`).
    if (!state.session) {
        if (state.result) invalidate();
        else maybeAuto(); // чата не считали ни разу: устаревать нечему
        return;
    }
    if (!(index > state.session.lastIndex)) return;

    // Фиксируем номер сразу, а не после ответа воркера: иначе два подряд
    // пришедших MESSAGE_RECEIVED оба пройдут проверку «номер больше
    // последнего», пока первый ещё стоит в очереди и не подтверждён.
    state.session.lastIndex = index;

    const gen = state.gen;
    const message = { index, name: m.name, mes: st.messageText(m) };

    // Строго по порядку номеров: следующий append ждёт, пока вернётся предыдущий.
    appendChain = appendChain.then(() => doAppend(gen, message));
}

async function doAppend(gen, message) {
    if (gen !== state.gen) return; // чат сменился, пока сообщение стояло в очереди

    try {
        let result;
        if (state.session?.kind === 'worker') {
            const client = getWorker();
            if (!client) throw new Error('воркер недоступен');
            result = await client.append(gen, message);
        } else if (state.session?.kind === 'main') {
            coreSession.push(message);
            result = coreSession.result();
        } else {
            return; // сессию успели сбросить, пока сообщение стояло в очереди
        }

        if (gen !== state.gen) return; // отменили, пока ждали ответ

        state.result = result;
        state.fromCache = false;
        afterResult();
        saveSoon();
        draw();
    } catch (error) {
        if (gen !== state.gen) return;
        // Протокол воркера: если сессии нет (например, воркер перезапустился
        // или уже был выброшен), он отвечает ошибкой, а не молчит. Досчитать
        // нечего — считаем заново, а не оставляем панель с устаревшими числами.
        console.error('[anti-slop] досчёт сорвался — пересчитываю заново:', error);
        void recount();
    }
}

/** Пометить, что числа устарели. Сессию при этом выбрасываем: вычесть из счётчика нельзя. */
function invalidate() {
    if (!state.result && !state.session) return;
    if (state.session?.kind === 'worker' && workerClient) workerClient.drop(state.gen);
    state.session = null;
    coreSession = null;
    state.dirty = true;
    draw();
    maybeAuto();
}

/** Смена чата: своё состояние забываем целиком, для нового пробуем кеш. */
async function switchChat() {
    clearTimeout(saveTimer);
    // Счёт для прежнего чата, если он ещё идёт, должен перестать что-либо
    // менять: роняем его сессию и увеличиваем поколение — все запросы и
    // шаги запасного цикла со старым `gen` дальше игнорируются.
    cancelRunning();
    state.gen++;
    missedWhileBusy = false;

    state.chatId = st.chatId();
    state.hasChat = (st.ctx().chat?.length ?? 0) > 0;
    state.session = null;
    state.result = null;
    state.fromCache = false;
    state.dirty = false;
    state.error = null;
    state.notice = null;
    state.progress = null;
    state.fallbackNotice = false;
    state.busy = false;
    state.stage = null;
    state.names = st.chatNames().names;
    state.anchor = null;
    // Новый чат ничего не ждёт: дроссель отсчитывает ответы от последнего прохода
    // ПО ЭТОМУ чату, а его не было. Иначе, открыв непосчитанный чат, человек с
    // включённым автоподсчётом сидел бы без чисел до пятого ответа.
    state.sinceCount = Infinity;
    wantPromptAnchor = false;

    // Числа прежнего чата не должны пережить смену ни в разметке, ни в промпте:
    // бейджи чужого чата сели бы на сообщения по совпадению номеров.
    badges?.clear();
    st.setPrompt('');
    draw();

    if (!chatOpen()) return;
    // У временного чата номера нет: таверна не пишет его на диск. Кеша и якоря
    // ему не полагается, а вот считать его автоподсчёт обязан — это такой же чат.
    if (!state.chatId) {
        maybeAuto();
        return;
    }

    const chatId = state.chatId;
    const [cached, anchor] = await Promise.all([
        loadCache(chatId, st.signature(state.names)),
        loadAnchor(chatId),
    ]);
    // Пока читали, пользователь мог уйти в другой чат.
    if (chatId !== st.chatId()) return;

    state.anchor = anchor;
    // Правило включено, а якоря у этого чата ещё нет: ставим его здесь и сейчас,
    // как только будет с чего снять. Это и есть «отсчёт с момента, как я начала
    // пользоваться правилом в этом чате».
    wantPromptAnchor = !!settings.promptEnabled && !anchor;

    if (cached) {
        state.result = cached.result;
        state.fromCache = true;
        afterResult();
        draw();
    }

    // Кеш подошёл — считать нечего: числа верные, и автоподсчёт это знает
    // (`auto.mjs`). Не подошёл или его нет — вот тогда проход и пойдёт.
    maybeAuto();
}

// --- то, что делается с готовым итогом --------------------------------------

/** Контекст темпа: номер последнего сообщения и якорь. Один на всех, кому он нужен. */
function trendContext() {
    return { lastIndex: lastMessageIndex(state.result), anchor: state.anchor };
}

/**
 * Текст, который уйдёт в промпт при нынешних настройках, и сам список оборотов.
 *
 * Знание о темпе собирается здесь и уходит в `prompt.mjs` функцией: сам якорь
 * живёт в хранилище браузера, и чистый модуль о нём знать не должен.
 *
 * Ротация включена всегда, когда известен номер последнего сообщения. Она
 * привязана к нему, а не к моменту вызова: два вызова подряд — панель рисует
 * предпросмотр, адаптер ставит правило в промпт — обязаны дать один и тот же
 * текст, иначе человек увидит в предпросмотре не то, что уехало модели.
 */
function promptForResult(result) {
    const format = settings.promptFormat ?? 'rule';
    const ctx = trendContext();
    return promptParts(result, {
        format,
        template: settings.promptTemplates?.[format] || '',
        limit: settings.promptCount ?? 8,
        locale: getLocale(),
        lastIndex: ctx.lastIndex,
        trend: item => phraseTrend(item, ctx),
        rotate: true,
    });
}

/** Только текст — там, где список не нужен. */
const buildPromptText = result => promptForResult(result).text;

/**
 * Подвинуть якорь темпа, если пора, и записать его.
 *
 * Якорь снимается с ПОЛНОГО итога, а не с того, что видит пользователь: скрытый
 * оборот можно вернуть в список обратно, и без его счётчика в снимке сравнивать
 * стало бы не с чем.
 *
 * Запись редкая по устройству `advanceAnchor`: он отвечает `null`, пока двигать
 * нечего, то есть на подавляющем большинстве досчётов. Отдельного откладывания,
 * как у кеша (`saveSoon`), здесь не нужно.
 */
function updateAnchor() {
    if (!state.result) return;

    let next = null;
    if (wantPromptAnchor) {
        next = makeAnchor(state.result, 'prompt');
        if (next) wantPromptAnchor = false;
    } else {
        next = advanceAnchor(state.anchor, state.result);
    }
    if (!next) return;

    state.anchor = next;
    void saveAnchor(state.chatId, next);
}

/**
 * Разложить свежий итог по остальным местам: якорь темпа, бейджи и вставка в
 * промпт.
 *
 * Отдельной функцией, потому что мест, где появляется новый итог, три (полный
 * подсчёт, досчёт ответа, кеш при открытии чата), и забыть одно из них — значит
 * получить чат, где бейджи есть, а правило в промпт не уехало.
 */
function afterResult() {
    updateAnchor();
    badges?.update(state.result?.messages, settings.badges);

    if (!settings.promptEnabled || !state.result) {
        st.setPrompt('');
        return;
    }
    st.setPrompt(buildPromptText(visibleResult()), settings.promptDepth);
}

// --- обработчики панели -----------------------------------------------------

/**
 * Скопировать в буфер.
 *
 * `navigator.clipboard` есть не везде: в некоторых встроенных браузерах и на
 * страницах без защищённого соединения его нет вовсе. Поэтому запасной путь
 * через скрытое поле — старый, некрасивый и работающий там, где не работает
 * ничего другого. Молчать при неудаче нельзя: человек нажал кнопку и ушёл
 * вставлять пустоту.
 */
async function copyText(text) {
    if (!text) return false;
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (error) {
        console.warn('[anti-slop] буфер обмена недоступен, пробую по-старому:', error);
    }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    } catch (error) {
        console.error('[anti-slop] скопировать не вышло:', error);
        return false;
    }
}

async function onCopy(kind) {
    const result = visibleResult();
    if (!result) return;

    const text = kind === 'prompt' ? buildPromptText(result)
        : kind === 'list' ? buildList(result, TOP_LIMIT)
            : toSlopListJson(result, { limit: TOP_LIMIT });

    panel.flash(await copyText(text) ? 'export.copied' : 'export.copyFailed');
}

async function onCard() {
    const result = visibleResult();
    if (!result) return;

    panel.flash('card.saving');
    try {
        const title = st.chatTitle();
        const blob = await drawCard({
            title,
            index: result.index?.value,
            draft: !!result.index?.draft,
            mattr: result.diversity?.mattr,
            words: result.stats?.words,
            messages: result.messages?.length ?? 0,
            top: result.top.slice(0, 6).map(item => ({ text: item.text, count: item.count })),
        });
        await shareCard(blob, cardFilename(title));
    } catch (error) {
        console.error('[anti-slop] карточка не нарисовалась:', error);
        panel.flash('card.failed');
    }
}

/** Сменить настройку и разложить последствия. Пишем сразу: настройки мелкие. */
function onSetting(key, value) {
    settings[key] = value;
    st.saveSettings();

    if (key === 'lang') applyLocale();
    if (key === 'badges') badges?.update(state.result?.messages, settings.badges);

    // Момент включения галочки — единственная точка, про которую расширение
    // вправе сказать «до правила было так, а после эдак». Поэтому якорь здесь
    // ставится заново, даже если автоматический уже был: тот просто точка в
    // прошлом, а этот — граница события.
    if (key === 'promptEnabled') {
        if (value) {
            wantPromptAnchor = true;
        } else {
            wantPromptAnchor = false;
            // Правило выключено — ссылаться на него в подписях больше нельзя, но
            // и выбрасывать снимок незачем: как обычная точка отсчёта он годен,
            // а заодно снова начнёт двигаться следом за чатом.
            if (state.anchor?.reason === 'prompt') {
                state.anchor = { ...state.anchor, reason: 'auto' };
                void saveAnchor(state.chatId, state.anchor);
            }
        }
    }
    if (key === 'promptEnabled' || key === 'promptFormat' || key === 'promptCount' || key === 'promptDepth') {
        afterResult();
    }
    // Галочку включают, глядя на чат, числа которого уже устарели, — и ждут, что
    // расширение разберётся с ним прямо сейчас, а не с пятого следующего ответа.
    if (key === 'autoEnabled' || key === 'autoEvery') maybeAuto();
    draw();
}

/** Правка шаблона. `null` — вернуть умолчание, то есть забыть свой текст. */
function onTemplate(format, text) {
    if (!settings.promptTemplates) settings.promptTemplates = { ...DEFAULTS.promptTemplates };
    settings.promptTemplates[format] = text == null ? '' : text;
    st.saveSettings();
    afterResult();
    draw();
}

function onHide(item) {
    const entry = ignoreEntry(item);
    if (!entry.key) return;
    if (!settings.ignored.some(e => e.key === entry.key)) settings.ignored.push(entry);
    st.saveSettings();
    // Скрытый оборот не должен остаться в промпте: он туда попадал ровно потому,
    // что стоял в топе, а пользователь только что сказал, что это не повтор.
    afterResult();
    draw();
}

function onUnhide(key) {
    settings.ignored = settings.ignored.filter(e => e.key !== key);
    st.saveSettings();
    afterResult();
    draw();
}

function onUnhideAll() {
    settings.ignored = [];
    st.saveSettings();
    afterResult();
    draw();
}

/** Выбрать язык: свой, если задан, иначе язык таверны. */
function applyLocale() {
    setLocale(settings.lang && settings.lang !== 'auto' ? settings.lang : st.locale());
}

function install() {
    settings = st.settings(DEFAULTS);
    // Две поправки к тому, что вернул адаптер.
    //
    // Первая: настройки могли приехать из версии, где этих ключей ещё не было —
    // `settings` дописывает только отсутствующие ключи верхнего уровня, и
    // вложенный объект шаблонов может оказаться неполным.
    //
    // Вторая, менее очевидная: недостающие ключи адаптер берёт из `DEFAULTS` как
    // есть, ссылкой. Первое же скрытие оборота дописало бы оборот в сам массив
    // умолчаний, и он остался бы там до перезагрузки вкладки — то есть «вернуть
    // всё» перестало бы возвращать. Поэтому и массив, и объект здесь пересобираются.
    settings.promptTemplates = { ...DEFAULTS.promptTemplates, ...(settings.promptTemplates ?? {}) };
    settings.ignored = Array.isArray(settings.ignored) ? [...settings.ignored] : [];
    applyLocale();

    badges = mountBadges();
    panel = mountPanel({
        onAnalyze: () => recount(),
        onJump: index => st.scrollToMessage(index),
        onHide,
        onUnhide,
        onUnhideAll,
        onSetting,
        onTemplate,
        onCopy,
        onCard,
    });

    // Считаем на получении, а не на отрисовке: данные уже в `chat`, разметка
    // придёт через десяток миллисекунд и нам не нужна.
    st.on('MESSAGE_RECEIVED', index => append(Number(index)));

    // Правка: новый текст записан в `chat` уже к `MESSAGE_EDITED`, но досчитать
    // его нельзя — из накопительного счётчика старый текст не вычесть.
    st.on('MESSAGE_EDITED', () => invalidate());
    st.on('MESSAGE_DELETED', () => invalidate());
    // Переключение свайпа генерации не создаёт, но текст подменяет — те же грабли.
    st.on('MESSAGE_SWIPED', () => invalidate());

    st.on('CHAT_CHANGED', () => switchChat());

    // Чат мог быть открыт до нас — расширения грузятся после него.
    switchChat();

    // Отладочная ручка. В релизе она безвредна, а без неё любая проверка на
    // живой таверне превращается в кликанье.
    globalThis.antislop = {
        get state() { return state; },
        get settings() { return settings; },
        get prompt() { return state.result ? buildPromptText(visibleResult()) : ''; },
        recount,
        // Перерисовать панель по текущему состоянию. Нужна не для отладки ради
        // отладки: проверить график, скрытие оборота и карточку можно только на
        // чате, где повторы есть, а такого чата на установке может не быть —
        // тогда состояние подставляется руками, и панель надо чем-то обновить.
        redraw: draw,
        drop: () => dropCache(st.chatId()),
        t,
    };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
} else {
    install();
}
