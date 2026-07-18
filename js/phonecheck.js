/**
 * phonecheck.js — проверка телефона клиента на спам через SpravPortal API.
 *
 * Задача: при поступлении заявки понять, живой это человек или
 * спам/мошеннический номер, до звонка менеджера.
 *
 * Как работает:
 *  - POST {apiUrl}/whocalls/check?apiKey=... с телом
 *    { phones: ["79..."], params: { showPhoneInfo: true, ... } };
 *  - ответ по каждому номеру: action ('Block' | 'NoAction' | ...),
 *    categories (например ["Реклама, спам"]), phoneInfo (оператор, регион).
 *
 * Ключ и адрес сервиса хранятся в настройках приложения Bitrix24
 * (app.option, имя 'phone_check_config') — НЕ в коде и НЕ в репозитории.
 * Адрес выдаётся SpravPortal вместе с ключом (у sandbox и боевого ключа
 * адреса разные), поэтому оба поля вводятся в настройках.
 *
 * Конкурентов/парсеров по номеру не определить ни одним сервисом —
 * это ловится дублями в CRM (уже реализовано на портале) и поведением.
 */

'use strict';

window.Opora = window.Opora || {};

Opora.PhoneCheck = (function () {

    /** Конфиг SpravPortal. apiUrl — базовый адрес без пути, например
     *  https://b2b-api-stage-05.spravportal.ru (sandbox). */
    const CONFIG = { apiUrl: '', apiKey: '' };

    /** Имя настройки приложения Bitrix24, где лежит конфиг (JSON). */
    const OPTION_NAME = 'phone_check_config';

    /** Загружает конфиг из настроек приложения (после BX24.init). */
    function loadConfig() {
        try {
            const raw = Opora.Bitrix.getAppOption(OPTION_NAME);
            if (!raw) return;
            const saved = JSON.parse(raw);
            CONFIG.apiUrl = saved.apiUrl || '';
            CONFIG.apiKey = saved.apiKey || '';
        } catch (e) {
            console.warn('[Opora.PhoneCheck] Конфиг не прочитан:', e.message);
        }
    }

    /**
     * Сохраняет конфиг в настройки приложения (нужны права админа).
     * @param {string} apiUrl — базовый адрес сервиса
     * @param {string} apiKey — ключ API
     * @returns {Promise<void>}
     */
    function saveConfig(apiUrl, apiKey) {
        CONFIG.apiUrl = String(apiUrl || '').trim().replace(/\/+$/, '');
        CONFIG.apiKey = String(apiKey || '').trim();
        return Opora.Bitrix.setAppOption(OPTION_NAME, JSON.stringify(CONFIG));
    }

    /** @returns {boolean} заполнены ли адрес и ключ */
    function enabled() {
        return !!(CONFIG.apiUrl && CONFIG.apiKey);
    }

    /**
     * Проверяет номер через SpravPortal.
     *
     * @param {string} phone — телефон в любом формате
     * @returns {Promise<Object|null>} результат:
     *  {
     *    isSpam: true|false,       // action === 'Block'
     *    action: 'Block',          // вердикт SpravPortal как есть
     *    categories: ['Реклама, спам'],
     *    operator: 'ПАО "МегаФон"',// из phoneInfo (может быть '')
     *    region: 'Новосибирская обл.'
     *  }
     *  null — проверка выключена, нет номера или ошибка сети/лимита.
     *  При ошибке в поле lastError остаётся текст для тоста.
     */
    async function check(phone) {
        check.lastError = '';
        if (!enabled()) {
            check.lastError = 'Не заполнены адрес и ключ SpravPortal в настройках';
            return null;
        }

        const digits = Opora.WhatsApp.normalizePhone(phone);
        if (!digits) {
            check.lastError = 'У клиента не указан телефон';
            return null;
        }

        const url = CONFIG.apiUrl + '/whocalls/check?apiKey=' + encodeURIComponent(CONFIG.apiKey);
        const body = {
            phones: [digits],
            params: { allowOrganizations: true, showPhoneInfo: true, showOrganization: true }
        };

        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (resp.status === 401) {
                check.lastError = 'Ключ SpravPortal не принят (401). Проверьте ключ и срок его действия';
                return null;
            }
            if (resp.status === 429) {
                check.lastError = 'Лимит запросов SpravPortal исчерпан (429)';
                return null;
            }
            if (!resp.ok) {
                check.lastError = 'SpravPortal: HTTP ' + resp.status;
                return null;
            }

            const data = await resp.json();
            const item = data && Array.isArray(data.phones) ? data.phones[0] : null;
            if (!item) {
                check.lastError = 'SpravPortal: пустой ответ';
                return null;
            }

            const info = item.phoneInfo || {};
            // Оператор и регион: берём русские поля, если есть, иначе транслит
            const operator = info.operator || info.operatorTranslit || '';
            const region = info.region || info.regionTranslit || '';

            return {
                isSpam: item.action === 'Block',
                action: item.action || '',
                categories: Array.isArray(item.categories) ? item.categories : [],
                operator: operator,
                region: region
            };
        } catch (e) {
            console.warn('[Opora.PhoneCheck] Проверка номера:', e.message);
            check.lastError = 'Сеть/CORS: ' + e.message;
            return null;
        }
    }

    // Публичный интерфейс модуля
    return {
        check: check,
        enabled: enabled,
        loadConfig: loadConfig,
        saveConfig: saveConfig,
        CONFIG: CONFIG
    };

})();
