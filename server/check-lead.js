/**
 * check-lead.js — серверная функция автопроверки новых лидов «Опоры».
 *
 * Что делает по каждому лиду:
 *  1. Получает ID лида от робота Bitrix24 (исходящий вебхук).
 *  2. Читает телефон лида через входящий вебхук Bitrix24 (REST).
 *  3. Проверяет номер в SpravPortal (спам-вердикт, категории, оператор).
 *  4. Если вердикт «спам» — проверяет наличие WhatsApp/Telegram/MAX
 *     через Green API (каскад: мессенджеры проверяются только у
 *     подозрительных номеров — экономия квот Green API в 10–20 раз).
 *  5. Пишет результат в поле лида UF_CRM_OPORA_CHECK и комментарий
 *     в таймлайн «Помечено приложением Опора: …».
 *  6. РЕЖИМЫ: AUTO_CLOSE=0 (наблюдательный, по умолчанию) — только пометка;
 *     AUTO_CLOSE=1 — лид со «спам + нет ни одного мессенджера»
 *     автоматически переводится в стадию SPAM_STATUS_ID.
 *
 * Значения поля UF_CRM_OPORA_CHECK:
 *  clean              — жалоб нет;
 *  spam               — спам-метка есть, но есть мессенджеры/не всё проверено;
 *  spam_no_messengers — спам-метка + подтверждено отсутствие всех мессенджеров;
 *  no_phone / error   — нет телефона / ошибка проверки.
 *
 * Запуск: node check-lead.js (Node.js >= 18, БЕЗ npm-зависимостей).
 * Все ключи — в переменных окружения (файл .env рядом, см. README).
 * НИКАКИЕ ключи не хранятся в коде и в репозитории.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------
// Конфигурация из окружения (.env поддерживается без зависимостей)
// ------------------------------------------------------------

(function loadDotEnv() {
    try {
        const envPath = path.join(__dirname, '.env');
        if (!fs.existsSync(envPath)) return;
        fs.readFileSync(envPath, 'utf8').split('\n').forEach(function (line) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
            if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        });
    } catch (e) { /* нет .env — работаем от окружения */ }
})();

const CFG = {
    port: parseInt(process.env.PORT || '8399', 10),
    // Секрет самого эндпоинта: робот должен слать ?token=...
    token: process.env.ENDPOINT_TOKEN || '',
    // Входящий вебхук Bitrix24 с правами crm, например
    // https://stopdolg.bitrix24.ru/rest/1/xxxxxxxxxxxx/
    b24: (process.env.B24_WEBHOOK_URL || '').replace(/\/+$/, ''),
    // SpravPortal
    spravUrl: (process.env.SPRAV_URL || '').replace(/\/+$/, ''),
    spravKey: process.env.SPRAV_KEY || '',
    // Green API: три инстанса (whatsapp/telegram/max)
    green: {
        whatsapp: { url: process.env.GREEN_WA_URL, id: process.env.GREEN_WA_ID, token: process.env.GREEN_WA_TOKEN },
        telegram: { url: process.env.GREEN_TG_URL, id: process.env.GREEN_TG_ID, token: process.env.GREEN_TG_TOKEN },
        max:      { url: process.env.GREEN_MAX_URL, id: process.env.GREEN_MAX_ID, token: process.env.GREEN_MAX_TOKEN }
    },
    // Наблюдательный режим по умолчанию: только пометка, без смены стадии
    autoClose: process.env.AUTO_CLOSE === '1',
    // Стадия «Ошибочная заявка» (ID статуса лида, например 'JUNK')
    spamStatusId: process.env.SPAM_STATUS_ID || 'JUNK',
    // Код пользовательского поля лида для вердикта
    ufField: process.env.UF_FIELD || 'UF_CRM_OPORA_CHECK'
};

// ------------------------------------------------------------
// Утилиты
// ------------------------------------------------------------

/** Нормализует телефон РФ к цифрам с кодом страны: 8XXX… → 7XXX… */
function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D+/g, '');
    if (!d) return '';
    if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
    if (d.length === 10) d = '7' + d;
    return d;
}

/** POST JSON с таймаутом. Возвращает {status, json} или бросает ошибку. */
async function postJson(url, body, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 15000);
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
        const json = await resp.json().catch(function () { return null; });
        return { status: resp.status, json: json };
    } finally {
        clearTimeout(t);
    }
}

/** Вызов REST Bitrix24 через входящий вебхук. */
async function b24(method, params) {
    const r = await postJson(CFG.b24 + '/' + method + '.json', params || {});
    if (!r.json || r.json.error) {
        throw new Error('B24 ' + method + ': ' + (r.json && r.json.error_description || 'HTTP ' + r.status));
    }
    return r.json.result;
}

// ------------------------------------------------------------
// Проверки
// ------------------------------------------------------------

/** SpravPortal: {isSpam, categories, operator, region} или null при ошибке. */
async function checkSpravportal(digits) {
    const url = CFG.spravUrl + '/whocalls/check?apiKey=' + encodeURIComponent(CFG.spravKey);
    const r = await postJson(url, {
        phones: [digits],
        params: { allowOrganizations: true, showPhoneInfo: true, showOrganization: true }
    });
    const item = r.json && Array.isArray(r.json.phones) ? r.json.phones[0] : null;
    if (!item) return null;
    const info = item.phoneInfo || {};
    return {
        isSpam: item.action === 'Block',
        categories: Array.isArray(item.categories) ? item.categories : [],
        operator: info.operator || info.operatorTranslit || '',
        region: info.region || info.regionTranslit || ''
    };
}

/** Green API: true/false — аккаунт есть/нет, null — не проверено (ошибка/нет ключей). */
async function checkMessenger(channel, digits) {
    const c = CFG.green[channel];
    if (!c || !c.url || !c.id || !c.token) return null;
    const method = channel === 'whatsapp' ? 'checkWhatsapp' : 'checkAccount';
    try {
        const r = await postJson(
            c.url.replace(/\/+$/, '') + '/waInstance' + c.id + '/' + method + '/' + c.token,
            { phoneNumber: parseInt(digits, 10) },
            12000
        );
        if (!r.json) return null;
        if (channel === 'whatsapp') return typeof r.json.existsWhatsapp === 'boolean' ? r.json.existsWhatsapp : null;
        return typeof r.json.exist === 'boolean' ? r.json.exist : null;
    } catch (e) {
        return null;
    }
}

// ------------------------------------------------------------
// Основной сценарий по лиду
// ------------------------------------------------------------

async function processLead(leadId) {
    const lead = await b24('crm.lead.get', { id: leadId });
    const phones = Array.isArray(lead.PHONE) ? lead.PHONE : [];
    const digits = normalizePhone(phones.length ? phones[0].VALUE : '');

    if (!digits) {
        await writeResult(leadId, 'no_phone', 'Проверка Опоры: у лида нет телефона.');
        return { leadId: leadId, verdict: 'no_phone' };
    }

    const sp = await checkSpravportal(digits);
    if (!sp) {
        await writeResult(leadId, 'error', 'Проверка Опоры: SpravPortal недоступен или лимит исчерпан.');
        return { leadId: leadId, verdict: 'error' };
    }

    const extra = [sp.operator, sp.region].filter(Boolean).join(', ');

    // Чистый номер — фиксируем и выходим (мессенджеры не тратим)
    if (!sp.isSpam) {
        await writeResult(leadId, 'clean', 'Проверка Опоры: номер чистый, жалоб нет' + (extra ? ' (' + extra + ')' : '') + '.');
        return { leadId: leadId, verdict: 'clean' };
    }

    // Спам-метка есть → каскад: проверяем мессенджеры
    const cats = sp.categories.join(', ') || 'без категории';
    const [wa, tg, mx] = await Promise.all([
        checkMessenger('whatsapp', digits),
        checkMessenger('telegram', digits),
        checkMessenger('max', digits)
    ]);

    // «Нет ни одного мессенджера» — строго: все три проверки вернули false.
    // Если хоть одна null (не проверено) — автозакрытие не применяем.
    const noMessengers = wa === false && tg === false && mx === false;
    const msngText = 'WhatsApp: ' + fmt(wa) + ', Telegram: ' + fmt(tg) + ', MAX: ' + fmt(mx);

    if (noMessengers) {
        const comment = 'Помечено приложением Опора: СПАМ-НОМЕР (' + cats + '), мессенджеров нет (' + msngText + ')' +
            (extra ? '. ' + extra : '') +
            (CFG.autoClose ? '. Лид закрыт автоматически.' : '. Режим наблюдения: закрытие вручную.');
        await writeResult(leadId, 'spam_no_messengers', comment);
        if (CFG.autoClose) {
            await b24('crm.lead.update', { id: leadId, fields: { STATUS_ID: CFG.spamStatusId } });
        }
        return { leadId: leadId, verdict: 'spam_no_messengers', autoClosed: CFG.autoClose };
    }

    await writeResult(leadId, 'spam',
        'Помечено приложением Опора: спам-метка (' + cats + '), но мессенджеры: ' + msngText +
        (extra ? '. ' + extra : '') + '. Требует внимания менеджера.');
    return { leadId: leadId, verdict: 'spam' };

    function fmt(v) { return v === true ? 'есть' : v === false ? 'нет' : 'не проверено'; }
}

/** Пишет вердикт в UF-поле и комментарий в таймлайн лида. */
async function writeResult(leadId, verdict, comment) {
    const fields = {};
    fields[CFG.ufField] = verdict;
    try {
        await b24('crm.lead.update', { id: leadId, fields: fields });
    } catch (e) {
        // Поле может быть ещё не создано — не роняем весь сценарий
        console.warn('[opora-check] UF update:', e.message);
    }
    await b24('crm.timeline.comment.add', {
        fields: { ENTITY_ID: leadId, ENTITY_TYPE: 'lead', COMMENT: comment }
    });
}

// ------------------------------------------------------------
// HTTP-сервер
// ------------------------------------------------------------

const server = http.createServer(function (req, res) {
    const u = new URL(req.url, 'http://localhost');

    function reply(code, obj) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
    }

    if (u.pathname === '/health') return reply(200, { ok: true, autoClose: CFG.autoClose });
    if (u.pathname !== '/check') return reply(404, { error: 'not found' });
    if (!CFG.token || u.searchParams.get('token') !== CFG.token) return reply(403, { error: 'bad token' });

    let body = '';
    req.on('data', function (ch) { body += ch; if (body.length > 1e6) req.destroy(); });
    req.on('end', async function () {
        // ID лида: ?leadId=…, JSON {leadId}, либо формат исходящего
        // вебхука Bitrix24 (application/x-www-form-urlencoded: data[FIELDS][ID])
        let leadId = u.searchParams.get('leadId') || u.searchParams.get('document_id');
        if (!leadId && body) {
            try { leadId = (JSON.parse(body).leadId || '') } catch (e) {
                const m = body.match(/data%5BFIELDS%5D%5BID%5D=(\d+)/) || body.match(/data\[FIELDS\]\[ID\]=(\d+)/);
                if (m) leadId = m[1];
            }
        }
        // Робот может прислать «CRM_LEAD_123» или «LEAD_123»
        const idm = String(leadId || '').match(/(\d+)\s*$/);
        if (!idm) return reply(400, { error: 'leadId not found in request' });

        try {
            const result = await processLead(idm[1]);
            console.log('[opora-check]', JSON.stringify(result));
            reply(200, result);
        } catch (e) {
            console.error('[opora-check] lead ' + idm[1] + ':', e.message);
            reply(500, { error: e.message });
        }
    });
});

server.listen(CFG.port, function () {
    console.log('[opora-check] listening on :' + CFG.port +
        ' | autoClose=' + (CFG.autoClose ? 'ON' : 'OFF (наблюдательный режим)'));
    if (!CFG.b24 || !CFG.token || !CFG.spravUrl || !CFG.spravKey) {
        console.warn('[opora-check] ВНИМАНИЕ: заполните .env (B24_WEBHOOK_URL, ENDPOINT_TOKEN, SPRAV_URL, SPRAV_KEY)');
    }
});
