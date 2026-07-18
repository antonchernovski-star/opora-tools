/**
 * app.js — точка входа приложения «Инструменты Опоры».
 *
 * Отвечает за:
 *  - запуск: инициализация Bitrix24 → определение сделки → загрузка контакта;
 *  - отрисовку данных контакта в интерфейсе;
 *  - обработку кнопок (WhatsApp, Telegram, Email, копирование);
 *  - демо-режим при открытии вне Bitrix24 (для проверки интерфейса).
 *
 * Как добавить новый инструмент (GetContact, Глаз Бога, ФССП, ЕФРСБ,
 * AI-помощник, скоринг и т.д.):
 *  1. создать файл js/имя-инструмента.js с модулем Opora.ИмяИнструмента
 *     (по образцу whatsapp.js);
 *  2. подключить его в index.html до app.js;
 *  3. добавить кнопку в index.html и обработчик в bindActions() ниже.
 * Остальной код менять не нужно.
 */

'use strict';

window.Opora = window.Opora || {};

(function () {

    /** Текущий контакт (единый формат из Opora.Crm). */
    let contact = null;

    /**
     * Карта мессенджеров клиента (из Opora.Messengers.detect):
     * { whatsapp: {hasChat, dialogId}, telegram: {...}, max: {...} }
     */
    let messengers = null;

    /** Текущий сотрудник Bitrix24 (для окна чатов Wazzup). */
    let currentUser = { id: 'opora-tools', name: 'Сотрудник' };

    /** Демо-контакт для открытия вне Bitrix24. */
    const DEMO_CONTACT = {
        id: 'demo',
        firstName: 'Иван',
        lastName: 'Петров',
        fullName: 'Иван Петров (демо)',
        phone: '+7 913 000-00-00',
        email: 'demo@opora.ru'
    };

    // ------------------------------------------------------------
    // Вспомогательные функции интерфейса
    // ------------------------------------------------------------

    /** Короткий доступ к элементу по id. */
    function $(id) {
        return document.getElementById(id);
    }

    /**
     * Обновляет строку статуса подключения.
     * @param {'loading'|'ok'|'error'} state — состояние
     * @param {string} text — текст статуса
     */
    function setStatus(state, text) {
        const bar = $('status-bar');
        bar.className = 'status-bar status-bar--' + state;
        $('status-text').textContent = text;
    }

    /**
     * Показывает всплывающее уведомление (toast) на 2.5 секунды.
     * @param {string} message — текст уведомления
     */
    function showToast(message) {
        const toast = $('toast');
        toast.textContent = message;
        toast.classList.add('toast--visible');

        clearTimeout(showToast._timer);
        showToast._timer = setTimeout(function () {
            toast.classList.remove('toast--visible');
        }, 2500);
    }

    /**
     * Показывает карточку «нет данных» с заголовком и описанием.
     * @param {string} title — заголовок
     * @param {string} text — описание
     */
    function showEmpty(title, text) {
        $('empty-title').textContent = title;
        $('empty-text').textContent = text;
        $('empty-card').classList.remove('card--hidden');
        $('contact-card').classList.add('card--hidden');
    }

    /**
     * Показывает в пустой карточке кнопку «Добавить вкладку в карточку сделки».
     * Кнопка вызывает placement.bind (нужно право `placement`) и сама
     * привязывает приложение к вкладке сделки — без ручной работы с REST.
     */
    function showInstallButton() {
        // Не дублируем кнопку при повторном рендере
        if ($('btn-install-tab')) {
            return;
        }

        const btn = document.createElement('button');
        btn.id = 'btn-install-tab';
        btn.type = 'button';
        btn.className = 'btn btn--email';
        btn.style.marginTop = '16px';
        btn.innerHTML = '<span class="btn-label">Добавить вкладку в карточку лида</span>';

        btn.addEventListener('click', async function () {
            btn.disabled = true;
            try {
                // Смотрим текущие привязки (для диагностики в консоли)
                const bindings = await Opora.Bitrix.getPlacementBindings();
                console.log('[Opora] placement.get:', JSON.stringify(bindings));

                // Всегда пересоздаём привязку: при перезаливке ZIP адрес приложения
                // на CDN Bitrix24 меняется, и старый handler перестаёт работать.
                // Вкладки + кнопки в шапке карточек лида и сделки.
                // Кнопка в шапке не зависит от кастомизации меню вкладок.
                const placements = [
                    'CRM_LEAD_DETAIL_TAB', 'CRM_LEAD_DETAIL_TOOLBAR',
                    'CRM_DEAL_DETAIL_TAB', 'CRM_DEAL_DETAIL_TOOLBAR'
                ];
                for (const p of placements) {
                    const hasOld = Array.isArray(bindings) && bindings.some(function (b) {
                        return b.placement === p;
                    });
                    if (hasOld) {
                        const unbindResult = await Opora.Bitrix.unbindPlacement(p);
                        console.log('[Opora] placement.unbind', p, JSON.stringify(unbindResult));
                    }
                    const bindResult = await Opora.Bitrix.bindPlacement(p, 'Инструменты Опоры');
                    console.log('[Opora] placement.bind', p, JSON.stringify(bindResult),
                        'handler:', Opora.Bitrix.getHandlerUrl());
                }
                showToast('Готово! Откройте любой лид — там появилась вкладка');
            } catch (e) {
                console.error('[Opora] placement.bind:', e);
                showToast('Ошибка: ' + e.message + '. Проверьте право placement у приложения');
            } finally {
                btn.disabled = false;
            }
        });

        $('empty-card').querySelector('.empty-state').appendChild(btn);
    }

    /**
     * Рисует форму настроек чекеров Green API (в режиме открытия из меню).
     * Ключи сохраняются в настройки приложения Bitrix24 (app.option) —
     * в коде и репозитории они не хранятся. Сохранять может администратор.
     */
    function showCheckerSettings() {
        if ($('checker-settings')) return;

        const cfg = Opora.Messengers.CHECKER_CONFIG;
        const wrap = document.createElement('div');
        wrap.id = 'checker-settings';
        wrap.className = 'checker-settings';

        let html = '<h3 class="checker-title">Проверка номеров (Green API)</h3>' +
            '<p class="checker-hint">Ключи из <a href="https://console.green-api.com/instanceList" target="_blank" rel="noopener">консоли Green API</a>. ' +
            'Заполненный мессенджер проверяется автоматически при открытии карточки.</p>';

        [['whatsapp', 'WhatsApp'], ['telegram', 'Telegram'], ['max', 'MAX']].forEach(function (pair) {
            const ch = pair[0], label = pair[1];
            const savedUrl = (cfg[ch].apiUrl && cfg[ch].apiUrl !== 'https://api.green-api.com') ? cfg[ch].apiUrl : '';
            html += '<div class="checker-row">' +
                '<span class="checker-label">' + label + '</span>' +
                '<input type="text" id="cfg-' + ch + '-id" placeholder="idInstance" value="' + (cfg[ch].idInstance || '') + '">' +
                '<input type="text" id="cfg-' + ch + '-token" placeholder="apiTokenInstance" value="' + (cfg[ch].apiTokenInstance || '') + '">' +
                '</div>' +
                '<div class="checker-row checker-row--url">' +
                '<span class="checker-label"></span>' +
                '<input type="text" id="cfg-' + ch + '-url" placeholder="apiUrl из консоли (например https://7107.api.greenapi.com)" value="' + savedUrl + '">' +
                '</div>';
        });

        html += '<h3 class="checker-title" style="margin-top:18px">Окно чатов Wazzup (написать первым)</h3>' +
            '<p class="checker-hint">API-ключ из личного кабинета Wazzup: Настройки → Интеграция через API. ' +
            'С ключом кнопки мессенджеров открывают окно чатов Wazzup, где сотрудник пишет клиенту первым с корпоративных каналов.</p>' +
            '<div class="checker-row">' +
            '<span class="checker-label">Wazzup</span>' +
            '<input type="text" id="cfg-wazzup-key" placeholder="API-ключ Wazzup" value="' + (Opora.Messengers.WAZZUP_CONFIG.apiKey || '') + '">' +
            '</div>';

        html += '<button id="btn-save-checker" class="btn btn--email checker-save" type="button">' +
            '<span class="btn-label">Сохранить настройки</span></button>';

        wrap.innerHTML = html;
        $('empty-card').appendChild(wrap);

        $('btn-save-checker').addEventListener('click', async function () {
            const btn = $('btn-save-checker');
            btn.disabled = true;
            try {
                const cfgNew = {};
                ['whatsapp', 'telegram', 'max'].forEach(function (ch) {
                    cfgNew[ch] = {
                        idInstance: $('cfg-' + ch + '-id').value,
                        apiTokenInstance: $('cfg-' + ch + '-token').value,
                        apiUrl: $('cfg-' + ch + '-url').value
                    };
                });
                await Opora.Messengers.saveCheckerConfig(cfgNew);
                await Opora.Messengers.saveWazzupConfig($('cfg-wazzup-key').value);
                showToast('Настройки сохранены');
            } catch (e) {
                console.error('[Opora] Сохранение настроек:', e);
                showToast('Ошибка сохранения: ' + e.message + ' (нужны права администратора)');
            } finally {
                btn.disabled = false;
            }
        });
    }

    /**
     * Отрисовывает контакт в карточке и настраивает доступность кнопок.
     * @param {Object} c — контакт в едином формате
     */
    function renderContact(c) {
        contact = c;

        // Инициалы для аватара
        const initials =
            (c.firstName ? c.firstName[0] : '') +
            (c.lastName ? c.lastName[0] : '');
        $('contact-avatar').textContent = initials || '?';

        $('contact-name').textContent = c.fullName;
        $('contact-phone').textContent = c.phone || 'не указан';
        $('contact-email').textContent = c.email || 'не указан';

        // Второстепенные кнопки
        $('btn-copy-phone').disabled = !c.phone;
        $('btn-email').disabled = !c.email;
        $('btn-copy-email').disabled = !c.email;

        $('contact-card').classList.remove('card--hidden');
        $('empty-card').classList.add('card--hidden');
    }

    /**
     * Запускает определение мессенджеров и обновляет кнопки.
     * @param {number} ownerTypeId — 1 лид, 2 сделка
     * @param {string|number} entityId — ID сущности
     * @param {Object} c — нормализованный контакт (для rawEmails)
     */
    function detectMessengers(ownerTypeId, entityId, c) {
        setBadge('whatsapp', 'проверяю…', 'unknown');
        setBadge('telegram', 'проверяю…', 'unknown');
        setBadge('max', 'проверяю…', 'unknown');

        Opora.Messengers.detect(ownerTypeId, entityId, c.rawEmails || [], c.phone)
            .then(function (map) {
                messengers = map;
                updateMessengerButtons();
            })
            .catch(function (e) {
                console.warn('[Opora] Определение мессенджеров:', e.message);
                messengers = null;
                updateMessengerButtons();
            });
    }

    /**
     * Обновляет вид кнопки одного мессенджера.
     * @param {string} channel — 'whatsapp' | 'telegram' | 'max'
     * @param {string} badgeText — текст статуса
     * @param {string} state — 'active' (цветная) | 'unknown' (серая) | 'none' (нет аккаунта)
     */
    function setBadge(channel, badgeText, state) {
        const btn = $('btn-' + channel);
        const badge = $('badge-' + channel);
        if (!btn || !badge) return;

        badge.textContent = badgeText;
        btn.classList.toggle('btn--active', state === 'active');
        btn.classList.toggle('btn--unknown', state === 'unknown');
        btn.classList.toggle('btn--none', state === 'none');
    }

    /** Применяет карту мессенджеров к кнопкам. */
    function updateMessengerButtons() {
        const map = messengers || {};

        ['whatsapp', 'telegram', 'max'].forEach(function (ch) {
            const info = map[ch] || { hasChat: false, accountExists: null };
            const btn = $('btn-' + ch);
            btn.disabled = false;

            if (info.hasChat) {
                // Уже переписывались — открываем диалог
                setBadge(ch, 'переписка есть', 'active');
            } else if (info.accountExists === true) {
                // Чекер подтвердил аккаунт — можно писать первым
                setBadge(ch, 'аккаунт есть', 'active');
            } else if (info.accountExists === false) {
                // Чекер сказал: аккаунта нет
                setBadge(ch, 'нет аккаунта', 'none');
                btn.disabled = true;
            } else {
                setBadge(ch, 'не проверено', 'unknown');
            }
        });

        // Без телефона первое касание невозможно (ни Wazzup, ни ссылки)
        const noPhone = contact && !contact.phone;
        ['whatsapp', 'telegram', 'max'].forEach(function (ch) {
            if (noPhone && !(map[ch] && map[ch].hasChat)) $('btn-' + ch).disabled = true;
        });
    }

    // ------------------------------------------------------------
    // Окно чатов Wazzup (первое сообщение с корпоративных каналов)
    // ------------------------------------------------------------

    /**
     * Открывает окно чатов Wazzup по клиенту поверх приложения.
     * В окне сотрудник создаёт диалог («Откуда писать» — корпоративный
     * канал WhatsApp/Telegram/MAX) и пишет клиенту первым.
     * @param {string} url — ссылка из POST /v3/iframe
     */
    function showWazzupWindow(url) {
        let overlay = $('wazzup-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'wazzup-overlay';
            overlay.className = 'wazzup-overlay';
            overlay.innerHTML =
                '<div class="wazzup-window">' +
                '  <div class="wazzup-window-head">' +
                '    <span>Чаты Wazzup — написать клиенту</span>' +
                '    <button id="wazzup-close" class="wazzup-close" type="button" title="Закрыть">✕</button>' +
                '  </div>' +
                '  <iframe id="wazzup-frame" allow="microphone *; clipboard-write *"></iframe>' +
                '</div>';
            document.body.appendChild(overlay);
            $('wazzup-close').addEventListener('click', function () {
                overlay.classList.remove('wazzup-overlay--visible');
                $('wazzup-frame').src = 'about:blank';
            });
        }
        $('wazzup-frame').src = url;
        overlay.classList.add('wazzup-overlay--visible');
    }

    /**
     * Первое касание: запрашивает ссылку окна чатов Wazzup и открывает его.
     * @param {string} channel — канал, из которого нажата кнопка (для текста)
     */
    async function openWazzupForFirstTouch(channel) {
        if (!contact || !contact.phone) {
            showToast('У клиента не указан телефон');
            return;
        }
        showToast('Открываю окно Wazzup…');
        const url = await Opora.Messengers.getWazzupIframeUrl(
            currentUser, contact.phone, contact.fullName
        );
        if (url) {
            showWazzupWindow(url);
        } else {
            showToast('Wazzup недоступен. Проверьте API-ключ в настройках приложения');
        }
    }

    // ------------------------------------------------------------
    // Действия кнопок
    // ------------------------------------------------------------

    /**
     * Копирует текст в буфер обмена через navigator.clipboard
     * с запасным вариантом для старых браузеров / iframe без прав.
     * @param {string} text — что копировать
     * @param {string} successMessage — сообщение при успехе
     */
    function copyToClipboard(text, successMessage) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
                .then(function () { showToast(successMessage); })
                .catch(function () { fallbackCopy(text, successMessage); });
        } else {
            fallbackCopy(text, successMessage);
        }
    }

    /**
     * Запасное копирование через скрытый textarea + execCommand.
     * Нужно, если iframe Bitrix24 не даёт доступ к navigator.clipboard.
     * @param {string} text — что копировать
     * @param {string} successMessage — сообщение при успехе
     */
    function fallbackCopy(text, successMessage) {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();

        try {
            document.execCommand('copy');
            showToast(successMessage);
        } catch (e) {
            showToast('Не удалось скопировать');
        }

        document.body.removeChild(area);
    }

    /**
     * Клик по кнопке мессенджера.
     * 1) Есть переписка → открываем диалог открытой линии прямо в Bitrix24
     *    (сообщения уходят через корпоративную интеграцию Wazzup / OLChat).
     * 2) Переписки нет → открываем окно чатов Wazzup по клиенту:
     *    сотрудник выбирает корпоративный канал и пишет первым.
     * 3) Wazzup не настроен → резерв: wa.me / t.me по номеру
     *    (у MAX ссылки по номеру не существует).
     * @param {string} channel — 'whatsapp' | 'telegram' | 'max'
     */
    function onMessengerClick(channel) {
        const info = messengers && messengers[channel];
        const titles = { whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX' };

        // 1. Существующий диалог — внутри Bitrix24
        if (info && info.hasChat && info.dialogId && Opora.Messengers.openDialog(info.dialogId)) {
            showToast('Открываю чат ' + titles[channel] + '…');
            return;
        }

        // 2. Первое касание — окно чатов Wazzup (корпоративные номера)
        if (Opora.Messengers.wazzupEnabled()) {
            openWazzupForFirstTouch(channel);
            return;
        }

        // 3. Резерв без Wazzup: внешние ссылки по номеру
        if (channel === 'whatsapp' && contact && Opora.WhatsApp.open(contact.phone)) {
            showToast('Wazzup не настроен — открываю wa.me');
            return;
        }
        if (channel === 'telegram' && contact && Opora.Telegram.open(contact.phone)) {
            showToast('Wazzup не настроен — открываю t.me по номеру');
            return;
        }
        showToast('Заполните API-ключ Wazzup в настройках приложения');
    }

    /** Привязывает обработчики ко всем кнопкам. */
    function bindActions() {
        ['whatsapp', 'telegram', 'max'].forEach(function (ch) {
            $('btn-' + ch).addEventListener('click', function () {
                onMessengerClick(ch);
            });
        });

        $('btn-email').addEventListener('click', function () {
            if (contact && contact.email) {
                window.location.href = 'mailto:' + contact.email;
            }
        });

        $('btn-copy-phone').addEventListener('click', function () {
            if (contact && contact.phone) {
                copyToClipboard(contact.phone, 'Телефон скопирован');
            }
        });

        $('btn-copy-email').addEventListener('click', function () {
            if (contact && contact.email) {
                copyToClipboard(contact.email, 'Email скопирован');
            }
        });
    }

    // ------------------------------------------------------------
    // Запуск приложения
    // ------------------------------------------------------------

    /**
     * Основной сценарий внутри Bitrix24:
     *  1. BX24.init;
     *  2. читаем PLACEMENT и ENTITY_ID;
     *  3. если открыто из карточки сделки — загружаем контакт сделки.
     */
    async function startInsideBitrix() {
        setStatus('loading', 'Подключение к Bitrix24…');
        await Opora.Bitrix.init();

        // Подтягиваем ключи чекеров Green API и Wazzup из настроек приложения
        Opora.Messengers.loadCheckerConfig();
        Opora.Messengers.loadWazzupConfig();

        // Текущий сотрудник — для окна чатов Wazzup (не критично при ошибке)
        Opora.Bitrix.callMethod('user.current', {})
            .then(function (u) {
                if (u && u.ID) {
                    currentUser = {
                        id: String(u.ID),
                        name: ((u.NAME || '') + ' ' + (u.LAST_NAME || '')).trim() || 'Сотрудник'
                    };
                }
            })
            .catch(function (e) {
                console.warn('[Opora] user.current:', e.message);
            });

        const placementInfo = Opora.Bitrix.getPlacement();
        const entityId = Opora.Bitrix.getEntityId();

        console.log('[Opora] PLACEMENT:', placementInfo.placement, 'ENTITY_ID:', entityId);

        // Откуда открыто приложение?
        const isDealPlacement = placementInfo.placement.indexOf('CRM_DEAL') === 0;
        const isLeadPlacement = placementInfo.placement.indexOf('CRM_LEAD') === 0;

        if (isLeadPlacement && entityId) {
            setStatus('loading', 'Лид #' + entityId + ' — загрузка данных…');

            const c = await Opora.Crm.getContactByLead(entityId);
            renderContact(c);
            setStatus('ok', 'Bitrix24 · лид #' + entityId);

            // Определяем мессенджеры клиента (по переписке в открытых линиях)
            detectMessengers(1, entityId, c);
        } else if (isDealPlacement && entityId) {
            setStatus('loading', 'Сделка #' + entityId + ' — загрузка контакта…');

            const c = await Opora.Crm.getContactByDeal(entityId);
            renderContact(c);
            setStatus('ok', 'Bitrix24 · сделка #' + entityId);

            // Определяем мессенджеры клиента (по переписке в открытых линиях)
            detectMessengers(2, entityId, c);
        } else {
            setStatus('ok', 'Bitrix24 · размещение: ' + placementInfo.placement);
            showEmpty(
                'Откройте из карточки лида',
                'Приложение определяет клиента автоматически, когда открыто во вкладке лида или сделки CRM. ' +
                'Если вкладки ещё нет — добавьте её кнопкой ниже.'
            );
            // Открыто из меню/слева — предлагаем установить вкладку в сделку
            showInstallButton();
            // И показываем настройки чекеров Green API (для администратора)
            showCheckerSettings();
        }
    }

    /**
     * Демо-режим для открытия вне Bitrix24
     * (например, напрямую через GitHub Pages) — чтобы проверить интерфейс.
     */
    function startDemoMode() {
        setStatus('error', 'Вне Bitrix24 — демо-режим');
        renderContact(DEMO_CONTACT);
        showToast('Приложение открыто вне Bitrix24 — показаны демо-данные');
    }

    /** Точка входа. */
    async function start() {
        bindActions();

        if (!Opora.Bitrix.isAvailable()) {
            startDemoMode();
            return;
        }

        try {
            await startInsideBitrix();
        } catch (e) {
            console.error('[Opora] Ошибка запуска:', e);
            setStatus('error', 'Ошибка: ' + e.message);
            showEmpty('Не удалось загрузить данные', e.message);
        }
    }

    // Запускаем после полной загрузки DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

})();
