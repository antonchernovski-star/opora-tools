/**
 * bitrix.js — обёртка над Bitrix24 JS SDK (BX24).
 *
 * Отвечает за:
 *  - инициализацию SDK (BX24.init);
 *  - получение информации о размещении (PLACEMENT / ENTITY_ID);
 *  - универсальный вызов REST-методов с промисами;
 *  - определение, открыто ли приложение внутри Bitrix24.
 *
 * Все остальные модули работают с Bitrix24 только через этот файл —
 * так проще тестировать и добавлять новые инструменты.
 */

'use strict';

/** Глобальное пространство имён приложения. */
window.Opora = window.Opora || {};

Opora.Bitrix = (function () {

    /** Признак того, что SDK загружен и мы внутри Bitrix24. */
    let insideBitrix = false;

    /**
     * Проверяет доступность BX24 SDK.
     * SDK доступен только когда приложение открыто внутри Bitrix24 (iframe).
     * @returns {boolean}
     */
    function isAvailable() {
        return typeof window.BX24 !== 'undefined' && window.BX24 !== null;
    }

    /**
     * Инициализирует BX24 SDK.
     * @returns {Promise<void>} промис, который резолвится после BX24.init
     */
    function init() {
        return new Promise(function (resolve, reject) {
            if (!isAvailable()) {
                reject(new Error('BX24 SDK недоступен: приложение открыто вне Bitrix24'));
                return;
            }

            try {
                BX24.init(function () {
                    insideBitrix = true;
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Возвращает информацию о размещении приложения.
     *
     * Пример ответа для карточки сделки:
     * {
     *   placement: 'CRM_DEAL_DETAIL_TAB',
     *   options: { ID: '123' }
     * }
     *
     * Для приложения, открытого из левого меню:
     * { placement: 'DEFAULT', options: {} }
     *
     * @returns {{placement: string, options: Object}}
     */
    function getPlacement() {
        if (!isAvailable()) {
            return { placement: 'NONE', options: {} };
        }
        try {
            const info = BX24.placement.info();
            return {
                placement: info && info.placement ? info.placement : 'DEFAULT',
                options: info && info.options ? info.options : {}
            };
        } catch (e) {
            console.warn('[Opora.Bitrix] Не удалось получить placement:', e);
            return { placement: 'DEFAULT', options: {} };
        }
    }

    /**
     * Извлекает ENTITY_ID (ID сущности CRM) из параметров размещения.
     * В карточке сделки Bitrix24 передаёт ID в options.ID.
     * @returns {string|null} ID сущности или null
     */
    function getEntityId() {
        const info = getPlacement();
        const options = info.options || {};

        // Bitrix24 в разных размещениях передаёт ID по-разному
        const id = options.ID || options.id || options.ENTITY_ID || options.entityId || null;
        return id ? String(id) : null;
    }

    /**
     * Универсальный вызов REST-метода Bitrix24 через BX24.callMethod.
     *
     * @param {string} method — имя REST-метода, например 'crm.deal.get'
     * @param {Object} [params] — параметры вызова
     * @returns {Promise<*>} промис с данными ответа (result.data())
     */
    function callMethod(method, params) {
        return new Promise(function (resolve, reject) {
            if (!isAvailable()) {
                reject(new Error('BX24 SDK недоступен, метод не вызван: ' + method));
                return;
            }

            BX24.callMethod(method, params || {}, function (result) {
                if (result.error()) {
                    reject(new Error('[' + method + '] ' + result.error().toString()));
                } else {
                    resolve(result.data());
                }
            });
        });
    }

    /**
     * @returns {boolean} true, если приложение успешно инициализировано внутри Bitrix24
     */
    function isInsideBitrix() {
        return insideBitrix;
    }

    /**
     * Возвращает публичный URL этого приложения (обработчик для placement.bind).
     * Работает и на GitHub Pages, и на любом другом хостинге.
     * @returns {string} например 'https://user.github.io/opora-tools/index.html'
     */
    function getHandlerUrl() {
        let path = window.location.pathname;
        // Если открыто как каталог (/opora-tools/) — дописываем index.html
        if (path.endsWith('/')) {
            path += 'index.html';
        }
        return window.location.origin + path;
    }

    /**
     * Привязывает приложение к размещению (например, вкладка карточки сделки).
     * Требует право (scope) `placement`.
     *
     * @param {string} placement — код размещения, например 'CRM_DEAL_DETAIL_TAB'
     * @param {string} title — заголовок вкладки
     * @returns {Promise<*>}
     */
    function bindPlacement(placement, title) {
        return callMethod('placement.bind', {
            PLACEMENT: placement,
            HANDLER: getHandlerUrl(),
            TITLE: title,
            LANG_ALL: { ru: { TITLE: title } }
        });
    }

    /**
     * Возвращает список размещений, к которым приложение уже привязано.
     * @returns {Promise<Array>} массив привязок [{placement, handler, title}, ...]
     */
    function getPlacementBindings() {
        return callMethod('placement.get', {});
    }

    // Публичный интерфейс модуля
    return {
        isAvailable: isAvailable,
        init: init,
        getPlacement: getPlacement,
        getEntityId: getEntityId,
        callMethod: callMethod,
        isInsideBitrix: isInsideBitrix,
        getHandlerUrl: getHandlerUrl,
        bindPlacement: bindPlacement,
        getPlacementBindings: getPlacementBindings
    };

})();
