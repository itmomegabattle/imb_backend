import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, unwrap } from "../../lib/db.js";
import { requireRole } from "../../lib/session.js";

const orgOnly = requireRole("organizer", "admin", "site_admin");
const iso = z.string().datetime({ offset: true });

const availabilitySchema = z.object({ startsAt: iso, endsAt: iso, status: z.enum(["free", "busy", "preferred"]).default("free"), note: z.string().max(300).nullable().optional() });
const meetingSchema = z.object({ title: z.string().min(2).max(200), blockKey: z.string().max(80).nullable().optional(), topic: z.string().max(1000).nullable().optional(), keyQuestions: z.array(z.string().max(500)).max(30).default([]), location: z.string().max(300).nullable().optional(), conferenceUrl: z.string().url().nullable().optional(), startsAt: iso, endsAt: iso, attendeeProfileIds: z.array(z.string().uuid()).max(100).default([]), status: z.enum(["draft", "scheduled", "completed", "cancelled"]).default("scheduled") });
const taskSchema = z.object({ title: z.string().min(2).max(500), description: z.string().max(20_000).nullable().optional(), status: z.enum(["not_started", "in_progress", "done", "cancelled"]).default("not_started"), priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"), deadlineAt: iso.nullable().optional(), parentTaskId: z.string().uuid().nullable().optional(), assigneeProfileIds: z.array(z.string().uuid()).max(30).default([]), reminderOffsets: z.array(z.number().int().positive().max(525_600)).max(10).default([2880, 1440, 180]), syncYouGile: z.boolean().default(true) });

export async function organizerRoutes(app: FastifyInstance) {
  app.get("/api/v1/organizer/members", { preHandler: orgOnly }, async () => ({
    members: unwrap(await db().from("organizer_memberships").select("*,profiles(id,nickname,full_name,avatar_url,telegram_username,birth_date)").eq("is_active", true).order("rank")) ?? [],
  }));

  app.patch("/api/v1/organizer/members/:profileId", { preHandler: requireRole("admin", "site_admin") }, async (request) => {
    const profileId = (request.params as { profileId: string }).profileId;
    const body = z.object({ rank: z.enum(["head_org", "mega_org", "mega_responsible"]), blockKey: z.string().max(80).nullable().optional(), positionTitle: z.string().max(120).nullable().optional(), isActive: z.boolean().default(true) }).parse(request.body);
    const membership = unwrap(await db().from("organizer_memberships").upsert({ profile_id: profileId, rank: body.rank, block_key: body.blockKey, position_title: body.positionTitle, is_active: body.isActive, granted_by: request.principal!.profileId, updated_at: new Date().toISOString() }, { onConflict: "profile_id" }).select("*").single());
    unwrap(await db().from("profile_roles").upsert({ profile_id: profileId, role: "organizer", granted_by: request.principal!.profileId }, { onConflict: "profile_id,role" }));
    await audit(request.principal!.profileId, "organizer.membership_updated", "profile", profileId, body); return membership;
  });

  app.get("/api/v1/organizer/dashboard", { preHandler: orgOnly }, async (request) => {
    const profileId = request.principal!.profileId;
    const now = new Date().toISOString();
    const [membership, meetings, tasks, birthdays] = await Promise.all([
      db().from("organizer_memberships").select("*").eq("profile_id", profileId).maybeSingle(),
      db().from("organizer_meeting_attendees").select("response,organizer_meetings(*)").eq("profile_id", profileId).gte("organizer_meetings.starts_at", now).limit(10),
      db().from("organizer_task_assignees").select("organizer_tasks(*,organizer_task_assignees(profile_id,profiles(nickname,avatar_url)))").eq("profile_id", profileId).limit(20),
      db().from("profiles").select("id,nickname,full_name,avatar_url,birth_date").not("birth_date", "is", null).eq("is_banned", false),
    ]);
    for (const item of [membership, meetings, tasks, birthdays]) if (item.error) throw item.error;
    const today = new Date();
    const upcomingBirthdays = (birthdays.data ?? []).map((person) => {
      const birth = new Date(`${person.birth_date}T00:00:00Z`); let next = new Date(Date.UTC(today.getUTCFullYear(), birth.getUTCMonth(), birth.getUTCDate()));
      if (next.getTime() < today.getTime() - 86_400_000) next = new Date(Date.UTC(today.getUTCFullYear() + 1, birth.getUTCMonth(), birth.getUTCDate()));
      return { ...person, nextDate: next.toISOString().slice(0, 10), daysUntil: Math.ceil((next.getTime() - today.getTime()) / 86_400_000) };
    }).filter((person) => person.daysUntil <= 30).sort((a, b) => a.daysUntil - b.daysUntil);
    return { membership: membership.data, meetings: meetings.data ?? [], tasks: tasks.data ?? [], birthdays: upcomingBirthdays };
  });

  app.get("/api/v1/organizer/availability", { preHandler: orgOnly }, async (request) => {
    const q = z.object({ from: iso, to: iso, profileId: z.string().uuid().optional() }).parse(request.query);
    let query = db().from("organizer_availability").select("*,profiles(id,nickname,full_name,avatar_url)").lt("starts_at", q.to).gt("ends_at", q.from).order("starts_at");
    if (q.profileId) query = query.eq("profile_id", q.profileId);
    return { slots: unwrap(await query) };
  });

  app.put("/api/v1/organizer/availability", { preHandler: orgOnly }, async (request, reply) => {
    const parsed = z.array(availabilitySchema).min(1).max(336).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Некорректные интервалы", details: parsed.error.flatten() });
    const rows = parsed.data.map((slot) => ({ profile_id: request.principal!.profileId, starts_at: slot.startsAt, ends_at: slot.endsAt, status: slot.status, note: slot.note, updated_at: new Date().toISOString() }));
    const data = unwrap(await db().from("organizer_availability").upsert(rows, { onConflict: "profile_id,starts_at,ends_at" }).select("*"));
    await audit(request.principal!.profileId, "availability.updated", "organizer_availability", undefined, { count: rows.length });
    return { slots: data };
  });

  app.delete("/api/v1/organizer/availability/:id", { preHandler: orgOnly }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = await db().from("organizer_availability").delete().eq("id", id).eq("profile_id", request.principal!.profileId); if (result.error) throw result.error;
    return reply.code(204).send();
  });

  app.get("/api/v1/organizer/availability/suggestions", { preHandler: orgOnly }, async (request) => {
    const q = z.object({ from: iso, to: iso, durationMinutes: z.coerce.number().int().min(30).max(480).default(60), blockKey: z.string().optional(), limit: z.coerce.number().int().min(1).max(30).default(10) }).parse(request.query);
    let membersQuery = db().from("organizer_memberships").select("profile_id").eq("is_active", true); if (q.blockKey) membersQuery = membersQuery.eq("block_key", q.blockKey);
    const members = (unwrap(await membersQuery) ?? []).map((row) => row.profile_id);
    const slots = members.length ? unwrap(await db().from("organizer_availability").select("profile_id,starts_at,ends_at,status").in("profile_id", members).in("status", ["free", "preferred"]).lt("starts_at", q.to).gt("ends_at", q.from)) ?? [] : [];
    const duration = q.durationMinutes * 60_000; const start = Date.parse(q.from); const end = Date.parse(q.to); const suggestions = [] as any[];
    for (let cursor = start; cursor + duration <= end; cursor += 30 * 60_000) {
      const available = members.filter((member) => slots.some((slot) => slot.profile_id === member && Date.parse(slot.starts_at) <= cursor && Date.parse(slot.ends_at) >= cursor + duration));
      const preferred = available.filter((member) => slots.some((slot) => slot.profile_id === member && slot.status === "preferred" && Date.parse(slot.starts_at) <= cursor && Date.parse(slot.ends_at) >= cursor + duration));
      suggestions.push({ startsAt: new Date(cursor).toISOString(), endsAt: new Date(cursor + duration).toISOString(), availableCount: available.length, totalCount: members.length, preferredCount: preferred.length, availableProfileIds: available, score: available.length * 10 + preferred.length });
    }
    return { suggestions: suggestions.sort((a, b) => b.score - a.score || Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, q.limit) };
  });

  app.get("/api/v1/organizer/meetings", { preHandler: orgOnly }, async (request) => {
    const q = z.object({ from: iso.optional(), to: iso.optional(), status: z.string().optional() }).parse(request.query);
    let query = db().from("organizer_meetings").select("*,organizer_meeting_attendees(response,responded_at,profiles(id,nickname,full_name,avatar_url))").order("starts_at");
    if (q.from) query = query.gte("starts_at", q.from); if (q.to) query = query.lte("starts_at", q.to); if (q.status) query = query.eq("status", q.status);
    return { meetings: unwrap(await query) };
  });

  app.post("/api/v1/organizer/meetings", { preHandler: orgOnly }, async (request, reply) => {
    const parsed = meetingSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "Некорректное собрание", details: parsed.error.flatten() });
    const { attendeeProfileIds, ...body } = parsed.data;
    const meeting = unwrap(await db().from("organizer_meetings").insert({ title: body.title, block_key: body.blockKey, topic: body.topic, key_questions: body.keyQuestions, location: body.location, conference_url: body.conferenceUrl, starts_at: body.startsAt, ends_at: body.endsAt, status: body.status, created_by: request.principal!.profileId }).select("*").single());
    const attendees = [...new Set([...attendeeProfileIds, request.principal!.profileId])];
    if (attendees.length) unwrap(await db().from("organizer_meeting_attendees").insert(attendees.map((profile_id) => ({ meeting_id: meeting.id, profile_id, response: profile_id === request.principal!.profileId ? "accepted" : "pending" }))));
    const recipients = attendees.filter((id) => id !== request.principal!.profileId);
    if (recipients.length) unwrap(await db().from("notification_queue").insert(recipients.map((profile_id) => ({ profile_id, bot: "organizer", type: "meeting.created", payload: { text: `📅 <b>${meeting.title}</b>\n${new Date(meeting.starts_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`, meetingId: meeting.id, title: meeting.title, startsAt: meeting.starts_at }, scheduled_at: new Date().toISOString(), idempotency_key: `meeting:${meeting.id}:created:${profile_id}` }))));
    await audit(request.principal!.profileId, "meeting.created", "meeting", meeting.id);
    return reply.code(201).send(meeting);
  });

  app.patch("/api/v1/organizer/meetings/:id", { preHandler: orgOnly }, async (request) => {
    const id = (request.params as { id: string }).id; const parsed = meetingSchema.partial().parse(request.body); const { attendeeProfileIds, ...body } = parsed;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const mapping: Record<string,string> = { blockKey: "block_key", keyQuestions: "key_questions", conferenceUrl: "conference_url", startsAt: "starts_at", endsAt: "ends_at" };
    for (const [key, value] of Object.entries(body)) patch[mapping[key] ?? key] = value;
    const meeting = unwrap(await db().from("organizer_meetings").update(patch).eq("id", id).select("*").single());
    if (attendeeProfileIds) unwrap(await db().from("organizer_meeting_attendees").upsert(attendeeProfileIds.map((profile_id) => ({ meeting_id: id, profile_id })), { onConflict: "meeting_id,profile_id" }));
    await audit(request.principal!.profileId, "meeting.updated", "meeting", id, { fields: Object.keys(parsed) }); return meeting;
  });

  app.post("/api/v1/organizer/meetings/:id/respond", { preHandler: orgOnly }, async (request) => {
    const id = (request.params as { id: string }).id; const response = z.enum(["accepted", "declined", "maybe", "attended", "missed"]).parse((request.body as any)?.response);
    unwrap(await db().from("organizer_meeting_attendees").upsert({ meeting_id: id, profile_id: request.principal!.profileId, response, responded_at: new Date().toISOString() }, { onConflict: "meeting_id,profile_id" }));
    return { ok: true };
  });

  app.get("/api/v1/organizer/tasks", { preHandler: orgOnly }, async (request) => {
    const q = z.object({ status: z.string().optional(), assignee: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    let query = db().from("organizer_tasks").select("*,organizer_task_assignees(profile_id,profiles(id,nickname,full_name,avatar_url)),organizer_task_comments(id,body,created_at,profiles:author_profile_id(nickname,avatar_url)),organizer_task_reminders(offset_minutes)").order("deadline_at", { nullsFirst: false }).limit(q.limit);
    if (q.status) query = query.eq("status", q.status); if (q.assignee) query = query.eq("organizer_task_assignees.profile_id", q.assignee);
    return { tasks: unwrap(await query) };
  });

  app.post("/api/v1/organizer/tasks", { preHandler: orgOnly }, async (request, reply) => {
    const parsed = taskSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "Некорректная задача", details: parsed.error.flatten() });
    const { assigneeProfileIds, reminderOffsets, syncYouGile, ...body } = parsed.data;
    const task = unwrap(await db().from("organizer_tasks").insert({ title: body.title, description: body.description, status: body.status, priority: body.priority, deadline_at: body.deadlineAt, parent_task_id: body.parentTaskId, created_by: request.principal!.profileId, source: "megabattle", sync_status: syncYouGile ? "pending" : "synced" }).select("*").single());
    if (assigneeProfileIds.length) unwrap(await db().from("organizer_task_assignees").insert(assigneeProfileIds.map((profile_id) => ({ task_id: task.id, profile_id }))));
    if (assigneeProfileIds.length) unwrap(await db().from("notification_queue").insert(assigneeProfileIds.map((profile_id) => ({ profile_id, bot: "organizer", type: "task.assigned", payload: { text: `📌 Новая задача: <b>${task.title}</b>${task.deadline_at ? `\nДедлайн: ${new Date(task.deadline_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}` : ""}`, taskId: task.id }, idempotency_key: `task:${task.id}:assigned:${profile_id}` }))));
    if (reminderOffsets.length) unwrap(await db().from("organizer_task_reminders").insert(reminderOffsets.map((offset_minutes) => ({ task_id: task.id, offset_minutes, created_by: request.principal!.profileId }))));
    if (syncYouGile) unwrap(await db().from("integration_jobs").insert({ integration: "yougile", operation: "task.create", entity_type: "organizer_task", entity_id: task.id }));
    await audit(request.principal!.profileId, "task.created", "task", task.id); return reply.code(201).send(task);
  });

  app.patch("/api/v1/organizer/tasks/:id", { preHandler: orgOnly }, async (request) => {
    const id = (request.params as { id: string }).id; const parsed = taskSchema.partial().parse(request.body); const { assigneeProfileIds, reminderOffsets, syncYouGile, ...body } = parsed;
    const mapping: Record<string,string> = { deadlineAt: "deadline_at", parentTaskId: "parent_task_id" }; const patch: Record<string,unknown> = { updated_at: new Date().toISOString(), sync_status: syncYouGile === false ? "synced" : "pending" };
    for (const [key,value] of Object.entries(body)) patch[mapping[key] ?? key] = value;
    const task = unwrap(await db().from("organizer_tasks").update(patch).eq("id", id).select("*").single());
    if (assigneeProfileIds) {
      unwrap(await db().from("organizer_task_assignees").delete().eq("task_id", id));
      if (assigneeProfileIds.length) {
        unwrap(await db().from("organizer_task_assignees").insert(assigneeProfileIds.map((profile_id) => ({ task_id: id, profile_id }))));
        unwrap(await db().from("notification_queue").upsert(assigneeProfileIds.map((profile_id) => ({ profile_id, bot: "organizer", type: "task.assigned", payload: { text: `📌 Задача назначена: <b>${task.title}</b>`, taskId: id }, idempotency_key: `task:${id}:assigned:${profile_id}` })), { onConflict: "idempotency_key", ignoreDuplicates: true }));
      }
    }
    if (reminderOffsets) { unwrap(await db().from("organizer_task_reminders").delete().eq("task_id", id)); if (reminderOffsets.length) unwrap(await db().from("organizer_task_reminders").insert(reminderOffsets.map((offset_minutes) => ({ task_id: id, offset_minutes, created_by: request.principal!.profileId })))); }
    if (syncYouGile !== false) unwrap(await db().from("integration_jobs").insert({ integration: "yougile", operation: "task.update", entity_type: "organizer_task", entity_id: id }));
    await audit(request.principal!.profileId, "task.updated", "task", id, { fields: Object.keys(parsed) }); return task;
  });

  app.delete("/api/v1/organizer/tasks/:id", { preHandler: orgOnly }, async (request, reply) => {
    const id = (request.params as { id: string }).id; const task = unwrap(await db().from("organizer_tasks").select("yougile_task_id").eq("id", id).single());
    if (task?.yougile_task_id) unwrap(await db().from("integration_jobs").insert({ integration: "yougile", operation: "task.delete", entity_type: "organizer_task", entity_id: id, payload: { yougileTaskId: task.yougile_task_id } }));
    unwrap(await db().from("organizer_tasks").delete().eq("id", id)); await audit(request.principal!.profileId, "task.deleted", "task", id); return reply.code(204).send();
  });

  app.post("/api/v1/organizer/tasks/:id/comments", { preHandler: orgOnly }, async (request, reply) => {
    const taskId = (request.params as { id: string }).id; const body = z.object({ body: z.string().trim().min(1).max(20_000) }).parse(request.body);
    const comment = unwrap(await db().from("organizer_task_comments").insert({ task_id: taskId, author_profile_id: request.principal!.profileId, body: body.body }).select("*").single());
    unwrap(await db().from("integration_jobs").insert({ integration: "yougile", operation: "comment.create", entity_type: "organizer_task_comment", entity_id: comment.id, payload: { taskId } }));
    return reply.code(201).send(comment);
  });
}
