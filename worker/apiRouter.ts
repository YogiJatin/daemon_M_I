/**
 * worker/apiRouter.ts — Personal AI OS Services Router
 *
 * Implements OS Services Architecture:
 * - Uniform Response Envelopes & Error Models (never leaks raw SQL)
 * - Safe Bounded Pagination, Filtering, and Sorting
 * - Optimistic Concurrency Control (deadline_version check)
 * - Services: Auth, Tasks, Recurrence, Timetable, Focus / Read Models,
 *   Inbox / Capture, Global Search, Activity Timeline, Settings, Stats, Health,
 *   and Reserved Foundation Endpoints (AI, Devices, Integrations).
 */

import { getISTDateParts, istToUtcDate, parseDateShorthand } from "./dateParser";
import { planNotification } from "./notificationPlanner";
import {
  createRecurrenceRule,
  materializeRecurringOccurrences,
  addDaysYmd,
  parseRecurrenceShorthand,
} from "./recurrenceEngine";
import {
  getActiveSemester,
  activateSemester,
  materializeTimetableOccurrences,
  getSchedulePreview,
  getClassesForDate,
  getNextClass,
  getOngoingClass,
  getPrepDigestData,
  renderPrepDigestMessage,
} from "./timetableEngine";
import {
  verifyAndConsumePairingCode,
  revokeSession,
  createSessionCookie,
  createClearSessionCookie,
  SessionRecord,
} from "./auth";

// ---------------------------------------------------------------------------
// Standard Envelopes & Error Helpers
// ---------------------------------------------------------------------------

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
}

export function jsonSuccess<T>(
  data: T,
  pagination?: PaginationMeta,
  status: number = 200,
  extraHeaders?: Record<string, string>
): Response {
  const body: any = { ok: true, data };
  if (pagination) {
    body.pagination = pagination;
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(extraHeaders || {}),
    },
  });
}

export function jsonError(
  code: string,
  message: string,
  status: number = 400,
  requestId?: string
): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code,
        message,
        request_id: requestId || crypto.randomUUID(),
      },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}

export function parsePagination(url: URL): { page: number; limit: number; offset: number } {
  let page = parseInt(url.searchParams.get("page") || "1", 10);
  if (isNaN(page) || page < 1) page = 1;

  let limit = parseInt(url.searchParams.get("limit") || "20", 10);
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100; // Hard ceiling

  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export function parseSort(
  url: URL,
  allowedFields: string[],
  defaultField: string,
  defaultOrder: "asc" | "desc" = "desc"
): { sortBy: string; order: "ASC" | "DESC" } {
  const rawField = url.searchParams.get("sort_by")?.toLowerCase();
  const sortBy = allowedFields.includes(rawField || "") ? (rawField as string) : defaultField;

  const rawOrder = url.searchParams.get("order")?.toLowerCase();
  const order = rawOrder === "asc" ? "ASC" : rawOrder === "desc" ? "DESC" : defaultOrder.toUpperCase() as "ASC" | "DESC";

  return { sortBy, order };
}

// ---------------------------------------------------------------------------
// Main OS Services Router
// ---------------------------------------------------------------------------

export async function handleApiRequest(
  request: Request,
  env: { DB: D1Database; TELEGRAM_OWNER_ID: string; [key: string]: any },
  session?: SessionRecord,
  now: Date = new Date()
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const nowIso = now.toISOString();

  try {
    // =======================================================================
    // 1. AUTHENTICATION SERVICE
    // =======================================================================

    // POST /api/v1/auth/pair (Public - exchanges 6-digit code for session)
    if (method === "POST" && path === "/api/v1/auth/pair") {
      const body = (await request.json().catch(() => ({}))) as any;
      const code = body.code || "";
      if (!code || typeof code !== "string" || code.trim().length === 0) {
        return jsonError("validation_error", "Missing or invalid pairing code", 400);
      }

      const userAgent = request.headers.get("User-Agent") || undefined;
      const ipAddress = request.headers.get("CF-Connecting-IP") || undefined;
      const result = await verifyAndConsumePairingCode(env.DB, code, userAgent, ipAddress, now);

      if (!result.success || !result.sessionToken) {
        return jsonError(
          result.error === "pairing_code_expired" ? "expired_code" : "unauthorized",
          result.error === "pairing_code_expired" ? "Pairing code has expired. Generate a new one via /pair." : "Invalid or already consumed pairing code.",
          401
        );
      }

      const cookieHeader = createSessionCookie(result.sessionToken);
      return jsonSuccess(
        {
          authenticated: true,
          token: result.sessionToken,
          expires_at: result.expiresAt,
          token_type: "Bearer",
        },
        undefined,
        200,
        { "Set-Cookie": cookieHeader }
      );
    }

    // GET /api/v1/auth/me (Protected - checks active session)
    if (method === "GET" && path === "/api/v1/auth/me") {
      if (!session) return jsonError("unauthorized", "Authentication required", 401);
      return jsonSuccess({
        owner_user_id: session.owner_user_id,
        workspace_id: session.workspace_id,
        expires_at: session.expires_at,
        created_at: session.created_at,
      });
    }

    // POST /api/v1/auth/logout (Protected - revokes active session)
    if (method === "POST" && path === "/api/v1/auth/logout") {
      let token: string | null = null;
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
        token = authHeader.substring(7).trim();
      }
      if (!token) {
        const cookieHeader = request.headers.get("Cookie");
        if (cookieHeader) {
          const match = cookieHeader.match(/(?:^|;\s*)session_token=([^;]+)/);
          if (match) token = match[1].trim();
        }
      }
      if (token) {
        await revokeSession(env.DB, token, now);
      }
      return jsonSuccess({ logged_out: true }, undefined, 200, {
        "Set-Cookie": createClearSessionCookie(),
      });
    }

    // =======================================================================
    // 2. FOCUS READ MODEL (Command Center Home Screen)
    // =======================================================================

    // GET /api/v1/focus (Protected)
    if (method === "GET" && path === "/api/v1/focus") {
      const ist = getISTDateParts(now);
      const todayYmd = ist.localDate;
      const nowUtcIso = now.toISOString();

      // Highest priority open tasks
      const urgentTasks = await env.DB.prepare(
        `SELECT * FROM tasks 
         WHERE status = 'open' 
         ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END ASC,
                  deadline_at_utc ASC LIMIT 5`
      ).all();

      // Next class occurrence
      const nextClass = await getNextClass(env.DB, now);
      const ongoingClass = await getOngoingClass(env.DB, now);

      // Next notification in queue
      const nextNotification = await env.DB.prepare(
        `SELECT * FROM notification_log 
         WHERE status = 'scheduled' AND scheduled_at >= ?
         ORDER BY scheduled_at ASC LIMIT 1`
      ).bind(nowUtcIso).first();

      // Countdowns
      let nextClassCountdownMin: number | null = null;
      if (nextClass) {
        const classDateUtc = istToUtcDate(nextClass.occurrence_date, nextClass.start_time);
        nextClassCountdownMin = Math.max(0, Math.round((classDateUtc.getTime() - now.getTime()) / 60000));
      }

      // Read attention budget
      const budget = await env.DB.prepare(
        `SELECT sent_count, reserved_count FROM daily_notification_counters WHERE local_date = ? AND channel = 'telegram'`
      ).bind(todayYmd).first<{ sent_count: number; reserved_count: number }>() || { sent_count: 0, reserved_count: 0 };

      return jsonSuccess({
        current_focus: ongoingClass ? { type: "class", data: ongoingClass } : (urgentTasks.results[0] ? { type: "task", data: urgentTasks.results[0] } : null),
        next_task: urgentTasks.results[0] || null,
        next_class: nextClass || null,
        ongoing_class: ongoingClass || null,
        next_notification: nextNotification || null,
        highest_priority_tasks: urgentTasks.results || [],
        ai_suggestion: null, // Reserved for future AI assistance
        countdowns: {
          minutes_to_next_class: nextClassCountdownMin,
        },
        attention_budget: {
          sent_today: budget.sent_count,
          reserved_today: budget.reserved_count,
          daily_cap: 8,
          remaining: Math.max(0, 8 - budget.sent_count - budget.reserved_count),
        },
        system_status: "healthy",
      });
    }

    // =======================================================================
    // 3. READ MODELS (/today, /tomorrow, /upcoming)
    // =======================================================================

    // GET /api/v1/today
    if (method === "GET" && path === "/api/v1/today") {
      const ist = getISTDateParts(now);
      const todayYmd = ist.localDate;

      const overdueTasks = await env.DB.prepare(
        `SELECT * FROM tasks 
         WHERE status = 'open' AND deadline_local_date IS NOT NULL AND deadline_local_date < ?
         ORDER BY deadline_local_date ASC, priority DESC`
      ).bind(todayYmd).all();

      const todayTasks = await env.DB.prepare(
        `SELECT * FROM tasks 
         WHERE status = 'open' AND deadline_local_date = ?
         ORDER BY CASE WHEN deadline_time_local IS NOT NULL THEN deadline_time_local ELSE '23:59' END ASC`
      ).bind(todayYmd).all();

      const classesToday = await getClassesForDate(env.DB, todayYmd);
      const activeSem = await getActiveSemester(env.DB);

      return jsonSuccess({
        date: todayYmd,
        semester: activeSem?.name || null,
        overdue_tasks: overdueTasks.results || [],
        today_tasks: todayTasks.results || [],
        classes_today: classesToday,
      });
    }

    // GET /api/v1/tomorrow
    if (method === "GET" && path === "/api/v1/tomorrow") {
      const ist = getISTDateParts(now);
      const tomorrowYmd = addDaysYmd(ist.localDate, 1);

      const tomorrowTasks = await env.DB.prepare(
        `SELECT * FROM tasks 
         WHERE status = 'open' AND deadline_local_date = ?
         ORDER BY CASE WHEN deadline_time_local IS NOT NULL THEN deadline_time_local ELSE '23:59' END ASC`
      ).bind(tomorrowYmd).all();

      const classesTomorrow = await getClassesForDate(env.DB, tomorrowYmd);
      const prepDigest = await getPrepDigestData(env.DB, tomorrowYmd);

      return jsonSuccess({
        date: tomorrowYmd,
        tomorrow_tasks: tomorrowTasks.results || [],
        classes_tomorrow: classesTomorrow,
        preparation_digest: prepDigest,
      });
    }

    // GET /api/v1/upcoming
    if (method === "GET" && path === "/api/v1/upcoming") {
      const ist = getISTDateParts(now);
      const startDate = ist.localDate;
      const endDate = addDaysYmd(startDate, 7);

      const upcomingTasks = await env.DB.prepare(
        `SELECT * FROM tasks 
         WHERE status = 'open' AND deadline_local_date >= ? AND deadline_local_date <= ?
         ORDER BY deadline_local_date ASC, deadline_time_local ASC`
      ).bind(startDate, endDate).all();

      const previewClasses = await getSchedulePreview(env.DB, startDate, endDate);

      return jsonSuccess({
        start_date: startDate,
        end_date: endDate,
        tasks: upcomingTasks.results || [],
        schedule_preview: previewClasses,
      });
    }

    // =======================================================================
    // 4. TASKS SERVICE
    // =======================================================================

    // GET /api/v1/tasks (List with pagination, filtering, and sorting)
    if (method === "GET" && path === "/api/v1/tasks") {
      const { page, limit, offset } = parsePagination(url);
      const { sortBy, order } = parseSort(
        url,
        ["created_at", "deadline_at_utc", "deadline_local_date", "priority", "status", "title"],
        "created_at",
        "desc"
      );

      const statusFilter = url.searchParams.get("status");
      const priorityFilter = url.searchParams.get("priority");
      const categoryFilter = url.searchParams.get("category");

      const whereClauses: string[] = ["1=1"];
      const bindParams: any[] = [];

      if (statusFilter) {
        whereClauses.push("status = ?");
        bindParams.push(statusFilter);
      }
      if (priorityFilter) {
        whereClauses.push("priority = ?");
        bindParams.push(priorityFilter);
      }
      if (categoryFilter) {
        whereClauses.push("category = ?");
        bindParams.push(categoryFilter);
      }

      const whereSql = whereClauses.join(" AND ");

      const totalRow = await env.DB.prepare(`SELECT count(*) as count FROM tasks WHERE ${whereSql}`)
        .bind(...bindParams)
        .first<{ count: number }>();
      const total = totalRow?.count || 0;

      const listQuery = `
        SELECT * FROM tasks 
        WHERE ${whereSql}
        ORDER BY ${sortBy} ${order}
        LIMIT ? OFFSET ?
      `;
      const tasks = await env.DB.prepare(listQuery)
        .bind(...bindParams, limit, offset)
        .all();

      return jsonSuccess(tasks.results || [], {
        page,
        limit,
        total,
        has_more: offset + (tasks.results?.length || 0) < total,
      });
    }

    // POST /api/v1/tasks (Create manual task)
    if (method === "POST" && path === "/api/v1/tasks") {
      const body = (await request.json().catch(() => ({}))) as any;
      if (!body.title || typeof body.title !== "string" || body.title.trim().length === 0) {
        return jsonError("validation_error", "Task title is required");
      }

      const taskId = crypto.randomUUID();
      const title = body.title.trim();
      const description = body.description ? String(body.description).trim() : null;
      const category = body.category ? String(body.category).trim() : "general";
      const priority = ["low", "normal", "high", "urgent"].includes(body.priority) ? body.priority : "normal";
      const workspaceId = body.workspace_id ? String(body.workspace_id).trim() : (session?.workspace_id || "default");

      let deadlineKind: "none" | "date_only" | "timed" = "none";
      let deadlineLocalDate: string | null = null;
      let deadlineTimeLocal: string | null = null;
      let deadlineAtUtc: string | null = null;

      if (body.deadline) {
        const parsed = parseDateShorthand(String(body.deadline), now);
        if (parsed.success && parsed.deadline) {
          deadlineKind = parsed.deadline.kind;
          deadlineLocalDate = parsed.deadline.localDate || null;
          deadlineTimeLocal = parsed.deadline.localTime || null;
          deadlineAtUtc = parsed.deadline.utcInstant || null;
        }
      } else if (body.deadline_local_date) {
        deadlineLocalDate = body.deadline_local_date;
        if (body.deadline_time_local) {
          deadlineKind = "timed";
          deadlineTimeLocal = body.deadline_time_local;
          deadlineAtUtc = istToUtcDate(deadlineLocalDate, deadlineTimeLocal).toISOString();
        } else {
          deadlineKind = "date_only";
        }
      }

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO tasks (
             id, title, description, category, status, priority,
             deadline_kind, deadline_local_date, deadline_time_local, deadline_at_utc,
             deadline_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?)`
        ).bind(
          taskId,
          title,
          description,
          category,
          priority,
          deadlineKind,
          deadlineLocalDate,
          deadlineTimeLocal,
          deadlineAtUtc,
          nowIso,
          nowIso
        ),
        env.DB.prepare(
          `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
           VALUES (?, 'task', ?, 'task_created', 'owner:web', ?, ?)`
        ).bind(crypto.randomUUID(), taskId, JSON.stringify({ title, priority, deadline_kind: deadlineKind }), nowIso),
      ]);

      // Plan reminders if timed
      if (deadlineKind === "timed" && deadlineAtUtc) {
        await planNotification({
          db: env.DB,
          taskId,
          deadlineKind,
          deadlineAtUtc,
          deadlineVersion: 1,
          stage: "nominal",
          now,
        });
      }

      const created = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
      return jsonSuccess(created, undefined, 201);
    }

    // Task ID routes
    const taskMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)(\/(complete|snooze|dismiss|reopen|why))?$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      const subAction = taskMatch[3];

      // GET /api/v1/tasks/:id
      if (method === "GET" && !subAction) {
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        if (!task) return jsonError("not_found", "Task not found", 404);
        return jsonSuccess(task);
      }

      // GET /api/v1/tasks/:id/why (Provenance & Audit History)
      if (method === "GET" && subAction === "why") {
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        if (!task) return jsonError("not_found", "Task not found", 404);

        const auditTrail = await env.DB.prepare(
          "SELECT * FROM audit_events WHERE entity_id = ? ORDER BY created_at ASC"
        ).bind(taskId).all();

        const notifications = await env.DB.prepare(
          "SELECT * FROM notification_log WHERE task_id = ? ORDER BY created_at ASC"
        ).bind(taskId).all();

        return jsonSuccess({
          task,
          audit_trail: auditTrail.results || [],
          notifications: notifications.results || [],
        });
      }

      // PATCH /api/v1/tasks/:id (Supports Optimistic Concurrency with deadline_version)
      if (method === "PATCH" && !subAction) {
        const body = (await request.json().catch(() => ({}))) as any;
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<any>();
        if (!task) return jsonError("not_found", "Task not found", 404);

        // Optimistic concurrency check
        if (body.deadline_version !== undefined && body.deadline_version !== null) {
          if (Number(body.deadline_version) !== Number(task.deadline_version)) {
            return jsonError(
              "conflict",
              `Version conflict: record was modified (server version ${task.deadline_version}, client expected ${body.deadline_version})`,
              409
            );
          }
        }

        const newTitle = body.title !== undefined ? String(body.title).trim() : task.title;
        const newPriority = ["low", "normal", "high", "urgent"].includes(body.priority) ? body.priority : task.priority;
        const newCategory = body.category !== undefined ? String(body.category).trim() : task.category;
        const newDescription = body.description !== undefined ? String(body.description).trim() : task.description;

        let newDeadlineKind = task.deadline_kind;
        let newLocalDate = task.deadline_local_date;
        let newTimeLocal = task.deadline_time_local;
        let newUtcInstant = task.deadline_at_utc;
        let deadlineChanged = false;

        if (body.deadline !== undefined) {
          const parsed = parseDateShorthand(String(body.deadline), now);
          if (parsed.success && parsed.deadline) {
            newDeadlineKind = parsed.deadline.kind;
            newLocalDate = parsed.deadline.localDate || null;
            newTimeLocal = parsed.deadline.localTime || null;
            newUtcInstant = parsed.deadline.utcInstant || null;
            deadlineChanged = true;
          }
        }

        const newVersion = deadlineChanged ? task.deadline_version + 1 : task.deadline_version;

        await env.DB.batch([
          env.DB.prepare(
            `UPDATE tasks 
             SET title = ?, description = ?, priority = ?, category = ?,
                 deadline_kind = ?, deadline_local_date = ?, deadline_time_local = ?, deadline_at_utc = ?,
                 deadline_version = ?, updated_at = ?
             WHERE id = ?`
          ).bind(
            newTitle,
            newDescription,
            newPriority,
            newCategory,
            newDeadlineKind,
            newLocalDate,
            newTimeLocal,
            newUtcInstant,
            newVersion,
            nowIso,
            taskId
          ),
          env.DB.prepare(
            `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
             VALUES (?, 'task', ?, 'task_updated', 'owner:web', ?, ?)`
          ).bind(crypto.randomUUID(), taskId, JSON.stringify({ deadlineChanged, version: newVersion }), nowIso),
        ]);

        // Re-plan if deadline changed
        if (deadlineChanged && newDeadlineKind === "timed" && newUtcInstant) {
          await planNotification({
            db: env.DB,
            taskId,
            deadlineKind: newDeadlineKind,
            deadlineAtUtc: newUtcInstant,
            deadlineVersion: newVersion,
            stage: "nominal",
            now,
          });
        }

        const updated = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        return jsonSuccess(updated);
      }

      // DELETE /api/v1/tasks/:id
      if (method === "DELETE" && !subAction) {
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        if (!task) return jsonError("not_found", "Task not found", 404);

        await env.DB.batch([
          env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(taskId),
          env.DB.prepare("UPDATE notification_log SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = 'scheduled'").bind(nowIso, taskId),
          env.DB.prepare(
            `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
             VALUES (?, 'task', ?, 'task_deleted', 'owner:web', '{}', ?)`
          ).bind(crypto.randomUUID(), taskId, nowIso),
        ]);

        return jsonSuccess({ deleted: true, id: taskId });
      }

      // POST /api/v1/tasks/:id/complete
      if (method === "POST" && subAction === "complete") {
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<any>();
        if (!task) return jsonError("not_found", "Task not found", 404);
        if (task.status === "done") {
          return jsonSuccess(task); // Idempotent
        }

        await env.DB.batch([
          env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?").bind(nowIso, nowIso, taskId),
          env.DB.prepare("UPDATE notification_log SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = 'scheduled'").bind(nowIso, taskId),
          env.DB.prepare(
            `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
             VALUES (?, 'task', ?, 'task_completed', 'owner:web', '{}', ?)`
          ).bind(crypto.randomUUID(), taskId, nowIso),
        ]);

        const completed = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        return jsonSuccess(completed);
      }

      // POST /api/v1/tasks/:id/snooze
      if (method === "POST" && subAction === "snooze") {
        const body = (await request.json().catch(() => ({}))) as any;
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<any>();
        if (!task) return jsonError("not_found", "Task not found", 404);

        const preset = String(body.preset || body.snooze_until || "1h").trim();
        let snoozedUntilUtc: string;

        if (preset === "1h") {
          snoozedUntilUtc = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
        } else if (preset === "tonight") {
          const ist = getISTDateParts(now);
          snoozedUntilUtc = istToUtcDate(ist.localDate, "20:30").toISOString();
        } else if (preset === "tomorrow") {
          const ist = getISTDateParts(now);
          snoozedUntilUtc = istToUtcDate(addDaysYmd(ist.localDate, 1), "09:00").toISOString();
        } else {
          const candidate = new Date(preset);
          snoozedUntilUtc = !isNaN(candidate.getTime()) ? candidate.toISOString() : new Date(now.getTime() + 60 * 60 * 1000).toISOString();
        }

        const newSnoozeCount = (task.snooze_count || 0) + 1;

        await env.DB.batch([
          env.DB.prepare("UPDATE tasks SET status = 'snoozed', snoozed_until = ?, snooze_count = ?, updated_at = ? WHERE id = ?").bind(snoozedUntilUtc, newSnoozeCount, nowIso, taskId),
          env.DB.prepare(
            `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
             VALUES (?, 'task', ?, 'task_snoozed', 'owner:web', ?, ?)`
          ).bind(crypto.randomUUID(), taskId, JSON.stringify({ snoozed_until: snoozedUntilUtc, count: newSnoozeCount }), nowIso),
        ]);

        const snoozed = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        return jsonSuccess(snoozed);
      }

      // POST /api/v1/tasks/:id/dismiss
      if (method === "POST" && subAction === "dismiss") {
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        if (!task) return jsonError("not_found", "Task not found", 404);

        await env.DB.batch([
          env.DB.prepare("UPDATE tasks SET status = 'dismissed', updated_at = ? WHERE id = ?").bind(nowIso, taskId),
          env.DB.prepare("UPDATE notification_log SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = 'scheduled'").bind(nowIso, taskId),
          env.DB.prepare(
            `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
             VALUES (?, 'task', ?, 'task_dismissed', 'owner:web', '{}', ?)`
          ).bind(crypto.randomUUID(), taskId, nowIso),
        ]);

        const dismissed = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        return jsonSuccess(dismissed);
      }

      // POST /api/v1/tasks/:id/reopen
      if (method === "POST" && subAction === "reopen") {
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        if (!task) return jsonError("not_found", "Task not found", 404);

        await env.DB.batch([
          env.DB.prepare("UPDATE tasks SET status = 'open', snoozed_until = NULL, completed_at = NULL, updated_at = ? WHERE id = ?").bind(nowIso, taskId),
          env.DB.prepare(
            `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
             VALUES (?, 'task', ?, 'task_reopened', 'owner:web', '{}', ?)`
          ).bind(crypto.randomUUID(), taskId, nowIso),
        ]);

        const reopened = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        return jsonSuccess(reopened);
      }
    }

    // =======================================================================
    // 5. INBOX & CAPTURE SERVICE (Share Target & Ingress Abstraction)
    // =======================================================================

    // POST /api/v1/capture & POST /api/v1/inbox
    if (method === "POST" && (path === "/api/v1/capture" || path === "/api/v1/inbox")) {
      const body = (await request.json().catch(() => ({}))) as any;
      const rawText = String(body.text || body.raw_payload || body.url || "").trim();
      const action = String(body.action || "confirm").toLowerCase(); // "preview" or "confirm"
      const contentType = String(body.content_type || (rawText.startsWith("http") ? "url" : "text"));

      if (!rawText) {
        return jsonError("validation_error", "No text or content payload provided");
      }

      // Parse candidate
      const pipeIndex = rawText.indexOf("|");
      let candidateTitle = rawText;
      let candidateDeadline: any = null;

      if (pipeIndex !== -1) {
        const datePart = rawText.slice(0, pipeIndex).trim();
        const titlePart = rawText.slice(pipeIndex + 1).trim();
        const parsed = parseDateShorthand(datePart, now);
        if (parsed.success && parsed.deadline && titlePart) {
          candidateTitle = titlePart;
          candidateDeadline = parsed.deadline;
        }
      }

      // Preview only: do not persist to database
      if (action === "preview") {
        return jsonSuccess({
          action: "preview",
          content_type: contentType,
          raw_payload: rawText,
          candidate: {
            title: candidateTitle,
            deadline_kind: candidateDeadline?.kind || "none",
            deadline_local_date: candidateDeadline?.localDate || null,
            deadline_time_local: candidateDeadline?.localTime || null,
            deadline_at_utc: candidateDeadline?.utcInstant || null,
          },
          persisted: false,
        });
      }

      // Confirm flow: persist to Inbox and Tasks table
      const inboxId = crypto.randomUUID();
      const taskId = crypto.randomUUID();

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO tasks (
             id, title, category, status, priority,
             deadline_kind, deadline_local_date, deadline_time_local, deadline_at_utc,
             deadline_version, created_at, updated_at
           ) VALUES (?, ?, 'inbox', 'open', 'normal', ?, ?, ?, ?, 1, ?, ?)`
        ).bind(
          taskId,
          candidateTitle,
          candidateDeadline?.kind || "none",
          candidateDeadline?.localDate || null,
          candidateDeadline?.localTime || null,
          candidateDeadline?.utcInstant || null,
          nowIso,
          nowIso
        ),
        env.DB.prepare(
          `INSERT INTO inbox_items (
             id, workspace_id, content_type, raw_payload, parsed_title,
             parsed_deadline_local_date, parsed_deadline_time_local, status, task_id, created_at, updated_at
           ) VALUES (?, 'default', ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`
        ).bind(
          inboxId,
          contentType,
          rawText,
          candidateTitle,
          candidateDeadline?.localDate || null,
          candidateDeadline?.localTime || null,
          taskId,
          nowIso,
          nowIso
        ),
        env.DB.prepare(
          `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
           VALUES (?, 'inbox', ?, 'inbox_item_captured', 'owner:web', ?, ?)`
        ).bind(crypto.randomUUID(), inboxId, JSON.stringify({ title: candidateTitle, content_type: contentType }), nowIso),
      ]);

      if (candidateDeadline?.kind === "timed" && candidateDeadline?.utcInstant) {
        await planNotification({
          db: env.DB,
          taskId,
          deadlineKind: "timed",
          deadlineAtUtc: candidateDeadline.utcInstant,
          deadlineVersion: 1,
          stage: "nominal",
          now,
        });
      }

      const createdTask = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
      return jsonSuccess({
        action: "confirm",
        inbox_id: inboxId,
        task: createdTask,
        persisted: true,
      }, undefined, 201);
    }

    // =======================================================================
    // 6. RECURRENCE RULES SERVICE (Handled by Block 3A Router in index.ts)
    // =======================================================================

    // =======================================================================
    // 7. TIMETABLE SERVICE
    // =======================================================================

    // GET /api/v1/timetable/semesters
    if (method === "GET" && path === "/api/v1/timetable/semesters") {
      const semesters = await env.DB.prepare("SELECT * FROM timetable_semesters ORDER BY start_date DESC").all();
      return jsonSuccess(semesters.results || []);
    }

    // POST /api/v1/timetable/semesters
    if (method === "POST" && path === "/api/v1/timetable/semesters") {
      const body = (await request.json().catch(() => ({}))) as any;
      if (!body.name || !body.start_date || !body.end_date) {
        return jsonError("validation_error", "Missing name, start_date or end_date for semester");
      }
      const semId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO timetable_semesters (id, name, start_date, end_date, is_active, external_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
      ).bind(semId, body.name, body.start_date, body.end_date, body.external_id || null, nowIso, nowIso).run();

      const created = await env.DB.prepare("SELECT * FROM timetable_semesters WHERE id = ?").bind(semId).first();
      return jsonSuccess(created, undefined, 201);
    }

    // POST /api/v1/timetable/semesters/:id/activate
    const semActivateMatch = path.match(/^\/api\/v1\/timetable\/semesters\/([^/]+)\/activate$/);
    if (method === "POST" && semActivateMatch) {
      const semId = semActivateMatch[1];
      const success = await activateSemester(env.DB, semId, now);
      if (!success) return jsonError("not_found", "Semester not found", 404);
      await materializeTimetableOccurrences(env.DB, now, 14);
      return jsonSuccess({ activated: true, semester_id: semId });
    }

    // GET /api/v1/timetable/subjects
    if (method === "GET" && path === "/api/v1/timetable/subjects") {
      const subjects = await env.DB.prepare("SELECT * FROM timetable_subjects ORDER BY name ASC").all();
      return jsonSuccess(subjects.results || []);
    }

    // POST /api/v1/timetable/subjects
    if (method === "POST" && path === "/api/v1/timetable/subjects") {
      const body = (await request.json().catch(() => ({}))) as any;
      if (!body.name || !body.semester_id) {
        return jsonError("validation_error", "Missing subject name or semester_id");
      }
      const subjId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO timetable_subjects (id, semester_id, code, name, faculty, default_room, color, section_name, preparation_minutes, external_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        subjId,
        body.semester_id,
        body.code || null,
        body.name,
        body.faculty || null,
        body.default_room || null,
        body.color || "#3b82f6",
        body.section_name || null,
        body.preparation_minutes || 45,
        body.external_id || null,
        nowIso,
        nowIso
      ).run();

      const created = await env.DB.prepare("SELECT * FROM timetable_subjects WHERE id = ?").bind(subjId).first();
      return jsonSuccess(created, undefined, 201);
    }

    // GET /api/v1/timetable/occurrences
    if (method === "GET" && path === "/api/v1/timetable/occurrences") {
      const dateFilter = url.searchParams.get("date");
      const statusFilter = url.searchParams.get("status");

      let query = `
        SELECT o.*, s.name as subject_name, s.code as subject_code, s.faculty, s.color
        FROM class_occurrences o
        JOIN timetable_subjects s ON o.subject_id = s.id
        WHERE 1=1
      `;
      const binds: any[] = [];
      if (dateFilter) {
        query += " AND o.occurrence_date = ?";
        binds.push(dateFilter);
      }
      if (statusFilter) {
        query += " AND o.status = ?";
        binds.push(statusFilter);
      }
      query += " ORDER BY o.occurrence_date ASC, o.start_time ASC LIMIT 100";

      const rows = await env.DB.prepare(query).bind(...binds).all();
      return jsonSuccess(rows.results || []);
    }

    // PATCH /api/v1/timetable/occurrences/:id
    const occMatch = path.match(/^\/api\/v1\/timetable\/occurrences\/([^/]+)$/);
    if (method === "PATCH" && occMatch) {
      const occId = occMatch[1];
      const body = (await request.json().catch(() => ({}))) as any;
      const status = body.status;
      if (!["planned", "completed", "attended", "cancelled", "missed"].includes(status)) {
        return jsonError("validation_error", "Invalid class occurrence status");
      }
      await env.DB.prepare(
        "UPDATE class_occurrences SET status = ?, updated_at = ? WHERE id = ?"
      ).bind(status, nowIso, occId).run();

      const updated = await env.DB.prepare("SELECT * FROM class_occurrences WHERE id = ?").bind(occId).first();
      return jsonSuccess(updated);
    }

    // =======================================================================
    // 8. NOTIFICATIONS SERVICE
    // =======================================================================

    // GET /api/v1/notifications
    if (method === "GET" && path === "/api/v1/notifications") {
      const { page, limit, offset } = parsePagination(url);
      const statusFilter = url.searchParams.get("status"); // scheduled, delivered, failed, cancelled

      const whereClauses = ["1=1"];
      const binds: any[] = [];

      if (statusFilter) {
        whereClauses.push("status = ?");
        binds.push(statusFilter);
      }

      const countRow = await env.DB.prepare(
        `SELECT count(*) as count FROM notification_log WHERE ${whereClauses.join(" AND ")}`
      ).bind(...binds).first<{ count: number }>();
      const total = countRow?.count || 0;

      const rows = await env.DB.prepare(
        `SELECT * FROM notification_log WHERE ${whereClauses.join(" AND ")} ORDER BY scheduled_at DESC LIMIT ? OFFSET ?`
      ).bind(...binds, limit, offset).all();

      return jsonSuccess(rows.results || [], {
        page,
        limit,
        total,
        has_more: offset + (rows.results?.length || 0) < total,
      });
    }

    // =======================================================================
    // 9. GLOBAL SEARCH SERVICE
    // =======================================================================

    // GET /api/v1/search?q=...
    if (method === "GET" && path === "/api/v1/search") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q || q.length < 2) {
        return jsonSuccess({ tasks: [], subjects: [], recurrence_rules: [] });
      }

      const pattern = `%${q}%`;

      const tasks = await env.DB.prepare(
        `SELECT id, title, category, status, priority, deadline_local_date, 'task' as entity_type 
         FROM tasks WHERE title LIKE ? OR description LIKE ? LIMIT 20`
      ).bind(pattern, pattern).all();

      const subjects = await env.DB.prepare(
        `SELECT id, code, name, faculty, default_room, 'subject' as entity_type 
         FROM timetable_subjects WHERE name LIKE ? OR code LIKE ? OR faculty LIKE ? LIMIT 10`
      ).bind(pattern, pattern, pattern).all();

      const rules = await env.DB.prepare(
        `SELECT id, title, pattern as recurrence_pattern, active, 'recurrence_rule' as entity_type 
         FROM recurrence_rules WHERE title LIKE ? LIMIT 10`
      ).bind(pattern).all();

      return jsonSuccess({
        query: q,
        tasks: tasks.results || [],
        subjects: subjects.results || [],
        recurrence_rules: rules.results || [],
      });
    }

    // =======================================================================
    // 10. ACTIVITY TIMELINE & AUDIT SERVICE
    // =======================================================================

    // GET /api/v1/history
    if (method === "GET" && path === "/api/v1/history") {
      const { page, limit, offset } = parsePagination(url);
      const entityType = url.searchParams.get("entity_type");
      const actor = url.searchParams.get("actor");

      const whereClauses = ["1=1"];
      const binds: any[] = [];

      if (entityType) {
        whereClauses.push("entity_type = ?");
        binds.push(entityType);
      }
      if (actor) {
        whereClauses.push("actor = ?");
        binds.push(actor);
      }

      const totalRow = await env.DB.prepare(
        `SELECT count(*) as count FROM audit_events WHERE ${whereClauses.join(" AND ")}`
      ).bind(...binds).first<{ count: number }>();
      const total = totalRow?.count || 0;

      const events = await env.DB.prepare(
        `SELECT * FROM audit_events WHERE ${whereClauses.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(...binds, limit, offset).all();

      return jsonSuccess(events.results || [], {
        page,
        limit,
        total,
        has_more: offset + (events.results?.length || 0) < total,
      });
    }

    // =======================================================================
    // 11. SETTINGS & SYSTEM STATS SERVICE
    // =======================================================================

    // GET /api/v1/settings
    if (method === "GET" && path === "/api/v1/settings") {
      const rows = await env.DB.prepare("SELECT * FROM settings").all();
      return jsonSuccess(rows.results || []);
    }

    // PUT /api/v1/settings
    if (method === "PUT" && path === "/api/v1/settings") {
      const body = (await request.json().catch(() => ({}))) as Record<string, any>;
      const entries = Object.entries(body);
      for (const [key, val] of entries) {
        const valStr = typeof val === "object" ? JSON.stringify(val) : String(val);
        await env.DB.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).bind(key, valStr, nowIso).run();
      }
      const updated = await env.DB.prepare("SELECT * FROM settings").all();
      return jsonSuccess(updated.results || []);
    }

    // GET /api/v1/stats
    if (method === "GET" && path === "/api/v1/stats") {
      const openCount = (await env.DB.prepare("SELECT count(*) as count FROM tasks WHERE status = 'open'").first<{ count: number }>())?.count || 0;
      const doneCount = (await env.DB.prepare("SELECT count(*) as count FROM tasks WHERE status = 'done'").first<{ count: number }>())?.count || 0;
      const snoozedCount = (await env.DB.prepare("SELECT count(*) as count FROM tasks WHERE status = 'snoozed'").first<{ count: number }>())?.count || 0;
      const totalRules = (await env.DB.prepare("SELECT count(*) as count FROM recurrence_rules WHERE active = 1").first<{ count: number }>())?.count || 0;
      const attendedClasses = (await env.DB.prepare("SELECT count(*) as count FROM class_occurrences WHERE status = 'attended'").first<{ count: number }>())?.count || 0;

      return jsonSuccess({
        tasks: {
          open: openCount,
          completed: doneCount,
          snoozed: snoozedCount,
          total: openCount + doneCount + snoozedCount,
          completion_rate_percent: openCount + doneCount > 0 ? Math.round((doneCount / (openCount + doneCount)) * 100) : 100,
        },
        recurrence: {
          active_rules: totalRules,
        },
        academics: {
          attended_classes: attendedClasses,
        },
      });
    }

    // GET /api/v1/budget/today
    if (method === "GET" && path === "/api/v1/budget/today") {
      const ist = getISTDateParts(now);
      const row = await env.DB.prepare(
        "SELECT * FROM daily_notification_counters WHERE local_date = ? AND channel = 'telegram'"
      ).bind(ist.localDate).first<any>();

      const sent = row?.sent_count || 0;
      const reserved = row?.reserved_count || 0;
      const cap = 8;

      return jsonSuccess({
        date: ist.localDate,
        channel: "telegram",
        sent_count: sent,
        reserved_count: reserved,
        daily_cap: cap,
        remaining_budget: Math.max(0, cap - sent - reserved),
      });
    }

    // GET /api/v1/health (Comprehensive System Health)
    if (method === "GET" && path === "/api/v1/health") {
      const healthRow = await env.DB.prepare("SELECT * FROM system_health WHERE id = 1").first<any>();
      const pausedSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'reminders_paused'").first<{ value: string }>();
      const isPaused = pausedSetting?.value === "true";

      return jsonSuccess({
        overall_status: isPaused ? "paused" : (healthRow?.consecutive_failures > 0 ? "degraded" : "healthy"),
        reminders_paused: isPaused,
        last_scheduler_run: healthRow?.last_scheduler_start || null,
        consecutive_failures: healthRow?.consecutive_failures || 0,
        telegram_configured: !!env.TELEGRAM_OWNER_ID,
        database_ready: true,
        scheduler_monitor: "active",
      });
    }

    // =======================================================================
    // 12. RESERVED FUTURE SERVICES (AI, Devices, Integrations Foundations)
    // =======================================================================

    if (
      path === "/api/v1/assistant" ||
      path === "/api/v1/context" ||
      path === "/api/v1/suggestions" ||
      path === "/api/v1/assistant/action" ||
      path === "/api/v1/devices" ||
      path === "/api/v1/actions" ||
      path === "/api/v1/integrations" ||
      path === "/api/v1/automation"
    ) {
      return jsonSuccess({
        service: path.replace("/api/v1/", ""),
        status: "not_implemented",
        backend_ready: true,
        message: "Endpoint reserved for future system service integration",
      });
    }

    // Fallback: 404 Route Not Found
    return jsonError("not_found", `Route ${method} ${path} not found`, 404);
  } catch (err: any) {
    const errorId = crypto.randomUUID();
    console.error(`[API Error ${errorId}]`, err);
    return jsonError(
      "internal_error",
      "An unexpected server error occurred while processing the request",
      500,
      errorId
    );
  }
}
