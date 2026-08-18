import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, stem, stemKey, tokenize, tokenizeMessage, nameBarriers, namesFromChat,
} from '../core/tokenize.mjs';

const forms = segments => segments.map(s => s.map(t => t.form));
const stems = segments => segments.map(s => s.map(t => t.stem));

test('нормализация: регистр, ё, неразрывный пробел', () => {
  assert.equal(normalize('Пришёл'), 'пришел');
  assert.equal(normalize('ЁЖ'), 'еж');
  assert.equal(normalize('а б'), 'а б');
});

test('«ё» приводится до стемминга — иначе формы разойдутся', () => {
  assert.equal(stem(normalize('пришёл')), stem(normalize('пришел')));
});

test('стемминг выбирается по алфавиту слова', () => {
  assert.equal(stem('смотрели'), stem('смотрела'));
  assert.equal(stem('looking'), stem('looked'));
});

test('сегменты обрываются на знаках конца предложения', () => {
  const segs = tokenize('Он замолчал. Она ушла', { stem: false });
  assert.deepEqual(forms(segs), [['он', 'замолчал'], ['она', 'ушла']]);
});

test('перенос строки — тоже граница', () => {
  const segs = tokenize('первая строка\nвторая строка', { stem: false });
  assert.equal(segs.length, 2);
});

test('дефисные слова остаются одним токеном', () => {
  const segs = tokenize('из-за двери', { stem: false });
  assert.deepEqual(forms(segs), [['из-за', 'двери']]);
});

test('цифры и знаки не превращаются в токены', () => {
  const segs = tokenize('в 22 30 часа', { stem: false });
  assert.deepEqual(forms(segs), [['в', 'часа']]);
});

test('имя обрывает оборот, а не выпадает из него молча', () => {
  // Иначе «посмотрел на Алису и вздохнул» дало бы оборот
  // «посмотрел на вздохнул», которого в тексте не было.
  const barriers = nameBarriers(['Алиса де Вер']);
  const segs = tokenize('посмотрел на Алису и вздохнул', { barriers });
  assert.deepEqual(forms(segs), [['посмотрел', 'на'], ['и', 'вздохнул']]);
});

test('имя ловится в любой падежной форме', () => {
  const barriers = nameBarriers(['Алиса']);
  const segs = tokenize('обнял Алису крепко', { barriers });
  assert.deepEqual(forms(segs), [['обнял'], ['крепко']]);
});

test('короткая основа имени не режет похожие слова', () => {
  // У «Ильи» основа «ил» — ровно как у союза «или». Барьер по одной основе
  // разрывал бы текст на каждом «или»: 363 раза на четырёх тестовых чатах.
  const barriers = nameBarriers(['Илья']);
  const segs = tokenize('илья кивнул или промолчал', { barriers });
  assert.deepEqual(forms(segs), [['кивнул', 'или', 'промолчал']]);
});

test('название карточки не превращает обычные слова в барьеры', () => {
  const barriers = nameBarriers(['A Girl and Two Boys']);
  const segs = tokenize('the girl looked at the boys', { barriers });
  assert.equal(segs.length, 1, 'английская фраза распалась на куски');
});

test('исключения разлепляют слова, слитые стеммером', () => {
  // Найдено на живых чатах: «боль» уходила в «бол» вместе с «более»,
  // «запах» — в «зап» вместе с «записью», «целует» — в «цел» вместе с «целью».
  assert.notEqual(stemKey('боль'), stemKey('более'));
  assert.notEqual(stemKey('запах'), stemKey('запись'));
  assert.notEqual(stemKey('целует'), stemKey('цель'));
  assert.notEqual(stemKey('нее'), stemKey('не'));
  assert.notEqual(stemKey('нос'), stemKey('носить'));
  assert.notEqual(stemKey('надеюсь'), stemKey('над'));
});

test('исключения склеивают видовые пары', () => {
  assert.equal(stemKey('продолжал'), stemKey('продолжил'));
  assert.equal(stemKey('позволяя'), stemKey('позволил'));
});

test('имена берутся из чата без участия пользователя', () => {
  const names = namesFromChat({
    characterName: 'unused',
    userName: 'Renee',
    messages: [{ name: 'Ilya Yarovoy' }, { name: 'Renee' }],
  });
  assert.deepEqual([...names].sort(), ['Ilya Yarovoy', 'Renee']);
});

test('исключения стеммера перекрывают алгоритм', () => {
  const exceptions = new Map([['холодок', 'холодк']]);
  const segs = tokenize('холодок и холодка', { exceptions });
  assert.deepEqual(stems(segs), [['холодк', 'и', 'холодк']]);
});

test('разбор сообщения: проза, отчёт и токены в одном вызове', () => {
  const mes = 'Его голос был тихим.\n<div style="x">Одежда: пижама</div>\nОн отвернулся.';
  const { segments, dropped, words } = tokenizeMessage(mes);

  assert.deepEqual(forms(segments), [
    ['его', 'голос', 'был', 'тихим'],
    ['он', 'отвернулся'],
  ]);
  assert.equal(words, 6);
  assert.ok(dropped.blocks === 1);
});

test('на пустом входе ничего не падает', () => {
  assert.deepEqual(tokenizeMessage('').segments, []);
  assert.deepEqual(tokenizeMessage(undefined).segments, []);
  assert.deepEqual(tokenize('!!! ... ???').length, 0);
});
