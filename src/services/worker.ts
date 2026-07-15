import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import { db, unwrap } from "../lib/db.js";
import { youGile } from "../modules/yougile/client.js";

async function telegramId(profileId: string) {
  const identity = unwrap(await db().from("account_identities").select("provider_subject").eq("profile_id", profileId).eq("provider", "telegram").maybeSingle());
  return identity?.provider_subject;
}

async function sendTelegram(bot: "participant" | "organizer", chatId: string, payload: any) {
  const token = bot === "participant" ? env.TELEGRAM_PARTICIPANT_BOT_TOKEN : env.TELEGRAM_ORG_BOT_TOKEN;
  if (!token) throw new Error(`${bot} bot token is not configured`);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: payload.text ?? payload.message ?? "Новое уведомление Megabattle", parse_mode: payload.parseMode ?? "HTML", reply_markup: payload.replyMarkup }),
  });
  const body = await response.json() as { ok?: boolean; description?: string }; if (!response.ok || !body.ok) throw new Error(`Telegram: ${JSON.stringify(body)}`);
}

async function processNotifications(limit = 25) {
  const rows = unwrap(await db().from("notification_queue").select("*").eq("status", "pending").lte("scheduled_at", new Date().toISOString()).order("scheduled_at").limit(limit)) ?? [];
  for (const row of rows) {
    unwrap(await db().from("notification_queue").update({ status: "processing", attempts: row.attempts + 1 }).eq("id", row.id).eq("status", "pending"));
    try {
      if (!row.profile_id) throw new Error("Notification profile is missing");
      const chatId = await telegramId(row.profile_id); if (!chatId) throw new Error("Telegram identity is not linked");
      await sendTelegram(row.bot, chatId, row.payload);
      unwrap(await db().from("notification_queue").update({ status: "sent", sent_at: new Date().toISOString(), last_error: null }).eq("id", row.id));
    } catch (error) {
      const attempts = row.attempts + 1;
      unwrap(await db().from("notification_queue").update({ status: attempts >= 5 ? "failed" : "pending", scheduled_at: new Date(Date.now() + attempts * 60_000).toISOString(), last_error: error instanceof Error ? error.message : String(error) }).eq("id", row.id));
    }
  }
  return rows.length;
}

async function processYouGileJob(job: any) {
  if (job.operation === "task.delete") return youGile.deleteTask(job.payload.yougileTaskId);
  if (job.operation === "comment.create") {
    const comment = unwrap(await db().from("organizer_task_comments").select("*,organizer_tasks(yougile_task_id),profiles:author_profile_id(nickname,full_name)").eq("id", job.entity_id).single());
    const task = Array.isArray(comment.organizer_tasks) ? comment.organizer_tasks[0] : comment.organizer_tasks;
    if (!task?.yougile_task_id) throw new Error("Task is not synchronized with YouGile yet");
    const author = Array.isArray(comment.profiles) ? comment.profiles[0] : comment.profiles;
    return youGile.addComment(task.yougile_task_id, `${author?.full_name ?? author?.nickname ?? "Организатор"} через MegaBot:\n${comment.body}`);
  }
  const task = unwrap(await db().from("organizer_tasks").select("*,organizer_task_assignees(profile_id)").eq("id", job.entity_id).single());
  const input = { title: task.title, columnId: task.yougile_column_id ?? env.YOUGILE_DEFAULT_COLUMN_ID, description: task.description ?? undefined, deadline: task.deadline_at ? { deadline: Date.parse(task.deadline_at) } : undefined };
  if (!input.columnId) throw new Error("YOUGILE_DEFAULT_COLUMN_ID is not configured");
  if (job.operation === "task.create") {
    const created = await youGile.createTask(input);
    unwrap(await db().from("organizer_tasks").update({ yougile_task_id: created.id, sync_status: "synced", last_synced_at: new Date().toISOString() }).eq("id", task.id));
    return created;
  }
  if (!task.yougile_task_id) throw new Error("Task has no YouGile ID");
  const result = await youGile.updateTask(task.yougile_task_id, input);
  unwrap(await db().from("organizer_tasks").update({ sync_status: "synced", last_synced_at: new Date().toISOString() }).eq("id", task.id));
  return result;
}

async function itmoEventsRequest(path: string, init?: RequestInit) {
  if (!env.ITMO_EVENTS_BASE_URL || !env.ITMO_EVENTS_API_KEY) throw new Error("ITMO Events API is not configured");
  const response = await fetch(`${env.ITMO_EVENTS_BASE_URL.replace(/\/$/, "")}${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ITMO_EVENTS_API_KEY}`, ...init?.headers } });
  const body = await response.json().catch(() => null); if (!response.ok) throw new Error(`ITMO Events: ${response.status} ${JSON.stringify(body)}`); return body as any;
}

async function processItmoEventsJob(job: any) {
  if (job.operation === "registration.cancel") return itmoEventsRequest(`/registrations/${encodeURIComponent(job.payload.externalId)}`, { method: "DELETE" });
  const registration = unwrap(await db().from("event_registrations").select("id,profile_id,project_events(itmo_events_id),profiles(isu_number,full_name)").eq("id", job.entity_id).single());
  if (!registration) throw new Error("Registration not found");
  const event = Array.isArray(registration.project_events) ? registration.project_events[0] : registration.project_events as any;
  const profile = Array.isArray(registration.profiles) ? registration.profiles[0] : registration.profiles as any;
  if (!event?.itmo_events_id || !profile?.isu_number) throw new Error("ITMO Events link or ISU is missing");
  const external = await itmoEventsRequest(`/events/${encodeURIComponent(event.itmo_events_id)}/registrations`, { method: "POST", body: JSON.stringify({ isu: profile.isu_number, name: profile.full_name }) });
  unwrap(await db().from("event_registrations").update({ itmo_events_registration_id: String(external.id), updated_at: new Date().toISOString() }).eq("id", registration.id));
  return external;
}

async function processIntegrations(limit = 10) {
  const jobs = unwrap(await db().from("integration_jobs").select("*").eq("status", "pending").lte("run_after", new Date().toISOString()).order("created_at").limit(limit)) ?? [];
  for (const job of jobs) {
    unwrap(await db().from("integration_jobs").update({ status: "processing", attempts: job.attempts + 1, updated_at: new Date().toISOString() }).eq("id", job.id).eq("status", "pending"));
    try {
      if (job.integration === "yougile") await processYouGileJob(job);
      else if (job.integration === "itmo_events") await processItmoEventsJob(job);
      else throw new Error(`${job.integration} worker is not configured`);
      unwrap(await db().from("integration_jobs").update({ status: "done", last_error: null, updated_at: new Date().toISOString() }).eq("id", job.id));
    } catch (error) {
      const attempts = job.attempts + 1;
      unwrap(await db().from("integration_jobs").update({ status: attempts >= 8 ? "failed" : "pending", run_after: new Date(Date.now() + Math.min(3600, 2 ** attempts * 30) * 1000).toISOString(), last_error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).eq("id", job.id));
      if (job.entity_type === "organizer_task") unwrap(await db().from("organizer_tasks").update({ sync_status: "error" }).eq("id", job.entity_id));
    }
  }
  return jobs.length;
}

async function scheduleReminders() {
  const now = Date.now(); const horizon = new Date(now + 48 * 3600_000).toISOString();
  const meetings = unwrap(await db().from("organizer_meetings").select("id,title,starts_at,organizer_meeting_attendees(profile_id)").eq("status", "scheduled").gt("starts_at", new Date(now).toISOString()).lte("starts_at", horizon)) ?? [];
  const notificationRows: any[] = [];
  for (const meeting of meetings) for (const offset of [2880, 1440, 180]) {
    const scheduled = new Date(Date.parse(meeting.starts_at) - offset * 60_000); if (scheduled.getTime() < now - 5 * 60_000) continue;
    for (const attendee of meeting.organizer_meeting_attendees ?? []) notificationRows.push({ profile_id: attendee.profile_id, bot: "organizer", type: "meeting.reminder", payload: { text: `⏰ <b>${meeting.title}</b>\nНачало: ${new Date(meeting.starts_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`, meetingId: meeting.id }, scheduled_at: scheduled.toISOString(), idempotency_key: `meeting:${meeting.id}:${offset}:${attendee.profile_id}` });
  }
  const tasks = unwrap(await db().from("organizer_tasks").select("id,title,deadline_at,organizer_task_assignees(profile_id),organizer_task_reminders(offset_minutes)").not("deadline_at", "is", null).in("status", ["not_started", "in_progress"]).lte("deadline_at", horizon)) ?? [];
  for (const task of tasks) for (const reminder of task.organizer_task_reminders ?? []) {
    const scheduled = new Date(Date.parse(task.deadline_at) - reminder.offset_minutes * 60_000); if (scheduled.getTime() < now - 5 * 60_000) continue;
    for (const assignee of task.organizer_task_assignees ?? []) notificationRows.push({ profile_id: assignee.profile_id, bot: "organizer", type: "task.reminder", payload: { text: `📌 <b>${task.title}</b>\nДедлайн: ${new Date(task.deadline_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`, taskId: task.id }, scheduled_at: scheduled.toISOString(), idempotency_key: `task:${task.id}:${reminder.offset_minutes}:${assignee.profile_id}` });
  }
  if (notificationRows.length) await db().from("notification_queue").upsert(notificationRows, { onConflict: "idempotency_key", ignoreDuplicates: true });
  return notificationRows.length;
}

async function scheduleBirthdaysAndEvents() {
  const now = new Date(); const date = now.toISOString().slice(0, 10); const rows: any[] = [];
  const [people, organizers, registrations] = await Promise.all([
    db().from("profiles").select("id,full_name,nickname,birth_date").not("birth_date", "is", null).eq("is_banned", false),
    db().from("organizer_memberships").select("profile_id").eq("is_active", true),
    db().from("event_registrations").select("profile_id,event_id,project_events(name,starts_at)").in("status", ["registered", "waitlist"]).gt("project_events.starts_at", now.toISOString()).lt("project_events.starts_at", new Date(now.getTime() + 25 * 3600_000).toISOString()),
  ]);
  for (const result of [people, organizers, registrations]) if (result.error) throw result.error;
  const birthdays = (people.data ?? []).filter((person) => person.birth_date?.slice(5) === date.slice(5));
  for (const birthday of birthdays) for (const organizer of organizers.data ?? []) rows.push({ profile_id: organizer.profile_id, bot: "organizer", type: "birthday", payload: { text: `🎂 Сегодня день рождения: <b>${birthday.full_name ?? birthday.nickname}</b>` }, idempotency_key: `birthday:${date}:${birthday.id}:${organizer.profile_id}` });
  for (const registration of registrations.data ?? []) {
    const event = Array.isArray(registration.project_events) ? registration.project_events[0] : registration.project_events as any; if (!event?.starts_at) continue;
    rows.push({ profile_id: registration.profile_id, bot: "participant", type: "event.reminder", payload: { text: `⏰ Уже скоро <b>${event.name}</b>\n${new Date(event.starts_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`, eventId: registration.event_id }, idempotency_key: `event:${registration.event_id}:24h:${registration.profile_id}` });
  }
  if (rows.length) await db().from("notification_queue").upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true });
  return rows.length;
}

async function cleanupTemporaryMedia() {
  const expired = unwrap(await db().from("temporary_media").select("id,bucket,object_path").is("deleted_at", null).lte("expires_at", new Date().toISOString()).limit(100)) ?? [];
  for (const file of expired) {
    const result = await db().storage.from(file.bucket).remove([file.object_path]);
    if (!result.error) unwrap(await db().from("temporary_media").update({ deleted_at: new Date().toISOString() }).eq("id", file.id));
  }
  return expired.length;
}

let running = false;
export async function runWorkerOnce(logger?: FastifyBaseLogger) {
  if (running) return { skipped: true }; running = true;
  try {
    const scheduled = await scheduleReminders();
    const scheduledGeneral = await scheduleBirthdaysAndEvents();
    const notifications = await processNotifications();
    const integrations = await processIntegrations();
    const cleanedMedia = await cleanupTemporaryMedia();
    await db().rpc("trim_audit_logs", { p_keep: 50 });
    return { scheduled, scheduledGeneral, notifications, integrations, cleanedMedia };
  } catch (error) { logger?.error(error); throw error; } finally { running = false; }
}

export function startWorker(logger: FastifyBaseLogger) {
  if (!env.WORKER_ENABLED) return () => undefined;
  const timer = setInterval(() => void runWorkerOnce(logger).catch(() => undefined), env.WORKER_INTERVAL_SECONDS * 1000);
  timer.unref(); void runWorkerOnce(logger).catch(() => undefined); return () => clearInterval(timer);
}
