# Автопроверка новых лидов «Опоры» — инструкция для техотдела

Сервис проверяет каждый новый лид: спам-вердикт номера (SpravPortal),
при спам-метке — наличие WhatsApp/Telegram/MAX (Green API). Результат
пишется в поле лида и комментарий таймлайна. В наблюдательном режиме
(по умолчанию) стадию НЕ меняет; при `AUTO_CLOSE=1` лид «спам + нет
ни одного мессенджера» автоматически уходит в «Ошибочную заявку».

## Требования

- Node.js 18+ (нужен встроенный fetch). Зависимостей нет, npm install не нужен.
- Исходящий доступ в интернет (bitrix24.ru, spravportal.ru, green-api.com).
- Открытый снаружи HTTPS-порт ИЛИ reverse-proxy (nginx) до локального порта 8399.
  Bitrix24 должен уметь дёргать URL сервиса.

## Установка

1. Скопировать `check-lead.js` на сервер (например, `/opt/opora-check/`).
2. Рядом создать файл `.env` (права 600, владелец — сервисный пользователь):

```
# Порт HTTP-сервера
PORT=8399
# Секрет эндпоинта — придумать длинную случайную строку
ENDPOINT_TOKEN=ПРИДУМАТЬ_СЛУЧАЙНУЮ_СТРОКУ_40_СИМВОЛОВ
# Входящий вебхук Bitrix24 (создаётся на портале: Разработчикам →
# Другое → Входящий вебхук; права: CRM (crm)). Формат:
B24_WEBHOOK_URL=https://stopdolg.bitrix24.ru/rest/XX/xxxxxxxxxxxxxxxx/
# SpravPortal (адрес и ключ выдаёт SpravPortal; тестовые значения — у Антона)
SPRAV_URL=https://b2b-api-stage-05.spravportal.ru
SPRAV_KEY=sp_...
# Green API — три инстанса (значения те же, что в настройках приложения
# «Инструменты Опоры»; хранить только здесь, не в коде)
GREEN_WA_URL=https://7107.api.greenapi.com
GREEN_WA_ID=710722686704
GREEN_WA_TOKEN=...
GREEN_TG_URL=https://4100.api.green-api.com
GREEN_TG_ID=410022686697
GREEN_TG_TOKEN=...
GREEN_MAX_URL=https://3100.api.green-api.com
GREEN_MAX_ID=310022686734
GREEN_MAX_TOKEN=...
# Режим: 0 = наблюдательный (только пометка), 1 = автозакрытие
AUTO_CLOSE=0
# Стадия для автозакрытия (ID статуса лида «Ошибочная заявка»)
SPAM_STATUS_ID=JUNK
# Код пользовательского поля лида для вердикта
UF_FIELD=UF_CRM_OPORA_CHECK
```

3. Запуск как systemd-сервис (`/etc/systemd/system/opora-check.service`):

```
[Unit]
Description=Opora lead check
After=network.target

[Service]
WorkingDirectory=/opt/opora-check
ExecStart=/usr/bin/node /opt/opora-check/check-lead.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

`systemctl daemon-reload && systemctl enable --now opora-check`

4. Проверка: `curl http://localhost:8399/health` → `{"ok":true,...}`.
5. Открыть сервис наружу по HTTPS (nginx proxy_pass на 8399) и сообщить
   Антону итоговый URL вида `https://host/opora-check/check`.

## Что настраивается на стороне Bitrix24 (делает Антон/Claude)

1. Входящий вебхук с правами crm → значение в `.env`.
2. Пользовательское поле лида `UF_CRM_OPORA_CHECK` (строка).
3. Робот на стадии «Новый лид»: «Исходящий вебхук» на
   `https://host/opora-check/check?token=<ENDPOINT_TOKEN>&leadId={{ID}}`.

## Эндпоинты

- `GET /health` — статус и режим.
- `POST|GET /check?token=...&leadId=123` — проверить лид. Понимает также
  форматы исходящего вебхука Bitrix24 (`data[FIELDS][ID]`) и роботов
  (`document_id=CRM_LEAD_123`).

## Экономика запросов

Каскад: SpravPortal — каждый лид (~0,54–0,75 ₽); Green API (3 запроса) —
только если SpravPortal сказал «спам». На бесплатных тарифах Green API
лимиты малы (MAX ~100/мес) — при боевом объёме нужны платные инстансы.

## Безопасность

- `.env` не коммитить, права 600. В репозитории ключей нет.
- Эндпоинт защищён токеном; всё остальное отвечает 403/404.
- Сервис не принимает ничего, кроме ID лида; данные клиента наружу
  не передаются (номер уходит только в SpravPortal/Green API по HTTPS).
