/**
 * card — карточка чата в PNG.
 *
 * Смысл функции не в красоте: цифра, которой нельзя
 * поделиться, не сравнивается ни с чьей чужой, а сравнение пресетов между людьми
 * — это то, ради чего в проекте вообще заводится индекс. Скриншот панели для
 * этого не годится: он несёт чужую тему, обрезанный список и ничего не говорит о
 * том, что число посчитано в браузере.
 *
 * Рисуется руками на канве. Обе очевидные альтернативы отпали заранее:
 * html2canvas — это 150 КБ и собственный приблизительный движок вёрстки, а SVG,
 * загруженный как изображение, не имеет права тянуть внешние шрифты, то есть
 * поедет чужой гарнитурой у каждого второго.
 *
 * Три ловушки, каждая ломает функцию молча, — и что с ними здесь сделано:
 *
 * 1. **Лимит площади канвы в iOS Safari.** Карточка 1200×1600 при тройной
 *    плотности пикселей даёт 17 миллионов точек и превышает его. Масштаб
 *    считается от лимита, а не берётся константой.
 * 2. **Safari не спешит освобождать память канвы.** Размеры обнуляются сразу
 *    после экспорта, иначе вторая-третья карточка подряд падает.
 * 3. **Только `toBlob`.** `toDataURL` на картинку такого размера — это лишние
 *    двадцать мегабайт строкой в памяти на ровном месте.
 *
 * И отдельно про текст: ширина мерится штатным измерителем, высота строки берётся
 * из метрик. Наивный расчёт «размер шрифта × 1,2» срезает у «Ё» верхнюю точку, а
 * средняя ширина символа, посчитанная по латинице, обрезает русскую строку.
 */

import { t, formatNumber, formatPercent } from '../i18n/index.mjs';

/** Логический размер карточки. Портрет 3:4 — то, что не обрезают мессенджеры. */
const W = 1200;
const H = 1600;

/**
 * Потолок площади растра. У iOS Safari он около 16,7 миллиона точек, у части
 * старых Android-вебвью — меньше; берём с запасом. Превышение не даёт ошибки:
 * канва просто оказывается пустой, и пользователь получает чёрный прямоугольник
 * вместо карточки.
 */
const MAX_AREA = 12_000_000;

/** И отдельно потолок стороны: некоторые движки ограничивают именно её. */
const MAX_SIDE = 4096;

/**
 * Своя палитра, а не переменные темы таверны.
 *
 * Соблазн взять цвета темы велик — карточка выглядела бы «своей». Но тема
 * пользователя может быть какой угодно, вплоть до белого текста на белом фоне с
 * подложкой картинкой, и проверить их сочетаемость мы не можем. Карточка уходит
 * наружу, где чинить её будет некому.
 */
const COLORS = {
    bg: '#14161b',
    panel: '#1b1e26',
    text: '#e8e6e3',
    muted: '#9aa0ab',
    line: '#2b303b',
    calm: '#6fb98f',
    mid: '#e0a458',
    loud: '#d4736f',
};

const FONT = '"Segoe UI", "Noto Sans", Roboto, system-ui, -apple-system, sans-serif';
const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;

/** Цвет числа — те же границы, что у бейджей. */
const tone = value => (value >= 40 ? COLORS.loud : value >= 20 ? COLORS.mid : COLORS.calm);

/**
 * Высота строки по метрикам шрифта, а не по кеглю.
 *
 * `actualBoundingBox*` меряет конкретную строку, `fontBoundingBox*` — шрифт
 * целиком; нужен второй, иначе строки карточки запрыгают по высоте в зависимости
 * от того, есть ли в них буквы с выносом. Откат на 1,25 кегля — для движков, где
 * метрик шрифта нет вовсе.
 */
function lineHeight(ctx, size) {
    const m = ctx.measureText('Ёg');
    const h = (m.fontBoundingBoxAscent ?? 0) + (m.fontBoundingBoxDescent ?? 0);
    return h > 0 ? h : size * 1.25;
}

/** Разбить строку по ширине, меряя измерителем. Возвращает не больше `maxLines` строк. */
function wrap(ctx, text, maxWidth, maxLines = 2) {
    const words = String(text ?? '').split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';

    for (const word of words) {
        const next = current ? current + ' ' + word : word;
        if (ctx.measureText(next).width <= maxWidth || !current) {
            current = next;
            continue;
        }
        lines.push(current);
        current = word;
        if (lines.length === maxLines) break;
    }
    if (lines.length < maxLines && current) lines.push(current);

    // Последняя строка обрезается многоточием по измерителю, а не по числу
    // символов: в кириллице символы шире, и счёт по символам режет не там.
    if (lines.length === maxLines && current && lines[maxLines - 1] !== current) {
        let tail = lines[maxLines - 1];
        while (tail && ctx.measureText(tail + '…').width > maxWidth) tail = tail.slice(0, -1);
        lines[maxLines - 1] = tail + '…';
    }
    return lines;
}

/** Обрезать одну строку до ширины. */
function ellipsize(ctx, text, maxWidth) {
    let s = String(text ?? '');
    if (ctx.measureText(s).width <= maxWidth) return s;
    while (s && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    return s + '…';
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    // `roundRect` есть не везде, где расширение должно работать, — своя дуга
    // дешевле, чем проверка возможностей движка в двух местах.
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
}

/**
 * Нарисовать карточку.
 *
 * @param {{title: string, index: number, draft: boolean, mattr: number, words: number,
 *          messages: number, top: Array<{text: string, count: number}>}} model
 * @returns {Promise<Blob>} PNG
 */
export async function drawCard(model) {
    const dpr = globalThis.devicePixelRatio || 1;
    // Масштаб считается, а не берётся: см. ловушку 1 в шапке модуля.
    const scale = Math.max(1, Math.min(dpr, Math.sqrt(MAX_AREA / (W * H)), MAX_SIDE / H, MAX_SIDE / W));

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(W * scale);
    canvas.height = Math.floor(H * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('канва недоступна');
    ctx.scale(scale, scale);
    ctx.textBaseline = 'top';

    const pad = 80;
    const inner = W - pad * 2;

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    let y = pad;

    // Шапка: что это за картинка вообще.
    ctx.font = font(34, 600);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(t('card.title').toUpperCase(), pad, y);
    y += lineHeight(ctx, 34) + 24;

    // Имя чата — крупно, до двух строк.
    ctx.font = font(64, 700);
    ctx.fillStyle = COLORS.text;
    for (const line of wrap(ctx, model.title, inner, 2)) {
        ctx.fillText(line, pad, y);
        y += lineHeight(ctx, 64);
    }
    y += 40;

    // Главное число.
    const value = Math.round(model.index);
    const shown = Number.isFinite(model.index) ? formatNumber(value) : '—';

    ctx.font = font(240, 800);
    const numberMetrics = ctx.measureText(shown);
    const numberWidth = numberMetrics.width;
    ctx.fillStyle = tone(value);
    ctx.fillText(shown, pad, y);

    ctx.font = font(38, 600);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(t('card.index'), pad + numberWidth + 28, y + 90);
    if (model.draft) {
        ctx.font = font(28, 400);
        ctx.fillText(ellipsize(ctx, t('card.draft'), inner - numberWidth - 28), pad + numberWidth + 28, y + 148);
    }
    // Отступ под числом — по НАРИСОВАННЫМ цифрам, а не по высоте строки шрифта.
    // В строке из одних цифр нет ни выносных элементов, ни подстрочных, и полная
    // высота строки оставила бы под числом полторы сотни пикселей пустоты — на
    // карточке это выглядит как забытый блок, а не как воздух.
    y += (numberMetrics.actualBoundingBoxDescent || lineHeight(ctx, 240)) + 48;

    // Три числа помельче — одной полосой.
    const stats = [
        [formatPercent(model.mattr), t('card.diversity')],
        [formatNumber(model.words), t('card.words')],
        [formatNumber(model.messages), t('card.messages')],
    ];
    const cell = inner / stats.length;

    ctx.fillStyle = COLORS.panel;
    roundRect(ctx, pad, y, inner, 170, 24);

    stats.forEach(([big, small], i) => {
        const x = pad + cell * i + 32;
        ctx.font = font(56, 700);
        ctx.fillStyle = COLORS.text;
        ctx.fillText(ellipsize(ctx, big, cell - 64), x, y + 32);
        ctx.font = font(28, 400);
        ctx.fillStyle = COLORS.muted;
        ctx.fillText(ellipsize(ctx, small, cell - 64), x, y + 104);
    });
    y += 170 + 56;

    // Топ оборотов — то единственное, что делает карточку конкретной.
    ctx.font = font(34, 600);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(t('card.top').toUpperCase(), pad, y);
    y += lineHeight(ctx, 34) + 20;

    const footerTop = H - pad - 60;
    for (const item of model.top ?? []) {
        if (y + 84 > footerTop) break;

        ctx.fillStyle = COLORS.line;
        ctx.fillRect(pad, y, inner, 1);

        ctx.font = font(38, 600);
        ctx.fillStyle = COLORS.muted;
        const badge = '×' + formatNumber(item.count);
        const badgeWidth = ctx.measureText(badge).width;
        ctx.fillText(badge, W - pad - badgeWidth, y + 24);

        ctx.font = font(38, 400);
        ctx.fillStyle = COLORS.text;
        ctx.fillText(ellipsize(ctx, item.text, inner - badgeWidth - 40), pad, y + 24);
        y += 84;
    }

    // Подпись. Первая строка анонса — «не тратит ни одного токена» — и на
    // карточке стоит на том же месте: она уезжает к людям, которые про
    // расширение ещё ничего не знают.
    ctx.font = font(26, 400);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(ellipsize(ctx, t('card.footer'), inner), pad, H - pad - 26);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

    // Ловушка 2: без обнуления Safari держит память канвы до следующей сборки
    // мусора, и третья карточка подряд не рисуется.
    canvas.width = 0;
    canvas.height = 0;

    if (!blob) throw new Error('канва не отдала PNG');
    return blob;
}

/**
 * Отдать карточку пользователю.
 *
 * Системный шаринг там, где он есть и умеет файлы, — на телефоне это
 * единственный удобный путь. Проверка `canShare` обязательна: `navigator.share`
 * существует и там, где файлы он не принимает, и без проверки функция падает
 * ровно на телефоне, ради которого затевалась.
 *
 * Отмена шаринга пользователем — не ошибка и запасного пути не запускает:
 * скачивать то, от чего человек только что отказался, — худшее, что можно
 * сделать.
 *
 * @returns {Promise<'shared'|'downloaded'>}
 */
export async function shareCard(blob, filename) {
    const file = new File([blob], filename, { type: 'image/png' });

    if (navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: t('card.share') });
            return 'shared';
        } catch (error) {
            if (error?.name === 'AbortError') return 'shared';
            console.warn('[anti-slop] системный шаринг не сработал, скачиваю файлом:', error);
        }
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    // Отзывать сразу нельзя: часть браузеров к этому моменту ещё не начала
    // читать. Минуты хватает любому, а держать ссылку до конца сеанса — держать
    // и саму картинку.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'downloaded';
}

/** Имя файла: чат и дата, без символов, запрещённых в файловых системах. */
export function cardFilename(title, now = new Date()) {
    const safe = String(title ?? 'chat').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'chat';
    const stamp = now.toISOString().slice(0, 10);
    return `anti-slop ${safe} ${stamp}.png`;
}
