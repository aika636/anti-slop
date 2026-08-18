/**
 * interop/prosepolisher — отдача списка соседям.
 *
 * За роль исполнителя мы не конкурируем. Лечение остаётся за
 * `final-response-processor` и ProsePolisher, наша задача — отдать им выверенный
 * список. Отсюда и формат: не наш, а их.
 *
 * **Что проверено и что нет.** Формат `{{slopList}}` взят из описания
 * ProsePolisher: это JSON-массив, элемент которого несёт либо `phrase`, либо
 * `pattern_template` с `variants`, плюс `score` и `type`. Шаблонных элементов мы
 * не отдаём — наш анализ находит обороты целиком, а не схемы с подстановкой, и
 * выдумывать `variants` из ничего значило бы врать в данных.
 *
 * Чего проверить не удалось: как именно `final-response-processor` читает этот
 * список у себя: в описании его репозитория формат
 * не документирован. Поэтому наружу отдаются оба вида — JSON и голые строки, — и
 * решение, что подсунуть соседу, остаётся за пользователем.
 *
 * Модуль чистый: тестируется на Node.
 */

/**
 * Список в формате `{{slopList}}`.
 *
 * `score` — наш C-value, а не частота: частота без поправки на вложенность
 * поднимает наверх куски длинных оборотов, и сосед получил бы «по спине
 * пробежал» вместо «по спине пробежал холодок». Числа округляются до одного
 * знака — точность здесь мнимая, а длинные хвосты дробей раздувают файл.
 *
 * Ключи ровно те, что описаны у соседа, и ни одного своего: чужой разбор может
 * оказаться строгим, а сведения о наших полях ему всё равно негде взять.
 *
 * @param {{top?: Array<{text?: string, cvalue?: number, count?: number}>}} result
 * @param {{limit?: number}} [opts]
 * @returns {Array<{phrase: string, score: number, type: string}>}
 */
export function toSlopList(result, opts = {}) {
    const { limit = 50 } = opts;
    const out = [];
    const seen = new Set();

    for (const item of result?.top ?? []) {
        const phrase = (item?.text ?? '').trim();
        if (!phrase) continue;
        const key = phrase.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
            phrase,
            score: Math.round((Number(item.cvalue) || 0) * 10) / 10,
            type: 'phrase',
        });
        if (out.length >= limit) break;
    }
    return out;
}

/** То же самое строкой, как оно уедет в буфер обмена. */
export function toSlopListJson(result, opts = {}) {
    return JSON.stringify(toSlopList(result, opts), null, 2);
}
