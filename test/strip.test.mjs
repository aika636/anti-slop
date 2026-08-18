import test from 'node:test';
import assert from 'node:assert/strict';
import { splitProse } from '../core/strip.mjs';

test('инфоблок в <div> выбрасывается целиком', () => {
  const mes = [
    'Илья застыл в дверном проеме.',
    '',
    '<memo><small>',
    '<div style="background:#2c2c34;padding:8px;font:14px system-ui">',
    '<div style="color:#f7cac9">Текущая обстановка</div>',
    '<span style="color:#ffe0b2">Одежда:</span> строгий черный костюм',
    '</div>',
    '</small></memo>',
    '',
    '"Заткни музыку," процедил он.',
  ].join('\n');

  const { prose, dropped } = splitProse(mes);

  assert.match(prose, /Илья застыл в дверном проеме/);
  assert.match(prose, /процедил он/);
  assert.doesNotMatch(prose, /Одежда/);
  assert.doesNotMatch(prose, /background/);
  assert.doesNotMatch(prose, /system-ui/);
  assert.ok(dropped.blocks >= 1);
  assert.ok(dropped.share > 0.4, `выброшено ${(dropped.share * 100).toFixed(0)}%`);
});

test('промпт генерации картинки не доживает до токенизации', () => {
  const mes = 'Текст. <img src="https://image.pollinations.ai/prompt/'
    + 'retro%2090s%20anime%20cow%20girl?width=1024&height=1024&nologo=true'
    + '&negative_prompt=blurry,text,watermark,ugly" style="width:50px"> Ещё текст.';

  const { prose } = splitProse(mes);

  assert.match(prose, /Текст/);
  assert.match(prose, /Ещё текст/);
  assert.doesNotMatch(prose, /pollinations|negative_prompt|nologo|width/);
});

test('вложенные одноимённые блоки закрываются правильно', () => {
  const mes = 'До. <div>a<div>b</div>c</div> После.';
  const { prose } = splitProse(mes);
  assert.equal(prose.replace(/\s+/g, ' ').trim(), 'До. После.');
});

test('незакрытый блочный тег не съедает остаток сообщения', () => {
  // Модель иногда забывает закрыть тег. Съесть за это половину сообщения —
  // хуже, чем оставить одну лишнюю строку.
  const mes = 'До. <div style="x"> Настоящая проза после сломанного тега.';
  const { prose } = splitProse(mes);
  assert.match(prose, /Настоящая проза/);
  assert.doesNotMatch(prose, /style/);
});

test('атрибут с угловой скобкой не разрывает тег', () => {
  const { prose } = splitProse('А <span title="a>b">видимое</span> Б.');
  assert.equal(prose.replace(/\s+/g, ' ').trim(), 'А видимое Б.');
});

test('инлайновая разметка снимается, слова остаются', () => {
  const { prose } = splitProse('*Он посмотрел* на **неё** и `хмыкнул`.');
  assert.match(prose, /Он посмотрел на неё/);
});

test('блок кода и таблица считаются служебными', () => {
  const mes = 'Проза.\n```\nfoo bar\n```\n| Время | 20:45 |\n| --- | --- |\nЕщё проза.';
  const { prose, dropped } = splitProse(mes);
  assert.doesNotMatch(prose, /foo bar/);
  assert.doesNotMatch(prose, /20:45/);
  assert.match(prose, /Проза/);
  assert.match(prose, /Ещё проза/);
  assert.ok(dropped.code > 0 && dropped.table > 0);
});

test('чистая проза не теряет ни символа', () => {
  const mes = 'Он смотрел на неё, и голос был тихим. Она молчала.';
  const { prose, dropped } = splitProse(mes);
  assert.equal(prose, mes);
  assert.equal(dropped.total, 0);
});
