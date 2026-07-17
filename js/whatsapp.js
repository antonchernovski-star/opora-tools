/**
 * whatsapp.js — инструмент «Написать в WhatsApp».
 *
 * Логика:
 *  1. очищаем телефон от всего, кроме цифр;
 *  2. если номер начинается с 8 — заменяем первую цифру на 7 (формат РФ);
 *  3. открываем чат по ссылке https://wa.me/НОМЕР в новой вкладке.
 *
 * Модуль самодостаточен: не зависит от Bitrix24, работает с любым телефоном.
 * По такому же шаблону добавляются новые инструменты (GetContact, ФССП и т.д.).
 */

'use strict';

window.Opora = window.Opora || {};

Opora.WhatsApp = (function () {

    /**
     * Нормализует телефон для WhatsApp.
     *
     * Примеры:
     *  '+7 (913) 000-00-00' → '79130000000'
     *  '8-913-000-00-00'    → '79130000000'
     *
     * @param {string} phone — телефон в любом формате
     * @returns {string|null} только цифры (8 → 7 в начале) или null, если цифр нет
     */
    function normalizePhone(phone) {
        if (!phone) {
            return null;
        }

        // Оставляем только цифры
        let digits = String(phone).replace(/\D/g, '');

        if (!digits) {
            return null;
        }

        // Российский формат: 8XXXXXXXXXX → 7XXXXXXXXXX
        if (digits.startsWith('8') && digits.length === 11) {
            digits = '7' + digits.slice(1);
        }

        return digits;
    }

    /**
     * Формирует ссылку на чат WhatsApp.
     * @param {string} phone — телефон в любом формате
     * @returns {string|null} ссылка https://wa.me/НОМЕР или null
     */
    function buildLink(phone) {
        const digits = normalizePhone(phone);
        return digits ? 'https://wa.me/' + digits : null;
    }

    /**
     * Открывает чат WhatsApp с указанным номером в новой вкладке.
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
        normalizePhone: normalizePhone,
        buildLink: buildLink,
        open: open
    };

})();
