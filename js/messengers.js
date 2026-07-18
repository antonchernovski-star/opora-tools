/**
 * messengers.js — определение доступных мессенджеров клиента
 * и открытие диалогов.
 *
 * Как работает определение («канал подтверждён»):
 *  1. По переписке: чаты Wazzup (Telegram, MAX) и OLChat (WhatsApp)
 *     хранятся в открытых линиях Bitrix24. Берём активности клиента
 *     (crm.activity.list, PROVIDER_ID = IMOPENLINES_SESSION) и по коду
 *     коннектора / заголовку чата определяем канал.
 *     Пример: USER_CODE "wz_max_connec...|88|...|109230" → канал MAX.
 *  2. По контактным данным: Wazzup записывает служебные email вида
 *     "231067375@max.wazzup" — это тоже маркер канала.
 *
 * ВАЖНО (техническое ограничение мессенджеров, а не приложения):
 * узнать наличие Telegram/MAX у номера ДО первой переписки невозможно —
 * мессенджеры не раскрывают эту информацию. Для WhatsApp возможна
 * платная проверка внешним сервисом — см. CHECKER_CONFIG ниже.
 *
 * Открытие диалога: существующий чат открытой линии открывается прямо
 * в Bitrix24 (в нём оператор пишет клиенту через Wazzup/OLChat).
 */

'use strict';

window.Opora = window.Opora || {};

Opora.Messengers = (function () {

    /**
     * Проверка наличия мессенджера у номера ДО переписки — через Green API.
     *
     * Для каждого мессенджера нужен СВОЙ инстанс Green API
     * (ЛК: console.green-api.com → создать инстанс нужного типа →
     * скопировать apiUrl, idInstance, apiTokenInstance).
     * Пока поля пустые — проверка канала выключена, бейдж «не проверено».
     *
     * ВНИМАНИЕ: токены видны в коде приложения любому, кто откроет исходник.
     * С токеном инстанса можно отправлять сообщения от имени подключённого
     * номера — используйте отдельные технические номера и следите за лимитами.
     */
    const CHECKER_CONFIG = {
        whatsapp: { apiUrl: 'https://api.green-api.com', idInstance: '', apiTokenInstance: '' },
        telegram: { apiUrl: 'https://api.green-api.com', idInstance: '', apiTokenInstance: '' },
        max:      { apiUrl: 'https://api.green-api.com', idInstance: '', apiTokenInstance: '' }
    };

    /** Имя настройки приложения Bitrix24, где лежит конфиг чекеров (JSON). */
    const CONFIG_OPTION_NAME = 'green_api_checker_config';

    /**
     * Конфиг окна чатов Wazzup (первое сообщение клиенту с корпоративных
     * каналов WhatsApp/Telegram/MAX, когда переписки ещё нет).
     * API-ключ берётся в личном кабинете Wazzup: Настройки → Интеграция через API.
     * Хранится в настройках приложения Bitrix24 (app.option), не в коде.
     */
    const WAZZUP_CONFIG = { apiKey: '' };

    /** Имя настройки приложения Bitrix24 для конфига Wazzup (JSON). */
    const WAZZUP_OPTION_NAME = 'wazzup_iframe_config';

    /** Загружает конфиг Wazzup из настроек приложения. */
    function loadWazzupConfig() {
        try {
            const raw = Opora.Bitrix.getAppOption(WAZZUP_OPTION_NAME);
            if (!raw) return;
            const saved = JSON.parse(raw);
            WAZZUP_CONFIG.apiKey = saved.apiKey || '';
        } catch (e) {
            console.warn('[Opora.Messengers] Конфиг Wazzup не прочитан:', e.message);
        }
    }

    /**
     * Сохраняет конфиг Wazzup в настройки приложения (нужны права админа).
     * @param {string} apiKey
     * @returns {Promise<void>}
     */
    function saveWazzupConfig(apiKey) {
        WAZZUP_CONFIG.apiKey = String(apiKey || '').trim();
        return Opora.Bitrix.setAppOption(WAZZUP_OPTION_NAME, JSON.stringify(WAZZUP_CONFIG));
    }

    /** @returns {boolean} настроено ли окно чатов Wazzup */
    function wazzupEnabled() {
        return !!WAZZUP_CONFIG.apiKey;
    }

    /**
     * Запрашивает у Wazzup ссылку на окно чатов по конкретному клиенту
     * (официальное API «Окно чатов (iFrame)»: POST /v3/iframe).
     * В этом окне сотрудник видит чаты клиента по всем каналам
     * и может написать ПЕРВЫМ с корпоративного номера (WhatsApp/Telegram/MAX).
     *
     * @param {{id: string, name: string}} user — сотрудник Bitrix24
     * @param {string} phone — телефон клиента в любом формате
     * @param {string} [clientName] — имя клиента (для новых контактов Wazzup)
     * @returns {Promise<string|null>} URL окна чатов или null при ошибке
     */
    async function getWazzupIframeUrl(user, phone, clientName) {
        if (!wazzupEnabled()) return null;

        const digits = Opora.WhatsApp.normalizePhone(phone);
        if (!digits) return null;

        const body = {
            user: { id: String(user.id || 'opora-tools'), name: user.name || 'Сотрудник' },
            scope: 'card',
            // Фильтр «карточка клиента»: указываем телефон клиента.
            // Каналы (Telegram/MAX/WhatsApp) выбираются внутри окна Wazzup
            // при создании диалога — «Откуда писать».
            filter: [{ chatType: 'whatsapp', chatId: digits, name: clientName || digits }]
        };

        try {
            const resp = await fetch('https://api.wazzup24.com/v3/iframe', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + WAZZUP_CONFIG.apiKey
                },
                body: JSON.stringify(body)
            });
            const data = await resp.json().catch(function () { return {}; });
            if (!resp.ok || !data.url) {
                console.warn('[Opora.Messengers] Wazzup iframe: HTTP ' + resp.status, JSON.stringify(data));
                return null;
            }
            return data.url;
        } catch (e) {
            console.warn('[Opora.Messengers] Wazzup iframe:', e.message);
            return null;
        }
    }

    /**
     * Загружает конфиг чекеров из настроек приложения Bitrix24.
     * Вызывается один раз при старте (после BX24.init).
     */
    function loadCheckerConfig() {
        try {
            const raw = Opora.Bitrix.getAppOption(CONFIG_OPTION_NAME);
            if (!raw) return;
            const saved = JSON.parse(raw);
            CHANNELS.forEach(function (ch) {
                if (saved[ch]) {
                    CHECKER_CONFIG[ch].apiUrl = saved[ch].apiUrl || CHECKER_CONFIG[ch].apiUrl;
                    CHECKER_CONFIG[ch].idInstance = saved[ch].idInstance || '';
                    CHECKER_CONFIG[ch].apiTokenInstance = saved[ch].apiTokenInstance || '';
                }
            });
        } catch (e) {
            console.warn('[Opora.Messengers] Конфиг чекеров не прочитан:', e.message);
        }
    }

    /**
     * Сохраняет конфиг чекеров в настройки приложения Bitrix24
     * (доступно администраторам портала).
     * @param {Object} cfg — { whatsapp: {idInstance, apiTokenInstance}, ... }
     * @returns {Promise<void>}
     */
    function saveCheckerConfig(cfg) {
        CHANNELS.forEach(function (ch) {
            if (cfg[ch]) {
                CHECKER_CONFIG[ch].idInstance = (cfg[ch].idInstance || '').trim();
                CHECKER_CONFIG[ch].apiTokenInstance = (cfg[ch].apiTokenInstance || '').trim();
                const url = (cfg[ch].apiUrl || '').trim().replace(/\/+$/, '');
                if (url) CHECKER_CONFIG[ch].apiUrl = url;
            }
        });
        return Opora.Bitrix.setAppOption(CONFIG_OPTION_NAME, JSON.stringify(CHECKER_CONFIG));
    }

    /**
     * Проверяет, включён ли чекер для канала (заполнены ли ключи).
     * @param {string} channel
     * @returns {boolean}
     */
    function checkerEnabled(channel) {
        const c = CHECKER_CONFIG[channel];
        return !!(c && c.apiUrl && c.idInstance && c.apiTokenInstance);
    }

    /**
     * Проверяет наличие аккаунта мессенджера у номера через Green API.
     *
     * Методы Green API:
     *  - WhatsApp: POST /waInstance{id}/checkWhatsapp/{token} → {existsWhatsapp}
     *  - Telegram и MAX: POST /waInstance{id}/checkAccount/{token} → {exist}
     *
     * @param {string} channel — 'whatsapp' | 'telegram' | 'max'
     * @param {string} phone — телефон в любом формате
     * @returns {Promise<boolean|null>} true/false — результат, null — ошибка/выключено
     */
    async function checkAccount(channel, phone) {
        if (!checkerEnabled(channel)) return null;

        const digits = Opora.WhatsApp.normalizePhone(phone);
        if (!digits) return null;

        const c = CHECKER_CONFIG[channel];
        // У каждого инстанса Green API свой поддомен:
        // первые 4 цифры idInstance, например 4100 → https://4100.api.green-api.com
        const apiUrl = (c.apiUrl && c.apiUrl !== 'https://api.green-api.com')
            ? c.apiUrl
            : 'https://' + String(c.idInstance).slice(0, 4) + '.api.green-api.com';
        const method = channel === 'whatsapp' ? 'checkWhatsapp' : 'checkAccount';
        const url = apiUrl + '/waInstance' + c.idInstance + '/' + method + '/' + c.apiTokenInstance;

        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumber: parseInt(digits, 10) })
            });
            if (!resp.ok) {
                console.warn('[Opora.Messengers] Чекер ' + channel + ': HTTP ' + resp.status);
                return null;
            }
            const data = await resp.json();
            if (channel === 'whatsapp') {
                return typeof data.existsWhatsapp === 'boolean' ? data.existsWhatsapp : null;
            }
            return typeof data.exist === 'boolean' ? data.exist : null;
        } catch (e) {
            console.warn('[Opora.Messengers] Чекер ' + channel + ':', e.message);
            return null;
        }
    }

    /** Коды каналов. */
    const CHANNELS = ['whatsapp', 'telegram', 'max'];

    /**
     * Определяет канал мессенджера по строке (код коннектора, заголовок чата).
     * @param {string} text — например 'wz_max_connec...' или 'Чат ... (WAZZUP: Max)'
     * @returns {string|null} 'whatsapp' | 'telegram' | 'max' | null
     */
    function channelFromText(text) {
        const s = String(text || '').toLowerCase();
        if (!s) return null;
        if (/max/.test(s)) return 'max';
        if (/telegram|tlgrm|tgb?_/.test(s)) return 'telegram';
        if (/whatsapp|olchat|wapi|\bwa\b/.test(s)) return 'whatsapp';
        return null;
    }

    /**
     * Достаёт маркеры каналов из контактных данных
     * (служебные email Wazzup вида 123@max.wazzup).
     * @param {Array} emails — мультиполе EMAIL сущности CRM (сырое)
     * @returns {Object} например { max: true }
     */
    function channelsFromEmails(emails) {
        const found = {};
        (Array.isArray(emails) ? emails : []).forEach(function (e) {
            const m = String(e && e.VALUE || '').match(/@(whatsapp|telegram|max)\.wazzup$/i);
            if (m) found[m[1].toLowerCase()] = true;
        });
        return found;
    }

    /**
     * Проверяет, является ли email служебным (Wazzup) — такие не показываем
     * как email клиента и не используем для mailto.
     * @param {string} email
     * @returns {boolean}
     */
    function isServiceEmail(email) {
        return /@(whatsapp|telegram|max)\.wazzup$/i.test(String(email || ''));
    }

    /**
     * Собирает карту мессенджеров клиента по активностям открытых линий.
     *
     * @param {number} ownerTypeId — 1 = лид, 2 = сделка
     * @param {string|number} ownerId — ID лида/сделки
     * @param {Array} [rawEmails] — сырое мультиполе EMAIL (для маркеров Wazzup)
     * @param {string} [phone] — телефон клиента (для проверки чекером Green API)
     * @returns {Promise<Object>} карта вида:
     *  {
     *    whatsapp: { hasChat: false, dialogId: null, accountExists: true },
     *    telegram: { hasChat: false, dialogId: null, accountExists: null },
     *    max:      { hasChat: true,  dialogId: 'imol|wz_max_...', accountExists: null }
     *  }
     *  accountExists: true/false — результат чекера Green API,
     *  null — чекер выключен, ошибка или проверка не потребовалась.
     */
    async function detect(ownerTypeId, ownerId, rawEmails, phone) {
        const map = {};
        CHANNELS.forEach(function (ch) {
            map[ch] = { hasChat: false, dialogId: null, accountExists: null };
        });

        // 1. Маркеры из контактных данных (email *@max.wazzup и т.п.)
        const emailChannels = channelsFromEmails(rawEmails);
        Object.keys(emailChannels).forEach(function (ch) {
            if (map[ch]) map[ch].hasChat = true;
        });

        // 2. Активности открытых линий по этому клиенту
        try {
            const acts = await Opora.Bitrix.callMethod('crm.activity.list', {
                filter: {
                    OWNER_TYPE_ID: ownerTypeId,
                    OWNER_ID: ownerId,
                    PROVIDER_ID: 'IMOPENLINES_SESSION'
                },
                select: ['ID', 'SUBJECT', 'PROVIDER_PARAMS', 'COMMUNICATIONS'],
                order: { ID: 'DESC' }
            });

            (acts || []).forEach(function (a) {
                const userCode = (a.PROVIDER_PARAMS && a.PROVIDER_PARAMS.USER_CODE) || '';
                const channel = channelFromText(userCode) || channelFromText(a.SUBJECT);
                if (!channel || !map[channel]) return;

                // ID диалога для открытия чата в Bitrix24
                let dialogId = null;
                if (Array.isArray(a.COMMUNICATIONS) && a.COMMUNICATIONS.length) {
                    dialogId = a.COMMUNICATIONS[0].VALUE || null; // 'imol|...'
                }
                if (!dialogId && userCode) {
                    dialogId = 'imol|' + userCode;
                }

                map[channel].hasChat = true;
                // Берём самый свежий диалог (список отсортирован по ID DESC)
                if (!map[channel].dialogId) {
                    map[channel].dialogId = dialogId;
                }
            });
        } catch (e) {
            console.warn('[Opora.Messengers] Не удалось получить активности:', e.message);
        }

        // 3. Чекеры Green API: для каналов без переписки проверяем
        //    наличие аккаунта по номеру (если ключи заполнены).
        //    Проверки идут параллельно, ошибки не ломают остальное.
        const pending = CHANNELS
            .filter(function (ch) { return !map[ch].hasChat && checkerEnabled(ch); })
            .map(function (ch) {
                return checkAccount(ch, phone).then(function (exists) {
                    map[ch].accountExists = exists;
                });
            });
        if (pending.length) {
            await Promise.all(pending);
        }

        return map;
    }

    /**
     * Открывает существующий диалог открытой линии в Bitrix24.
     * Оператор пишет в него — сообщение уходит клиенту в мессенджер
     * через настроенную интеграцию (Wazzup или OLChat).
     *
     * @param {string} dialogId — 'imol|...'
     * @returns {boolean} true, если диалог открыт
     */
    function openDialog(dialogId) {
        if (!dialogId) return false;

        // Штатный способ SDK — открыть мессенджер Bitrix24 на нужном диалоге
        try {
            if (window.BX24 && BX24.im && typeof BX24.im.openMessenger === 'function') {
                BX24.im.openMessenger(dialogId);
                return true;
            }
        } catch (e) {
            console.warn('[Opora.Messengers] BX24.im.openMessenger:', e.message);
        }

        // Резерв: открыть мессенджер портала отдельной вкладкой
        try {
            const domain = (window.BX24 && BX24.getDomain && BX24.getDomain()) || '';
            if (domain) {
                window.open('https://' + domain + '/online/?IM_DIALOG=' + encodeURIComponent(dialogId), '_blank', 'noopener');
                return true;
            }
        } catch (e) {
            console.warn('[Opora.Messengers] fallback open:', e.message);
        }
        return false;
    }

    // Публичный интерфейс модуля
    return {
        detect: detect,
        openDialog: openDialog,
        isServiceEmail: isServiceEmail,
        channelFromText: channelFromText,
        checkAccount: checkAccount,
        checkerEnabled: checkerEnabled,
        loadCheckerConfig: loadCheckerConfig,
        saveCheckerConfig: saveCheckerConfig,
        CHECKER_CONFIG: CHECKER_CONFIG,
        loadWazzupConfig: loadWazzupConfig,
        saveWazzupConfig: saveWazzupConfig,
        wazzupEnabled: wazzupEnabled,
        getWazzupIframeUrl: getWazzupIframeUrl,
        WAZZUP_CONFIG: WAZZUP_CONFIG
    };

})();
