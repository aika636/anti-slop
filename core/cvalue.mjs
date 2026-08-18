// core/cvalue — ранжирование оборотов по C-value (Frantzi & Ananiadou).
//
// Задача: в топе не должно быть шести строк одного и того же
// оборота в разной обрезке. Порог «подавляем, если родитель набрал 80%» решает
// только простой случай: если «по спине пробежал» встретился 20 раз, из них 11
// с «холодок» и 9 с «озноб», ни один родитель до порога не дотягивает и в топ
// попадают все трое.
//
// Метод: длинному обороту бонус за длину log2(n), вложенному — штраф на среднюю
// частоту непосредственных родителей.
//
// РЕШАЮЩЕЕ СВОЙСТВО: считается только по частотам внутри самого чата. Никакого
// внешнего корпуса — его для русских фраз не существует и не будет.
// Поэтому метод работает с первого же чата и не требует ничего скачивать.
//
// Две ступени: сперва дешёвый фильтр закрытости
// (`closedness`), потом C-value (`cvalue`).
//
// Метод перенесён из отлаженного на реальном топе прототипа
// `tools/corpus-stats.mjs` (и его копии в `tools/cutoff.mjs`, функция `rank`),
// где он был проверен против голой частоты. Формула не изменена.
//
// Вход — то, что отдаёт core/ngrams.mjs:
//   { hash, n, count, firstMessage, lastMessage, stems: string[], text? }
// Поля, которых мы не понимаем (в том числе `text` с живой формой), протаскиваются
// в результат нетронутыми.

/** Порог кандидата в топ (по замеру «топ-5 одинаков при порогах от 2 до 5»). */
export const MIN_COUNT = 3;

/** Порог на бедном чате, куда опускаемся, пометив результат предварительным. */
export const MIN_COUNT_SHORT = 2;

/** Меньше этого числа кандидатов — чат считается бедным. */
export const SHORT_CHAT_CANDIDATES = 20;

/**
 * Порог фильтра закрытости по умолчанию.
 *
 * Взят 0,8. Как единственный механизм борьбы с
 * вложенностью он негоден, но как
 * дешёвая первая ступень честен: если один-единственный родитель объясняет 80% и
 * больше вхождений оборота, оборот не самостоятельная находка, а обрезок, и
 * показывать надо родителя. Всё, что ниже порога (разошлось по нескольким
 * родителям или живёт само по себе), фильтр не трогает — это работа C-value.
 *
 * Считаем по САМОМУ ЧАСТОМУ родителю, а не по сумме: одно вхождение оборота
 * длины n лежит сразу внутри двух родителей длины n+1 (продолженного влево и
 * вправо), поэтому сумма легко переваливает за собственную частоту и по ней
 * фильтр выкосил бы живое.
 */
export const CLOSEDNESS = 0.8;

/** Ключ тождества кандидата. `hash` приходит из ngrams; в тестах его может не быть. */
const idOf = c => c.hash ?? c.stems.join(' ');

/** Ключ поиска по составу оборота: n-грамма однозначно задаётся своими основами. */
const stemKey = c => c.stems.join(' ');

/**
 * Структура вложенности: для каждого кандидата — его НЕПОСРЕДСТВЕННЫЕ родители,
 * то есть обороты длины n+1, совпадающие с ним со сдвигом 0 или 1.
 *
 * Почему хватает только длины n+1 (поведение прототипа, сохранено осознанно).
 * Настоящий C-value штрафует на все более длинные обороты, содержащие данный, и
 * для этого нужен полный перебор вхождений — квадратичный по числу кандидатов.
 * Но родитель длины n+2 содержит внутри себя родителя длины n+1, и по построению
 * n-грамм его частота не выше: масса длинных оборотов уже учтена в частоте
 * непосредственных родителей. Мы теряем не сам штраф, а его точную величину — на
 * реальном топе этого хватило, чтобы схлопнуть каждое
 * семейство в одну строку.
 *
 * Экспортируется ради тестов.
 *
 * @param {Array<{n:number, count:number, stems:string[], hash?:string}>} candidates
 * @returns {Map<string, {sum:number, count:number, max:number, parents:string[]}>}
 *   ключ — идентификатор кандидата, значение — сумма частот родителей, их число,
 *   максимальная частота одного родителя и их идентификаторы.
 */
export function nestingMap(candidates) {
  const nesting = new Map();
  const byStems = new Map();
  for (const c of candidates) {
    nesting.set(idOf(c), { sum: 0, count: 0, max: 0, parents: [] });
    byStems.set(stemKey(c), c);
  }

  for (const parent of candidates) {
    if (parent.n < 2) continue;
    // Сдвиг 0 — обрезали хвост, сдвиг 1 — обрезали голову.
    const heads = parent.stems.slice(0, -1).join(' ');
    const tails = parent.stems.slice(1).join(' ');
    for (const sub of heads === tails ? [heads] : [heads, tails]) {
      const child = byStems.get(sub);
      if (!child || child.n !== parent.n - 1) continue;
      const e = nesting.get(idOf(child));
      e.sum += parent.count;
      e.count++;
      e.max = Math.max(e.max, parent.count);
      e.parents.push(idOf(parent));
    }
  }
  return nesting;
}

/**
 * Первая ступень: отсев несамостоятельных оборотов.
 *
 * Выбрасывает кандидата, у которого один родитель объясняет долю вхождений не
 * меньше порога. Такой оборот — обрезок родителя, а не отдельная находка.
 *
 * @param {Array} candidates
 * @param {{threshold?:number}|number} [opts] порог доли, по умолчанию CLOSEDNESS
 * @returns {Array} те же объекты, без отсеянных
 */
export function closedness(candidates, opts = {}) {
  const threshold = typeof opts === 'number' ? opts : opts.threshold ?? CLOSEDNESS;
  const nesting = nestingMap(candidates);
  return candidates.filter(c => {
    const e = nesting.get(idOf(c));
    if (!e || e.count === 0 || c.count <= 0) return true;
    return e.max / c.count < threshold;
  });
}

/**
 * Ранжирование оборотов по C-value.
 *
 * Порог кандидата: count >= MIN_COUNT и оборот встретился минимум в
 * двух разных сообщениях — требование, отсекающее 9,9% повторов, то есть цитаты и
 * перечисления внутри одного хода. Если кандидатов набралось меньше
 * SHORT_CHAT_CANDIDATES, порог опускается до MIN_COUNT_SHORT, а результат
 * помечается предварительным: на бедном чате лучше показать шаткий список, чем
 * пустой. Явно заданный `minCount` отключает это послабление — считаем, что
 * вызывающий знает, что делает.
 *
 * @param {Array} candidates
 * @param {{minCount?:number, requireTwoMessages?:boolean, limit?:number,
 *          closedness?:boolean|number}} [opts]
 * @returns {{top:Array, preliminary:boolean, candidates:number}}
 *   `top` — исходные объекты с добавленными `cvalue` и `nested {sum, count}`,
 *   по убыванию `cvalue`, без всего, что получило `cvalue <= 0`.
 */
export function cvalue(candidates, opts = {}) {
  const {
    minCount, requireTwoMessages = true, limit,
    closedness: closednessOpt = true,
  } = opts;

  const passes = min => candidates.filter(c =>
    c.count >= min
    && !(requireTwoMessages && c.firstMessage === c.lastMessage));

  let preliminary = false;
  let kept;
  if (minCount !== undefined) {
    kept = passes(minCount);
  } else {
    kept = passes(MIN_COUNT);
    if (kept.length < SHORT_CHAT_CANDIDATES) {
      const wider = passes(MIN_COUNT_SHORT);
      // Опускаем порог только если это что-то даёт: иначе «предварительный»
      // ярлык повиснет на списке, который от послабления не изменился.
      if (wider.length > kept.length) { kept = wider; preliminary = true; }
    }
  }

  const passed = kept.length;

  // Первая ступень. Порог считается уже по прошедшим порог кандидатам: обрезок,
  // родитель которого сам не дотянул до порога, отсекать не за что.
  if (closednessOpt !== false) {
    kept = closedness(kept, typeof closednessOpt === 'number' ? closednessOpt : {});
  }

  // Вторая ступень. Формула прототипа: бонус за длину, штраф на среднюю частоту
  // непосредственных родителей.
  const nesting = nestingMap(kept);
  const scored = kept.map(c => {
    const e = nesting.get(idOf(c));
    const bonus = Math.log2(c.n);
    const score = e.count === 0
      ? bonus * c.count
      : bonus * (c.count - e.sum / e.count);
    return { ...c, cvalue: score, nested: { sum: e.sum, count: e.count } };
  });

  const top = scored
    .filter(o => o.cvalue > 0)
    // Порядок при равных очках фиксируем, чтобы вывод не плясал между запусками.
    .sort((a, b) => b.cvalue - a.cvalue || b.count - a.count || b.n - a.n
      || (stemKey(a) < stemKey(b) ? -1 : stemKey(a) > stemKey(b) ? 1 : 0));

  return {
    top: limit ? top.slice(0, limit) : top,
    preliminary,
    candidates: passed,
  };
}
