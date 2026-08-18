// Отделение прозы от служебного текста.
//
// Сообщение реального чата состоит не только из прозы: вместе с ней в текст
// попадают промпты генерации картинок, инфоблоки пресета и разметка. Всё это
// повторяется по устройству, а не потому, что модель скатилась в штамп, и без
// фильтрации занимает половину топа.
//
// Надёжность по убыванию: разметка и промпты картинок вырезаются точно,
// инфоблоки — эвристикой, поэтому функция возвращает отчёт о выброшенном:
// пользователю его надо показывать, иначе непонятные цифры спишут на баг.

// Теги, внутри которых текст остаётся прозой: тег снимается, содержимое живёт.
const TRANSPARENT = new Set([
  'i', 'b', 'em', 'strong', 'u', 's', 'strike', 'del', 'ins', 'mark', 'q',
  'span', 'small', 'big', 'font', 'sub', 'sup', 'a', 'p', 'br', 'hr', 'wbr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

// Пустые теги: закрывающего нет, содержимого нет.
const VOID = new Set([
  'br', 'hr', 'img', 'wbr', 'input', 'meta', 'link', 'source', 'col', 'area',
]);

const TAG_START = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/y;

/**
 * Находит конец тега, начинающегося в позиции i (символ `<`).
 * Кавычки в значениях атрибутов учитываются: `<div title="a>b">` — один тег.
 * Возвращает позицию сразу за `>` или -1, если тег не закрыт.
 */
function tagEnd(text, i) {
  let quote = null;
  for (let p = i + 1; p < text.length; p++) {
    const ch = text[p];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return p + 1;
    }
  }
  return -1;
}

/** Разбор `<...>` в позиции i. Возвращает null, если это не тег. */
function parseTag(text, i) {
  TAG_START.lastIndex = i;
  const m = TAG_START.exec(text);
  if (!m) return null;
  const end = tagEnd(text, i);
  if (end < 0) return null;
  return {
    name: m[1].toLowerCase(),
    closing: text[i + 1] === '/',
    selfClosing: text[end - 2] === '/',
    end,
  };
}

/**
 * Ищет закрывающий тег с учётом вложенности одноимённых.
 * Возвращает позицию сразу за закрывающим тегом или -1.
 */
function findClose(text, from, name) {
  let depth = 1;
  let p = from;
  while (p < text.length) {
    const lt = text.indexOf('<', p);
    if (lt < 0) return -1;
    const t = parseTag(text, lt);
    if (!t) { p = lt + 1; continue; }
    if (t.name === name && !t.selfClosing && !VOID.has(name)) {
      depth += t.closing ? -1 : 1;
      if (depth === 0) return t.end;
    }
    p = t.end;
  }
  return -1;
}

/**
 * Вырезает разметку. Блочные и незнакомые теги (`div`, `table`, `details`,
 * а также XML-подобные теги пресетов вроде `<status>`) считаются служебными
 * вместе с содержимым: там и лежат инфоблоки с промптами картинок.
 * Незакрытый блочный тег до конца сообщения не съедает — снимается как одиночный,
 * иначе одна опечатка модели обнулила бы всё сообщение.
 */
function stripMarkup(text) {
  let out = '';
  let droppedBlocks = 0;
  let droppedChars = 0;
  let p = 0;

  while (p < text.length) {
    const lt = text.indexOf('<', p);
    if (lt < 0) { out += text.slice(p); break; }
    out += text.slice(p, lt);

    // Комментарий.
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt);
      const end = close < 0 ? text.length : close + 3;
      droppedChars += end - lt;
      p = end;
      continue;
    }

    const t = parseTag(text, lt);
    if (!t) { out += '<'; p = lt + 1; continue; }

    const isBlock = !TRANSPARENT.has(t.name);
    if (isBlock && !t.closing && !t.selfClosing && !VOID.has(t.name)) {
      const close = findClose(text, t.end, t.name);
      if (close > 0) {
        droppedChars += close - lt;
        droppedBlocks++;
        out += ' ';
        p = close;
        continue;
      }
    }

    // Одиночный тег: снимаем вместе с атрибутами, содержимое остаётся.
    droppedChars += t.end - lt;
    out += ' ';
    p = t.end;
  }

  return { text: out, droppedBlocks, droppedChars };
}

/** Блоки кода — служебные целиком: там либо разметка, либо технический вывод. */
function stripFences(text) {
  let dropped = 0;
  const out = text.replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?\2[ \t]*(?=\n|$)/g, m => {
    dropped += m.length;
    return '\n';
  });
  return { text: out, droppedChars: dropped };
}

/** Таблицы markdown — инфоблок в самом частом его оформлении. */
function stripTables(text) {
  let dropped = 0;
  const out = text.split('\n').filter(line => {
    const l = line.trim();
    const isRow = l.startsWith('|') && l.slice(1).includes('|');
    if (isRow) dropped += line.length;
    return !isRow;
  }).join('\n');
  return { text: out, droppedChars: dropped };
}

/** Снимает markdown-оформление, не трогая слова. */
function stripInlineMarkdown(text) {
  return text
    .replace(/`{1,3}[^`\n]*`{1,3}/g, ' ')            // инлайн-код
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')   // ссылки и картинки
    .replace(/(^|\n)[ \t]*#{1,6}[ \t]+/g, '$1')      // заголовки
    .replace(/(^|\n)[ \t]*>+[ \t]?/g, '$1')          // цитаты
    .replace(/[*_~]/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');              // html-сущности
}

/**
 * Разбирает текст сообщения на прозу и служебную часть.
 *
 * @param {string} mes текст активного свайпа
 * @returns {{prose: string, dropped: {code: number, table: number, markup: number,
 *   blocks: number, total: number, share: number}}}
 */
export function splitProse(mes) {
  const original = mes ?? '';

  const fences = stripFences(original);
  const tables = stripTables(fences.text);
  const markup = stripMarkup(tables.text);
  const prose = stripInlineMarkdown(markup.text).replace(/[ \t]+/g, ' ').trim();

  const total = fences.droppedChars + tables.droppedChars + markup.droppedChars;
  return {
    prose,
    dropped: {
      code: fences.droppedChars,
      table: tables.droppedChars,
      markup: markup.droppedChars,
      blocks: markup.droppedBlocks,
      total,
      share: original.length ? total / original.length : 0,
    },
  };
}

export const __internals = { stripMarkup, stripFences, stripTables, stripInlineMarkdown };
