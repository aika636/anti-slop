// Модульный воркер стенда производительности.
//
// Часть 3 замера (см. `tools/bench/bench.mjs`): тот же полный проход,
// что и на главном потоке, только внутри `Worker({type: 'module'})`, который
// импортирует ядро своими собственными `import`. Отдельной пробой заранее
// проверено, что такой воркер в таверне поднимается, — здесь тот же приём,
// но с настоящим ядром вместо игрушечного счётчика слов.
//
// Протокол: главный поток шлёт {id, chat}. Воркер немедленно, до всякой
// тяжёлой работы, отвечает {type:'ack', id} — этим сообщением стенд меряет
// стоимость передачи текста в воркер (структурное клонирование туда и
// обратно), отдельно от стоимости самого анализа. Затем воркер считает
// analyzeChat и шлёт {type:'done', id, passMs, summary}. `passMs` — по часам
// самого воркера: у воркера свой time origin, сравнивать его напрямую со
// временем главного потока нельзя, поэтому наружу идёт только длительность.

import { analyzeChat } from '../../core/analyze.mjs';

self.addEventListener('message', (e) => {
  const { id, chat } = e.data ?? {};
  if (chat == null) return;

  // Отвечаем раньше, чем начнём считать: именно момент получения этого
  // сообщения на главном потоке и есть цена передачи чата в воркер.
  self.postMessage({ type: 'ack', id });

  try {
    const t0 = performance.now();
    const result = analyzeChat(chat, { extraNames: chat.extraNames ?? [] });
    const passMs = performance.now() - t0;

    self.postMessage({
      type: 'done',
      id,
      passMs,
      summary: {
        index: result.index.value,
        words: result.stats.words,
        top: result.top.slice(0, 10).map(x => x.text),
        findings: result.findings.length,
      },
    });
  } catch (error) {
    self.postMessage({ type: 'error', id, message: String(error?.stack ?? error) });
  }
});
