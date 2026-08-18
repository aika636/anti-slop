/**
 * ui/settings — настройки и выдача наружу.
 *
 * Отдельным файлом от панели по одной причине: здесь два десятка элементов
 * управления, и вместе со списками они превратили бы `panel.js` в свалку, где
 * разметка списка теряется среди чекбоксов.
 *
 * Классы — таверны (`checkbox_label`, `text_pole`, `menu_button`): своя вёрстка
 * элементов управления означала бы, что при смене темы наши поля выглядят
 * чужими среди соседских.
 *
 * Один принцип, который стоит проговорить. **Вставка в промпт выключена по
 * умолчанию и подписана ценой.** Первая строка анонса — «не делает ни одного
 * запроса к API и ничего не добавляет в промпт», и включённая по умолчанию
 * вставка сделала бы её ложью. Человек, включающий её, должен видеть рядом, что
 * именно эта галочка и есть исключение.
 */

import { t, LOCALES } from '../i18n/index.mjs';
import { AUTO_EVERY_DEFAULT, AUTO_EVERY_MIN, AUTO_EVERY_MAX } from '../auto.mjs';

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
};

/** Чекбокс в разметке таверны. */
function checkbox(label, checked, onChange) {
    const wrap = el('label', 'checkbox_label antislop-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, el('span', null, label));
    return wrap;
}

/** Поле с подписью сверху: на узкой панели подпись сбоку не помещается. */
function field(label, control, hint) {
    const box = el('div', 'antislop-field');
    box.append(el('div', 'antislop-field-label', label), control);
    if (hint) box.append(el('div', 'antislop-hint', hint));
    return box;
}

function select(options, value, onChange) {
    const node = el('select', 'text_pole');
    for (const [key, label] of options) {
        const option = el('option', null, label);
        option.value = key;
        node.append(option);
    }
    node.value = value;
    node.addEventListener('change', () => onChange(node.value));
    return node;
}

function number(value, min, max, onChange) {
    const node = el('input', 'text_pole');
    node.type = 'number';
    node.min = String(min);
    node.max = String(max);
    node.value = String(value);
    // `change`, а не `input`: на каждое нажатие клавиши перерисовывать панель и
    // переписывать файл настроек таверны — значит писать его десять раз за слово.
    node.addEventListener('change', () => {
        const next = Math.min(max, Math.max(min, Math.round(Number(node.value) || min)));
        node.value = String(next);
        onChange(next);
    });
    return node;
}

/**
 * Блок настроек и выдачи.
 *
 * @param {object} state состояние панели целиком
 * @param {{onSetting: (key: string, value: any) => void,
 *          onTemplate: (format: string, text: string|null) => void,
 *          onCopy: (kind: 'prompt'|'list'|'json') => void,
 *          onCard: () => void}} handlers
 */
export function renderSettings(state, { onSetting, onTemplate, onCopy, onCard }) {
    const s = state.settings ?? {};
    const box = el('div', 'antislop-section antislop-settings');

    const drawer = el('div', 'inline-drawer antislop-subdrawer');
    const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
    toggle.append(el('b', null, t('settings.title')), el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    const content = el('div', 'inline-drawer-content');
    drawer.append(toggle, content);
    box.append(drawer);

    content.append(
        field(t('settings.lang'), select(
            [['auto', t('settings.lang.auto')], ...LOCALES.map(code => [code, code.toUpperCase()])],
            s.lang ?? 'auto',
            value => onSetting('lang', value),
        )),
        checkbox(t('settings.badges'), s.badges, value => onSetting('badges', value)),
        checkbox(t('settings.graph'), s.graph, value => onSetting('graph', value)),
    );

    // --- считать сам ------------------------------------------------------
    //
    // Подсказка под галочкой обязательна, и вот почему. Ожидание от такой
    // настройки — «теперь он читает чат каждые N сообщений», а на деле новые
    // ответы досчитывались и раньше, без неё. Не сказав этого, мы получим
    // человека, уверенного, что до галочки расширение простаивало, и ставящего
    // единицу «чтобы точно считало»: полный проход на каждый ответ вместо
    // бесплатного досчёта.

    content.append(checkbox(t('settings.auto'), s.autoEnabled, value => onSetting('autoEnabled', value)));
    content.append(el('div', 'antislop-hint', t('settings.auto.hint')));

    if (s.autoEnabled) {
        const inner = el('div', 'antislop-nested');
        inner.append(field(
            t('settings.auto.every'),
            number(s.autoEvery ?? AUTO_EVERY_DEFAULT, AUTO_EVERY_MIN, AUTO_EVERY_MAX,
                v => onSetting('autoEvery', v)),
            t('settings.auto.every.hint'),
        ));
        content.append(inner);
    }

    // --- промпт ---------------------------------------------------------

    content.append(checkbox(t('settings.prompt'), s.promptEnabled, value => onSetting('promptEnabled', value)));
    content.append(el('div', 'antislop-hint antislop-cost', t('settings.prompt.cost')));

    if (s.promptEnabled) {
        const format = s.promptFormat ?? 'rule';
        const inner = el('div', 'antislop-nested');

        inner.append(
            field(t('settings.prompt.format'), select(
                [['rule', t('settings.prompt.format.rule')], ['list', t('settings.prompt.format.list')]],
                format,
                value => onSetting('promptFormat', value),
            ), t('settings.prompt.format.hint')),
            field(t('settings.prompt.count'), number(s.promptCount ?? 8, 1, 50, v => onSetting('promptCount', v))),
            field(t('settings.prompt.depth'), number(s.promptDepth ?? 4, 0, 100, v => onSetting('promptDepth', v))),
        );

        const area = el('textarea', 'text_pole antislop-template');
        area.rows = 8;
        area.spellcheck = false;
        area.value = state.promptTemplate ?? '';
        area.addEventListener('change', () => onTemplate(format, area.value));
        inner.append(field(t('settings.prompt.template'), area, t('settings.prompt.template.hint')));

        const reset = el('div', 'menu_button antislop-wide', t('settings.prompt.reset'));
        // Сброс — это «шаблона нет», а не «шаблон равен нынешнему умолчанию»:
        // иначе при смене языка интерфейса у человека останется правило на
        // прежнем, и он не поймёт, откуда оно взялось.
        reset.addEventListener('click', () => onTemplate(format, null));
        inner.append(reset);

        // Попадание правила. Единственное число, отвечающее на вопрос «стоит ли
        // вставка своих токенов»: список известен, и известно, что модель писала
        // после него. Формулировка описательная — «встречались», а не «правило
        // подействовало»: причину данные не выдерживают (см. `trend.mjs`).
        if (state.promptHits) {
            const { hits, total, span } = state.promptHits;
            inner.append(field(
                t('settings.prompt.hits'),
                el('div', 'antislop-hits', t('settings.prompt.hits.value', { hits, total, span })),
                t('settings.prompt.hits.hint'),
            ));
        }

        const preview = el('div', 'antislop-preview');
        preview.append(el('div', 'antislop-field-label', t('settings.prompt.preview')));
        preview.append(el('pre', 'antislop-preview-text', state.promptText || t('settings.prompt.nothing')));
        inner.append(preview);

        content.append(inner);
    }

    // --- выдача наружу --------------------------------------------------

    const exportBox = el('div', 'antislop-export');
    exportBox.append(el('div', 'antislop-field-label', t('export.title')));

    const buttons = el('div', 'antislop-buttons');
    const has = !!state.result;

    const action = (label, icon, fn) => {
        const button = el('div', 'menu_button menu_button_icon');
        button.append(el('i', `fa-solid ${icon}`), el('span', null, label));
        button.classList.toggle('disabled', !has);
        button.addEventListener('click', () => { if (has) fn(); });
        return button;
    };

    buttons.append(
        action(t('export.copyPrompt'), 'fa-quote-right', () => onCopy('prompt')),
        action(t('export.copyList'), 'fa-list', () => onCopy('list')),
        action(t('export.copyJson'), 'fa-code', () => onCopy('json')),
        action(t('export.card'), 'fa-image', () => onCard()),
    );
    exportBox.append(buttons);
    if (!has) exportBox.append(el('div', 'antislop-hint', t('export.nothing')));
    content.append(exportBox);

    return box;
}

/**
 * Список скрытых оборотов.
 *
 * Показывается только когда в нём что-то есть: пустой раздел «Скрытые обороты»
 * на чистой установке — это строка интерфейса, объясняющая функцию, которой
 * человек ещё не пользовался.
 */
export function renderHidden(ignored, { onUnhide, onUnhideAll }) {
    const known = ignored ?? [];
    if (!known.length) return null;

    const box = el('div', 'antislop-section');
    const head = el('div', 'antislop-section-head');
    head.append(el('span', null, t('hidden.title')), el('span', 'antislop-note', t('hidden.count', { n: known.length })));
    box.append(head);

    const list = el('div', 'antislop-list');
    for (const entry of known) {
        const row = el('div', 'antislop-row');
        row.append(el('div', 'antislop-main', entry.text));

        const back = el('div', 'antislop-jump menu_button');
        back.title = t('hidden.restore');
        back.setAttribute('role', 'button');
        back.tabIndex = 0;
        back.append(el('i', 'fa-solid fa-rotate-left'));
        const go = () => onUnhide(entry.key);
        back.addEventListener('click', go);
        back.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });

        row.append(back);
        list.append(row);
    }
    box.append(list);

    const all = el('div', 'menu_button antislop-wide', t('hidden.clear'));
    all.addEventListener('click', () => onUnhideAll());
    box.append(all);

    return box;
}
