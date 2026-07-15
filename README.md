# ITMO Megabattle Backend

Единый backend для сайта, двух Telegram-ботов, Mini Apps, ITMO.ID, NFC, рейтингов, мероприятий, YouGile и временных фотографий.

## Уже реализовано

- Fastify + TypeScript API.
- Серверный клиент Supabase с `service_role`.
- HMAC-проверка Telegram Mini App `initData`.
- Общий профиль с несколькими identity: Telegram сейчас, ITMO.ID позже.
- Раздельные сервисные токены участнического и организаторского ботов.
- API профиля, игрового dashboard, мероприятий и рейтинга участников.
- Схема БД для XP, уровней, валют, достижений и регистраций.
- YouGile REST-клиент через один технический аккаунт.
- Каркас OIDC для ITMO.ID.

## Модель аккаунта

```text
Профиль Megabattle
├─ Telegram identity
├─ ITMO.ID identity (после выдачи доступа)
└─ Supabase identity (переходный слой сайта)
```

Telegram и ITMO.ID должны привязываться к одному `profiles.id`, а не создавать два профиля. После подключения ITMO.ID он станет обязательным для официальной регистрации и отметки на мероприятиях.

## YouGile

Backend хранит ключ одного технического аккаунта YouGile. Режиссёр и продюсер могут продолжать работать в YouGile, а остальные организаторы — в нашей Mini App. Их реальные Telegram ID, назначения и действия сохраняются в PostgreSQL и журнале интеграции.

Ключ YouGile никогда не отправляется в браузер или Mini App. Ограничение YouGile в 50 запросов в минуту позднее закрывается очередью, webhooks и периодической сверкой.

## Локальный запуск

```bash
cp .env.example .env
npm install
npm run dev
```

Проверка:

```bash
curl http://localhost:4000/health
```

Для существующего Supabase-проекта выполните новые файлы из `supabase/migrations/` по порядку. Для чистого проекта сначала выполните `supabase/schema.sql`.

Сервисные секреты создавайте независимо, например `openssl rand -hex 32`. Значение `PARTICIPANT_BOT_SERVICE_TOKEN` должно совпадать с `SERVICE_TOKEN` в `imbot`.

## Границы API

- `/api/v1/participant/*` — участнический бот, Mini App, события и рейтинг.
- `/api/v1/integrations/yougile/*` — только бот организаторов.
- `/auth/telegram/verify` — проверка Telegram Mini App.
- `/auth/itmo/*` — OIDC ITMO.ID после получения credentials.
- `/health` — состояние подключений.

API может работать на URL VPS или отдельного Vercel-проекта; поддомен `api.megabattle.itmo.ru` для этого не обязателен.

## Безопасность

- `SUPABASE_SERVICE_ROLE_KEY`, `YOUGILE_API_KEY` и токены ботов хранятся только в backend environment.
- Mini App передаёт подписанный Telegram `initData`.
- Боты используют разные сервисные токены, их можно отозвать независимо.
- Новые игровые таблицы не имеют публичных RLS-политик: изменение выполняется через backend.

## Следующие модули

- завершение обмена токенов ITMO.ID и безопасное объединение профилей;
- NFC-метки и граф знакомств;
- ITMO Events API;
- task tracker с двусторонней синхронизацией YouGile и очередью;
- webhook-режим обоих Telegram-ботов;
- временные фотографии с удалением через час;
- уведомления и планировщик.
