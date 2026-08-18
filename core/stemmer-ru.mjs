// Snowball-стеммер русского языка.
// Порт эталонного алгоритма (snowballstem.org/algorithms/russian/stemmer.html).
//
// Ожидает слово в нижнем регистре и уже с заменой «ё → е»: замена делается
// до стемминга в tokenize.mjs, иначе «пришёл» и «пришел» разойдутся в разные
// корзины. Букву «ё» алгоритм всё же считает гласной — на случай, если сюда
// прилетело ненормализованное слово.

const VOWELS = new Set(['а', 'е', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я', 'ё']);

const isVowel = ch => VOWELS.has(ch);

// Списки окончаний. Порядок внутри списка не важен: matchEnding всегда берёт
// самое длинное подходящее — так требует Snowball («among» с максимальным
// совпадением).
const PERFECTIVE_GERUND_1 = ['вшись', 'вши', 'в']; // требуют «а» или «я» перед собой
const PERFECTIVE_GERUND_2 = ['ывшись', 'ившись', 'ывши', 'ивши', 'ыв', 'ив'];

const ADJECTIVE = [
  'ими', 'ыми', 'его', 'ого', 'ему', 'ому',
  'ее', 'ие', 'ые', 'ое', 'ей', 'ий', 'ый', 'ой',
  'ем', 'им', 'ым', 'ом', 'их', 'ых', 'ую', 'юю',
  'ая', 'яя', 'ою', 'ею',
];
const PARTICIPLE_1 = ['ющ', 'вш', 'нн', 'ем', 'щ']; // требуют «а» или «я» перед собой
const PARTICIPLE_2 = ['ующ', 'ивш', 'ывш'];

const REFLEXIVE = ['ся', 'сь'];

const VERB_1 = [ // требуют «а» или «я» перед собой
  'ешь', 'нно', 'ете', 'йте', 'ла', 'на', 'ли', 'ем', 'ло', 'но',
  'ет', 'ют', 'ны', 'ть', 'й', 'л', 'н',
];
const VERB_2 = [
  'ейте', 'уйте', 'ила', 'ыла', 'ена', 'ите', 'или', 'ыли', 'ило', 'ыло',
  'ено', 'ует', 'уют', 'ены', 'ить', 'ыть', 'ишь', 'ей', 'уй', 'ил', 'ыл',
  'им', 'ым', 'ен', 'ят', 'ит', 'ыт', 'ую', 'ю',
];

const NOUN = [
  'иями', 'ями', 'ами', 'иях', 'иям', 'ием', 'ией', 'ях', 'ям', 'ам', 'ах',
  'ев', 'ов', 'ие', 'ье', 'еи', 'ии', 'ей', 'ой', 'ий', 'ем', 'ом', 'ию',
  'ью', 'ия', 'ья', 'а', 'е', 'и', 'й', 'о', 'у', 'ы', 'ь', 'ю', 'я',
];

const SUPERLATIVE = ['ейше', 'ейш'];
const DERIVATIONAL = ['ость', 'ост'];

/**
 * Границы областей слова по Snowball.
 * RV — после первой гласной. R1 — после первой пары «гласная + согласная».
 * R2 — то же самое внутри R1.
 */
function regions(word) {
  const n = word.length;
  let rv = n;
  for (let i = 0; i < n; i++) {
    if (isVowel(word[i])) { rv = i + 1; break; }
  }
  let r1 = n;
  for (let i = 1; i < n; i++) {
    if (isVowel(word[i - 1]) && !isVowel(word[i])) { r1 = i + 1; break; }
  }
  let r2 = n;
  for (let i = r1 + 1; i < n; i++) {
    if (isVowel(word[i - 1]) && !isVowel(word[i])) { r2 = i + 1; break; }
  }
  return { rv, r1, r2 };
}

/**
 * Ищет самое длинное окончание из списка, целиком лежащее внутри области
 * начиная с from. Возвращает позицию начала окончания или -1.
 */
function matchEnding(word, endings, from) {
  let best = -1;
  for (const e of endings) {
    const p = word.length - e.length;
    if (p < from) continue;
    if (word.startsWith(e, p) && p > best) best = p;
  }
  return best;
}

/** То же, но окончанию должна предшествовать «а» или «я», тоже внутри области. */
function matchEndingAfterAYa(word, endings, from) {
  let best = -1;
  for (const e of endings) {
    const p = word.length - e.length;
    if (p - 1 < from) continue;                 // сама «а»/«я» обязана быть в области
    if (word[p - 1] !== 'а' && word[p - 1] !== 'я') continue;
    if (word.startsWith(e, p) && p > best) best = p;
  }
  return best;
}

/** Шаг 1: деепричастие → возвратность → прилагательное / глагол / существительное. */
function step1(word, rv) {
  let p = matchEndingAfterAYa(word, PERFECTIVE_GERUND_1, rv);
  if (p < 0) p = matchEnding(word, PERFECTIVE_GERUND_2, rv);
  if (p >= 0) return word.slice(0, p);

  const refl = matchEnding(word, REFLEXIVE, rv);
  if (refl >= 0) word = word.slice(0, refl);

  // Прилагательное, возможно с причастным окончанием перед ним.
  const adj = matchEnding(word, ADJECTIVE, rv);
  if (adj >= 0) {
    const stem = word.slice(0, adj);
    let q = matchEndingAfterAYa(stem, PARTICIPLE_1, rv);
    if (q < 0) q = matchEnding(stem, PARTICIPLE_2, rv);
    return q >= 0 ? stem.slice(0, q) : stem;
  }

  let v = matchEndingAfterAYa(word, VERB_1, rv);
  if (v < 0) v = matchEnding(word, VERB_2, rv);
  if (v >= 0) return word.slice(0, v);

  const noun = matchEnding(word, NOUN, rv);
  if (noun >= 0) return word.slice(0, noun);

  return word;
}

/**
 * Основа слова по Snowball. Возвращаемая строка — служебный ключ, а не слово:
 * показывать её пользователю нельзя.
 */
export function stemRu(word) {
  if (word.length < 3) return word;

  let { rv, r2 } = regions(word);
  let w = step1(word, rv);

  // Шаг 2: конечная «и».
  if (w.length > rv && w.endsWith('и')) w = w.slice(0, -1);

  // Шаг 3: словообразовательное окончание в R2.
  // R2 считается по исходному слову — так в эталонной реализации.
  if (r2 <= w.length) {
    const d = matchEnding(w, DERIVATIONAL, r2);
    if (d >= 0) w = w.slice(0, d);
  }

  // Шаг 4: «нн» → «н», превосходная степень, мягкий знак.
  if (w.endsWith('нн')) {
    w = w.slice(0, -1);
  } else {
    const s = matchEnding(w, SUPERLATIVE, rv);
    if (s >= 0) {
      w = w.slice(0, s);
      if (w.endsWith('нн')) w = w.slice(0, -1);
    } else if (w.endsWith('ь')) {
      w = w.slice(0, -1);
    }
  }

  return w;
}

export const __internals = { regions, matchEnding, matchEndingAfterAYa };
