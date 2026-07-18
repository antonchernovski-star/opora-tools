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
     * Заготовка под проверку WhatsApp ДО переписки (Green API и аналоги).
     * Чтобы включить: заполните apiUrl/идентификаторы своего инстанса.
     * Пока ключа нет — проверка выключена, статус будет «не проверено».
     */
    const CHECKER_CONFIG = {
        enabled: false,
        // Пример для Green API:
        // urlTemplate: 'https://api.green-api.com/waInstance{id}/checkWhatsapp/{token}'
        urlTemplate: '',
        instanceId: '',
        token: ''
    };

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
     * @returns {Promise<Object>} карта вида:
     *  {
     *    whatsapp: { hasChat: false, dialogId: null },
     *    telegram: { hasChat: false, dialogId: null },
     *    max:      { hasChat: true,  dialogId: 'imol|wz_max_...' }
     *  }
     */
    async function detect(ownerTypeId, ownerId, rawEmails) {
        const map = {};
        CHANNELS.forEach(function (ch) {
            map[ch] = { hasChat: false, dialogId: null };
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

        // 3. Внешняя проверка WhatsApp до переписки (если настроен чекер)
        //    Пока CHECKER_CONFIG.enabled = false — пропускается.

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
        CHECKER_CONFIG: CHECKER_CONFIG
    };

})();
