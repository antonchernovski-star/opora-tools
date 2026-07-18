/**
 * crm.js — работа с CRM Bitrix24.
 *
 * Отвечает за:
 *  - получение сделки по ID (crm.deal.get);
 *  - получение контакта сделки (crm.contact.get);
 *  - нормализацию данных контакта в единый формат.
 *
 * Единый формат контакта, который использует весь интерфейс:
 * {
 *   id:        '15',
 *   firstName: 'Иван',
 *   lastName:  'Петров',
 *   fullName:  'Иван Петров',
 *   phone:     '+7 913 000-00-00' | null,
 *   email:     'ivan@example.com' | null
 * }
 */

'use strict';

window.Opora = window.Opora || {};

Opora.Crm = (function () {

    /**
     * Получает сделку по ID.
     * @param {string|number} dealId — ID сделки
     * @returns {Promise<Object>} данные сделки
     */
    function getDeal(dealId) {
        return Opora.Bitrix.callMethod('crm.deal.get', { id: dealId });
    }

    /**
     * Получает контакт по ID.
     * @param {string|number} contactId — ID контакта
     * @returns {Promise<Object>} данные контакта
     */
    function getContact(contactId) {
        return Opora.Bitrix.callMethod('crm.contact.get', { id: contactId });
    }

    /**
     * Достаёт первое значение из мультиполя Bitrix24 (PHONE / EMAIL).
     * Мультиполя приходят массивом объектов: [{ VALUE: '...', VALUE_TYPE: 'WORK' }, ...]
     *
     * @param {Array|undefined} field — мультиполе контакта
     * @returns {string|null} первое значение или null
     */
    function firstMultiFieldValue(field) {
        if (Array.isArray(field) && field.length > 0 && field[0] && field[0].VALUE) {
            return String(field[0].VALUE).trim();
        }
        return null;
    }

    /**
     * Преобразует «сырой» контакт Bitrix24 в единый формат приложения.
     * @param {Object} raw — ответ crm.contact.get
     * @returns {Object} нормализованный контакт
     */
    function normalizeContact(raw) {
        const firstName = (raw.NAME || '').trim();
        const lastName = (raw.LAST_NAME || '').trim();
        const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Без имени';

        return {
            id: String(raw.ID || ''),
            firstName: firstName,
            lastName: lastName,
            fullName: fullName,
            phone: firstMultiFieldValue(raw.PHONE),
            email: firstMultiFieldValue(raw.EMAIL)
        };
    }

    /**
     * Получает лид по ID.
     * @param {string|number} leadId — ID лида
     * @returns {Promise<Object>} данные лида
     */
    function getLead(leadId) {
        return Opora.Bitrix.callMethod('crm.lead.get', { id: leadId });
    }

    /**
     * Преобразует «сырой» лид Bitrix24 в единый формат приложения.
     * У лида имя/телефон/email хранятся прямо в нём (контакт не обязателен).
     * @param {Object} raw — ответ crm.lead.get
     * @returns {Object} нормализованный контакт
     */
    function normalizeLead(raw) {
        const firstName = (raw.NAME || '').trim();
        const lastName = (raw.LAST_NAME || '').trim();
        const fullName = [firstName, lastName].filter(Boolean).join(' ')
            || (raw.TITLE || '').trim()
            || 'Без имени';

        return {
            id: String(raw.ID || ''),
            firstName: firstName,
            lastName: lastName,
            fullName: fullName,
            phone: firstMultiFieldValue(raw.PHONE),
            email: firstMultiFieldValue(raw.EMAIL)
        };
    }

    /**
     * Сценарий для лида: по ID лида получить данные клиента.
     * Если у лида есть привязанный контакт и в самом лиде нет телефона —
     * добираем данные из контакта.
     *
     * @param {string|number} leadId — ID лида
     * @returns {Promise<Object>} нормализованный контакт
     */
    async function getContactByLead(leadId) {
        const lead = await getLead(leadId);
        const fromLead = normalizeLead(lead);

        // Телефон/email есть в самом лиде — этого достаточно
        if (fromLead.phone || fromLead.email) {
            return fromLead;
        }

        // Иначе пробуем контакт лида
        const contactId = lead.CONTACT_ID;
        if (contactId && Number(contactId) > 0) {
            const rawContact = await getContact(contactId);
            return normalizeContact(rawContact);
        }

        return fromLead;
    }

    /**
     * Основной сценарий: по ID сделки получить её контакт.
     *
     * Шаги:
     *  1. crm.deal.get → берём CONTACT_ID;
     *  2. crm.contact.get → получаем имя, фамилию, телефон, email;
     *  3. нормализуем в единый формат.
     *
     * @param {string|number} dealId — ID сделки
     * @returns {Promise<Object>} нормализованный контакт
     * @throws {Error} если у сделки нет привязанного контакта
     */
    async function getContactByDeal(dealId) {
        const deal = await getDeal(dealId);

        const contactId = deal.CONTACT_ID;
        if (!contactId || Number(contactId) <= 0) {
            throw new Error('У сделки #' + dealId + ' нет привязанного контакта');
        }

        const rawContact = await getContact(contactId);
        return normalizeContact(rawContact);
    }

    // Публичный интерфейс модуля
    return {
        getDeal: getDeal,
        getContact: getContact,
        getContactByDeal: getContactByDeal,
        getLead: getLead,
        getContactByLead: getContactByLead,
        normalizeContact: normalizeContact,
        normalizeLead: normalizeLead
    };

})();
