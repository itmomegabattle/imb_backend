# Архитектура экосистемы

```text
Сайт / Mini App участников / Mini App организаторов
                         │
                         ▼
              ITMO Megabattle Backend
              ├─ авторизация и роли
              ├─ профили и контент
              ├─ NFC и граф знакомств
              ├─ геймификация и события
              ├─ собрания и task tracker
              ├─ уведомления и worker
              └─ аудит и защищённый vault
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
       Supabase/Postgres YouGile  ITMO Events
       + Storage + Auth           + ITMO.ID
```

## Идентичность

`profiles.id` — внутренний неизменяемый ID человека. Таблица `account_identities` привязывает к нему Telegram ID, ITMO.ID subject и временный Supabase Auth user. Один человек может входить любым привязанным способом и всегда попадёт в тот же профиль.

Telegram сейчас является основным входом. После выдачи credentials ITMO.ID подключается без миграции профилей. Для мероприятий с `requires_itmo_id=true` backend возвращает `428 ITMO_ID_REQUIRED`, пока пользователь не привяжет ITMO.ID.

## Роли

- `participant` — участник;
- `organizer` — организатор;
- `admin` — администратор экосистемы;
- `site_admin` — административный доступ к сайту.

Организаторский ранг хранится отдельно: `head_org`, `mega_org`, `mega_responsible`. Это позволяет не смешивать технические права API с внутренней структурой команды.

## Задачи и YouGile

`organizer_tasks` — локальная рабочая копия. Изменение через Mini App создаёт `integration_jobs`; worker синхронизирует его с YouGile и повторяет запрос при временной ошибке. Изменение в YouGile приходит webhook либо импортируется `/sync`. Внешние YouGile user ID связываются с профилями через `integration_user_mappings`.

Ключ YouGile находится только на backend. Аккаунт YouGile всем 25 организаторам не нужен.

## Фоновые процессы

Worker:

- создаёт уведомления о задачах и собраниях;
- отправляет Telegram-сообщения;
- выполняет integration jobs;
- удаляет временные фото;
- обрезает аудит до 50 записей.

На VPS используется `WORKER_ENABLED=true`. На serverless вызывается `POST /internal/cron` внешним cron с `CRON_SECRET` каждые 1–5 минут.

## Безопасность

- Service Role, bot tokens, YouGile key, ITMO credentials и vault key находятся только в environment backend;
- Telegram Mini App `initData` проверяется HMAC;
- OIDC использует signed state, nonce, discovery и проверку ID Token через JWKS;
- callback ITMO.ID возвращает одноразовый пятиминутный code, а не токен в URL;
- роль и бан перепроверяются в БД на каждом защищённом запросе;
- балансы изменяются только транзакциями, reward code погашается атомарной SQL-функцией;
- пароли шифруются AES-256-GCM, PIN используется как второй барьер доступа;
- временные фото лежат в private bucket и отдаются по короткой signed URL.
