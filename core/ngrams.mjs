// core/ngrams — боевой счётчик n-грамм.
//
// Наивный словарь строк на миллионе слов стоит 267 МБ (158 байт на запись,
// померено кучей) — на телефоне это гарантированное падение вкладки, а не
// «подтормаживает». Поэтому здесь пять решений, каждое взято из замеров:
//
//   1. Основы интернируются в 32-битные идентификаторы: строка живёт в памяти
//      один раз, а не в каждом обороте, куда она входит.
//   2. Оборот представлен 53-битным хешем. Не 32-битным: на трёх миллионах
//      оборотов 32 бита дают около тысячи ложных склеек, и попадают они именно
//      в топ — то есть прямо на экран пользователю.
//   3. Пока прозы мало, считаем обычным `Map`: на коротком чате одиночки — это
//      почти весь чат, и отсев уничтожил бы результат. Переключение — на
//      50 тысячах слов (бюджет 16 МБ на наивный словарь), по словам, а не по
//      сообщениям: длина сообщения в реальных чатах различается на порядок.
//   4. После переключения — таблица на типизированных массивах с открытой
//      адресацией, слот 16 байт, и блум-фильтр на одиночки. Одиночки дают 94,4%
//      записей и 95% памяти, а в топ попасть не могут по определению.
//   5. Строки восстанавливаются отдельным проходом только для верхушки списка
//      (`resolve`). В таблице их нет и быть не может.
//
// Побочное свойство блума: первое вхождение каждого оборота теряется, то есть
// все частоты в таблице занижены ровно на единицу — константно. Компенсируется
// прибавлением единицы при показе, и после компенсации частота снова точная.
// Перелив при переходе идёт с тем же сдвигом (счётчик минус один), иначе
// пережившие переход обороты были бы завышены на единицу относительно новых:
// расхождение слишком маленькое, чтобы его заметили, и достаточно большое,
// чтобы месяцами портить ранжирование.

import { stemKey } from './tokenize.mjs';

// --- служебные слова --------------------------------------------------------
// Переехали из стенда `tools/cutoff.mjs`: оборот целиком из служебных слов —
// не находка, а шум языка. Отсев делается на входе, а не при выдаче: такие
// обороты не занимают памяти вообще, а на C-value это не влияет — родителем
// вложенного оборота всё равно может быть только оборот со знаменательным
// словом, а он не отсеивается.
//
// Обороты из одних предлогов («в на по», «из-за под над») отсеиваются этим же
// правилом и отдельного механизма не требуют: предлоги входят в список ниже
// целиком. Решение буквальное: любой оборот, у
// которого ВСЕ слова служебные, не считается. Стоит одному знаменательному
// слову появиться в окне — оборот считается, даже если остальные служебные
// («по спине пробежал» обязан считаться).

/** Служебные слова как они пишутся. Ключи считаются из них через `stemKey`. */
export const STOP_WORDS = new Set((
  'и а но да же ли бы то что как так вот уже еще не ни в во на за по под над о '
  + 'об от до из у к с со для при про без через между том тем тот та те это эта '
  + 'этот эти он она они оно его ее их им ими ему ей себя свой своя свои мой моя '
  + 'мои твой твоя ты я мы вы был была были было быть есть нет очень когда где '
  + 'куда потом просто только лишь если чтобы или либо тоже также сам сама сами '
  + 'один одна одно'
).split(' '));

/**
 * Служебные слова, приведённые к ключам основ. Счётчик сравнивает именно ключи:
 * на вход ему приходят основы, а не живые формы.
 */
export const STOP_KEYS = new Set([...STOP_WORDS].map(w => stemKey(w)));

// --- 53-битный хеш ----------------------------------------------------------
// Две независимые 32-битные дорожки, из которых на выходе собирается 53-битное
// целое: 32 бита первой дорожки и 21 бит второй. Больше в double без потерь не
// влезет, а 53 бита — ровно то, что нужно.
//
// Хеш наращивается по слову: одно и то же начало окна годится для всех длин
// от nMin до nMax, поэтому счётчик за один проход по позиции выдаёт обороты
// всех длин, а не считает каждую длину заново.

const SEED1 = 0x9e3779b1 | 0;
const SEED2 = 0x85ebca6b | 0;

function step1(h, id) {
  h = Math.imul(h ^ id, 0x85ebca6b);
  return (h << 13) | (h >>> 19);
}

function step2(h, id) {
  h = Math.imul(h ^ id, 0xc2b2ae35);
  return (h << 17) | (h >>> 15);
}

// Длина оборота подмешивается в финал: иначе окна разной длины с одинаковым
// хвостом склеивались бы чаще, чем позволяет случай.
function finish(h1, h2, n) {
  h1 = Math.imul(h1 ^ n, 0x27d4eb2f);
  h1 ^= h1 >>> 15;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;

  h2 = Math.imul(h2 ^ Math.imul(n, 0x9e3779b1), 0xc2b2ae35);
  h2 ^= h2 >>> 16;

  // 32 бита + 21 бит = 53. Максимум ровно 2^53 - 1, точность double не теряется.
  return (h1 >>> 0) * 2097152 + (h2 >>> 11);
}

/** Сколько бит в хеше оборота. Не константа ради красоты: от неё зависит вывод. */
export const HASH_BITS = 53;

/**
 * Хеш одного оборота по идентификаторам основ.
 *
 * Чистая функция — тем же кодом пользуется и счётчик, и восстановление строк
 * в `resolve`, иначе второй проход не нашёл бы то, что нашёл первый.
 *
 * @param {ArrayLike<number>} ids идентификаторы основ
 * @param {number} [start] начало окна
 * @param {number} [n] длина окна
 * @returns {number} целое в диапазоне [0, 2^53)
 */
export function hashNgram(ids, start = 0, n = ids.length - start) {
  let h1 = SEED1, h2 = SEED2;
  for (let i = 0; i < n; i++) {
    const id = ids[start + i];
    h1 = step1(h1, id);
    h2 = step2(h2, id);
  }
  return finish(h1, h2, n);
}

// --- блум-фильтр ------------------------------------------------------------
// Держит только «этот оборот уже когда-то попадался». Оборот, впервые увиденный
// после перехода, помечается здесь и в таблицу не попадает: одиночки — 94,4%
// записей, и хранить их незачем.
//
// Размер по умолчанию — 2 МБ (2^24 бит) при трёх хеш-функциях. Ориентир
// нагрузки — миллион слов прозы; по закону Хипса с этого корпуса
// (различных = 5,46 · N^0,913) это около 1,6 млн различных оборотов, из них
// примерно 1,55 млн одиночек. На них выходит 10,8 бит на элемент и вероятность
// ложного срабатывания около 1,4%.
//
// Направление ошибки безобидное и это главное при выборе размера: ложное
// срабатывание означает, что настоящая одиночка всё-таки заведёт слот в
// таблице (16 лишних байт и частота 2 вместо 1 после компенсации). Порог
// кандидата — три вхождения, так что до экрана это не доходит. Ложных
// отрицаний у блума не бывает вообще, то есть ни один настоящий повтор не
// потеряется.

/**
 * Блум-фильтр на 53-битных хешах.
 *
 * @param {{bits?: number, hashes?: number}} [opts] bits округляется вверх до
 *   степени двойки
 */
export function createBloom(opts = {}) {
  const wanted = Math.max(1024, opts.bits ?? (1 << 24));
  let bits = 1;
  while (bits < wanted) bits <<= 1;
  const mask = bits - 1;
  const k = Math.max(1, opts.hashes ?? 3);
  const words = new Uint32Array(bits >>> 5);
  let marks = 0;

  // Две независимые позиции из одного хеша, дальше по Кирш–Мицценмахеру:
  // g_i = a + i*b. Отдельные хеш-функции считать незачем, качество то же.
  const lanes = h => {
    const a = (h % 4294967296) >>> 0;
    const b = (Math.floor(h / 4294967296) * 2654435761) >>> 0;
    return [a, b | 1];
  };

  return {
    /** Встречался ли оборот. Ложное «да» возможно, ложное «нет» — нет. */
    has(h) {
      const [a, b] = lanes(h);
      for (let i = 0; i < k; i++) {
        const p = ((a + Math.imul(i, b)) >>> 0) & mask;
        if ((words[p >>> 5] & (1 << (p & 31))) === 0) return false;
      }
      return true;
    },
    /** Пометить оборот как виденный. */
    add(h) {
      const [a, b] = lanes(h);
      for (let i = 0; i < k; i++) {
        const p = ((a + Math.imul(i, b)) >>> 0) & mask;
        words[p >>> 5] |= 1 << (p & 31);
      }
      marks++;
    },
    get marks() { return marks; },
    get bits() { return bits; },
    get hashes() { return k; },
    get bytes() { return words.byteLength; },
  };
}

// --- таблица счётчиков ------------------------------------------------------
// Открытая адресация, линейное пробирование, ёмкость — степень двойки.
// Слот 16 байт ровно, как записано в разделе 3.1:
//
//   hashes[i]  Float64  8 байт  полный 53-битный хеш
//   meta[i]    Uint32   4 байта  длина оборота (4 старших бита) + счётчик
//   edges[i]   Uint32   4 байта  номер первого сообщения и последнего, по 16 бит
//
// Почему хеш занимает восемь байт, а не четыре: нужны все 53 бита, и
// урезать их до размера слота значило бы вернуть ложные склейки в топ. Место
// выкроено на другом. Длина оборота живёт в старших битах счётчика (обороты
// длиннее 15 слов не бывают, а счётчик до 268 миллионов заведомо хватает), а
// номера сообщений ужаты до 16 бит.
//
// Множество номеров сообщений не хранится вообще: правило «встретился в двух
// разных сообщениях» тождественно «первый номер не равен последнему» — на 19
// тысячах повторяющихся оборотов корпуса разработки — ноль расхождений.
//
// Потолок номера сообщения — 65 535. Ориентир нагрузки — миллион слов, то есть
// сотни-тысячи сообщений; чат на 65 тысяч ходов не существует. При выходе за
// потолок номер прижимается к максимуму: тогда правило «двух сообщений» может
// отбросить находку, но не выдумать её.

const MSG_MAX = 0xffff;
const COUNT_MASK = 0x0fffffff;
const COUNT_MAX = COUNT_MASK;
const LOAD = 0.7;
export const SLOT_BYTES = 16;

function createTable(minCapacity) {
  let cap = 1024;
  while (cap * LOAD < minCapacity) cap <<= 1;
  let mask = cap - 1;
  let hashes = new Float64Array(cap);
  let meta = new Uint32Array(cap);
  let edges = new Uint32Array(cap);
  let used = 0;

  const bucket = h => ((h % 4294967296) >>> 0) & mask;

  /** Слот оборота, если он есть; иначе ~индекс свободного места. */
  function probe(h) {
    let i = bucket(h);
    while (meta[i] !== 0) {
      if (hashes[i] === h) return i;
      i = (i + 1) & mask;
    }
    return ~i;
  }

  function grow() {
    const oldHashes = hashes, oldMeta = meta, oldEdges = edges, oldCap = cap;
    cap <<= 1;
    mask = cap - 1;
    hashes = new Float64Array(cap);
    meta = new Uint32Array(cap);
    edges = new Uint32Array(cap);
    for (let i = 0; i < oldCap; i++) {
      if (oldMeta[i] === 0) continue;
      const h = oldHashes[i];
      let j = bucket(h);
      while (meta[j] !== 0) j = (j + 1) & mask;
      hashes[j] = h;
      meta[j] = oldMeta[i];
      edges[j] = oldEdges[i];
    }
  }

  return {
    probe,
    get used() { return used; },
    get capacity() { return cap; },
    get bytes() { return cap * SLOT_BYTES; },

    /** Завести слот. Индекс свободного места пересчитывается сам: таблица могла вырасти. */
    insert(h, n, count, first, last) {
      if (used + 1 > cap * LOAD) grow();
      let i = bucket(h);
      while (meta[i] !== 0) {
        if (hashes[i] === h) return i;
        i = (i + 1) & mask;
      }
      hashes[i] = h;
      meta[i] = (n << 28) | Math.min(count, COUNT_MAX);
      edges[i] = (Math.min(first, MSG_MAX) << 16) | Math.min(last, MSG_MAX);
      used++;
      return i;
    },

    /** Ещё одно вхождение в слот, уже существующий. */
    hit(i, message) {
      const c = meta[i] & COUNT_MASK;
      if (c < COUNT_MAX) meta[i]++;
      edges[i] = (edges[i] & 0xffff0000) | Math.min(message, MSG_MAX);
    },

    /** Обход занятых слотов. */
    forEach(fn) {
      for (let i = 0; i < cap; i++) {
        const m = meta[i];
        if (m === 0) continue;
        fn(hashes[i], m >>> 28, m & COUNT_MASK, edges[i] >>> 16, edges[i] & 0xffff);
      }
    },
  };
}

// --- счётчик ----------------------------------------------------------------

// Оценка памяти для стендов. Запись `Map` здесь дешевле наивной строковой (158
// байт, померено): ключ — число, а не строка длиной в 24 символа. Но объект
// записи с четырьмя полями всё равно платный, отсюда порядок величины.
const MAP_ENTRY_BYTES = 96;
const INTERN_ENTRY_BYTES = 80;

/**
 * Счётчик n-грамм.
 *
 * @param {{nMin?: number, nMax?: number, switchAtWords?: number,
 *          stopKeys?: Set<string>, bloomBits?: number, bloomHashes?: number}} [opts]
 */
export function createCounter(opts = {}) {
  const nMin = Math.max(1, opts.nMin ?? 3);
  // Длина живёт в четырёх битах слота: пятнадцать слов — потолок формата,
  // а не произвол. Реально используются n от 3 до 6.
  const nMax = Math.min(15, Math.max(nMin, opts.nMax ?? 6));
  const switchAtWords = opts.switchAtWords ?? 50000;
  const stopKeys = opts.stopKeys ?? STOP_KEYS;

  // Интернирование: строка основы хранится один раз, обороты ссылаются числами.
  const ids = new Map();          // ключ основы → идентификатор
  const stems = [];               // идентификатор → ключ основы
  const stopFlags = [];           // идентификатор → служебное ли слово
  let internChars = 0;

  function intern(key) {
    let id = ids.get(key);
    if (id === undefined) {
      id = stems.length;
      ids.set(key, id);
      stems.push(key);
      stopFlags.push(stopKeys.has(key) ? 1 : 0);
      internChars += key.length;
    }
    return id;
  }

  let map = new Map();            // хеш → {n, count, first, last}
  let table = null;
  let bloom = null;
  let mode = 'map';
  let words = 0;
  let insertsAfterFlush = 0;

  // Общий обход оборотов сегмента. Через него идут все три потребителя —
  // подсчёт, покрытие и восстановление строк, — потому что хеш обязан
  // считаться ровно одинаково: второй проход иначе не найдёт то, что нашёл
  // первый, а покрытие спрашивало бы про обороты, которых счётчик не видел.
  let buf = new Int32Array(256);
  let mark = new Uint16Array(256);

  function ensureBuf(len) {
    if (buf.length >= len) return;
    let size = buf.length;
    while (size < len) size <<= 1;
    buf = new Int32Array(size);
    mark = new Uint16Array(size);
  }

  /** Разложить сегмент в идентификаторы. `toId` решает, заводить новые или нет. */
  function fillBuf(seg, toId) {
    const len = seg.length;
    ensureBuf(len);
    for (let i = 0; i < len; i++) buf[i] = toId(seg[i]);
    return len;
  }

  /**
   * Обход всех оборотов длиной от nMin до nMax по заполненному буферу.
   * Хеш наращивается по слову: одно начало окна — все длины сразу.
   * `visit(hash, n, start, allStop)`.
   */
  function scanNgrams(len, visit) {
    for (let i = 0; i < len; i++) {
      let h1 = SEED1, h2 = SEED2;
      let allStop = true;
      const max = Math.min(nMax, len - i);
      for (let k = 0; k < max; k++) {
        const id = buf[i + k];
        h1 = step1(h1, id);
        h2 = step2(h2, id);
        // Незнакомая основа (идентификатор -1) считается знаменательным словом:
        // ошибиться здесь безопаснее в сторону «оборот учитываем».
        if (allStop && !stopFlags[id]) allStop = false;
        const n = k + 1;
        if (n < nMin) continue;
        visit(finish(h1, h2, n), n, i, allStop);
      }
    }
  }

  /** Известен ли оборот сейчас. Внутренняя форма `has`. */
  function known(h) {
    if (mode === 'map') return map.has(h);
    return table.probe(h) >= 0 || bloom.has(h);
  }

  function bumpMap(h, n, message) {
    const rec = map.get(h);
    if (rec === undefined) {
      map.set(h, { n, count: 1, first: message, last: message });
    } else {
      rec.count++;
      rec.last = message;
    }
  }

  function bumpTable(h, n, message) {
    const slot = table.probe(h);
    if (slot >= 0) {
      table.hit(slot, message);
      return;
    }
    if (bloom.has(h)) {
      // Второе вхождение: заводим запись со счётчиком 1 — первое вхождение
      // потеряно намеренно и одинаково для всех, компенсируется при показе.
      // Номер первого сообщения здесь тоже второй по счёту: восстановить
      // настоящий первый нельзя, и это единственная плата за отсев.
      table.insert(h, n, 1, message, message);
      insertsAfterFlush++;
    } else {
      bloom.add(h);
    }
  }

  /**
   * Переход `Map` → таблица. Одиночки уходят в блум, у остальных счётчик
   * уменьшается на единицу — тогда вся таблица живёт по одному правилу
   * «вхождений минус первое», и при показе везде прибавляется одна и та же
   * единица. Обратного перехода нет: чат только растёт.
   */
  function flush() {
    let survivors = 0;
    for (const rec of map.values()) if (rec.count > 1) survivors++;

    bloom = createBloom({ bits: opts.bloomBits, hashes: opts.bloomHashes });
    table = createTable(survivors);

    for (const [h, rec] of map) {
      if (rec.count === 1) { bloom.add(h); continue; }
      table.insert(h, rec.n, rec.count - 1, rec.first, rec.last);
    }

    map = null;
    mode = 'table';
  }

  return {
    /**
     * Учесть сообщение.
     *
     * @param {number} messageIndex номер сообщения в чате
     * @param {string[][]} segments сегменты ключей основ одного сообщения,
     *   то есть `tokenize(...).map(seg => seg.map(t => t.stem))`
     */
    add(messageIndex, segments) {
      for (const seg of segments ?? []) {
        words += seg.length;
        if (seg.length < nMin) continue;

        const len = fillBuf(seg, intern);
        scanNgrams(len, (h, n, _start, allStop) => {
          // Оборот целиком из служебных слов — шум языка, а не находка.
          if (allStop) return;
          if (mode === 'map') bumpMap(h, n, messageIndex);
          else bumpTable(h, n, messageIndex);
        });
      }

      // Проверка после сообщения, а не внутри: одно сообщение не должно
      // оказаться посчитанным наполовину в одном режиме, наполовину в другом.
      if (mode === 'map' && words >= switchAtWords) flush();
    },

    /** Сколько слов прозы учтено. Порог перехода считается именно по нему. */
    get words() { return words; },

    /** `'map'` или `'table'`. */
    get mode() { return mode; },

    /**
     * Известен ли счётчику такой оборот сейчас — то есть встречался ли он хотя
     * бы раз к этому моменту.
     *
     * В режиме `Map` ответ точный. После перехода в таблицу он приблизительный
     * и ошибается только в сторону ложноположительных: одиночки живут в блуме,
     * а блум по устройству иногда говорит «да» про то, чего не видел (около
     * 1,4% на миллионе слов при размере по умолчанию). Ложных «нет» не бывает
     * никогда, поэтому настоящий повтор не теряется.
     *
     * @param {number} hash хеш оборота (`hashNgram` или поле `hash` кандидата)
     */
    has(hash) { return known(hash); },

    /**
     * Покрытие сообщения повторами: какая доля его слов входит в обороты,
     * счётчику уже известные. Нужно сводному индексу как «сколько здесь
     * сказано заново, а сколько повторено» (инкрементальность).
     *
     * Вызывать ДО `add` этого же сообщения — иначе сообщение окажется
     * повторяющим само себя и покрытие будет близко к единице у всех.
     *
     * Позиции объединяются, а не суммируются: слово, накрытое тремя разными
     * оборотами, считается один раз, иначе доля вылезла бы за единицу.
     *
     * @param {string[][]} segments те же сегменты ключей основ, что и в `add`
     * @returns {{words: number, covered: number, ratio: number, byN: Object<number, number>}}
     */
    coverage(segments) {
      let total = 0, covered = 0;
      const byN = {};
      for (let n = nMin; n <= nMax; n++) byN[n] = 0;

      for (const seg of segments ?? []) {
        const len = seg.length;
        total += len;
        if (len < nMin) continue;

        // Только чтение: покрытие не должно заводить новых идентификаторов,
        // иначе оно молча меняло бы состояние счётчика перед подсчётом.
        fillBuf(seg, key => ids.get(key) ?? -1);
        mark.fill(0, 0, len);

        scanNgrams(len, (h, n, start, allStop) => {
          if (allStop) return;
          if (!known(h)) return;
          const bit = 1 << (n - nMin);
          for (let t = start; t < start + n; t++) mark[t] |= bit;
        });

        for (let i = 0; i < len; i++) {
          if (mark[i] === 0) continue;
          covered++;
          for (let n = nMin; n <= nMax; n++) {
            if (mark[i] & (1 << (n - nMin))) byN[n]++;
          }
        }
      }

      return { words: total, covered, ratio: total ? covered / total : 0, byN };
    },

    /**
     * Кандидаты в топ, по убыванию частоты.
     *
     * `count` уже скомпенсирован: в режиме таблицы к нему прибавлена потерянная
     * блумом единица, так что наружу идёт настоящее число вхождений.
     *
     * @param {{minCount?: number, requireTwoMessages?: boolean}} [opts]
     * @returns {Array<{hash: number, n: number, count: number,
     *   firstMessage: number, lastMessage: number}>}
     */
    candidates(opts = {}) {
      const minCount = opts.minCount ?? 3;
      const requireTwoMessages = opts.requireTwoMessages ?? true;
      const out = [];

      const take = (hash, n, raw, first, last) => {
        const count = mode === 'table' ? raw + 1 : raw;
        if (count < minCount) return;
        if (requireTwoMessages && first === last) return;
        out.push({ hash, n, count, firstMessage: first, lastMessage: last });
      };

      if (mode === 'map') {
        for (const [h, rec] of map) take(h, rec.n, rec.count, rec.first, rec.last);
      } else {
        table.forEach(take);
      }

      out.sort((a, b) => b.count - a.count || b.n - a.n);
      return out;
    },

    /**
     * Оценка занимаемой памяти и наполнение таблицы. Для стендов, не для логики.
     *
     * `singles` — сколько оборотов известно как одиночки: в режиме `Map`
     * считается точно, в режиме таблицы это пометки блума за вычетом тех, кто
     * потом всплыл вторым вхождением.
     */
    stats() {
      const internBytes = stems.length * INTERN_ENTRY_BYTES + internChars * 2;
      if (mode === 'map') {
        let singles = 0;
        for (const rec of map.values()) if (rec.count === 1) singles++;
        return {
          words,
          distinct: map.size,
          mode,
          singles,
          tableLoad: 0,
          bytes: internBytes + map.size * MAP_ENTRY_BYTES,
        };
      }
      return {
        words,
        distinct: table.used,
        mode,
        singles: Math.max(0, bloom.marks - insertsAfterFlush),
        tableLoad: table.used / table.capacity,
        bytes: internBytes + table.bytes + bloom.bytes,
      };
    },

    /**
     * Второй проход: восстановление строк по верхушке списка. В таблице строк
     * нет и быть не может, поэтому кандидатам они возвращаются отдельным
     * проходом по сообщениям — и только тем, кого действительно покажут.
     *
     * Каждому кандидату проставляются `stems` (ключи основ) и `text` — самая
     * частая живая словоформенная запись оборота. Пользователю основа не
     * показывается никогда, наружу идёт только `text`.
     *
     * @param {Array<{hash: number, n: number, firstMessage: number, lastMessage: number}>} candidates
     * @param {(i: number) => Array<Array<{form: string, stem: string}>>} readMessage
     * @returns тот же массив
     */
    resolve(candidates, readMessage) {
      if (!candidates?.length) return candidates;

      const wanted = new Map();   // хеш → {forms: Map<строка, число>, stems}
      const ranges = [];
      for (const c of candidates) {
        if (!wanted.has(c.hash)) wanted.set(c.hash, { forms: new Map(), stems: null });
        ranges.push([c.firstMessage, c.lastMessage]);
      }

      // Читаем не весь чат, а объединение диапазонов «первое вхождение —
      // последнее». Слитые в интервалы, чтобы не перечитывать сообщение дважды.
      ranges.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const r of ranges) {
        const tail = merged[merged.length - 1];
        if (tail && r[0] <= tail[1] + 1) tail[1] = Math.max(tail[1], r[1]);
        else merged.push([r[0], r[1]]);
      }

      // Идентификаторы только читаются: незнакомая основа получает -1 и просто
      // не совпадёт ни с одним искомым хешем.
      const idOf = key => ids.get(key) ?? -1;

      for (const [from, to] of merged) {
        for (let i = from; i <= to; i++) {
          const segments = readMessage(i);
          if (!segments) continue;
          for (const seg of segments) {
            if (seg.length < nMin) continue;
            const len = fillBuf(seg, token => idOf(token.stem));

            scanNgrams(len, (h, n, start) => {
              const w = wanted.get(h);
              if (w === undefined) return;
              let form = seg[start].form;
              for (let t = 1; t < n; t++) form += ' ' + seg[start + t].form;
              w.forms.set(form, (w.forms.get(form) ?? 0) + 1);
              if (w.stems === null) {
                w.stems = [];
                for (let t = 0; t < n; t++) w.stems.push(seg[start + t].stem);
              }
            });
          }
        }
      }

      for (const c of candidates) {
        const w = wanted.get(c.hash);
        c.stems = w?.stems ?? [];
        let best = '', bestCount = 0;
        if (w) {
          for (const [form, n] of w.forms) {
            if (n > bestCount) { best = form; bestCount = n; }
          }
        }
        c.text = best;
      }
      return candidates;
    },
  };
}
