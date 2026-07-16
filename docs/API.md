# API v1

Все JSON endpoints находятся под `/api/v1`, кроме auth, health и webhooks.

## Авторизация

| Метод | URL | Назначение |
|---|---|---|
| POST | `/auth/telegram/login` | Telegram Login Widget сайта → backend JWT/cookie |
| POST | `/auth/telegram/session` | Telegram Mini App → backend JWT/cookie |
| GET | `/auth/itmo/start` | начало OIDC |
| GET | `/auth/itmo/callback` | callback провайдера |
| POST | `/auth/itmo/exchange` | одноразовый code → backend session |
| POST | `/auth/service/participant-session` | участнический бот действует от имени Telegram user |
| GET | `/auth/me` | текущая сессия |
| POST | `/auth/logout` | удалить cookie |

JWT передаётся `Authorization: Bearer TOKEN`. В браузере также поддерживается HttpOnly cookie.

## Профили и администрация

- `GET /profiles/:id-or-nickname` — публичная визитка;
- `GET/PATCH /profile` — собственный профиль;
- `GET /admin/profiles?search=&limit=&offset=` — поиск по имени, нику или ИСУ;
- `PATCH /admin/profiles/:id/moderation` — роль-бейдж, бан/разбан;
- `PUT/DELETE /admin/profiles/:id/roles/:role` — роли;
- `DELETE /admin/profiles/:id` — мягкое удаление.

## Контент сайта

Ресурсы: `people`, `stories`, `partners`, `events`.

- `GET /content/:resource` — опубликованные данные;
- `GET/POST /admin/content/:resource` — список/создание;
- `PATCH/DELETE /admin/content/:resource/:id` — изменение/удаление;
- `POST /stories/submissions` — предложить историю;
- `GET /stories/submissions/mine` — свои заявки;
- `POST /admin/stories/:id/moderate` — одобрить/отклонить.

## NFC и знакомства

- `GET /nfc/:code` — открыть визитку, записать просмотр;
- `GET /nfc` — собственные метки;
- `POST /nfc/:code/claim` — привязать ещё одну метку;
- `DELETE /nfc/:id/claim` — отвязать;
- `POST /connections` — создать знакомство;
- `DELETE /connections/:profileId` — скрыть связь;
- `GET /connections/graph?limit=&focus=` — актуальные nodes/edges;
- `GET/POST /admin/nfc` — поиск и массовая генерация меток.

## Игра и события

- `GET /game/dashboard` — уровень, XP, место, валюты, достижения, регистрации;
- `GET /game/leaderboard` — участники и факультеты;
- `POST /game/transfers` — целочисленный перевод от 10 единиц любому участнику;
- `POST /game/rewards/redeem` — погасить код;
- `POST /admin/game/transactions` — ручное начисление/списание;
- `POST /admin/game/reward-codes` — создать код;
- `POST /events/:eventId/register` — индивидуальная регистрация;
- `POST /events/:eventId/teams` — создать команду и получить код;
- `POST /events/teams/join` — вступить по коду;
- `GET /events/:eventId/team` — состав команды;
- `PATCH /events/teams/:teamId` — капитан: имя, новый код, состав, капитан, завершение регистрации;
- `POST /admin/events/:eventId/attendance` — отметить посещение.

## Управление через бот

- `GET/PUT /info` и `/admin/info/:key` — информационная справка;
- `GET/POST /admin/game/achievements` — справочник ачивок;
- `POST /admin/game/achievements/grant` — выдача ачивки;
- `GET /admin/stats` — статистика сезона;
- `POST/GET /admin/broadcasts` — очередь рассылок;
- `POST /admin/content/events` — выпуск мероприятия.

## Интеграции

- `POST /integrations/itmo-events/events/:eventId/publish`;
- `POST /integrations/itmo-events/events/:eventId/sync`;
- `POST /webhooks/itmo-events`.

## Медиа, аудит и пароли

- `POST /media/upload` — signed upload URL;
- `GET /media/temporary/:id` — пятиминутная signed view URL;
- `GET /admin/audit` — последние 10, поиск в последних 50;
- `POST /admin/vault/unlock`;
- `POST /admin/vault/list`;
- `POST /admin/vault/migrate-legacy` — зашифровать и удалить старые plaintext-записи;
- `POST/PUT/DELETE /admin/vault`.

## Коды ошибок

- `400` — невалидные поля;
- `401` — нет/неверная авторизация;
- `403` — недостаточно прав, бан;
- `404` — объект не найден;
- `409` — конфликт состояния;
- `428 ITMO_ID_REQUIRED` — требуется привязать ITMO.ID;
- `501` — интеграция ещё не настроена;
- `503` — отсутствует обязательный внешний сервис.

API бота организаторов здесь отсутствует намеренно.
