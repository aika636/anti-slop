/**
 * ui/badges — индекс прямо у сообщения.
 *
 * Панель отвечает на вопрос «как в чате в целом». Бейдж отвечает на вопрос «а
 * этот ответ хороший?» — и отвечает там, где человек читает, а не там, где он
 * открывает настройки. Без него список оборотов приходится сверять с текстом
 * глазами, прыгая туда-сюда.
 *
 * Три решения, каждое стоило отдельного размышления.
 *
 * **Куда вешать.** В `.ch_name` рядом с именем и временем, а не в `.mes_buttons`:
 * ряд кнопок в части тем таверны появляется только при наведении, а наведения на
 * телефоне нет. Бейдж, который видно лишь под мышью, не имеет смысла для той
 * половины аудитории, ради которой всё делалось.
 *
 * **Чем ловить появление сообщений.** Наблюдателем за `#chat`, а не подпиской на
 * события отрисовки. Событий, после которых разметка меняется, не меньше пяти
 * (отрисовка ответа, подгрузка старых при прокрутке, свайп, правка, перерисовка
 * чата целиком), список их зависит от версии таверны, и промах любого означает
 * сообщения без бейджа. Наблюдатель ловит всё разом и не знает про версии.
 * Частота — не проблема: работа сведена к одному проходу в кадре.
 *
 * **Что показывать.** Число индекса, а не цвет-светофор. Цвет добавлен вторым
 * слоем, но нести смысл в одном лишь цвете нельзя: часть аудитории его не
 * различает, а на телефоне бейдж рассматривают под углом и на солнце.
 */

import { t, formatNumber, formatPercent } from '../i18n/index.mjs';

/**
 * Границы окраски. Это ПОКАЗ, а не измерение: медиана корпуса разработки — 28
 * при размахе от 9 до 63, отсюда «спокойно» ниже двадцати и
 * «заметно» от сорока. Границы привязаны к версии формулы так же, как и сам
 * индекс: сменятся якоря — сменятся и они.
 */
const CALM = 20;
const LOUD = 40;

const severity = value => (value >= LOUD ? 'loud' : value >= CALM ? 'mid' : 'calm');

/**
 * Показ бейджей у сообщений чата.
 *
 * @param {{onJump?: (index: number) => void}} [handlers]
 */
export function mountBadges() {
    /** @type {Map<number, {value: number, coverage: number}>} по номеру сообщения */
    let data = new Map();
    let enabled = false;
    let observer = null;
    let scheduled = false;

    /** Куда именно внутри блока сообщения ложится бейдж. */
    function slot(mes) {
        return mes.querySelector('.ch_name .flex-container.flex1') ?? mes.querySelector('.ch_name');
    }

    function paint(mes) {
        const index = Number(mes.getAttribute('mesid'));
        const record = data.get(index);
        let badge = mes.querySelector(':scope > .mes_block .antislop-badge');

        // Сообщения без числа быть не должно с бейджем: реплики пользователя,
        // служебные вставки и всё, что пришло после подсчёта, — чистые.
        if (!record) {
            badge?.remove();
            return;
        }

        if (!badge) {
            const host = slot(mes);
            if (!host) return;
            badge = document.createElement('span');
            badge.className = 'antislop-badge';
            host.append(badge);
        }

        const value = Math.round(record.value);
        badge.textContent = formatNumber(value);
        badge.dataset.level = severity(value);
        badge.title = t('badge.title', { value })
            + (Number.isFinite(record.coverage)
                ? ' · ' + t('badge.coverage', { coverage: formatPercent(record.coverage) })
                : '');
    }

    /** Один проход по видимой разметке. Дешевле, чем кажется: сообщений в DOM десятки. */
    function paintAll() {
        scheduled = false;
        for (const mes of document.querySelectorAll('#chat .mes[mesid]')) paint(mes);
    }

    /**
     * Проход откладывается до кадра: во время потокового вывода таверна правит
     * разметку сообщения на каждом тике, и перекрашивать бейдж по десять раз в
     * секунду незачем — его число всё равно не меняется до конца ответа.
     */
    function schedule() {
        if (scheduled || !enabled) return;
        scheduled = true;
        requestAnimationFrame(paintAll);
    }

    function watch() {
        if (observer) return;
        const chat = document.querySelector('#chat');
        if (!chat) return;
        observer = new MutationObserver(schedule);
        observer.observe(chat, { childList: true, subtree: true });
    }

    function clear() {
        for (const badge of document.querySelectorAll('#chat .antislop-badge')) badge.remove();
    }

    return {
        /**
         * Обновить показ.
         *
         * @param {Array<{index: number, value: number, coverage?: number}>|null} messages записи итога
         * @param {boolean} on включены ли бейджи в настройках
         */
        update(messages, on) {
            enabled = !!on;

            if (!enabled) {
                observer?.disconnect();
                observer = null;
                data = new Map();
                clear();
                return;
            }

            data = new Map((messages ?? [])
                .filter(m => Number.isFinite(m?.value))
                .map(m => [m.index, { value: m.value, coverage: m.coverage }]));

            watch();
            schedule();
        },

        /** Снять всё: смена чата, выгрузка расширения. */
        clear() {
            observer?.disconnect();
            observer = null;
            data = new Map();
            clear();
        },
    };
}
