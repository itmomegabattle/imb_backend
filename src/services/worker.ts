import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import { db, unwrap } from "../lib/db.js";

async function telegramId(profileId: string) {
  const identity = unwrap(await db()
    .from("account_identities")
    .select("provider_subject")
    .eq("profile_id", profileId)
    .eq("provider", "telegram")
    .maybeSingle());
  return identity?.provider_subject;
}

async function sendTelegram(chatId: string, payload: Record<string, unknown>) {
  const token = env.TELEGRAM_PARTICIPANT_BOT_TOKEN;
  if (!token) throw new Error("Participant bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: payload.text ?? payload.message ?? "Новое уведомление Megabattle",
      parse_mode: payload.parseMode ?? "HTML",
      reply_markup: payload.replyMarkup,
    }),
  });
  const body = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !body.ok) throw new Error(`Telegram: ${JSON.stringify(body)}`);
}

async function processNotifications(limit = 25) {
  const rows = unwrap(await db()
    .from("notification_queue")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at")
    .limit(limit)) ?? [];

  for (const row of rows) {
    unwrap(await db().from("notification_queue")
      .update({ status: "processing", attempts: row.attempts + 1 })
      .eq("id", row.id)
      .eq("status", "pending"));
    try {
      if (!row.profile_id) throw new Error("Notification profile is missing");
      const chatId = await telegramId(row.profile_id);
      if (!chatId) throw new Error("Telegram identity is not linked");
      await sendTelegram(chatId, row.payload);
      unwrap(await db().from("notification_queue")
        .update({ status: "sent", sent_at: new Date().toISOString(), last_error: null })
        .eq("id", row.id));
    } catch (error) {
      const attempts = row.attempts + 1;
      unwrap(await db().from("notification_queue")
        .update({
          status: attempts >= 5 ? "failed" : "pending",
          scheduled_at: new Date(Date.now() + attempts * 60_000).toISOString(),
          last_error: error instanceof Error ? error.message : String(error),
        })
        .eq("id", row.id));
    }
  }
  return rows.length;
}

async function itmoEventsRequest(path: string, init?: RequestInit) {
  if (!env.ITMO_EVENTS_BASE_URL || !env.ITMO_EVENTS_API_KEY) throw new Error("ITMO Events API is not configured");
  const response = await fetch(`${env.ITMO_EVENTS_BASE_URL.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.ITMO_EVENTS_API_KEY}`,
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`ITMO Events: ${response.status} ${JSON.stringify(body)}`);
  return body as any;
}

async function processItmoEventsJob(job: any) {
  if (job.operation === "registration.cancel") {
    return itmoEventsRequest(`/registrations/${encodeURIComponent(job.payload.externalId)}`, { method: "DELETE" });
  }
  const registration = unwrap(await db()
    .from("event_registrations")
    .select("id,profile_id,project_events(itmo_events_id),profiles(isu_number,full_name)")
    .eq("id", job.entity_id)
    .single());
  if (!registration) throw new Error("Registration not found");
  const event = Array.isArray(registration.project_events) ? registration.project_events[0] : registration.project_events as any;
  const profile = Array.isArray(registration.profiles) ? registration.profiles[0] : registration.profiles as any;
  if (!event?.itmo_events_id || !profile?.isu_number) throw new Error("ITMO Events link or ISU is missing");
  const external = await itmoEventsRequest(`/events/${encodeURIComponent(event.itmo_events_id)}/registrations`, {
    method: "POST",
    body: JSON.stringify({ isu: profile.isu_number, name: profile.full_name }),
  });
  unwrap(await db().from("event_registrations")
    .update({ itmo_events_registration_id: String(external.id), updated_at: new Date().toISOString() })
    .eq("id", registration.id));
  return external;
}

async function processIntegrations(limit = 10) {
  const jobs = unwrap(await db()
    .from("integration_jobs")
    .select("*")
    .eq("status", "pending")
    .lte("run_after", new Date().toISOString())
    .order("created_at")
    .limit(limit)) ?? [];

  for (const job of jobs) {
    unwrap(await db().from("integration_jobs")
      .update({ status: "processing", attempts: job.attempts + 1, updated_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "pending"));
    try {
      if (job.integration !== "itmo_events") throw new Error(`${job.integration} worker is not configured`);
      await processItmoEventsJob(job);
      unwrap(await db().from("integration_jobs")
        .update({ status: "done", last_error: null, updated_at: new Date().toISOString() })
        .eq("id", job.id));
    } catch (error) {
      const attempts = job.attempts + 1;
      unwrap(await db().from("integration_jobs")
        .update({
          status: attempts >= 8 ? "failed" : "pending",
          run_after: new Date(Date.now() + Math.min(3600, 2 ** attempts * 30) * 1000).toISOString(),
          last_error: error instanceof Error ? error.message : String(error),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id));
    }
  }
  return jobs.length;
}

async function scheduleEventReminders() {
  const now = new Date();
  const registrations = unwrap(await db()
    .from("event_registrations")
    .select("profile_id,event_id,project_events(name,starts_at)")
    .in("status", ["registered", "waitlist"])
    .gt("project_events.starts_at", now.toISOString())
    .lt("project_events.starts_at", new Date(now.getTime() + 25 * 3600_000).toISOString())) ?? [];
  const rows: any[] = [];
  for (const registration of registrations) {
    const event = Array.isArray(registration.project_events) ? registration.project_events[0] : registration.project_events as any;
    if (!event?.starts_at) continue;
    rows.push({
      profile_id: registration.profile_id,
      bot: "participant",
      type: "event.reminder",
      payload: {
        text: `⏰ Уже скоро <b>${event.name}</b>\n${new Date(event.starts_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`,
        eventId: registration.event_id,
      },
      idempotency_key: `event:${registration.event_id}:24h:${registration.profile_id}`,
    });
  }
  if (rows.length) await db().from("notification_queue").upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true });
  return rows.length;
}

async function cleanupTemporaryMedia() {
  const expired = unwrap(await db()
    .from("temporary_media")
    .select("id,bucket,object_path")
    .is("deleted_at", null)
    .lte("expires_at", new Date().toISOString())
    .limit(100)) ?? [];
  for (const file of expired) {
    const result = await db().storage.from(file.bucket).remove([file.object_path]);
    if (!result.error) unwrap(await db().from("temporary_media").update({ deleted_at: new Date().toISOString() }).eq("id", file.id));
  }
  return expired.length;
}

let running = false;
export async function runWorkerOnce(logger?: FastifyBaseLogger) {
  if (running) return { skipped: true };
  running = true;
  try {
    const scheduled = await scheduleEventReminders();
    const notifications = await processNotifications();
    const integrations = await processIntegrations();
    const cleanedMedia = await cleanupTemporaryMedia();
    await db().rpc("trim_audit_logs", { p_keep: 50 });
    return { scheduled, notifications, integrations, cleanedMedia };
  } catch (error) {
    logger?.error(error);
    throw error;
  } finally {
    running = false;
  }
}

export function startWorker(logger: FastifyBaseLogger) {
  if (!env.WORKER_ENABLED) return () => undefined;
  const timer = setInterval(() => void runWorkerOnce(logger).catch(() => undefined), env.WORKER_INTERVAL_SECONDS * 1000);
  timer.unref();
  void runWorkerOnce(logger).catch(() => undefined);
  return () => clearInterval(timer);
}
