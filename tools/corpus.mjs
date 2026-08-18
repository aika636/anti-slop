// Тестовый корпус: экспортированные чаты `.jsonl` с чьей-то машины.
//
// Сообщение модели = НЕ пользователь. Скрытые (`is_system`) включаются намеренно:
// таверна метит этим флагом и служебные вставки, и нормальный отыгрыш, убранный
// из контекста ради экономии токенов. На корпусе разработки так помечено от 55
// до 85 процентов сообщений модели — правило «не системное» выбросило бы историю.
//
// Откуда берутся пути и имена. Сами чаты — личные и в репозиторий не едут, как и
// пути к ним. Порядок такой:
//   1) переменная окружения `ANTISLOP_CORPUS` — пути через `;`;
//   2) файл `tools/corpus.local.mjs` рядом (в `.gitignore`), экспортирующий
//      `FILES` и, если нужно, `CYRILLIC_NAMES`;
//   3) ничего — тогда `FILES` пуст, и стенд честно скажет, что мерить нечего.
//
// `CYRILLIC_NAMES` — костыль корпуса разработки, а не общее правило: в тех
// экспортах имя карточки записано латиницей, а текст ведётся кириллицей, и без
// подсказки стенд мерил бы поблажку, которой в бою не будет. В настоящей
// установке SillyTavern карточка называется так же, как персонаж в тексте.
// Имя персоны при этом дописывать не надо: оно лежит в самих репликах
// пользователя и подбирается само (см. `personaNames`).

import fs from 'node:fs';
import path from 'node:path';

let local = {};
try {
  local = await import('./corpus.local.mjs');
} catch { /* локального корпуса нет — не беда, см. комментарий выше */ }

export const FILES = process.env.ANTISLOP_CORPUS
  ? process.env.ANTISLOP_CORPUS.split(';').map((s) => s.trim()).filter(Boolean)
  : (local.FILES ?? []);

const CYRILLIC_NAMES = local.CYRILLIC_NAMES ?? {};

/** Один чат: заголовок экспорта плюс сообщения модели. */
export function readChat(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  let header = {};
  try { header = JSON.parse(lines[0]); } catch { /* заголовка нет — не беда */ }

  const messages = [];
  const personaNames = new Set();
  for (let i = 1; i < lines.length; i++) {
    let m;
    try { m = JSON.parse(lines[i]); } catch { continue; }
    // Имя персоны берём до отсева: в репликах пользователя оно записано так же,
    // как персонаж зовётся в тексте, — то есть кириллицей, когда карточка латиницей.
    if (m.is_user) { if (m.name) personaNames.add(m.name); continue; }
    if (typeof m.mes !== 'string' || !m.mes.trim()) continue;
    messages.push({ name: m.name, mes: m.mes, isSystem: !!m.is_system });
  }

  const title = path.basename(file);
  return {
    title,
    characterName: header.character_name,
    userName: header.user_name,
    extraNames: [...new Set([...personaNames, ...(CYRILLIC_NAMES[title] ?? [])])],
    messages,
  };
}

export function readCorpus(files = FILES) {
  return files.map(readChat);
}
