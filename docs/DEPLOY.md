# Запуск и деплой

## 1. Supabase

Создайте проект и примените SQL из `supabase/migrations` по порядку. Service Role берётся в Supabase Dashboard → Project Settings → API и добавляется только на backend.

Нужные Storage buckets создаются миграциями:

- `profile-avatars` — аватарки;
- `content-media` — фото людей, историй, партнёров и событий;
- `temporary-media` — закрытые временные фото.

## 2. Секреты

Сгенерируйте независимо:

```bash
openssl rand -hex 32 # SESSION_SECRET
openssl rand -hex 32 # CRON_SECRET
openssl rand -hex 32 # PARTICIPANT_BOT_SERVICE_TOKEN
openssl rand -hex 32 # ORG_BOT_SERVICE_TOKEN
openssl rand -hex 32 # VAULT_ENCRYPTION_KEY
printf '1234' | shasum -a 256 # VAULT_PIN_HASH, вместо 1234 выбрать свой PIN
```

Не коммитьте `.env`.

## 3. VPS — рекомендуемый production

```bash
docker build -t imb-backend .
docker run -d --restart unless-stopped --env-file .env -p 4000:4000 imb-backend
```

Установите `NODE_ENV=production`, `WORKER_ENABLED=true`. Перед сервисом поставьте Nginx/Caddy с HTTPS. Отдельный поддомен необязателен: допустим любой стабильный HTTPS URL сервера.

## 4. Vercel — быстрый запуск

Репозиторий содержит `api/index.ts` и `vercel.json`. Добавьте environment variables и разверните проект. На Vercel установите `WORKER_ENABLED=false`; внешний cron должен делать:

```bash
curl -X POST https://BACKEND_URL/internal/cron \
  -H "Authorization: Bearer $CRON_SECRET"
```

Vercel подходит для API и пилота. Постоянный worker и предсказуемые webhook/очереди проще эксплуатировать на VPS.

## 5. Telegram

В backend указываются токены обоих ботов. В каждом bot repository указывается свой `SERVICE_TOKEN` и URL backend. Service tokens должны различаться.

Mini App получает Telegram `initData` и отправляет его на `/auth/telegram/session`. Сервер бота при необходимости получает короткий пользовательский backend JWT через `/auth/service/participant-session` или `/auth/service/organizer-session`.

## 6. YouGile

Создайте один технический аккаунт, API key, project ID и default column ID. Webhook направьте на `/api/v1/integrations/yougile/webhook` и добавьте тот же `YOUGILE_WEBHOOK_SECRET`.

## 7. ITMO.ID и ITMO Events

Пока credentials отсутствуют, endpoints ITMO.ID возвращают `501`, остальная система работает через Telegram. После выдачи доступа заполните `ITMO_ID_*`. Для ITMO Events заполните `ITMO_EVENTS_*` согласно выданному API.

## 8. Smoke-check

```bash
npm test
curl https://BACKEND_URL/health
curl https://BACKEND_URL/version
```
