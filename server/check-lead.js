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
 * ДОПОЛНИТЕЛЬНО (v2): ГРЕЙД КЛИЕНТА (потенциал) по ТЗ «Автоматический грейд».
 *  Балльная модель из полей анкеты КЦ лида → поля лида:
 *   UF_CRM_OPORA_GRADE (Зелёный/Жёлтый/Красный/Неполный),
 *   UF_CRM_OPORA_SCORE (число), UF_CRM_OPORA_GRADE_NOTE (пометки).
 *  Опрос изменённых лидов по DATE_MODIFY раз в GRADE_SECONDS сек;
 *  запись только при изменении значений (защита от зацикливания).
 *  Веса/пороги/правила — в grade-config.json (создаётся с дефолтами),
 *  правится через GET/POST /grade-config без перезапуска.
 *  Ручной расчёт: /grade?token=…&leadId=…
 *  Валидация без записи: /grade-scan?token=…&days=7 (dry-run),
 *  с записью: /grade-scan?token=…&days=7&apply=1
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
    ufField: process.env.UF_FIELD || 'UF_CRM_OPORA_CHECK',
    // Автопроверка опросом: раз в POLL_SECONDS сек сервер сам берёт новые
    // лиды и проверяет их (0 = выключено; не зависит от роботов Bitrix24).
    pollSeconds: parseInt(process.env.POLL_SECONDS || '0', 10),
    // Экономия лимитов: стадии, в которых лид НЕ проверяем (менеджер уже
    // разобрал). Список STATUS_ID через запятую, например: 20,CONVERTED,JUNK
    skipStatuses: String(process.env.SKIP_STATUSES || '').split(',')
        .map(function (s) { return s.trim(); }).filter(Boolean),
    // Экономия лимитов: пропускать лиды, в названии которых есть эта
    // подстрока (например «Входящий звонок» — клиент сам позвонил, он живой)
    skipTitle: String(process.env.SKIP_TITLE || '').trim().toLowerCase(),
    // Грейд клиента: период опроса изменённых лидов, сек (0 = выключено)
    gradeSeconds: parseInt(process.env.GRADE_SECONDS || '300', 10)
};

/** Файл, где хранится ID последнего обработанного лида (watermark опроса). */
const STATE_FILE = path.join(__dirname, 'poll-state.json');
const STATE = { lastId: 0, gradeSince: '' };
(function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            STATE.lastId = s.lastId || 0;
            STATE.gradeSince = s.gradeSince || '';
        }
    } catch (e) { /* начнём с 0 */ }
})();
function saveState() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(STATE)); } catch (e) { console.warn('[opora-check] state save:', e.message); }
}

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

/** Списочный метод B24 с пагинацией (страницы по 50). capPages — предохранитель. */
async function b24List(method, params, capPages) {
    const all = [];
    let start = 0;
    for (let p = 0; p < (capPages || 10); p++) {
        const r = await postJson(CFG.b24 + '/' + method + '.json', Object.assign({}, params, { start: start }));
        if (!r.json || r.json.error) {
            throw new Error('B24 ' + method + ': ' + (r.json && r.json.error_description || 'HTTP ' + r.status));
        }
        const chunk = r.json.result || [];
        for (const it of chunk) all.push(it);
        if (typeof r.json.next === 'number') { start = r.json.next; } else { break; }
    }
    return all;
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
// ГРЕЙД КЛИЕНТА (потенциал) — балльная модель по ТЗ.
// Все веса, пороги и правила — в grade-config.json (не хардкод).
// ------------------------------------------------------------

const GRADE_CONFIG_FILE = path.join(__dirname, 'grade-config.json');

/**
 * Дефолтная конфигурация: веса откалиброваны по воронке ofbfl
 * (22 076 лидов, янв–июль 2026). ID значений — enum-поля лида
 * портала stopdolg.bitrix24.ru (поколение анкеты КЦ «17052025»).
 */
const GRADE_DEFAULTS = {
    // Поля лида
    fields: {
        sum: 'UF_CRM_1747492825',        // КО - Сумма всех кредитов 17052025
        property: 'UF_CRM_1747493130',   // КО - Имущество 17052025
        risk: 'UF_CRM_1747493296',       // КО - Риск потери имущества 17052025
        incomeOff: 'UF_CRM_1747493174',  // КО - Официальный доход 17052025
        incomeTotal: 'UF_CRM_1747493252',// КО - Общий доход 17052025
        payment: 'UF_CRM_1747492987',    // КО - Ежемесячный платёж 17052025
        debtNature: 'UF_CRM_1783479388494', // КО - Характер долга (new, мульти)
        grade: 'UF_CRM_OPORA_GRADE',
        score: 'UF_CRM_OPORA_SCORE',
        note: 'UF_CRM_OPORA_GRADE_NOTE'
    },
    // Баллы: ID значения списка → балл (ТЗ, разделы 3.1–3.4)
    points: {
        sum:      { '3660': -30, '3662': -20, '3664': -10, '3666': 5, '3668': 25, '3670': 35, '3672': 20, '3658': 0 },
        property: { '3726': 10, '3728': 15, '3730': 5, '3732': -5, '3734': -20, '3736': -25, '3724': 0 },
        risk:     { '3766': 20, '3770': 5, '3768': -15, '3764': 0 },
        incomeOff:{ '4352': -10, '3740': -10, '3742': -10, '3744': 5, '3746': 5, '3748': 0, '3750': 0, '3752': -5, '3738': 0 }
    },
    // «Не уточнил» по ключевым полям → грейд не считается (статус «Неполный»)
    unknownIds: { sum: '3658', property: '3724', risk: '3764', incomeOff: '3738', incomeTotal: '3754', payment: '3696' },
    // Задавленность: платёж «От 50 001» при доходе ниже 50к → штраф
    squeeze: {
        paymentHighId: '3704',
        lowIncomeTotalIds: ['6014', '5986', '3756', '5988', '3758'],
        lowIncomeOffIds: ['4352', '3740', '3742', '3744', '3746'],
        penalty: -10
    },
    // Переопределения (ТЗ, раздел 5). pledgeIds — Ипотека, Залоговый кредит
    overrides: {
        pledgeIds: ['5964', '5966'],
        mortgageId: '5964',
        riskNotReadyId: '3768',
        propertySingleHomeId: '3728',
        forceRedOnPledgeNotReady: true,
        capYellowOnPledge: true
    },
    // Пороги цвета (ТЗ, раздел 4)
    thresholds: { green: 35, yellow: 0 },
    // ID значений поля «Грейд клиента (потенциал)»
    gradeEnum: { green: '6150', yellow: '6152', red: '6154', incomplete: '6156' }
};

let GRADE_CFG = null;
let GRADE_CFG_MTIME = 0;

/** Читает grade-config.json (создаёт с дефолтами при первом запуске). */
function gradeConfig() {
    try {
        if (!fs.existsSync(GRADE_CONFIG_FILE)) {
            fs.writeFileSync(GRADE_CONFIG_FILE, JSON.stringify(GRADE_DEFAULTS, null, 2), { mode: 0o600 });
        }
        const mt = fs.statSync(GRADE_CONFIG_FILE).mtimeMs;
        if (!GRADE_CFG || mt !== GRADE_CFG_MTIME) {
            GRADE_CFG = JSON.parse(fs.readFileSync(GRADE_CONFIG_FILE, 'utf8'));
            GRADE_CFG_MTIME = mt;
        }
    } catch (e) {
        console.error('[opora-grade] config:', e.message, '— использую дефолты');
        GRADE_CFG = GRADE_DEFAULTS;
    }
    return GRADE_CFG;
}

/** Значение enum-поля лида как строка ID ('' если пусто). */
function enumVal(lead, field) {
    const v = lead[field];
    if (v === null || v === undefined || v === false || v === '' || v === '0') return '';
    return String(v);
}

/** Мультиполе как массив строк-ID. */
function enumMulti(lead, field) {
    const v = lead[field];
    if (!Array.isArray(v)) return [];
    return v.map(String).filter(function (x) { return x && x !== '0'; });
}

/**
 * Считает грейд по данным лида. Возвращает
 * { grade: 'green|yellow|red|incomplete|skip', score, notes[], detail{} }.
 * 'skip' — анкета не начата вовсе, ничего не пишем.
 */
function computeGrade(lead) {
    const cfg = gradeConfig();
    const F = cfg.fields, U = cfg.unknownIds;

    const sum = enumVal(lead, F.sum);
    const property = enumVal(lead, F.property);
    const risk = enumVal(lead, F.risk);
    const incomeOff = enumVal(lead, F.incomeOff);
    const incomeTotal = enumVal(lead, F.incomeTotal);
    const payment = enumVal(lead, F.payment);
    const debtNature = enumMulti(lead, F.debtNature);

    // Анкета не начата — не трогаем лид (не шумим «Неполными» по всей базе)
    const anyFilled = sum || property || risk || incomeOff || incomeTotal || payment || debtNature.length;
    if (!anyFilled) return { grade: 'skip', score: 0, notes: [], detail: {} };

    const notes = [];
    const detail = {};
    let score = 0;

    function add(part, id) {
        const p = (cfg.points[part] || {})[id];
        const val = typeof p === 'number' ? p : 0;
        detail[part] = { id: id || null, points: val };
        score += val;
    }
    add('sum', sum);
    add('property', property);
    add('risk', risk);
    add('incomeOff', incomeOff);

    // Задавленность платежом: платёж «От 50 001», доход (общий, иначе офиц.) < 50к
    const sq = cfg.squeeze;
    let squeezed = false;
    if (payment === sq.paymentHighId) {
        if (incomeTotal && incomeTotal !== U.incomeTotal) {
            squeezed = sq.lowIncomeTotalIds.indexOf(incomeTotal) !== -1;
        } else if (incomeOff && incomeOff !== U.incomeOff) {
            squeezed = sq.lowIncomeOffIds.indexOf(incomeOff) !== -1;
        }
    }
    if (squeezed) { score += sq.penalty; notes.push('задавлен платежом'); }
    detail.squeeze = { applied: squeezed, points: squeezed ? sq.penalty : 0 };

    // Неполный: ключевые поля (сумма, имущество) пустые или «Не уточнил»
    const sumUnknown = !sum || sum === U.sum;
    const propUnknown = !property || property === U.property;
    if (sumUnknown || propUnknown) {
        const missing = [];
        if (sumUnknown) missing.push('сумма кредитов');
        if (propUnknown) missing.push('имущество');
        return { grade: 'incomplete', score: score, notes: ['уточнить: ' + missing.join(', ')], detail: detail };
    }

    // Частичный расчёт: второстепенные поля не заполнены
    const partial = [];
    if (!risk || risk === U.risk) partial.push('риск потери');
    if (!incomeOff || incomeOff === U.incomeOff) partial.push('офиц. доход');
    if (!payment || payment === U.payment) partial.push('платёж');
    if (partial.length) notes.push('частичный расчёт (нет: ' + partial.join(', ') + ')');

    // Цвет по порогам
    const th = cfg.thresholds;
    let grade = score >= th.green ? 'green' : score >= th.yellow ? 'yellow' : 'red';

    // Переопределения (юридические факты сильнее статистики)
    const ov = cfg.overrides;
    const hasPledge = debtNature.some(function (id) { return ov.pledgeIds.indexOf(id) !== -1; });
    if (ov.forceRedOnPledgeNotReady && hasPledge && risk === ov.riskNotReadyId) {
        grade = 'red';
        notes.push('принудительно красный: залог/ипотека + не готов к потере');
    } else if (ov.capYellowOnPledge && hasPledge && grade === 'green') {
        grade = 'yellow';
        notes.push('не выше жёлтого: есть ипотека/залоговый кредит');
    }
    if (property === ov.propertySingleHomeId && debtNature.indexOf(ov.mortgageId) !== -1) {
        notes.push('ипотека на ЕЖ (298-ФЗ, особый сценарий)');
    }

    return { grade: grade, score: score, notes: notes, detail: detail };
}

/** Поля лида, нужные для расчёта и сравнения. */
function gradeSelectFields() {
    const F = gradeConfig().fields;
    return ['ID', 'TITLE', 'STATUS_ID', 'DATE_MODIFY',
        F.sum, F.property, F.risk, F.incomeOff, F.incomeTotal, F.payment, F.debtNature,
        F.grade, F.score, F.note];
}

/**
 * Применяет расчёт к лиду: пишет поля ТОЛЬКО при изменении.
 * Возвращает {leadId, grade, score, notes, written}.
 */
async function gradeLead(lead, dryRun) {
    const cfg = gradeConfig();
    const F = cfg.fields;
    const r = computeGrade(lead);
    const out = { leadId: Number(lead.ID), title: lead.TITLE, grade: r.grade, score: r.score, notes: r.notes, written: false };
    if (r.grade === 'skip') return out;

    const targetEnum = r.grade === 'incomplete' ? cfg.gradeEnum.incomplete : cfg.gradeEnum[r.grade];
    const noteText = r.notes.join('; ').slice(0, 250);

    const curEnum = enumVal(lead, F.grade);
    const curScore = lead[F.score] === null || lead[F.score] === undefined || lead[F.score] === '' ? null : Number(lead[F.score]);
    const curNote = String(lead[F.note] || '');

    const changed = curEnum !== String(targetEnum) || curScore !== r.score || curNote !== noteText;
    if (!changed || dryRun) return out;

    const fields = {};
    fields[F.grade] = targetEnum;
    fields[F.score] = r.score;
    fields[F.note] = noteText;
    await b24('crm.lead.update', { id: lead.ID, fields: fields });
    out.written = true;
    return out;
}

/** Один проход опроса грейда: лиды, изменённые после watermark. */
let gradePolling = false;
async function gradePollOnce() {
    if (gradePolling) return;
    gradePolling = true;
    try {
        if (!STATE.gradeSince) {
            STATE.gradeSince = new Date().toISOString();
            saveState();
            console.log('[opora-grade] опрос стартовал с ' + STATE.gradeSince);
            return;
        }
        const since = STATE.gradeSince;
        const leads = await b24List('crm.lead.list', {
            order: { DATE_MODIFY: 'ASC' },
            filter: { '>DATE_MODIFY': since },
            select: gradeSelectFields()
        }, 6);
        let maxMod = since;
        for (const lead of leads) {
            try {
                const r = await gradeLead(lead, false);
                if (r.written) console.log('[opora-grade]', JSON.stringify(r));
            } catch (e) {
                console.error('[opora-grade] lead ' + lead.ID + ':', e.message);
            }
            const dm = new Date(lead.DATE_MODIFY).toISOString();
            if (dm > maxMod) maxMod = dm;
        }
        if (maxMod !== since) { STATE.gradeSince = maxMod; saveState(); }
    } catch (e) {
        console.error('[opora-grade] poll:', e.message);
    } finally {
        gradePolling = false;
    }
}

// ------------------------------------------------------------
// Одноразовая веб-форма настройки (/setup) — чтобы вводить ключи
// в браузере, а не в VNC-консоли без вставки. Защищена тем же токеном.
// После сохранения .env сервис завершается — systemd перезапустит
// его уже с новыми настройками.
// ------------------------------------------------------------

const ENV_KEYS = [
    ['B24_WEBHOOK_URL', 'Входящий вебхук Bitrix24 (https://stopdolg.bitrix24.ru/rest/…/…/)'],
    ['SPRAV_URL', 'SpravPortal: адрес сервиса'],
    ['SPRAV_KEY', 'SpravPortal: ключ API (sp_…)'],
    ['GREEN_WA_URL', 'Green API WhatsApp: apiUrl'],
    ['GREEN_WA_ID', 'Green API WhatsApp: idInstance'],
    ['GREEN_WA_TOKEN', 'Green API WhatsApp: apiTokenInstance'],
    ['GREEN_TG_URL', 'Green API Telegram: apiUrl'],
    ['GREEN_TG_ID', 'Green API Telegram: idInstance'],
    ['GREEN_TG_TOKEN', 'Green API Telegram: apiTokenInstance'],
    ['GREEN_MAX_URL', 'Green API MAX: apiUrl'],
    ['GREEN_MAX_ID', 'Green API MAX: idInstance'],
    ['GREEN_MAX_TOKEN', 'Green API MAX: apiTokenInstance'],
    ['SPAM_STATUS_ID', 'ID стадии «Ошибочная заявка» (для автозакрытия)'],
    ['AUTO_CLOSE', 'Автозакрытие: 0 — наблюдательный режим, 1 — закрывать'],
    ['POLL_SECONDS', 'Автопроверка: период опроса новых лидов, сек (0 — выключена)'],
    ['SKIP_STATUSES', 'Не проверять лиды в стадиях (STATUS_ID через запятую)'],
    ['SKIP_TITLE', 'Не проверять лиды с этой подстрокой в названии'],
    ['GRADE_SECONDS', 'Грейд клиента: период опроса изменённых лидов, сек (0 — выключен)']
];

/** Отдаёт HTML-форму настройки с текущим состоянием (значения маскируются). */
function setupForm(res) {
    let rows = '';
    ENV_KEYS.forEach(function (pair) {
        const k = pair[0], label = pair[1];
        const cur = process.env[k] || '';
        const hint = cur ? 'заполнено — оставьте пустым, чтобы не менять' : 'не заполнено';
        rows += '<label>' + label + ' <i>(' + hint + ')</i><br>' +
            '<input name="' + k + '" value="" autocomplete="off" style="width:100%"></label><br><br>';
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">' +
        '<title>Опора — настройка автопроверки</title>' +
        '<style>body{font-family:sans-serif;max-width:640px;margin:30px auto;padding:0 16px;color:#333}' +
        'input{padding:8px;border:1px solid #ccc;border-radius:6px}i{color:#888;font-weight:normal;font-size:12px}' +
        'button{background:#2fc6f6;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:15px;cursor:pointer}</style>' +
        '</head><body><h2>Опора · настройка автопроверки лидов</h2>' +
        '<p>Пустое поле = оставить текущее значение. После сохранения сервис перезапустится (~5 сек).</p>' +
        '<form method="POST">' + rows + '<button type="submit">Сохранить и перезапустить</button></form></body></html>');
}

/** Принимает форму, переписывает .env, завершает процесс (systemd перезапустит). */
function setupSave(body, res) {
    const params = new URLSearchParams(body);
    const lines = ['PORT=' + CFG.port, 'ENDPOINT_TOKEN=' + CFG.token, 'UF_FIELD=' + CFG.ufField];
    ENV_KEYS.forEach(function (pair) {
        const k = pair[0];
        const v = (params.get(k) || '').trim() || process.env[k] || '';
        if (v) lines.push(k + '=' + v);
    });
    fs.writeFileSync(path.join(__dirname, '.env'), lines.join('\n') + '\n', { mode: 0o600 });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<meta charset="utf-8"><p style="font-family:sans-serif">Сохранено. Сервис перезапускается — ' +
        'через 5 секунд можно проверить <a href="/health">/health</a>.</p>');
    console.log('[opora-check] .env обновлён через /setup — перезапуск');
    setTimeout(function () { process.exit(0); }, 500);
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

    if (u.pathname === '/health') return reply(200, { ok: true, autoClose: CFG.autoClose, gradeSeconds: CFG.gradeSeconds });

    // --- Грейд: конфиг весов (GET — посмотреть, POST — сохранить) ---
    if (u.pathname === '/grade-config') {
        if (!CFG.token || u.searchParams.get('token') !== CFG.token) return reply(403, { error: 'bad token' });
        if (req.method === 'GET') return reply(200, gradeConfig());
        let cbody = '';
        req.on('data', function (ch) { cbody += ch; if (cbody.length > 1e6) req.destroy(); });
        req.on('end', function () {
            try {
                const parsed = JSON.parse(cbody);
                fs.writeFileSync(GRADE_CONFIG_FILE, JSON.stringify(parsed, null, 2), { mode: 0o600 });
                GRADE_CFG = null; // перечитать при следующем расчёте
                reply(200, { ok: true });
            } catch (e) { reply(400, { error: 'bad json: ' + e.message }); }
        });
        return;
    }

    // --- Грейд: ручной расчёт одного лида ---
    if (u.pathname === '/grade') {
        if (!CFG.token || u.searchParams.get('token') !== CFG.token) return reply(403, { error: 'bad token' });
        const gid = String(u.searchParams.get('leadId') || '').match(/(\d+)\s*$/);
        if (!gid) return reply(400, { error: 'leadId required' });
        const dry = u.searchParams.get('dry') === '1';
        (async function () {
            try {
                const lead = await b24('crm.lead.get', { id: gid[1] });
                const res = await gradeLead(lead, dry);
                res.detail = computeGrade(lead).detail;
                console.log('[opora-grade] manual', JSON.stringify(res));
                reply(200, res);
            } catch (e) { reply(500, { error: e.message }); }
        })();
        return;
    }

    // --- Грейд: скан изменённых лидов за N дней (dry-run по умолчанию) ---
    if (u.pathname === '/grade-scan') {
        if (!CFG.token || u.searchParams.get('token') !== CFG.token) return reply(403, { error: 'bad token' });
        const days = Math.min(parseInt(u.searchParams.get('days') || '7', 10) || 7, 90);
        const apply = u.searchParams.get('apply') === '1';
        (async function () {
            try {
                const since = new Date(Date.now() - days * 86400000).toISOString();
                const leads = await b24List('crm.lead.list', {
                    order: { DATE_MODIFY: 'DESC' },
                    filter: { '>DATE_MODIFY': since },
                    select: gradeSelectFields()
                }, 6);
                const out = [];
                for (const lead of leads) {
                    try {
                        const r = await gradeLead(lead, !apply);
                        if (r.grade !== 'skip') out.push(r);
                    } catch (e) { out.push({ leadId: lead.ID, error: e.message }); }
                }
                reply(200, { since: since, scanned: leads.length, graded: out.length, apply: apply, results: out });
            } catch (e) { reply(500, { error: e.message }); }
        })();
        return;
    }

    // Форма настройки (одноразовая, по токену)
    if (u.pathname === '/setup') {
        if (!CFG.token || u.searchParams.get('token') !== CFG.token) return reply(403, { error: 'bad token' });
        if (req.method === 'GET') return setupForm(res);
        let sbody = '';
        req.on('data', function (ch) { sbody += ch; if (sbody.length > 1e6) req.destroy(); });
        req.on('end', function () { setupSave(sbody, res); });
        return;
    }

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
                // Формат события ONCRMLEADADD: data[FIELDS][ID]=123
                const m = body.match(/data%5BFIELDS%5D%5BID%5D=(\d+)/) || body.match(/data\[FIELDS\]\[ID\]=(\d+)/)
                    // Формат робота «Веб-хук»: document_id[2]=LEAD_123 (возможно URL-encoded)
                    || body.match(/document_id(?:%5B|\[)2(?:%5D|\])=[A-Za-z_]*?(\d+)/i);
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

// ------------------------------------------------------------
// Автопроверка опросом (не зависит от роботов Bitrix24)
// ------------------------------------------------------------

let polling = false;

/** Один проход опроса: берём лиды с ID больше watermark и проверяем. */
async function pollOnce() {
    if (polling) return;      // не наслаиваем проходы
    polling = true;
    try {
        // При первом запуске (lastId=0) не проверяем всю базу — берём
        // текущий максимальный ID лида и стартуем с него.
        if (!STATE.lastId) {
            const top = await b24('crm.lead.list', { order: { ID: 'DESC' }, select: ['ID'], start: 0 });
            STATE.lastId = (top && top[0]) ? Number(top[0].ID) : 0;
            saveState();
            console.log('[opora-check] опрос стартовал с lastId=' + STATE.lastId);
            return;
        }

        // Новые лиды (ID больше последнего обработанного), по возрастанию
        const fresh = await b24('crm.lead.list', {
            order: { ID: 'ASC' },
            filter: { '>ID': STATE.lastId },
            select: ['ID', 'STATUS_ID', 'TITLE']
        });
        for (const l of (fresh || [])) {
            const id = String(l.ID);
            // Экономия лимитов: пропускаем лиды, которые менеджеры уже
            // разобрали (дубль, успех, встреча и т.п.) и входящие звонки —
            // клиент позвонил сам, проверка на спам не нужна.
            const status = String(l.STATUS_ID || '');
            const title = String(l.TITLE || '').toLowerCase();
            const skipByStatus = CFG.skipStatuses.indexOf(status) !== -1;
            const skipByTitle = CFG.skipTitle && title.indexOf(CFG.skipTitle) !== -1;
            if (skipByStatus || skipByTitle) {
                console.log('[opora-check] poll skip lead ' + id +
                    (skipByStatus ? ' (стадия ' + status + ')' : ' (входящий звонок)'));
            } else {
                try {
                    const r = await processLead(id);
                    console.log('[opora-check] poll', JSON.stringify(r));
                } catch (e) {
                    console.error('[opora-check] poll lead ' + id + ':', e.message);
                }
            }
            STATE.lastId = Math.max(STATE.lastId, Number(id));
            saveState();
        }
    } catch (e) {
        console.error('[opora-check] poll:', e.message);
    } finally {
        polling = false;
    }
}

server.listen(CFG.port, function () {
    console.log('[opora-check] listening on :' + CFG.port +
        ' | autoClose=' + (CFG.autoClose ? 'ON' : 'OFF (наблюдательный режим)') +
        ' | poll=' + (CFG.pollSeconds ? CFG.pollSeconds + 's' : 'OFF'));
    if (!CFG.b24 || !CFG.token || !CFG.spravUrl || !CFG.spravKey) {
        console.warn('[opora-check] ВНИМАНИЕ: заполните .env (B24_WEBHOOK_URL, ENDPOINT_TOKEN, SPRAV_URL, SPRAV_KEY)');
    }
    if (CFG.pollSeconds > 0 && CFG.b24) {
        setInterval(pollOnce, CFG.pollSeconds * 1000);
        pollOnce();   // первый проход сразу — инициализирует watermark
    }
    if (CFG.gradeSeconds > 0 && CFG.b24) {
        console.log('[opora-grade] грейд включён, опрос раз в ' + CFG.gradeSeconds + ' с');
        setInterval(gradePollOnce, CFG.gradeSeconds * 1000);
        gradePollOnce();   // первый проход — инициализирует watermark
    }
});
