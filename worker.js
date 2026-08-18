/**
 * worker.js — счёт в отдельном потоке.
 *
 * То же ядро, что и на главном потоке (`index.js`), только внутри
 * `Worker({type:'module'})`. Разведка производительности (`tools/bench/`)
 * показала, почему это вообще нужно: на десктопном чате в 166 378 слов прозы
 * полный проход на главном потоке — 1274 мс ОДНИМ неразрывным куском, между
 * кадрами дыра 1270,9 мс, пропущено 75 кадров — интерфейс таверны на это время
 * мёртв. Тот же проход в модульном воркере — 1534 мс работы, но на главном
 * потоке ни одного пропущенного кадра, самый долгий промежуток между кадрами
 * 7,1 мс. Разница в 260 мс общего времени — это и есть цена за то, что
 * интерфейс всё это время живой. Стенд там же сверил итог воркера с итогом
 * главного потока — индекс, топ-10, слова и находки совпадают.
 *
 * Протокол — по одному `id` на запрос (в расширении `id` — это поколение
 * счёта, `state.gen` в `index.js`), ответы адресные:
 *
 *   {type:'start', id, names, topLimit, messages} — создать сессию и прогнать
 *     по ней весь чат. По ходу — {type:'progress', id, done, total}, не чаще
 *     раза в 100 мс: `postMessage` на каждое из полутора сотен сообщений сам
 *     по себе не бесплатен, а чаще 100 мс глазу всё равно не нужно. В конце —
 *     {type:'done', id, result}.
 *   {type:'append', id, message} — досчитать один ответ в живой сессии,
 *     вернуть {type:'done', id, result}. Если сессии с таким id нет —
 *     {type:'error', id, message}: главный поток на это отвечает полным
 *     пересчётом, а не молчаливой потерей ответа.
 *   {type:'drop', id} — выбросить сессию (смена чата на главном потоке или
 *     отмена текущего счёта), без ответа.
 *   любая другая ошибка — {type:'error', id, message} со стеком в тексте.
 *
 * Сессия в воркере одна живая за раз, ключ — тот же `id`, что был у 'start'.
 * Новый 'start' выбрасывает прежнюю сессию, чем бы она ни была, — иначе
 * память росла бы от чата к чату у тех, кто ни разу не перезагружал вкладку.
 */

import { createAnalysis } from './core/analyze.mjs';

/** Живая сессия: {id, session} или null. Не Map — сессия всегда одна. */
let current = null;

/** Не чаще раза в 100 мс — см. комментарий в шапке файла. */
const PROGRESS_INTERVAL_MS = 100;

function handleStart({ id, names, topLimit, messages }) {
    // Своих текстов у воркера нет — сессия хранит их сама (own-хранилище,
    // см. комментарий в core/analyze.mjs у параметра readText). Это ровно тот
    // случай, для которого оно сделано: на главном потоке текст лежит в
    // context.chat, а воркеру взять его неоткуда, кроме как из присланных
    // сообщений.
    current = { id, session: createAnalysis({ names, topLimit }) };

    const total = messages.length;
    let lastProgressAt = 0;
    for (let i = 0; i < total; i++) {
        current.session.push(messages[i]);

        const now = performance.now();
        // Последний прогресс шлём всегда, даже если 100 мс не набежало —
        // иначе на быстром чате счётчик на главном потоке замрёт на «99 из 100».
        if (now - lastProgressAt >= PROGRESS_INTERVAL_MS || i === total - 1) {
            lastProgressAt = now;
            self.postMessage({ type: 'progress', id, done: i + 1, total });
        }
    }

    self.postMessage({ type: 'done', id, result: current.session.result() });
}

function handleAppend({ id, message }) {
    if (!current || current.id !== id) {
        // Главный поток мог перезапустить воркер (перезагрузка страницы) или
        // прислать append для сессии, которую сам же уже выбросил, — в обоих
        // случаях досчитывать нечего, и это не тихая ошибка, а сигнал: нужен
        // полный пересчёт.
        throw new Error('сессии для append нет — досчитывать нечего, нужен полный пересчёт');
    }
    current.session.push(message);
    self.postMessage({ type: 'done', id, result: current.session.result() });
}

function handleDrop({ id }) {
    if (current && current.id === id) current = null;
}

self.addEventListener('message', (e) => {
    const { type, id } = e.data ?? {};
    try {
        if (type === 'start') handleStart(e.data);
        else if (type === 'append') handleAppend(e.data);
        else if (type === 'drop') handleDrop(e.data);
    } catch (error) {
        self.postMessage({ type: 'error', id, message: String(error?.stack ?? error) });
    }
});
