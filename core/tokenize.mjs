// core/tokenize — нормализация, разбиение на сегменты, токенизация, стемминг.
//
// Публичная точка входа ядра для всего, что идёт до подсчёта n-грамм.
// Ничего не знает ни про браузер, ни про SillyTavern: на вход строка текста и
// список имён, на выход — сегменты токенов.
//
// Два решения, которые здесь материализуются:
//   1) стемминг включён по умолчанию. Русский оборот варьируется по
//         согласованию, и при точном совпадении каждая форма уходит в свою
//         корзину, а оборот не всплывает в топе вообще.
//   3.7 — проза отделяется от разметки и инфоблоков до токенизации.
//
// Пользователю основа не показывается никогда: наружу идёт самая частая живая
// форма, поэтому токен несёт и форму, и основу.

import { stemRu } from './stemmer-ru.mjs';
import { stemEn } from './stemmer-en.mjs';
import { splitProse } from './strip.mjs';

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[a-z]/;

// Слово: буква, дальше буквы, диакритика, дефис и апостроф внутри.
const WORD = /\p{L}[\p{L}\p{M}]*(?:['’-]\p{L}[\p{L}\p{M}]*)*/gu;

// Границы сегмента: между ними n-грамма не строится.
const SEGMENT_BREAK = /[.!?…;:\n\r]+|(?:^|\s)[—–-]{1,2}(?=\s)/g;

/**
 * Приведение к сравнимому виду: регистр, «ё → е», единая форма Unicode.
 * Замена «ё» обязана идти до стемминга — иначе «пришёл» и «пришел»
 * разойдутся в разные корзины.
 */
export function normalize(text) {
  return (text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[   ﻿]/g, ' ')
}

/** Основа слова. Кириллица — Snowball, латиница — Porter2, прочее — как есть. */
export function stem(word) {
  if (CYRILLIC.test(word)) return stemRu(word);
  if (LATIN.test(word)) return stemEn(word);
  return word;
}

// --- исключения стеммера ----------------------------------------------------
// Собраны по живому выводу на реальных
// чатах (`tools/stem-errors.mjs`), а не придуманы заранее.
// Список пополняется: это не полное описание русского языка, а заплатки на те
// ошибки, которые видны на РП-лексике и портят топ.
//
// Значение — внутренний ключ, пользователю он не показывается никогда, поэтому
// «пот_тело» ничем не хуже «пот»: важно только, чтобы ключи не пересекались.

// Разлепить: Snowball свёл в одну корзину разные слова.
const SPLIT = {
  // «нее»/«ней» уходили в «не» — местоимение слипалось с отрицанием
  'нее': ['нее', 'ней', 'нею'],
  // «боль» уходила в «бол» вместе с «более»
  'боль': ['боль', 'боли', 'болью', 'болит', 'болят', 'болела', 'болело'],
  // «пот» уходил в «пот» вместе с «потому» и «потом»
  'пот_тело': ['пот', 'пота', 'поту', 'потный', 'потная', 'потные'],
  // «запах» уходил в «зап» вместе с «записью»
  'запах': ['запах', 'запахах'],
  'запис': ['запись', 'записью', 'записка'],
  // «нос» слипался с «носить»
  'нос_тело': ['нос', 'носа', 'носу', 'носом', 'носы'],
  'носи': ['носить', 'носил', 'носила', 'носит', 'носишь', 'носят', 'носила'],
  // «целует» слипалось с «целью» и «целым»
  'целова': ['целовать', 'целует', 'целую', 'целуя', 'целуют', 'целовал', 'целовала'],
  'цель': ['цель', 'цели', 'целью', 'целей', 'целям'],
  // «надеюсь» уходило в «над»
  'надежд': ['надеюсь', 'надеяться', 'надеется', 'надейся', 'надеялся', 'надеялась', 'надежда', 'надежды'],
  // «давить» слипалось с «давая»
  'дави': ['давить', 'давит', 'давил', 'давила', 'давление', 'давлением'],
  // «семья» слипалась с «семя» и «семь»
  'семья': ['семья', 'семьи', 'семье', 'семьей', 'семью', 'семей'],
  'семя': ['семя', 'семени', 'семенем'],
  // «серия» слипалась с «серым»
  'сери': ['серия', 'серию', 'серии', 'сериал'],
  // «смесь» слипалась со «смей»
  'смесь': ['смесь', 'смеси', 'смесью'],
  // «медь» слипалась с «мёдом»
  'медь': ['медь', 'меди', 'медью'],
  // «имя» слипалось с «им»
  'имя': ['имя', 'имени', 'именем', 'имена', 'именам'],
  // «неся» уходило в отрицание «не»
  'нес': ['неся', 'нести', 'несу', 'несет'],
};

/**
 * Ручной список исключений стеммера. Ключ — слово целиком после нормализации,
 * значение — основа.
 */
export const STEM_EXCEPTIONS = new Map(
  Object.entries(SPLIT).flatMap(([key, words]) => words.map(w => [w, key])),
);

/**
 * Склеить: Snowball не свёл формы одного слова. Видовые пары русского глагола
 * он разводит систематически — «продолжал» даёт «продолжа», «продолжил» даёт
 * «продолж». Ключ — то, что стеммер выдал, значение — во что это свести.
 */
export const STEM_MERGES = new Map(Object.entries({
  'продолжа': 'продолж',
  'позволя': 'позвол',
  'пыта': 'пыт',
  'дава': 'дав',
  'стоя': 'сто',
}));

/**
 * Ключ слова: стеммер плюс исключения. Это то, чем пользуется всё остальное
 * ядро; голый `stem` оставлен для сравнений и отладки.
 */
export function stemKey(word, exceptions) {
  return stemWithExceptions(word, exceptions);
}

function stemWithExceptions(word, exceptions) {
  const own = exceptions?.get(word);
  if (own !== undefined) return own;
  const global = STEM_EXCEPTIONS.get(word);
  if (global !== undefined) return global;
  const s = stem(word);
  return STEM_MERGES.get(s) ?? s;
}

// Служебные слова двух языков. Нужны ровно в одном месте — чтобы не превратить
// в барьер обычное слово, попавшее в название карточки. Карточки часто зовутся
// фразой («A Girl and Two Boys»), и без этого фильтра «girl», «at»
// и «a» разрезали бы английские куски текста в труху.
const NAME_SAFE_STOP = new Set((
  'и а но да же ли бы то что как так вот уже еще не ни в во на за по под над о '
  + 'об от до из у к с со для при про без через между это эта этот эти он она они '
  + 'оно его ее их им ему ей я ты мы вы был была были было быть есть нет когда '
  + 'где куда только если чтобы или сам один одна одно мой моя твой '
  + 'the a an and or of in on at to for with from by is are was were be been am '
  + 'my your his her its our their this that these those it he she they you we i '
  + 'girl girls boy boys man woman men women only all new old'
).split(' '));

/**
 * Имена персонажей и персон, попадающие в стоп-лист автоматически.
 * Разбираются на отдельные слова: «Алиса де Вер» даёт два барьера — «де»
 * отсеивается по длине.
 *
 * Барьер, а не удаление: иначе «посмотрел на Алису и вздохнул» склеится в
 * оборот «посмотрел на вздохнул», которого в тексте не было.
 *
 * Сверка идёт по основе И по началу слова, а не по одной основе. У «Ильи»
 * основа «ил» — то же самое, что у союза «или», и барьер по одной основе резал
 * бы текст на каждом «или» (363 раза на четырёх чатах). Начало берётся длиной
 * до четырёх букв, чтобы падежные формы имени сохранились: «иль» ловит «илья»,
 * «ильи», «илью», но не «или».
 *
 * @returns {Map<string, string[]>} основа → допустимые начала слова
 */
export function nameBarriers(names, exceptions) {
  const out = new Map();
  for (const name of names ?? []) {
    for (const w of normalize(name).match(WORD) ?? []) {
      if (w.length < 3) continue;
      if (NAME_SAFE_STOP.has(w)) continue;
      const key = stemWithExceptions(w, exceptions);
      const prefix = w.slice(0, Math.max(2, Math.min(w.length - 1, 4)));
      const list = out.get(key);
      if (list) { if (!list.includes(prefix)) list.push(prefix); } else out.set(key, [prefix]);
    }
  }
  return out;
}

/**
 * Собирает имена из данных чата: заголовок экспорта плюс поле `name`
 * каждого сообщения. Пользователь в этом не участвует.
 */
export function namesFromChat({ characterName, userName, messages } = {}) {
  const out = new Set();
  const add = v => {
    if (typeof v === 'string' && v.trim() && v !== 'unused') out.add(v.trim());
  };
  add(characterName);
  add(userName);
  for (const m of messages ?? []) add(m?.name);
  return out;
}

/**
 * Разбивает нормализованный текст на сегменты и токены.
 *
 * @param {string} text проза, уже прошедшая splitProse
 * Токен всегда несёт живую форму; основа считается, когда она кому-то нужна —
 * для ключа при `stem: true` или для сверки со стоп-листом имён. Барьер
 * проверяется по основе всегда: имя должно обрываться в любом падеже,
 * независимо от того, по формам считается статистика или по основам.
 *
 * @param {string} text проза, уже прошедшая splitProse
 * @param {{barriers?: Map<string,string[]>, stem?: boolean, exceptions?: Map<string,string>}} [opts]
 * @returns {Array<Array<{form: string, stem: string}>>} сегменты токенов
 */
export function tokenize(text, opts = {}) {
  const { barriers, stem: doStem = true, exceptions } = opts;
  const needStem = doStem || !!barriers;
  const segments = [];

  for (const raw of normalize(text).split(SEGMENT_BREAK)) {
    if (!raw) continue;
    let current = [];
    for (const form of raw.match(WORD) ?? []) {
      const key = needStem ? stemWithExceptions(form, exceptions) : form;
      const prefixes = barriers?.get(key);
      if (prefixes && prefixes.some(p => form.startsWith(p))) {
        // Имя обрывает сегмент, но само в него не входит.
        if (current.length) segments.push(current);
        current = [];
        continue;
      }
      current.push({ form, stem: key });
    }
    if (current.length) segments.push(current);
  }

  return segments;
}

/**
 * Полный разбор одного сообщения: проза → сегменты токенов, плюс отчёт о том,
 * что было выброшено как служебное. Отчёт показывается пользователю — без него
 * непонятные цифры спишут на баг.
 *
 * @param {string} mes текст активного свайпа (`m.mes`)
 */
export function tokenizeMessage(mes, opts = {}) {
  const { prose, dropped } = splitProse(mes);
  const segments = tokenize(prose, opts);
  let words = 0;
  for (const s of segments) words += s.length;
  return { prose, dropped, segments, words };
}

export { splitProse } from './strip.mjs';
export { stemRu } from './stemmer-ru.mjs';
export { stemEn } from './stemmer-en.mjs';
