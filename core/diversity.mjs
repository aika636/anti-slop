// core/diversity — лексическое разнообразие: MATTR, MTLD, Yule's K.
//
// Основная цифра наружу — MATTR с окном 50: «из каждых
// 50 слов подряд уникальны в среднем 34». MTLD — вторая цифра «для тех, кто
// понимает». Yule's K не показывается никогда, он нужен для сортировки внутри.
//
// Обычный TTR (уникальных / всего) здесь непригоден и в модуле как публичная
// метрика отсутствует: он падает с длиной текста, поэтому два чата разной
// длины по нему сравнить нельзя. MATTR не зависит от длины по построению —
// это среднее TTR по всем окнам фиксированного размера.
//
// На вход везде плоский массив строк. Модуль сознательно не знает, что ему
// дали — ключи основ или живые формы. Это решает вызывающий: вопрос
// «по основам или по формам» (разница 5–15 процентных пунктов)
// решается только на реальных чатах, и до тех пор обе ветки должны считаться
// одним и тем же кодом, чтобы цифры были сравнимы между собой.

/**
 * Окно MATTR. Зафиксировано навсегда: значения при разных окнах
 * несравнимы, и смена окна в новой версии сломала бы метрику задним числом
 * у всех, у кого уже накоплена история.
 */
export const MATTR_WINDOW = 50;

/** Порог падения TTR в MTLD. Смысл константы — в комментарии к `mtld`. */
export const MTLD_THRESHOLD = 0.72;

/**
 * MATTR — среднее TTR по всем окнам подряд идущих слов.
 *
 * Считается честным скользящим окном: словарь окна живёт в Map «слово → сколько
 * раз оно сейчас в окне», на каждом шаге одно слово входит и одно выходит, счёт
 * уникальных правится на месте. Пересчёт множества на каждом шаге дал бы
 * O(N·window) — на чате в сотни тысяч слов это десятки миллионов операций
 * впустую, притом что метрика по природе инкрементальна.
 *
 * Возвращается доля, не проценты: в проценты переводит слой показа.
 *
 * @param {string[]} words плоский массив слов (основы либо формы — см. шапку)
 * @param {number} [window=MATTR_WINDOW] размер окна
 * @returns {{value: number, window: number, short: boolean}}
 *   `short: true` — окно не набралось, текст короче окна; тогда `value` —
 *   обычный TTR по всему тексту, и сравнивать его с полноценным MATTR нельзя.
 *   На пустом входе `value` равен нулю.
 */
export function mattr(words, window = MATTR_WINDOW) {
  const acc = createMattr(window);
  acc.pushAll(words);
  return acc.value();
}

/**
 * Инкрементальный MATTR: слова скармливаются по одному, текущее среднее
 * доступно в любой момент.
 *
 * Нужен для графика по ходу чата и для сводного индекса: сообщения проходятся
 * один раз, и после каждого можно снять цифру, не начиная счёт заново.
 * Окно намеренно НЕ обрывается на границе сообщения — разнообразие меряется по
 * потоку текста, а не по кускам, иначе короткие реплики давали бы вырожденные
 * окна.
 *
 * @param {number} [window=MATTR_WINDOW]
 * @returns {{
 *   push: (word: string) => void,
 *   pushAll: (words: Iterable<string>) => void,
 *   value: () => {value: number, window: number, short: boolean},
 *   size: () => number,
 * }}
 */
export function createMattr(window = MATTR_WINDOW) {
  const size = Math.max(1, Math.floor(window));
  const counts = new Map(); // слово → сколько раз оно сейчас в окне
  const buf = [];           // очередь слов окна; голова смещается индексом
  let head = 0;
  let uniques = 0;          // размер словаря окна, поддерживается на месте
  let sum = 0;              // сумма TTR по завершённым окнам
  let windows = 0;
  let total = 0;

  const push = word => {
    total += 1;
    buf.push(word);
    const c = counts.get(word) ?? 0;
    counts.set(word, c + 1);
    if (c === 0) uniques += 1;

    if (buf.length - head > size) {
      const old = buf[head];
      buf[head] = undefined; // не держим строку живой, пока не подчистили буфер
      head += 1;
      const oc = counts.get(old);
      if (oc === 1) { counts.delete(old); uniques -= 1; } else counts.set(old, oc - 1);
      // Буфер чистится редко и большими кусками: копирование на каждом шаге
      // (shift) сделало бы шаг линейным по длине окна.
      if (head > size) { buf.splice(0, head); head = 0; }
    }

    if (buf.length - head === size) { sum += uniques / size; windows += 1; }
  };

  return {
    push,
    pushAll(list) { for (const w of list ?? []) push(w); },
    value() {
      if (windows > 0) return { value: sum / windows, window: size, short: false };
      // Окно не набралось: пока текст короче окна, ни одно слово из него не
      // выбывало, поэтому `uniques` — словарь всего текста, а не куска.
      return { value: total ? uniques / total : 0, window: size, short: true };
    },
    size: () => total,
  };
}

/**
 * MTLD — средняя длина отрезка, на котором TTR держится выше порога.
 *
 * Классический алгоритм McCarthy & Jarvis: идём по тексту, ведём TTR, при
 * падении до порога засчитываем фактор и начинаем отрезок заново; проход
 * вперёд и назад, результат — среднее двух.
 *
 * Хвост, не успевший упасть до порога, учитывается частичным фактором
 * `(1 - ttr) / (1 - threshold)`: иначе последние слова текста просто пропадали
 * бы, и цифра прыгала бы от того, где именно оборвался чат.
 *
 * ОГОВОРКА: порог 0.72 откалиброван на английском. Русский
 * флективен, каждая словоформа — отдельный тип, TTR по нему выше при том же
 * содержательном разнообразии, так что на русском константа почти наверняка
 * смещена. Пока это не перемерено на живых чатах, MTLD годится для сравнения
 * чатов между собой, но не как абсолютная величина.
 *
 * @param {string[]} words
 * @param {number} [threshold=MTLD_THRESHOLD]
 * @returns {number} NaN, если текст слишком короткий или однороден настолько,
 *   что не набрался ни один фактор (пустой вход; текст без единого повтора —
 *   TTR не падает и величина не определена). NaN выбран вместо нуля и null
 *   намеренно: ноль соврал бы «разнообразия нет», а NaN не участвует в
 *   арифметике сводного индекса молча — он её ломает заметно.
 */
export function mtld(words, threshold = MTLD_THRESHOLD) {
  if (!words || words.length === 0) return NaN;
  const forward = mtldPass(words, threshold, false);
  const backward = mtldPass(words, threshold, true);
  if (!Number.isFinite(forward) || !Number.isFinite(backward)) return NaN;
  return (forward + backward) / 2;
}

function mtldPass(words, threshold, reversed) {
  const n = words.length;
  let factors = 0;
  let types = new Set();
  let tokens = 0;
  let ttr = 1;

  for (let i = 0; i < n; i += 1) {
    types.add(words[reversed ? n - 1 - i : i]);
    tokens += 1;
    ttr = types.size / tokens;
    if (ttr <= threshold) {
      factors += 1;
      types = new Set();
      tokens = 0;
      ttr = 1;
    }
  }

  if (tokens > 0) factors += (1 - ttr) / (1 - threshold);
  if (factors <= 0) return NaN;
  return n / factors;
}

/**
 * Yule's K — концентрация словаря: насколько часто повторяются одни и те же
 * слова. K = 10000 · (Σ f² − N) / N², где f — частоты слов, N — всего слов.
 *
 * ВНУТРЕННЯЯ метрика: пользователю не показывается никогда.
 * Её нельзя объяснить одной строкой, а шкала непривычная — растёт при падении
 * разнообразия, в отличие от обеих публичных цифр. Нужна для сортировки и
 * сравнений внутри кода.
 *
 * @param {string[]} words
 * @returns {number} 0 на пустом входе и на тексте без повторов.
 */
export function yulesK(words) {
  const n = words?.length ?? 0;
  if (n === 0) return 0;
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  let squares = 0;
  for (const f of freq.values()) squares += f * f;
  return (10000 * (squares - n)) / (n * n);
}

/**
 * Все метрики разнообразия за один вызов — то, что берёт сводный модуль.
 *
 * @param {string[]} words
 * @param {{window?: number, threshold?: number}} [opts]
 * @returns {{mattr: number, mattrShort: boolean, mtld: number, yulesK: number, words: number}}
 *   `mattr` — доля (в проценты переводит слой показа), `mattrShort` — признак
 *   того, что окно не набралось и цифра несравнима с полноценным MATTR.
 */
export function diversity(words, opts = {}) {
  const list = words ?? [];
  const { window = MATTR_WINDOW, threshold = MTLD_THRESHOLD } = opts;
  const m = mattr(list, window);
  return {
    mattr: m.value,
    mattrShort: m.short,
    mtld: mtld(list, threshold),
    yulesK: yulesK(list),
    words: list.length,
  };
}
