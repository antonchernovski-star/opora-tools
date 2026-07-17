/**
 * telegram.js — инструмент «Написать в Telegram».
 *
 * Telegram не даёт публичной ссылки «открыть чат по номеру телефона»
 * без API, поэтому пока используем поиск:
 *  - нормализуем телефон (как в WhatsApp: только цифры, 8 → 7);
 *  - открываем https://t.me/+НОМЕР — Telegram сам найдёт пользователя,
 *    если номер виден в его настройках приватности.
 *
 * Позже модуль можно расширить интеграцией с Telegram API
 * без изменения остального кода приложения.
 */

'use strict';

window.Opora = window.Opora || {};

Opora.Telegram = (function () {

    /**
     * Формирует ссылку поиска пользователя Telegram по номеру.
     * @param {string} phone — телефон в любом формате
     * @returns {string|null} ссылка https://t.me/+НОМЕР или null
     */
    function buildLink(phone) {
        // Используем ту же нормализацию, что и WhatsApp (единый формат РФ)
        const digits = Opora.WhatsApp.normalizePhone(phone);
        return digits ? 'https://t.me/+' + digits : null;
    }

    /**
     * Открывает поиск Telegram по номеру телефона в новой вкладке.
     * @param {string} phone — телефон в любом формате
     * @returns {boolean} true, если ссылка открыта
     */
    function open(phone) {
        const link = buildLink(phone);
        if (!link) {
            return false;
        }
        window.open(link, '_blank', 'noopener');
        return true;
    }

    // Публичный интерфейс модуля
    return {
        buildLink: buildLink,
        open: open
    };

})();
