/**
 * ui/panel — панель расширения.
 *
 * Про SillyTavern знает ровно одно: куда себя вставить и какими классами
 * пользоваться. Ни чата, ни событий, ни ядра отсюда не видно — панель получает
 * готовое состояние и набор обработчиков.
 *
 * Разметка строится в коде, а не шаблоном: шаблон пришлось бы тянуть отдельным
 * запросом ради двух десятков узлов.
 *
 * Строки — через `i18n`, ни одной прямо в коде. Проверять это глазами не нужно:
 * незнакомый ключ возвращается сам собой и виден в интерфейсе как `top.title`,
 * то есть забытый перевод заметен с первого открытия панели.
 */

import { t, plural, formatNumber, formatPercent, formatTimes } from '../i18n/index.mjs';
import { renderGraph } from './graph.js';
import { renderSettings, renderHidden } from './settings.js';
import { phraseTrend } from '../trend.mjs';
import { chatIndex } from '../core/index.mjs';

/**
 * Окно второй плитки индекса — сколько последних ответов в него входит.
 *
 * Общий индекс — среднее по всему чату, и на чате в две сотни ответов новый
 * ответ двигает его на доли балла: смену пресета, модели или включение правила
 * такая цифра показать физически не может. Плитка рядом отвечает на вопрос, ради
 * которого панель и открывают, — «а сейчас-то лучше стало?».
 *
 * Двадцать — не подобранное число, а компромисс: меньше даёт цифру, скачущую от
 * одной длинной сцены, больше — то же усреднение, от которого и уходим.
 */
export const RECENT_WINDOW = 20;

/**
 * Индекс за последние `RECENT_WINDOW` ответов и его отличие от предыдущих
 * стольких же.
 *
 * Считается из `result.messages`, где индекс каждого сообщения уже лежит
 * готовым, — ядро для этого не пересчитывается и новых чисел в данных не
 * появляется. Среднее берётся тем же `chatIndex`, что и общее: взвешивание по
 * словам и выбрасывание сообщений без прозы там уже решены, и повторять эту
 * развилку второй раз здесь — значит завести второй способ считать то же самое.
 *
 * Окно набирается по сообщениям С ПРОЗОЙ, а не по последним двадцати записям
 * подряд: у пользователя с инфоблоком каждый ход половина записей пустая, и
 * окно из двадцати записей оказалось бы окном из десяти ответов — причём в двух
 * сравниваемых окнах разной глубины.
 *
 * Наружу вынесена ради теста: сам модуль рисует и без браузера не проверяется, а
 * отбор окна — обычный счёт, и ошибиться в нём легко (окно на единицу короче,
 * предыдущее окно внахлёст с текущим).
 *
 * @returns {{value: number, delta: number|null}|null} `null`, пока ответов с
 *   прозой меньше окна: показывать «индекс за двадцать» по семи ответам нельзя.
 *   `delta === null` — предыдущее окно ещё не набралось, сравнивать не с чем.
 */
export function recentIndex(messages = []) {
    const prose = messages.filter(m => (m.words ?? 0) > 0);
    if (prose.length < RECENT_WINDOW) return null;

    const value = chatIndex(prose.slice(-RECENT_WINDOW)).value;
    const before = prose.slice(-2 * RECENT_WINDOW, -RECENT_WINDOW);
    return {
        value,
        delta: before.length === RECENT_WINDOW ? value - chatIndex(before).value : null,
    };
}

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
};

/**
 * Строка списка, по которой можно перейти к сообщению.
 *
 * Нажимается вся строка, а не только стрелка справа. На телефоне стрелка — цель
 * в три с половиной десятка пикселей, и промахнуться по ней проще, чем попасть;
 * строка же занимает всю ширину панели. Стрелка остаётся, но уже как подсказка
 * «сюда можно нажать», а не как единственное место нажатия, и своего обработчика
 * у неё нет — иначе клик по ней сработал бы дважды, всплыв в строку.
 */
function jumpRow(hint, onClick) {
    const row = el('div', 'antislop-row antislop-clickable');
    row.title = hint;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.addEventListener('click', onClick);
    row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
    });
    return row;
}

const iconButton = (icon, hint, onClick) => {
    const button = el('div', 'antislop-icon menu_button');
    button.title = hint;
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', hint);
    button.tabIndex = 0;
    button.append(el('i', `fa-solid ${icon}`));
    const go = e => {
        // Кнопка живёт внутри нажимаемой строки: без остановки всплытия нажатие
        // на неё сработало бы ещё и как переход к сообщению.
        e.stopPropagation();
        onClick();
    };
    button.addEventListener('click', go);
    button.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); }
    });
    return button;
};

/**
 * Знак темпа рядом с оборотом.
 *
 * Стрелка И слово, а не одна стрелка и уж тем более не один цвет. Причина та
 * же, что у бейджей (`ui/badges.js`): цвет различают не все, подсказки по
 * наведению на телефоне не открываются, и знак, чей смысл живёт в оттенке,
 * для половины аудитории просто отсутствует. Цвет добавлен третьим слоем.
 *
 * Возвращает `null`, когда сказать нечего, — и это самый частый случай.
 */
function trendChip(trend) {
    if (!trend) return null;

    const { kind } = trend;
    const chip = el('span', 'antislop-trend');
    chip.dataset.kind = kind;
    chip.append(
        el('i', `fa-solid ${kind === 'faster' ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'}`),
        el('span', null, t(`trend.chip.${kind}`)),
    );

    chip.title = kind === 'cooled'
        ? t('trend.hint.cooled', { step: formatTimes(trend.step), n: formatNumber(trend.silence) })
        : t('trend.hint.pace', {
            before: formatNumber(trend.before),
            after: formatNumber(trend.after),
            spanBefore: formatNumber(trend.spanBefore),
            spanAfter: formatNumber(trend.spanAfter),
        });

    return chip;
}

/** Та же мысль словами — в строку чисел под оборотом, где её видно без наведения. */
function trendWords(trend) {
    if (!trend) return null;
    if (trend.kind === 'cooled') {
        return t('trend.cooled', {
            n: formatNumber(trend.silence),
            word: plural(Math.round(trend.silence), 'word.answer'),
        });
    }
    // `reason` решает, можно ли ссылаться на правило: якорь с `prompt` поставлен
    // в момент включения галочки, и «до/после» разделены именно им. У
    // автоматического якоря такого права нет — он просто точка в прошлом.
    const suffix = trend.reason === 'prompt' ? 'prompt' : 'auto';
    if (trend.stopped) return t(`trend.stopped.${suffix}`);
    const times = trend.kind === 'slower' ? 1 / trend.ratio : trend.ratio;
    return t(`trend.${trend.kind}.${suffix}`, { times: formatTimes(times) });
}

/**
 * Отличие окна от предыдущего такого же — словами.
 *
 * Формулировки строго описательные, по тому же правилу, что и знак темпа
 * (раздел «Что важно помнить» в `README.md`): «больше, чем за предыдущие
 * двадцать» — наблюдение, «правило подействовало» — вывод, которого данные не
 * выдерживают. Окно сдвигается и оттого, что сменилась сцена, а ссылаться на
 * правило вправе только якорь с `reason: 'prompt'`, и в этой плитке его нет.
 */
function recentNote(delta) {
    if (delta == null) return null;
    const n = formatNumber(RECENT_WINDOW);
    if (delta === 0) return t('tile.recent.same', { n });
    return t(delta > 0 ? 'tile.recent.up' : 'tile.recent.down', { d: formatNumber(Math.abs(delta)), n });
}

const jumpIcon = () => {
    const jump = el('div', 'antislop-jump menu_button');
    jump.append(el('i', 'fa-solid fa-arrow-right-to-bracket'));
    return jump;
};

/**
 * Вставить панель в настройки расширений.
 *
 * @param {{onAnalyze: () => void, onJump: (index: number) => void,
 *          onHide: (item: object) => void, onUnhide: (key: string) => void,
 *          onUnhideAll: () => void, onSetting: (key: string, value: any) => void,
 *          onTemplate: (format: string, text: string|null) => void,
 *          onCopy: (kind: string) => void, onCard: () => void}} handlers
 */
export function mountPanel(handlers) {
    const { onAnalyze, onJump, onHide } = handlers;
    const root = el('div', 'antislop-panel');

    const drawer = el('div', 'inline-drawer');
    const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
    const title = el('b', null, t('panel.title'));
    // Имя расширения в шапке, пояснение — рядом и приглушённое. Человек, которому
    // расширение посоветовали по имени, ищет глазами именно имя; человек, который
    // забрёл сюда сам, по одному имени не поймёт, что это.
    const subtitle = el('span', 'antislop-subtitle', t('panel.subtitle'));
    toggle.append(title, subtitle, el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    const content = el('div', 'inline-drawer-content');
    drawer.append(toggle, content);
    root.append(drawer);

    // Кнопка и строка состояния.
    const button = el('div', 'menu_button menu_button_icon antislop-run');
    const buttonLabel = el('span', null, t('panel.analyze'));
    button.append(el('i', 'fa-solid fa-magnifying-glass-chart'), buttonLabel);
    const status = el('div', 'antislop-status');
    // Полоса прогресса полного подсчёта. Пустой контейнер без детей не занимает
    // места и без CSS — заполняется только пока идёт счёт и известно, сколько
    // всего сообщений; на досчёте одного ответа прогресса нет и не нужен, это
    // доли секунды. Ширина заполнения — инлайновый style.width в процентах,
    // отдельный CSS-файл сюда не трогаем.
    const progress = el('div', 'antislop-progress');
    // Не молчим о деградации: воркер недоступен, считаем на главном потоке.
    const fallbackNote = el('div', 'antislop-fallback');
    // Короткое сообщение о том, что действие удалось: «скопировано», «карточка
    // сохранена». Живёт своей жизнью и гаснет само — см. `flash`.
    const toast = el('div', 'antislop-toast');
    content.append(button, status, progress, fallbackNote, toast);

    // Сводка: числа, ради которых расширение и открывают.
    const summary = el('div', 'antislop-summary');
    content.append(summary);

    const sections = el('div', 'antislop-sections');
    content.append(sections);

    // Второй тык во время счёта запустил бы ещё один полный проход поверх
    // первого. От пальца и мыши это уже закрыто классом `disabled` — таверна
    // вешает на него `pointer-events: none`, — но защита, живущая только в CSS,
    // умирает от первой же темы, которая этот класс переопределит. Кнопка знает
    // своё состояние сама.
    button.addEventListener('click', () => {
        if (button.classList.contains('disabled')) return;
        onAnalyze();
    });

    document.querySelector('#extensions_settings2')?.append(root);

    /**
     * Плитка сводки.
     *
     * `note` — третья строка мелким под подписью. Нужна там, где само число без
     * второго числа рядом ничего не говорит: «индекс за двадцать ответов — 34»
     * читается только вместе с «на 7 больше, чем за предыдущие двадцать».
     */
    function tile(value, label, hint, note) {
        const box = el('div', 'antislop-tile');
        box.append(el('div', 'antislop-tile-value', value), el('div', 'antislop-tile-label', label));
        if (note) box.append(el('div', 'antislop-tile-note', note));
        if (hint) box.title = hint;
        return box;
    }

    function renderTop(result, allHidden, trendCtx) {
        const box = el('div', 'antislop-section');
        const head = el('div', 'antislop-section-head');
        head.append(el('span', null, t('top.title')));
        if (result.preliminary) head.append(el('span', 'antislop-note', t('top.preliminary')));
        box.append(head);

        if (!result.top.length) {
            box.append(el('div', 'antislop-empty', t(allHidden ? 'top.allHidden' : 'top.empty')));
            return box;
        }

        const list = el('div', 'antislop-list');
        for (const item of result.top) {
            const row = jumpRow(t('top.jump', { n: item.lastMessage }), () => onJump(item.lastMessage));

            const trend = phraseTrend(item, trendCtx);
            const words = trendWords(trend);

            const main = el('div', 'antislop-main');
            main.append(
                el('div', 'antislop-phrase', item.text || (item.stems ?? []).join(' ')),
                // Те же числа, что раньше были только в подсказке. На телефоне
                // подсказки нет — наведения мышью там не бывает, — и всё, что
                // живёт в `title`, для половины аудитории просто не существует.
                el('div', 'antislop-meta', t('top.meta', {
                    first: item.firstMessage,
                    last: item.lastMessage,
                    weight: item.cvalue.toFixed(1),
                }) + (words ? ' · ' + words : '')),
            );

            const count = el('div', 'antislop-count', '×' + formatNumber(item.count));
            // Накопительное число рядом со стрелкой «реже» выглядит противоречиво,
            // пока не сказано, что это разные вещи: сколько всего за чат и как
            // часто сейчас.
            count.title = t('top.count.hint');

            const chip = trendChip(trend);
            row.append(main);
            if (chip) row.append(chip);
            row.append(
                count,
                iconButton('fa-eye-slash', t('top.hide'), () => onHide(item)),
                jumpIcon(),
            );
            list.append(row);
        }
        box.append(list);
        return box;
    }

    function renderFindings(result) {
        const box = el('div', 'antislop-section');
        box.append(el('div', 'antislop-section-head', t('findings.title')));

        // Заметные — вперёд: иначе на чистом чате первой строкой окажется
        // случайное совпадение шести слов, и расширение соврёт с порога.
        const findings = [...result.findings].sort((a, b) =>
            (b.notable === true) - (a.notable === true) || b.containment - a.containment);

        if (!findings.length) {
            box.append(el('div', 'antislop-empty', t('findings.empty')));
            return box;
        }

        const list = el('div', 'antislop-list');
        for (const f of findings.slice(0, 20)) {
            const row = jumpRow(t('top.jump', { n: f.index }), () => onJump(f.index));
            if (f.notable) row.classList.add('antislop-notable');

            const main = el('div', 'antislop-main');
            main.append(
                el('div', 'antislop-phrase', t('findings.row', { index: f.index, partner: f.partner })),
                el('div', 'antislop-meta', f.runLength
                    ? t('findings.run', { n: f.runLength, word: plural(f.runLength, 'word.word') })
                    : t('findings.noRun')),
            );

            row.append(main, el('div', 'antislop-count', formatPercent(f.containment)), jumpIcon());
            list.append(row);
        }
        box.append(list);
        return box;
    }

    /** Строка состояния: одна, и порядок её случаев — от срочного к спокойному. */
    function renderStatus(state) {
        status.textContent = '';
        status.className = 'antislop-status';

        if (!state.chatOpen) {
            status.textContent = t('status.noChat');
        } else if (state.busy) {
            status.textContent = state.stage === 'counting'
                ? t('status.countingN', {
                    n: formatNumber(state.stageCount),
                    word: plural(state.stageCount, 'word.answer'),
                })
                : t(state.stage === 'reading' ? 'status.reading' : 'status.counting');
        } else if (state.error) {
            status.textContent = t(state.error);
            status.classList.add('antislop-error');
        } else if (state.dirty) {
            status.textContent = t('status.dirty');
            status.classList.add('antislop-warn');
        } else if (state.notice) {
            status.textContent = t('status.leaked', { name: state.notice });
            status.classList.add('antislop-warn');
        } else if (state.fromCache) {
            status.textContent = t('status.cache');
        }
    }

    let toastTimer = null;

    /**
     * Показать короткое сообщение об удавшемся действии.
     *
     * Не `toastr` таверны: он рисует всплывашку поверх всего экрана, а речь про
     * «скопировано» рядом с кнопкой, которую только что нажали. Уводить взгляд в
     * угол экрана ради этого незачем.
     */
    function flash(key) {
        toast.textContent = t(key);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.textContent = ''; }, 3000);
    }

    /**
     * Перерисовать панель целиком.
     *
     * @param {object} state состояние из `index.js`, дополненное настройками
     */
    function render(state) {
        title.textContent = t('panel.title');
        subtitle.textContent = t('panel.subtitle');
        buttonLabel.textContent = t('panel.analyze');
        button.classList.toggle('disabled', !!state.busy || !state.chatOpen);

        renderStatus(state);

        progress.textContent = '';
        if (state.busy && state.progress) {
            const { done, total } = state.progress;
            const percent = total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
            const track = el('div', 'antislop-progress-track');
            const fill = el('div', 'antislop-progress-fill');
            fill.style.width = percent.toFixed(0) + '%';
            track.append(fill);
            progress.append(track, el('div', 'antislop-progress-label',
                t('status.progress', { done: formatNumber(done), total: formatNumber(total) })));
        }

        fallbackNote.textContent = state.fallbackNotice ? t('status.fallback') : '';

        summary.textContent = '';
        sections.textContent = '';

        const result = state.result;
        if (result) {
            const draft = result.index?.draft;
            summary.append(
                tile(formatNumber(result.index?.value), t(draft ? 'tile.indexDraft' : 'tile.index'),
                    t(draft ? 'tile.indexDraft.hint' : 'tile.index.hint')),
            );

            // Плитка окна появляется, только когда окно набралось: на коротком
            // чате она повторяла бы общий индекс теми же цифрами.
            const recent = recentIndex(result.messages);
            if (recent) {
                summary.append(tile(
                    formatNumber(recent.value),
                    t('tile.recent', {
                        n: formatNumber(RECENT_WINDOW),
                        word: plural(RECENT_WINDOW, 'word.answer'),
                    }),
                    t('tile.recent.hint', { n: formatNumber(RECENT_WINDOW) }),
                    recentNote(recent.delta),
                ));
            }

            summary.append(
                tile(formatPercent(result.diversity?.mattr), t('tile.diversity'), t('tile.diversity.hint')),
                tile(formatNumber(result.stats?.words), t('tile.words'), t('tile.words.hint')),
                tile(formatNumber(result.messages?.length), t('tile.messages'), null),
            );

            if (state.settings?.graph) {
                const graph = renderGraph(result.messages, {
                    onJump,
                    width: root.clientWidth || 320,
                });
                if (graph) sections.append(graph);
            }

            sections.append(
                renderTop(result, state.hiddenHere > 0, state.trend),
                renderFindings(result),
            );
        } else if (!state.busy && state.chatOpen) {
            sections.append(el('div', 'antislop-empty', t('first.hint')));
        }

        const hidden = renderHidden(state.settings?.ignored, handlers);
        if (hidden) sections.append(hidden);

        sections.append(renderSettings(state, handlers));
    }

    return { render, root, flash };
}
