/**
 * callbacks.ts — Block 2A & 2B Telegram callback_query handler
 *
 * Requirements:
 * - callback_query webhook handling
 * - callback authorization & owner verification
 * - callback task verification
 * - callback status verification
 * - callback audit logging
 * - callback D1.batch() mutations
 */

import { materializeRecurringOccurrences } from "./recurrenceEngine";

export interface CallbackResult {
  success: boolean;
  action: string;
  taskId?: string;
  message: string;
}

export async function handleCallbackQuery(
  callbackQuery: any,
  env: Env,
  updateId: number
): Promise<CallbackResult> {
  const fromId = callbackQuery?.from?.id;
  const ownerId = env.TELEGRAM_OWNER_ID;

  // 1. Owner authorization check
  if (ownerId && fromId !== undefined && String(fromId) !== String(ownerId)) {
    return {
      success: false,
      action: "unauthorized",
      message: "Unauthorized callback query sender.",
    };
  }

  const data = typeof callbackQuery?.data === "string" ? callbackQuery.data.trim() : "";
  const [action, idFragment] = data.split(":");

  if (!action || !idFragment) {
    return {
      success: false,
      action: "invalid_data",
      message: "Invalid callback data format.",
    };
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // 2. Task lookup & verification
  const task = await env.DB.prepare(
    `SELECT id, title, status, priority, deadline_kind, deadline_local_date, deadline_time_local, snooze_count, recurrence_rule_id
     FROM tasks
     WHERE id = ? OR substr(id, 1, 8) = ?`
  )
    .bind(idFragment, idFragment)
    .first<{
      id: string;
      title: string;
      status: string;
      priority: string;
      deadline_kind: string;
      deadline_local_date: string | null;
      deadline_time_local: string | null;
      snooze_count: number;
      recurrence_rule_id: string | null;
    }>();

  if (!task) {
    return {
      success: false,
      action,
      message: `Task not found: ${idFragment}`,
    };
  }

  const auditId = crypto.randomUUID();

  // 3. Handle actions
  if (action === "done") {
    // Idempotent status verification
    if (task.status === "done") {
      return {
        success: true,
        action: "done",
        taskId: task.id,
        message: `Task already done: "${task.title}"`,
      };
    }

    const taskStmt = env.DB.prepare(
      `UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`
    ).bind(nowIso, nowIso, task.id);

    const auditStmt = env.DB.prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, 'task', ?, 'task_done_via_callback', 'owner:telegram', ?, ?)`
    ).bind(auditId, task.id, JSON.stringify({ previous_status: task.status }), nowIso);

    // Suppress pending notifications for this completed task
    const notifStmt = env.DB.prepare(
      `UPDATE notification_log
       SET status = 'suppressed', error_code = 'task_completed_via_callback', updated_at = ?
       WHERE task_id = ? AND status IN ('pending', 'claimed')`
    ).bind(nowIso, task.id);

    const ledgerStmt = env.DB.prepare(
      `UPDATE telegram_updates
       SET status = 'processed', processed_at = ?, outcome = 'callback_done'
       WHERE update_id = ?`
    ).bind(nowIso, updateId);

    await env.DB.batch([taskStmt, auditStmt, notifStmt, ledgerStmt]);

    if (task.recurrence_rule_id) {
      await materializeRecurringOccurrences(env.DB, now).catch(() => {});
    }

    return {
      success: true,
      action: "done",
      taskId: task.id,
      message: `✅ Done: "${task.title}"`,
    };
  }

  if (action === "snooze") {
    if (task.status === "done" || task.status === "dismissed") {
      return {
        success: false,
        action: "snooze",
        taskId: task.id,
        message: `Cannot snooze task with status '${task.status}'.`,
      };
    }

    // Default inline button snooze: +1 hour
    const snoozedUntil = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const newSnoozeCount = task.snooze_count + 1;

    const taskStmt = env.DB.prepare(
      `UPDATE tasks
       SET status = 'snoozed', snoozed_until = ?, snooze_count = ?, updated_at = ?
       WHERE id = ?`
    ).bind(snoozedUntil, newSnoozeCount, nowIso, task.id);

    const auditStmt = env.DB.prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, 'task', ?, 'task_snoozed_via_callback', 'owner:telegram', ?, ?)`
    ).bind(
      auditId,
      task.id,
      JSON.stringify({ snoozed_until: snoozedUntil, snooze_count: newSnoozeCount }),
      nowIso
    );

    const ledgerStmt = env.DB.prepare(
      `UPDATE telegram_updates
       SET status = 'processed', processed_at = ?, outcome = 'callback_snooze'
       WHERE update_id = ?`
    ).bind(nowIso, updateId);

    await env.DB.batch([taskStmt, auditStmt, ledgerStmt]);

    return {
      success: true,
      action: "snooze",
      taskId: task.id,
      message: `💤 Snoozed: "${task.title}" for 1 hour`,
    };
  }

  if (action === "details") {
    const timeStr = task.deadline_time_local ? ` at ${task.deadline_time_local}` : "";
    const dateStr = task.deadline_local_date ? ` (${task.deadline_local_date}${timeStr})` : "none";
    const detailsMsg = `ℹ️ Task Details:\n• ID: [${task.id.slice(0, 8)}]\n• Title: ${task.title}\n• Status: ${task.status}\n• Priority: ${task.priority}\n• Deadline: ${dateStr}\n• Snooze Count: ${task.snooze_count}`;

    const auditStmt = env.DB.prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, 'task', ?, 'task_details_viewed_via_callback', 'owner:telegram', ?, ?)`
    ).bind(auditId, task.id, JSON.stringify({}), nowIso);

    const ledgerStmt = env.DB.prepare(
      `UPDATE telegram_updates
       SET status = 'processed', processed_at = ?, outcome = 'callback_details'
       WHERE update_id = ?`
    ).bind(nowIso, updateId);

    await env.DB.batch([auditStmt, ledgerStmt]);

    return {
      success: true,
      action: "details",
      taskId: task.id,
      message: detailsMsg,
    };
  }

  return {
    success: false,
    action,
    message: `Unknown callback action: ${action}`,
  };
}
