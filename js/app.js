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
        btn.innerHTML = '<span class="btn-label">Добавить вкладку в карточку сделки</span>';

        btn.addEventListener('click', async function () {
            btn.disabled = true;
            try {
                // Проверяем, не привязано ли уже
                const bindings = await Opora.Bitrix.getPlacementBindings();
                const already = Array.isArray(bindings) && bindings.some(function (b) {
                    return b.placement === 'CRM_DEAL_DETAIL_TAB';
                });

                if (already) {
                    showToast('Вкладка уже добавлена — откройте любую сделку');
                    return;
                }

                await Opora.Bitrix.bindPlacement('CRM_DEAL_DETAIL_TAB', 'Инструменты Опоры');
                showToast('Готово! Откройте любую сделку — там появилась вкладка');
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

        // Кнопки, зависящие от телефона
        $('btn-whatsapp').disabled = !c.phone;
        $('btn-telegram').disabled = !c.phone;
        $('btn-copy-phone').disabled = !c.phone;

        // Кнопки, зависящие от email
        $('btn-email').disabled = !c.email;
        $('btn-copy-email').disabled = !c.email;

        $('contact-card').classList.remove('card--hidden');
        $('empty-card').classList.add('card--hidden');
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

    /** Привязывает обработчики ко всем кнопкам. */
    function bindActions() {
        $('btn-whatsapp').addEventListener('click', function () {
            if (contact && Opora.WhatsApp.open(contact.phone)) {
                showToast('Открываю WhatsApp…');
            }
        });

        $('btn-telegram').addEventListener('click', function () {
            if (contact && Opora.Telegram.open(contact.phone)) {
                showToast('Открываю Telegram…');
            }
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

        const placementInfo = Opora.Bitrix.getPlacement();
        const entityId = Opora.Bitrix.getEntityId();

        console.log('[Opora] PLACEMENT:', placementInfo.placement, 'ENTITY_ID:', entityId);

        // Открыто из карточки сделки?
        const isDealPlacement = placementInfo.placement.indexOf('CRM_DEAL') === 0;

        if (isDealPlacement && entityId) {
            setStatus('loading', 'Сделка #' + entityId + ' — загрузка контакта…');

            const c = await Opora.Crm.getContactByDeal(entityId);
            renderContact(c);
            setStatus('ok', 'Bitrix24 · сделка #' + entityId);
        } else {
            setStatus('ok', 'Bitrix24 · размещение: ' + placementInfo.placement);
            showEmpty(
                'Откройте из карточки сделки',
                'Приложение определяет клиента автоматически, когда открыто во вкладке сделки CRM. ' +
                'Если вкладки в сделках ещё нет — добавьте её кнопкой ниже.'
            );
            // Открыто из меню/слева — предлагаем установить вкладку в сделку
            showInstallButton();
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
