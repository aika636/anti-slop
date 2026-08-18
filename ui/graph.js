/**
 * ui/graph — индекс по ходу чата.
 *
 * Ради чего он нужен: одно число на чат отвечает на вопрос «много ли повторов»,
 * но не отвечает на вопрос «когда началось». А начинается это обычно не сразу —
 * первые двадцать ответов модель ещё придумывает, и только потом садится в
 * колею. Столбик на сообщение показывает и колею, и её начало, и то, что после
 * смены пресета стало лучше.
 *
 * **SVG, а не canvas.** Канва здесь проиграла бы по всем статьям: её пришлось бы
 * перерисовывать при каждой смене темы и плотности пикселей, она не масштабирует
 * подсказки и не умеет фокус с клавиатуры. График — это два десятка
 * прямоугольников, для них SVG и сделан. Канва остаётся карточке (`card/`),
 * где нужен именно растр.
 *
 * **Столбиков не больше, чем влезает.** На чате в полтысячи ответов рисовать
 * пятьсот прямоугольников по половине пикселя бессмысленно: пользователь увидит
 * серую заливку, а нажать на столбик пальцем не сможет вообще. Сообщения
 * сворачиваются в корзины, у корзины берётся максимум — не среднее: нас
 * интересует, где было плохо, а среднее ровно это и замазывает.
 */

import { t, formatNumber } from '../i18n/index.mjs';

const NS = 'http://www.w3.org/2000/svg';

/** Ширина столбика с зазором, в пикселях холста графика. Палец — от 8. */
const MIN_BAR = 8;

/** Высота графика в единицах вьюбокса. Ширина всегда 100 — растягиваем по месту. */
const H = 32;

const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
};

/**
 * Свернуть сообщения в столбики.
 *
 * @param {Array<{index: number, value: number}>} messages
 * @param {number} bars сколько столбиков поместится
 */
function bucketize(messages, bars) {
    const usable = messages.filter(m => Number.isFinite(m?.value));
    if (usable.length <= bars) {
        return usable.map(m => ({ value: m.value, index: m.index, from: m.index, to: m.index, count: 1 }));
    }

    const out = [];
    const per = usable.length / bars;
    for (let b = 0; b < bars; b++) {
        const start = Math.floor(b * per);
        const end = Math.min(usable.length, Math.floor((b + 1) * per));
        if (end <= start) continue;

        // Максимум, а не среднее: корзина отвечает на вопрос «было ли здесь
        // плохо», и один провал среди десяти ровных ответов — это тоже ответ.
        let worst = usable[start];
        for (let i = start + 1; i < end; i++) if (usable[i].value > worst.value) worst = usable[i];

        out.push({
            value: worst.value,
            index: worst.index,
            from: usable[start].index,
            to: usable[end - 1].index,
            count: end - start,
        });
    }
    return out;
}

/**
 * Нарисовать график.
 *
 * @param {Array<{index: number, value: number}>} messages записи сообщений из итога
 * @param {{onJump: (index: number) => void, width?: number}} handlers
 * @returns {HTMLElement|null} блок графика или null, если рисовать нечего
 */
export function renderGraph(messages, { onJump, width = 320 }) {
    const usable = (messages ?? []).filter(m => Number.isFinite(m?.value));
    const box = document.createElement('div');
    box.className = 'antislop-section antislop-graph';

    const head = document.createElement('div');
    head.className = 'antislop-section-head';
    head.textContent = t('graph.title');
    box.append(head);

    // Меньше трёх точек — не линия, а случайность: на двух ответах график
    // покажет «в два раза хуже», хотя разница в пределах шума.
    if (usable.length < 3) {
        const empty = document.createElement('div');
        empty.className = 'antislop-empty';
        empty.textContent = t('graph.short');
        box.append(empty);
        return box;
    }

    const bars = bucketize(usable, Math.max(4, Math.floor(width / MIN_BAR)));

    // Верх шкалы — от данных, но не ниже разумного: на чистом чате, где все
    // значения около пяти, шкала «от нуля до максимума» раздует рябь до
    // катастрофы. Пол в 20 не даёт мелочи выглядеть бедой.
    const peak = Math.max(20, ...bars.map(b => b.value));

    const svg = svgEl('svg', {
        viewBox: `0 0 100 ${H}`,
        preserveAspectRatio: 'none',
        class: 'antislop-graph-svg',
        role: 'img',
        'aria-label': t('graph.title'),
    });

    const step = 100 / bars.length;
    const gap = Math.min(step * 0.25, 0.6);

    bars.forEach((b, i) => {
        const h = Math.max(0.6, (b.value / peak) * (H - 2));
        const rect = svgEl('rect', {
            x: (i * step + gap / 2).toFixed(3),
            y: (H - h).toFixed(3),
            width: Math.max(0.2, step - gap).toFixed(3),
            height: h.toFixed(3),
            rx: 0.4,
            class: 'antislop-bar',
            tabindex: 0,
            role: 'button',
        });

        const hint = t('graph.point', { index: b.index, value: formatNumber(b.value) })
            + (b.count > 1 ? ` (${t('graph.axis', { first: b.from, last: b.to })})` : '');
        const title = svgEl('title');
        title.textContent = hint;
        rect.append(title);
        rect.setAttribute('aria-label', hint);

        const go = () => onJump(b.index);
        rect.addEventListener('click', go);
        rect.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });
        svg.append(rect);
    });

    box.append(svg);

    const foot = document.createElement('div');
    foot.className = 'antislop-graph-foot';
    // Подписи осей нет намеренно: на ширине панели телефона она читалась бы
    // хуже, чем не читалась бы вовсе. Вместо неё — границы диапазона словами.
    foot.append(
        Object.assign(document.createElement('span'), {
            textContent: t('graph.axis', { first: usable[0].index, last: usable[usable.length - 1].index }),
        }),
        Object.assign(document.createElement('span'), { textContent: t('graph.hint') }),
    );
    box.append(foot);

    return box;
}
