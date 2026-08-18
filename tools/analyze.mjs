// Стенд: полный проход ядра по чату.
//
//   node tools/analyze.mjs                    — весь корпус, по чату отдельно
//   node tools/analyze.mjs --top 20           — сколько оборотов печатать
//   node tools/analyze.mjs --messages         — плюс индекс по каждому сообщению
//   node tools/analyze.mjs "путь/к/чату.jsonl"
//
// Скрипт принимает
// JSON чата и печатает топ оборотов, индекс по сообщениям, разнообразие и
// находки самоповтора. Всё считает `core/analyze`, здесь только чтение файлов и
// печать — стенд не должен уметь ничего, чего не умеет ядро, иначе он перестанет
// быть проверкой ядра.

import { readCorpus, readChat, FILES } from './corpus.mjs';
import { analyzeChat } from '../core/analyze.mjs';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? def) : def;
};
const TOP = Number(flag('--top', 15)) || 15;
const SHOW_MESSAGES = argv.includes('--messages');
const files = argv.filter(a => !a.startsWith('--') && a.endsWith('.jsonl'));

const corpus = files.length ? files.map(readChat) : readCorpus(FILES);

const fmt = x => Math.round(x).toLocaleString('ru-RU');
const pct = x => (x * 100).toFixed(1) + '%';

for (const chat of corpus) {
  const t0 = Date.now();
  const r = analyzeChat(chat, { extraNames: chat.extraNames, topLimit: Math.max(TOP, 50) });
  const ms = Date.now() - t0;

  console.log('\n' + '='.repeat(72));
  console.log(chat.title);
  console.log('='.repeat(72));
  console.log(`Сообщений модели: ${r.messages.length}, слов прозы: ${fmt(r.stats.words)}, `
    + `за ${fmt(ms)} мс. Режим счётчика: ${r.stats.mode}.`);
  console.log(`Имена в стоп-листе: ${r.stats.names.join(', ') || '—'}`);

  console.log(`\nИндекс чата: ${r.index.value}`
    + `${r.index.draft ? ' (черновой: прозы меньше порога калибровки)' : ''}`
    + `, версия формулы ${r.index.version}`);
  console.log(`Разнообразие: MATTR ${pct(r.diversity.mattr)}`
    + `${Number.isFinite(r.diversity.mtld) ? `, MTLD ${r.diversity.mtld.toFixed(1)}` : ''}`);

  console.log(`\n--- Топ оборотов (C-value, кандидатов ${fmt(r.candidates)}`
    + `${r.preliminary ? ', список предварительный' : ''}) ---`);
  for (const [i, o] of r.top.slice(0, TOP).entries()) {
    console.log(String(i + 1).padStart(3) + '. '
      + `${(o.text ?? o.stems?.join(' ') ?? '?')}`.padEnd(48)
      + ` ×${String(o.count).padStart(3)}  C=${o.cvalue.toFixed(1)}`
      + `  сообщ. ${o.firstMessage}–${o.lastMessage}`);
  }

  console.log(`\n--- Самоповтор (порог ${pct(r.baseline.threshold)}, `
    + `пол ${pct(r.baseline.median)}, пар ${fmt(r.baseline.pairs)}) ---`);
  if (!r.findings.length) console.log('  находок нет');
  for (const f of r.findings.slice(0, 10)) {
    console.log(`  сообщение ${String(f.index).padStart(4)} ← ${String(f.partner).padStart(4)}`
      + `   похожесть ${pct(f.containment).padStart(7)}`
      + `   дословно подряд ${String(f.runLength).padStart(3)} слов`
      + (f.notable ? '  ← заметно' : ''));
  }

  if (SHOW_MESSAGES) {
    console.log('\n--- Индекс по сообщениям ---');
    console.log('№'.padStart(5), 'слов'.padStart(7), 'индекс'.padStart(7),
      'покрытие'.padStart(9), 'MATTR'.padStart(7), 'похоже'.padStart(8));
    for (const m of r.messages) {
      console.log(String(m.index).padStart(5), fmt(m.words).padStart(7),
        String(m.value).padStart(7), pct(m.coverage).padStart(9),
        pct(m.diversity.mattr).padStart(7),
        pct(m.repeat?.containment ?? 0).padStart(8));
    }
  }
}
