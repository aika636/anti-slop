// core/similarity — детектор самоповтора: похожесть сообщения на предыдущие.
//
// Главное решение: самоповтор — containment, не Жаккар.
// Метод не выдуман здесь заново: он отлажен на реальном
// корпусе стендом `tools/shingle.mjs`, отсюда перенесён в ядро как есть —
// четырёхсловные шинглы по основам, вложенность относительно нового
// сообщения, самый длинный дословный кусок через DP по скользящей строке.
//
// Четыре решения, которые здесь материализуются, и почему они именно такие:
//
//   1. Мера — containment, а не Жаккар. Жаккар штрафует за разницу длин и на
//      реальном случае «в новом сообщении на 300 слов дословно повторён кусок
//      из старого на 800» выдаёт 0,035, то есть ложное «непохоже». Нам нужна
//      вложенность нового в старое, а не симметричное сходство.
//   2. Шингл — четыре слова (см. SHINGLE_K).
//   3. Наружу показывается не коэффициент, а длина самого длинного дословно
//      повторённого фрагмента, и считается она по ЖИВЫМ ФОРМАМ: по основам
//      подсветка не сойдётся с текстом на экране у 12,9% сообщений (померено).
//   4. Порог — от распределения, а не абсолютный. Верхняя пара всего корпуса —
//      5,1%, и в ней 12 слов подряд дословно; интуитивный порог «десятки
//      процентов» не поймал бы ничего. Берутся верхние 5% по похожести с
//      вычетом базовой линии (шаблонное обрамление в каждом сообщении даёт
//      постоянный пол).
//
// Сравнение — только внутри одного чата и только с ПРЕДЫДУЩИМИ сообщениями.
// Один детектор обслуживает один чат: перекрёстное сравнение чатов меряет
// сходство разных историй, а не самоповтор модели.
//
// ЦЕНА. Инкрементально, на одно новое сообщение, точное сравнение со всеми
// предыдущими — единицы миллисекунд, и это то, ради чего детектор написан.
// А вот РЕТРОСПЕКТИВНЫЙ проход по длинному чату квадратичен: тысяча сообщений
// — полмиллиона пар, около минуты на десктопе и несколько минут на телефоне.
// Запасной ход померен: таблица n-грамм
// и так хранит номер первого вхождения каждого четырёхсловного оборота,
// и голосование по нему даёт корреляцию 0,94 с точным значением за один
// проход. Но партнёра оно угадывает лишь в 72,7% случаев — а именно партнёр
// («повторён фрагмент из сообщения №1204») и показывается пользователю.
// Поэтому приближение годится ТОЛЬКО как предварительный отбор подозреваемых
// перед точным сравнением, а не как замена ему; здесь оно сознательно
// не реализовано.

/**
 * Длина шингла — четыре слова. Подтверждена замером, а не унаследована.
 *
 * Три слова — мало: пол (медиана по всем парам) поднимается до 0,875% против
 * верхушки 5,6%, отрыв всего шестикратный. Трёхсловные совпадения даёт обычная
 * русская фраза, и сигнал в них тонет.
 *
 * Пять и больше — тоже мимо: пол обнуляется, но вместе с ним схлопывается и
 * сигнал (на k = 8 вся верхушка укладывается в 1,4%, то есть весь интересный
 * диапазон — один процент, и любое короткое сообщение начинает шуметь). Новых
 * находок длинный шингл не приносит: пары те же самые, только окно уже.
 *
 * На четырёх словах пол 0,132%, верхушка 3,1% — отрыв 23-кратный, лучший из
 * померенных.
 */
export const SHINGLE_K = 4;

/**
 * Короче сорока слов — сообщение не оценивается как ПОДОЗРЕВАЕМОЕ.
 *
 * Причина арифметическая: containment — это доля шинглов нового сообщения, а у
 * сообщения на десять слов шинглов семь, и одно случайное совпадение даёт
 * сразу 14% — выше верхушки всего корпуса. Такое сообщение забило бы и
 * распределение, и топ находок шумом. Порог тот же, по которому отбирались
 * сообщения в замере (`tools/shingle.mjs`), чтобы цифры порога были сравнимы
 * с померенными.
 *
 * Партнёром короткое сообщение при этом быть МОЖЕТ: в знаменателе стоит длина
 * нового сообщения, поэтому короткий старый текст ничего не раздувает, а
 * дословный повтор из него — настоящая находка.
 */
export const MIN_WORDS = 40;

/**
 * Длина дословного куска, с которой повтор «уже заметен» — p90 по корпусу
 * (медиана 6 слов, p90 11, максимум 17). Ядро на
 * эту константу не опирается, она для интерфейса.
 */
export const NOTABLE_RUN_WORDS = 10;

// --- хеш --------------------------------------------------------------------
// FNV-1a по символам слова, затем свёртка хешей слов окна тем же FNV и
// финальное перемешивание (avalanche из murmur3). Свёртка идёт по хешам слов,
// а не по символам всей склейки: хеш слова считается один раз и переиспользуется
// во всех k окнах, где слово участвует.
//
// Про коллизии. Шинглов на сообщение — около 1150 (4,6 КБ), пространство —
// 2^32. На пару сообщений это ~1,3 млн сравнений, то есть порядка 0,03% ложных
// совпадений шинглов. На фоне полезного сигнала в единицы процентов это шум
// третьего знака, а хранение строк стоило бы мегабайтов вместо килобайтов.
// Длина дословного куска считается по настоящим словам, а не по хешам, — там
// коллизии не участвуют вовсе.

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function hashWord(word) {
  let h = FNV_OFFSET;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

function avalanche(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Отпечаток сообщения: хеши всех k-словных шинглов, отсортированные и без
 * повторов.
 *
 * Представление — `Uint32Array`, а не `Set<string>`, и это не микрооптимизация:
 * 4,6 КБ на сообщение против мегабайтов у множества строк, плюс пересечение
 * двух отсортированных массивов идёт слиянием, без хеш-таблицы.
 *
 * @param {string[]} stems основы слов прозы, в порядке текста
 * @param {number} [k] длина шингла
 * @returns {Uint32Array} отсортированные уникальные хеши шинглов
 */
export function fingerprint(stems, k = SHINGLE_K) {
  const n = stems ? stems.length : 0;
  // Сообщение короче шингла шинглов не даёт вообще — пустой отпечаток. Это не
  // ошибка: containment с ним честно равен нулю, находок он не порождает.
  if (!n || k < 1 || n < k) return new Uint32Array(0);

  const wordHash = new Uint32Array(n);
  for (let i = 0; i < n; i++) wordHash[i] = hashWord(stems[i]);

  const out = new Uint32Array(n - k + 1);
  for (let i = 0; i + k <= n; i++) {
    let acc = FNV_OFFSET;
    for (let j = 0; j < k; j++) {
      acc = (acc ^ wordHash[i + j]) >>> 0;
      acc = Math.imul(acc, FNV_PRIME) >>> 0;
    }
    out[i] = avalanche(acc);
  }

  out.sort();
  let w = 0;
  for (let i = 0; i < out.length; i++) {
    if (i === 0 || out[i] !== out[i - 1]) out[w++] = out[i];
  }
  return out.slice(0, w);
}

/**
 * Вложенность: доля шинглов a, встретившихся в b.
 *
 * Мера НЕСИММЕТРИЧНА, и это её смысл. Считать надо относительно НОВОГО
 * сообщения: вопрос «сколько нового текста уже было», а не «насколько два
 * текста похожи». Жаккар отвечает на второй вопрос и на разнице длин даёт
 * ложный отрицательный ответ.
 *
 * @param {Uint32Array} aFp отпечаток нового сообщения
 * @param {Uint32Array} bFp отпечаток старого сообщения
 * @returns {number} 0..1
 */
export function containment(aFp, bFp) {
  const na = aFp ? aFp.length : 0;
  const nb = bFp ? bFp.length : 0;
  if (!na || !nb) return 0;
  let i = 0, j = 0, hit = 0;
  while (i < na && j < nb) {
    const x = aFp[i], y = bFp[j];
    if (x === y) { hit++; i++; j++; }
    else if (x < y) i++;
    else j++;
  }
  return hit / na;
}

// --- самый длинный дословный кусок ------------------------------------------

/**
 * Самая длинная общая подпоследовательность ПОДРЯД, по целочисленным кодам
 * слов. DP по скользящей строке: память O(min-стороны), а не O(n·m).
 */
function longestRunIds(a, b) {
  const na = a.length, nb = b.length;
  if (!na || !nb) return { length: 0, startA: 0, startB: 0 };
  const prev = new Int32Array(nb + 1);
  const cur = new Int32Array(nb + 1);
  let best = 0, endA = 0, endB = 0;
  for (let i = 1; i <= na; i++) {
    cur.fill(0);
    const ai = a[i - 1];
    for (let j = 1; j <= nb; j++) {
      if (ai === b[j - 1]) {
        const len = prev[j - 1] + 1;
        cur[j] = len;
        if (len > best) { best = len; endA = i; endB = j; }
      }
    }
    prev.set(cur);
  }
  return { length: best, startA: endA - best, startB: endB - best };
}

/**
 * Длина самого длинного дословно повторённого фрагмента и его начало в обоих
 * сообщениях.
 *
 * Подавать сюда надо ЖИВЫЕ ФОРМЫ, а не основы: совпадают они лишь у 87,1%
 * сообщений, и на остальных подсветка по основам не сойдётся с текстом на
 * экране. Позиции возвращаются, чтобы интерфейс
 * мог подсветить фрагмент в обоих сообщениях.
 *
 * Слова заранее переводятся в числа: строковое сравнение внутри двойного цикла
 * — самая дорогая часть DP, а словарь на сообщение всё равно маленький.
 *
 * @param {string[]} aForms формы слов нового сообщения
 * @param {string[]} bForms формы слов старого сообщения
 * @returns {{length: number, startA: number, startB: number}} длина в словах и
 *   индексы начала фрагмента в aForms и bForms
 */
export function longestRun(aForms, bForms) {
  const a = aForms || [], b = bForms || [];
  if (!a.length || !b.length) return { length: 0, startA: 0, startB: 0 };
  const dict = new Map();
  const ida = new Int32Array(a.length);
  const idb = new Int32Array(b.length);
  for (let i = 0; i < a.length; i++) {
    let id = dict.get(a[i]);
    if (id === undefined) { id = dict.size; dict.set(a[i], id); }
    ida[i] = id;
  }
  for (let i = 0; i < b.length; i++) {
    // Слова, которых нет в a, совпасть не могут — им хватает общего кода −1.
    const id = dict.get(b[i]);
    idb[i] = id === undefined ? -1 : id;
  }
  return longestRunIds(ida, idb);
}

// --- порог от распределения --------------------------------------------------

/** Квантиль по возрастающему массиву. Тот же способ, что в стенде. */
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/** Медиана по возрастающему массиву. */
function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Детектор самоповтора для ОДНОГО чата.
 *
 * Сообщения добавляются по одному в порядке чата; каждое сразу сравнивается со
 * всеми уже добавленными. DP на самый длинный кусок считается только для
 * лучшего партнёра: гонять его на всех парах — значит съесть всё время на
 * сообщениях, которые ни в какой отчёт не попадут.
 *
 * @param {{k?: number, quantile?: number}} [opts]
 */
export function createDetector(opts = {}) {
  const k = opts.k ?? SHINGLE_K;
  const q = opts.quantile ?? 0.95;

  // Сообщения. Формы хранятся кодами слов, а не строками: DP их и так требует в
  // числах, а память на длинном чате это заметно экономит.
  const docs = [];
  const dict = new Map();          // форма → код, общий на весь чат
  const bests = [];                // лучшая пара каждого сообщения-подозреваемого
  let pairs = new Float32Array(1024);   // все значения похожести — ради точной медианы
  let pairCount = 0;
  let sortedPairs = null;          // кеш, сбрасывается при добавлении

  function encode(forms) {
    const ids = new Int32Array(forms ? forms.length : 0);
    for (let i = 0; i < ids.length; i++) {
      let id = dict.get(forms[i]);
      if (id === undefined) { id = dict.size; dict.set(forms[i], id); }
      ids[i] = id;
    }
    return ids;
  }

  function pushPair(value) {
    if (pairCount === pairs.length) {
      const grown = new Float32Array(pairs.length * 2);
      grown.set(pairs);
      pairs = grown;
    }
    pairs[pairCount++] = value;
  }

  /**
   * Добавить сообщение и сразу сравнить со всеми предыдущими.
   *
   * @param {{index: number, stems: string[], forms?: string[]}} msg
   * @returns {{index: number, best: {index: number, containment: number,
   *   run: {length: number, startA: number, startB: number}} | null,
   *   containmentToPrev: number}}
   */
  function add(msg) {
    const stems = msg.stems || [];
    // Формы обязаны идти отдельным списком: подсветка по основам не сойдётся с
    // экраном. Если их не дали — считаем по основам и молча не врём про это
    // только потому, что интерфейса здесь нет.
    const forms = msg.forms || stems;
    const fp = fingerprint(stems, k);
    const ids = encode(forms);
    const doc = { index: msg.index, fp, ids, words: stems.length };

    // Короткое сообщение подозреваемым не становится (см. MIN_WORDS), но в
    // хранилище кладётся: партнёром быть может.
    const scored = stems.length >= MIN_WORDS && fp.length > 0;

    let bestIdx = -1, bestVal = 0;
    if (scored) {
      for (let j = 0; j < docs.length; j++) {
        const c = containment(fp, docs[j].fp);
        pushPair(c);
        if (c > bestVal) { bestVal = c; bestIdx = j; }
      }
      sortedPairs = null;
    }

    // Похожесть на непосредственно предыдущее сообщение — отдельная величина:
    // она отвечает на вопрос «модель повторяет сама себя прямо сейчас», и
    // считается всегда, даже для коротких, как диагностика.
    const prevDoc = docs.length ? docs[docs.length - 1] : null;
    const containmentToPrev = prevDoc ? containment(fp, prevDoc.fp) : 0;

    let best = null;
    if (bestIdx >= 0) {
      const partner = docs[bestIdx];
      const run = longestRunIds(ids, partner.ids);
      best = { index: partner.index, containment: bestVal, run };
      bests.push({
        index: doc.index,
        partner: partner.index,
        containment: bestVal,
        runLength: run.length,
        startA: run.startA,
        startB: run.startB,
      });
    }

    docs.push(doc);
    return { index: doc.index, best, containmentToPrev };
  }

  function pairsSorted() {
    if (!sortedPairs) {
      sortedPairs = Array.prototype.slice.call(pairs.subarray(0, pairCount)).sort((a, b) => a - b);
    }
    return sortedPairs;
  }

  /**
   * Что получилось полом и порогом.
   *
   * `median` — базовая линия: медиана по ВСЕМ парам. Если в каждом сообщении
   * есть шаблонное обрамление, попарная похожесть получает постоянный пол, и
   * без вычета этого пола находкой оказалось бы каждое сообщение.
   *
   * `threshold` — порог УЖЕ В ШКАЛЕ С ВЫЧЕТОМ БАЗОВОЙ ЛИНИИ: квантиль
   * (по умолчанию 0,95 — «верхние 5%») по величине `лучшая пара − медиана`.
   *
   * @returns {{median: number, threshold: number, pairs: number}}
   */
  function baseline() {
    const med = median(pairsSorted());
    const adjusted = bests.map(b => b.containment - med).sort((a, b) => a - b);
    return { median: med, threshold: quantile(adjusted, q), pairs: pairCount };
  }

  /**
   * Находки: сообщения, прошедшие порог, по убыванию похожести.
   *
   * Условие — превышение над базовой линией СТРОГОЕ. Это и есть защита от
   * шаблонного обрамления: когда все пары одинаковы, превышение у всех ровно
   * ноль, и находок не возникает ни одной, каким бы высоким ни был сам пол.
   *
   * Порог относительный, и у этого есть неустранимое следствие: «верхние 5%»
   * существуют в любом чате, в том числе в таком, где модель ни разу себя не
   * повторила. Абсолютного порога по похожести не бывает,
   * поэтому находки не отсеиваются по нему, а
   * помечаются: `notable` стоит там, где дословный кусок дотянул до десяти слов
   * — той длины, начиная с которой повтор заметен человеку (p90 корпуса, тот же
   * раздел). Показывать пользователю в первую очередь надо `notable`, иначе на
   * чистом чате он увидит «находку» из шести случайно совпавших слов и решит,
   * что расширение выдумывает.
   *
   * @returns {{index: number, partner: number, containment: number,
   *   runLength: number, startA: number, startB: number, notable: boolean}[]}
   */
  function findings() {
    const { median: med, threshold } = baseline();
    return bests
      .filter(b => {
        const adj = b.containment - med;
        return adj > 0 && adj >= threshold;
      })
      .sort((a, b) => b.containment - a.containment)
      .map(b => ({ ...b, notable: b.runLength >= NOTABLE_RUN_WORDS }));
  }

  /**
   * Память и объём работы — для стендов.
   *
   * @returns {{messages: number, scored: number, pairs: number,
   *   shingles: number, bytes: number}}
   */
  function stats() {
    let shingles = 0, bytes = 0;
    for (const d of docs) {
      shingles += d.fp.length;
      bytes += d.fp.byteLength + d.ids.byteLength;
    }
    return {
      messages: docs.length,
      scored: bests.length,
      pairs: pairCount,
      shingles,
      bytes: bytes + pairs.byteLength,
    };
  }

  return { add, findings, baseline, stats };
}
