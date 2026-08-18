// core/analyze — сборка ядра в один проход по чату.
//
// На вход разобранный чат, на выход топ
// оборотов, индекс по сообщениям, разнообразие и находки самоповтора. Ничего не
// знает ни про браузер, ни про SillyTavern: сюда приходят уже вытащенные из
// экспорта сообщения, а кто их вытащил — стенд на Node или адаптер расширения —
// модулю безразлично.
//
// Порядок внутри одного сообщения важен и зафиксирован:
//
//   1. считаем покрытие повторами ПРОТИВ словаря на момент до этого сообщения;
//   2. сравниваем с предыдущими сообщениями;
//   3. и только теперь добавляем сообщение в словарь и в детектор.
//
// Иначе сообщение окажется повторяющим само себя, и индекс будет тем выше, чем
// оно длиннее — то есть померяет многословность.

import { tokenizeMessage, namesFromChat, nameBarriers } from './tokenize.mjs';
import { createCounter } from './ngrams.mjs';
import { cvalue } from './cvalue.mjs';
import { diversity } from './diversity.mjs';
import { createDetector } from './similarity.mjs';
import { messageIndex, chatIndex } from './index.mjs';

/**
 * Сессия анализа: тот же проход, но растянутый во времени.
 *
 * Нужна расширению. Счётчик и детектор по устройству накопительные — сообщение
 * добавляется к тому, что уже посчитано, — и заново гонять весь чат ради одного
 * пришедшего ответа незачем. Но правило «покрытие и самоповтор считаются до
 * добавления в словарь» из шапки модуля соблюсти можно только внутри ядра,
 * поэтому сессия живёт здесь, а не в адаптере: иначе порядок пришлось бы
 * повторить второй раз в браузере и следить, чтобы две копии не разошлись.
 *
 * `analyzeChat` — та же сессия, прогнанная разом.
 *
 * @param {{names?: Iterable<string>, topLimit?: number, counter?: object,
 *          stem?: boolean, readText?: (i: number) => (string|null|undefined)}} [opts]
 *   `names` — стоп-лист имён целиком: в отличие от `analyzeChat`, сессия не
 *   видит чат заранее и собрать их сама не может;
 *   `readText` — как достать текст сообщения по номеру для восстановления строк
 *   (второй проход по верхушке списка). По умолчанию сессия хранит
 *   тексты сама; расширению это не нужно — они уже лежат в `context.chat`.
 */
export function createAnalysis(opts = {}) {
  const { names = [], topLimit = 50, counter: counterOpts = {}, stem = true } = opts;

  const nameSet = new Set(names);
  const barriers = nameBarriers(nameSet);

  const counter = createCounter(counterOpts);
  const detector = createDetector();

  const messages = [];
  const allWords = [];
  let droppedTotal = 0;

  // Своё хранилище текстов заводится только если снаружи не сказали, где их
  // брать. В расширении сказали, и копии не будет.
  const own = opts.readText ? null : new Map();
  const readText = opts.readText ?? (i => own.get(i));

  const parse = mes => tokenizeMessage(mes, { barriers, stem: true });

  return {
    /**
     * Учесть одно сообщение модели.
     *
     * @param {{index: number, name?: string, mes: string}} message
     *   `index` — номер, под которым сообщение будет искаться потом: в стенде
     *   это позиция в списке, в расширении — `mesid` таверны. Номера обязаны
     *   идти по возрастанию: и счётчик, и детектор считают, что прошлое уже
     *   посчитано.
     * @returns запись сообщения — та же, что попадает в `messages` итога.
     */
    push({ index, name, mes }) {
      if (own) own.set(index, mes);

      // Формы и основы нужны обе: статистика идёт по основам, а подсветка
      // самоповтора — по живым формам («подсвечивать по формам»).
      const parsed = parse(mes);
      const segments = parsed.segments.map(seg => seg.map(t => t.stem));
      const forms = parsed.segments.flat().map(t => t.form);
      const stems = segments.flat();

      // 1. Покрытие — до добавления в словарь.
      const cov = counter.coverage(segments);

      // 2. Самоповтор — только с ранее добавленными.
      const rep = detector.add({ index, stems, forms });

      // 3. И только теперь сообщение попадает в словарь.
      counter.add(index, segments);

      const words = stem ? stems : forms;
      const div = diversity(words);
      const mi = messageIndex({
        coverage: cov.ratio,
        mattr: div.mattr,
        similarity: rep.best?.containment ?? 0,
        words: parsed.words,
      });

      // `dropped` — отчёт splitProse (объект со счётчиками), а не массив:
      // блоки считаются по полю `blocks`.
      droppedTotal += parsed.dropped?.blocks ?? 0;
      allWords.push(...words);

      const record = {
        index,
        name,
        words: parsed.words,
        dropped: parsed.dropped,
        coverage: cov.ratio,
        diversity: div,
        repeat: rep.best,
        slop: mi,
        value: mi.value,
      };
      messages.push(record);
      return record;
    },

    /** Сколько сообщений учтено. */
    get size() { return messages.length; },

    /** Номер последнего учтённого сообщения, или -1. */
    get lastIndex() { return messages.length ? messages[messages.length - 1].index : -1; },

    /** Слов прозы учтено — по нему счётчик решает, когда переходить на таблицу. */
    get words() { return counter.words; },

    /** Итог по всему, что учтено к этому моменту. Считается заново при каждом вызове. */
    result() {
      // Восстановление строк идёт ДО ранжирования, и это не противоречит правилу
      // «строки восстанавливаются только для верхушки». Вложенность в
      // C-value определяется по подстрокам, то есть по основам, — без них ранжировать
      // нечего. Но восстанавливаются не все обороты чата, а только кандидаты:
      // прошедшие порог «трижды и в двух разных сообщениях», то есть проценты от
      // таблицы. Одиночки, ради которых схема и затевалась, до сюда не доходят.
      const cands = counter.candidates({});
      const readMessage = i => {
        const mes = readText(i);
        return mes == null ? [] : parse(mes).segments;
      };
      counter.resolve(cands, readMessage);
      const ranked = cvalue(cands, { limit: topLimit });

      return {
        top: ranked.top.slice(0, topLimit),
        preliminary: ranked.preliminary,
        candidates: ranked.candidates,
        messages,
        findings: detector.findings(),
        baseline: detector.baseline(),
        diversity: diversity(allWords),
        index: chatIndex(messages.map(m => ({ value: m.value, words: m.words }))),
        stats: { ...counter.stats(), droppedBlocks: droppedTotal, names: [...nameSet] },
      };
    },
  };
}

/**
 * Полный анализ чата.
 *
 * @param {{characterName?: string, userName?: string, messages: Array<{name?: string, mes: string}>}} chat
 *   сообщения ТОЛЬКО модели: реплики пользователя в статистику не входят, их
 *   отбирает вызывающий (см. `tools/corpus.mjs`).
 * @param {{extraNames?: string[], topLimit?: number, counter?: object, stem?: boolean}} [opts]
 *   `extraNames` — имена, которых нет в данных чата (в экспортах имя карточки
 *   бывает латиницей или «unused»);
 *   `stem` — по чему считать разнообразие: по основам (по умолчанию) или по
 *   живым формам. Вопрос пока открыт и решается только на живых чатах.
 */
export function analyzeChat(chat, opts = {}) {
  const { extraNames = [], ...rest } = opts;
  const names = new Set([...namesFromChat(chat), ...extraNames]);

  const session = createAnalysis({
    ...rest,
    names,
    // Тексты уже лежат в переданном чате — держать их вторым экземпляром незачем.
    readText: i => chat.messages[i]?.mes,
  });

  chat.messages.forEach((m, idx) => session.push({ index: idx, name: m.name, mes: m.mes }));
  return session.result();
}
