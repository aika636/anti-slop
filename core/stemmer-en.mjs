// Porter2 (English Snowball) — порт эталонного алгоритма
// (snowballstem.org/algorithms/english/stemmer.html).
//
// Латиница в русских чатах встречается кусками: английские реплики, названия,
// вставки. Отдельный стеммер нужен, чтобы «looked» и «looking» не расходились.
// Ожидает слово в нижнем регистре.

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
const isVowel = ch => VOWELS.has(ch);

const DOUBLES = ['bb', 'dd', 'ff', 'gg', 'mm', 'nn', 'pp', 'rr', 'tt'];
const VALID_LI = new Set(['c', 'd', 'e', 'g', 'h', 'k', 'm', 'n', 'r', 't']);

const EXCEPTIONS = new Map(Object.entries({
  skis: 'ski', skies: 'sky', dying: 'die', lying: 'lie', tying: 'tie',
  idly: 'idl', gently: 'gentl', ugly: 'ugli', early: 'earli', only: 'onli',
  singly: 'singl',
  sky: 'sky', news: 'news', howe: 'howe', atlas: 'atlas', cosmos: 'cosmos',
  bias: 'bias', andes: 'andes',
}));

// Слова, останавливающиеся сразу после step 1a.
const EXCEPTIONS_1A = new Set([
  'inning', 'outing', 'canning', 'herring', 'earring',
  'proceed', 'exceed', 'succeed',
]);

/** R1/R2 плюс особые приставки, для которых R1 задан жёстко. */
function regions(word) {
  let r1 = word.length;
  const special = ['gener', 'commun', 'arsen'];
  const pre = special.find(p => word.startsWith(p));
  if (pre) {
    r1 = pre.length;
  } else {
    for (let i = 1; i < word.length; i++) {
      if (isVowel(word[i - 1]) && !isVowel(word[i])) { r1 = i + 1; break; }
    }
  }
  let r2 = word.length;
  for (let i = r1 + 1; i < word.length; i++) {
    if (isVowel(word[i - 1]) && !isVowel(word[i])) { r2 = i + 1; break; }
  }
  return { r1, r2 };
}

/** Короткий слог: гласная между согласными в конце слова, либо в самом начале. */
function endsShortSyllable(word) {
  const n = word.length;
  if (n >= 3) {
    const [a, b, c] = [word[n - 3], word[n - 2], word[n - 1]];
    if (!isVowel(a) && isVowel(b) && !isVowel(c) && c !== 'w' && c !== 'x' && c !== 'y') return true;
  }
  return n === 2 && isVowel(word[0]) && !isVowel(word[1]);
}

const isShort = (word, r1) => r1 >= word.length && endsShortSyllable(word);

const containsVowel = s => [...s].some(isVowel);

/** «y» после гласной считается согласной — помечаем её заглавной Y. */
function markY(word) {
  let out = word[0] === 'y' ? 'Y' : word[0];
  for (let i = 1; i < word.length; i++) {
    out += (word[i] === 'y' && isVowel(word[i - 1])) ? 'Y' : word[i];
  }
  return out;
}

function step0(w) {
  for (const s of ["'s'", "'s", "'"]) {
    if (w.endsWith(s)) return w.slice(0, -s.length);
  }
  return w;
}

function step1a(w) {
  if (w.endsWith('sses')) return w.slice(0, -4) + 'ss';
  if (w.endsWith('ied') || w.endsWith('ies')) {
    return w.length > 4 ? w.slice(0, -3) + 'i' : w.slice(0, -3) + 'ie';
  }
  if (w.endsWith('ss') || w.endsWith('us')) return w;
  if (w.endsWith('s')) return containsVowel(w.slice(0, -2)) ? w.slice(0, -1) : w;
  return w;
}

function step1b(w, r1) {
  if (w.endsWith('eed') || w.endsWith('eedly')) {
    const suf = w.endsWith('eedly') ? 'eedly' : 'eed';
    const p = w.length - suf.length;
    return p >= r1 ? w.slice(0, p) + 'ee' : w;
  }
  for (const suf of ['ingly', 'edly', 'ing', 'ed']) {
    if (!w.endsWith(suf)) continue;
    const stem = w.slice(0, -suf.length);
    if (!containsVowel(stem)) return w;
    if (/(at|bl|iz)$/.test(stem)) return stem + 'e';
    if (DOUBLES.some(d => stem.endsWith(d))) return stem.slice(0, -1);
    if (isShort(stem, regions(stem).r1)) return stem + 'e';
    return stem;
  }
  return w;
}

function step1c(w) {
  const n = w.length;
  if (n > 2 && (w[n - 1] === 'y' || w[n - 1] === 'Y') && !isVowel(w[n - 2])) {
    return w.slice(0, -1) + 'i';
  }
  return w;
}

const STEP2 = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
  ['abli', 'able'], ['entli', 'ent'], ['izer', 'ize'], ['ization', 'ize'],
  ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['aliti', 'al'],
  ['alli', 'al'], ['fulness', 'ful'], ['ousli', 'ous'], ['ousness', 'ous'],
  ['iveness', 'ive'], ['iviti', 'ive'], ['biliti', 'ble'], ['bli', 'ble'],
  ['fulli', 'ful'], ['lessli', 'less'], ['ogi', 'og'], ['li', ''],
];

function step2(w, r1) {
  for (const [suf, rep] of [...STEP2].sort((a, b) => b[0].length - a[0].length)) {
    if (!w.endsWith(suf)) continue;
    const p = w.length - suf.length;
    if (p < r1) return w;
    if (suf === 'ogi') return w[p - 1] === 'l' ? w.slice(0, p) + rep : w;
    if (suf === 'li') return VALID_LI.has(w[p - 1]) ? w.slice(0, p) : w;
    return w.slice(0, p) + rep;
  }
  return w;
}

const STEP3 = [
  ['ational', 'ate'], ['tional', 'tion'], ['alize', 'al'], ['icate', 'ic'],
  ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', ''],
];

function step3(w, r1, r2) {
  if (w.endsWith('ative')) {
    return w.length - 5 >= r2 ? w.slice(0, -5) : w;
  }
  for (const [suf, rep] of [...STEP3].sort((a, b) => b[0].length - a[0].length)) {
    if (!w.endsWith(suf)) continue;
    const p = w.length - suf.length;
    return p >= r1 ? w.slice(0, p) + rep : w;
  }
  return w;
}

const STEP4 = [
  'ement', 'ance', 'ence', 'able', 'ible', 'ment', 'ant', 'ent', 'ism',
  'ate', 'iti', 'ous', 'ive', 'ize', 'al', 'er', 'ic',
];

function step4(w, r2) {
  if (w.endsWith('ion')) {
    const p = w.length - 3;
    if (p >= r2 && (w[p - 1] === 's' || w[p - 1] === 't')) return w.slice(0, p);
  }
  for (const suf of [...STEP4].sort((a, b) => b.length - a.length)) {
    if (!w.endsWith(suf)) continue;
    const p = w.length - suf.length;
    return p >= r2 ? w.slice(0, p) : w;
  }
  return w;
}

function step5(w, r1, r2) {
  if (w.endsWith('e')) {
    const p = w.length - 1;
    if (p >= r2) return w.slice(0, p);
    if (p >= r1 && !endsShortSyllable(w.slice(0, p))) return w.slice(0, p);
    return w;
  }
  if (w.endsWith('ll') && w.length - 1 >= r2) return w.slice(0, -1);
  return w;
}

/** Основа английского слова по Porter2. Как и в русском — служебный ключ. */
export function stemEn(word) {
  if (word.length <= 2) return word;
  if (EXCEPTIONS.has(word)) return EXCEPTIONS.get(word);

  let w = word.replace(/^'/, '');
  w = markY(w);
  const { r1, r2 } = regions(w);

  w = step0(w);
  w = step1a(w);
  if (EXCEPTIONS_1A.has(w.toLowerCase())) return w.toLowerCase();
  w = step1b(w, r1);
  w = step1c(w);
  w = step2(w, r1);
  w = step3(w, r1, r2);
  w = step4(w, r2);
  w = step5(w, r1, r2);

  return w.replace(/Y/g, 'y');
}
