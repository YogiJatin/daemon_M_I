/**
 * callbacks.ts -- Telegram callback_query handler
 *
 * Handles: done, snooze, details, confirm_proposal, reject_proposal,
 *          not_a_task, save_untimed, change_time, shift_yes, shift_no,
 *          prof_set, p_conf, p_rej, reschedule_anchor, pick_time
 *
 * Hard invariants:
 * - Owner check on every callback.
 * - All mutations idempotent.
 * - Remove inline buttons after a tap (via editMessageReplyMarkup).
 * - callback_data <= 64 bytes enforced at construction site.
 * - Double-tap Confirm -> returns "already confirmed", no second task.
 */

import { materializeRecurringOccurrences } from "./recurrenceEngine";
import { confirmProposal, rejectProposal } from "./inboxService";
import { runBulk, type BulkKind } from "./bulkOps";
import { recordRejectionFeedback } from "./captureEngine";
import { setProfileKey } from "./dailyRhythm";
import { applyReminderShifts, findRemindersToShift } from "./dailyRhythm";
import { sendTelegramMessage } from "./telegram";
import { handleSaveMemoryProposalCallback, handleDeleteMemoryCallback, handleReplaceMemoryProposalCallback } from "./memoryService";

export interface CallbackResult {
  success: boolean;
  action: string;
  taskId?: string;
  message: string;
  editMarkup?: boolean;    // true if caller should clear inline keyboard
}

// ---------------------------------------------------------------------------
// Utility: strip inline keyboard from an already-sent message
// ---------------------------------------------------------------------------
async function sendChatMessage(botToken: string, chatId: any, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    // best-effort
  }
}

async function clearKeyboard(botToken: string, chatId: any, messageId: number): Promise<void> {
  try {
    await fetch(
      `https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        }),
      }
    );
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Split callback data carefully: first token is action, rest is ID/payload
// (supports IDs with colons inside them via split limit)
// ---------------------------------------------------------------------------
function splitCallbackData(data: string): { action: string; payload: string } {
  const idx = data.indexOf(":");
  if (idx === -1) return { action: data, payload: "" };
  return { action: data.slice(0, idx), payload: data.slice(idx + 1) };
}

export async function handleCallbackQuery(
  callbackQuery: any,
  env: Env,
  updateId: number
): Promise<CallbackResult> {
  const fromId = callbackQuery?.from?.id;
  const ownerId = env.TELEGRAM_OWNER_ID;
  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  const botToken: string = env.TELEGRAM_BOT_TOKEN;

  // 1. Owner authorization check
  if (ownerId && fromId !== undefined && String(fromId) !== String(ownerId)) {
    return {
      success: false,
      action: "unauthorized",
      message: "Unauthorized callback query sender.",
    };
  }

  // 2. Deduplication check for this updateId
  const dup = await env.DB.prepare(
    "SELECT update_id FROM telegram_updates WHERE update_id = ? AND status = 'processed'"
  ).bind(updateId).first<{ update_id: number }>().catch(() => null);
  if (dup) {
    return { success: true, action: "duplicate", message: "Already processed." };
  }

  const rawData = typeof callbackQuery?.data === "string" ? callbackQuery.data.trim() : "";
  const { action, payload } = splitCallbackData(rawData);

  if (!action) {
    return { success: false, action: "invalid_data", message: "Invalid callback data format." };
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // ---------------------------------------------------------------------------
  // Bulk: bulk:<kind> / bulk:cancel  (owner tapped Confirm on a bulk card)
  // ---------------------------------------------------------------------------
  if (action === "bulk") {
    await clearKeyboard(botToken, chatId, messageId);
    if (payload === "cancel") {
      return { success: true, action, message: "Cancelled. Nothing was changed." };
    }
    const allowed: BulkKind[] = ["complete_tasks", "delete_tasks", "delete_classes", "delete_all"];
    if (!allowed.includes(payload as BulkKind)) {
      return { success: false, action, message: "Unknown bulk action." };
    }
    const bulkResult = await runBulk(env.DB, payload as BulkKind, nowIso);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, bulkResult.message).catch(() => {});
    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});
    return { success: true, action, message: bulkResult.message };
  }

  // ---------------------------------------------------------------------------
  // A. Proposal: confirm_proposal / p_conf / p_confirm
  // ---------------------------------------------------------------------------
  if (action === "confirm_proposal" || action === "p_conf" || action === "p_confirm") {
    const propId = payload;
    const proposal = await env.DB.prepare(
      "SELECT id, title, status FROM task_proposals WHERE id = ?"
    ).bind(propId).first<{ id: string; title: string; status: string }>().catch(() => null);

    if (!proposal) {
      return { success: false, action, message: "Proposal not found." };
    }

    // Idempotent: already confirmed
    if (proposal.status === "confirmed") {
      await clearKeyboard(botToken, chatId, messageId);
      return { success: true, action, message: `Task "${proposal.title}" was already confirmed.` };
    }

    const res = await confirmProposal(env.DB, proposal.id, undefined, now);
    await clearKeyboard(botToken, chatId, messageId);

    // Mark updateId processed
    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});

    return {
      success: res.success,
      action,
      taskId: res.task?.id,
      message: res.success ? `Task added: "${proposal.title}"` : (res.error || "Failed to confirm"),
    };
  }

  // ---------------------------------------------------------------------------
  // B. Proposal: reject_proposal / p_rej / p_reject / Cancel
  // ---------------------------------------------------------------------------
  if (action === "reject_proposal" || action === "p_rej" || action === "p_reject") {
    const propId = payload;
    const proposal = await env.DB.prepare(
      "SELECT id, title, status FROM task_proposals WHERE id = ?"
    ).bind(propId).first<{ id: string; title: string; status: string }>().catch(() => null);

    if (!proposal) {
      return { success: false, action, message: "Proposal not found." };
    }

    if (proposal.status === "rejected") {
      await clearKeyboard(botToken, chatId, messageId);
      return { success: true, action, message: `Proposal "${proposal.title}" was already rejected.` };
    }

    const res = await rejectProposal(env.DB, proposal.id, "Rejected via Telegram", now);
    await clearKeyboard(botToken, chatId, messageId);

    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});

    return {
      success: res.success,
      action,
      message: res.success ? `Cancelled: "${proposal.title}"` : (res.error || "Failed to reject"),
    };
  }

  // ---------------------------------------------------------------------------
  // C. not_a_task: reject implicit capture proposal + record feedback
  // ---------------------------------------------------------------------------
  if (action === "not_a_task") {
    const propId = payload;
    const proposal = await env.DB.prepare(
      "SELECT id, title, status FROM task_proposals WHERE id = ?"
    ).bind(propId).first<{ id: string; title: string; status: string }>().catch(() => null);

    if (!proposal) {
      return { success: false, action, message: "Proposal not found." };
    }

    if (proposal.status === "rejected") {
      await clearKeyboard(botToken, chatId, messageId);
      return { success: true, action, message: "Already marked as not a task." };
    }

    // Reject proposal + record feedback
    await rejectProposal(env.DB, proposal.id, "not_a_task via Telegram", now).catch(() => {});
    await recordRejectionFeedback(env.DB, proposal.title, now).catch(() => {});
    await clearKeyboard(botToken, chatId, messageId);

    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});

    return { success: true, action, message: "Got it, not a task." };
  }

  // ---------------------------------------------------------------------------
  // D. save_untimed: create an untimed proposal from raw text
  // ---------------------------------------------------------------------------
  if (action === "save_untimed") {
    const rawText = decodeURIComponent(payload).slice(0, 500).trim();
    if (!rawText) {
      return { success: false, action, message: "No text to save." };
    }

    const propId = "prop_" + Math.random().toString(36).slice(2, 10).toUpperCase();
    await env.DB.prepare(
      "INSERT INTO task_proposals (id, title, status, advisory_confidence, created_at, updated_at) VALUES (?, ?, 'pending', 0.5, ?, ?)"
    ).bind(propId, rawText, nowIso, nowIso).run().catch(() => {});

    await clearKeyboard(botToken, chatId, messageId);

    // Send new confirm buttons
    await sendTelegramMessage(botToken, chatId,
      `Saved: "${rawText.slice(0, 80)}"`,
      { inline_keyboard: [[
        { text: "Confirm", callback_data: `confirm_proposal:${propId}` },
        { text: "Cancel", callback_data: `reject_proposal:${propId}` },
      ]] }
    ).catch(() => {});

    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});

    return { success: true, action, message: `Saved as untimed: "${rawText.slice(0, 60)}"` };
  }

  // ---------------------------------------------------------------------------
  // E. change_time: prompt user to pick a new time for a pending proposal
  // ---------------------------------------------------------------------------
  if (action === "change_time") {
    const propId = payload;
    const proposal = await env.DB.prepare(
      "SELECT id, title FROM task_proposals WHERE id = ? AND status = 'pending'"
    ).bind(propId).first<{ id: string; title: string }>().catch(() => null);

    if (!proposal) {
      return { success: false, action, message: "Proposal not found or already processed." };
    }

    // Reply with time-change instructions; keep original buttons
    await sendTelegramMessage(botToken, chatId,
      `To change the time for "${proposal.title.slice(0, 60)}", reply: "make it HH:MM" or "change to [time]".`
    ).catch(() => {});

    return { success: true, action, message: "Prompted for new time." };
  }

  // ---------------------------------------------------------------------------
  // F. shift_yes / shift_no: apply or keep anchor-based reminder shifts
  // ---------------------------------------------------------------------------
  if (action === "shift_yes") {
    // payload = dateIst (YYYY-MM-DD)
    const dateIst = payload;
    const shifts = await findRemindersToShift(env.DB, dateIst, now).catch(() => [] as any[]);
    const count = await applyReminderShifts(env.DB, shifts, dateIst).catch(() => 0);
    await clearKeyboard(botToken, chatId, messageId);

    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});

    return { success: true, action, message: `Shifted ${count} reminder(s) to match your updated schedule.` };
  }

  if (action === "shift_no") {
    await clearKeyboard(botToken, chatId, messageId);
    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});

    return { success: true, action, message: "Keeping original reminder times." };
  }

  // ---------------------------------------------------------------------------
  // G. prof_set: save a profile setting and prompt for the next missing one
  // ---------------------------------------------------------------------------
  if (action === "prof_set") {
    // payload = key:value (value may contain colons)
    const colonIdx = payload.indexOf(":");
    if (colonIdx === -1) {
      return { success: false, action, message: "Invalid prof_set payload." };
    }
    const key = payload.slice(0, colonIdx);
    const value = payload.slice(colonIdx + 1);

    const ALLOWED_PROFILE_KEYS = new Set([
      "wake_time", "leave_home_time", "commute_to_college_min",
      "commute_home_min", "buffer_after_class_min", "bedtime",
      "morning_anchor_time", "evening_anchor_time",
    ]);

    if (!ALLOWED_PROFILE_KEYS.has(key)) {
      return { success: false, action, message: `Unknown profile key: ${key}` };
    }

    await setProfileKey(env.DB, key, value).catch(() => {});
    await clearKeyboard(botToken, chatId, messageId);

    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});

    return { success: true, action, message: `Profile updated: ${key} = ${value}` };
  }

  // ---------------------------------------------------------------------------
  // H. reschedule: +30m or +1d on a proposal
  // ---------------------------------------------------------------------------
  if (action === "reschedule") {
    // payload = propId:+30m or propId:+1d
    const parts = payload.split(":");
    const propId = parts[0];
    const delta = parts[1] || "+30m";

    const proposal = await env.DB.prepare(
      "SELECT id, title, proposed_local_date, proposed_local_time FROM task_proposals WHERE id = ? AND status = 'pending'"
    ).bind(propId).first<any>().catch(() => null);

    if (!proposal) {
      return { success: false, action, message: "Proposal not found." };
    }

    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    let baseMs = now.getTime();
    if (delta === "+30m") {
      baseMs += 30 * 60 * 1000;
    } else if (delta === "+1d") {
      baseMs += 24 * 60 * 60 * 1000;
    }

    const newLocal = new Date(baseMs + IST_OFFSET_MS);
    const newDate = newLocal.toISOString().slice(0, 10);
    const newTime = `${String(newLocal.getUTCHours()).padStart(2, "0")}:${String(newLocal.getUTCMinutes()).padStart(2, "0")}`;

    await env.DB.prepare(
      "UPDATE task_proposals SET proposed_local_date = ?, proposed_local_time = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
    ).bind(newDate, newTime, nowIso, propId).run().catch(() => {});

    await clearKeyboard(botToken, chatId, messageId);

    await sendTelegramMessage(botToken, chatId,
      `Rescheduled to ${newDate} ${newTime} IST`,
      { inline_keyboard: [[
        { text: "Confirm", callback_data: `confirm_proposal:${propId}` },
        { text: "Cancel", callback_data: `reject_proposal:${propId}` },
      ]] }
    ).catch(() => {});

    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});

    return { success: true, action, message: `Rescheduled to ${newDate} ${newTime}` };
  }

  // ---------------------------------------------------------------------------
  // I. Legacy proposal shortcuts: p_conf/p_rej with short prefix IDs
  // ---------------------------------------------------------------------------
  // (handled above by confirm_proposal / reject_proposal blocks)

  // ---------------------------------------------------------------------------
  // Memory callbacks: save_memory, reject_memory, delete_memory, cancel_forget
  // ---------------------------------------------------------------------------
  if (action === "replace_memory") {
    const propId = payload;
    const msg = await handleReplaceMemoryProposalCallback(env.DB, propId, now);
    await clearKeyboard(botToken, chatId, messageId);
    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});
    return { success: true, action, message: msg };
  }

  if (action === "save_memory") {
    const propId = payload;
    const msg = await handleSaveMemoryProposalCallback(env.DB, propId, now);
    await clearKeyboard(botToken, chatId, messageId);
    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});
    return { success: true, action, message: msg };
  }

  if (action === "reject_memory") {
    const propId = payload;
    await env.DB.prepare("UPDATE memory_proposals SET status = 'rejected', updated_at = ? WHERE id = ?")
      .bind(nowIso, propId).run().catch(() => {});
    await clearKeyboard(botToken, chatId, messageId);
    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});
    return { success: true, action, message: "Memory proposal cancelled." };
  }

  if (action === "delete_memory") {
    const memId = payload;
    const msg = await handleDeleteMemoryCallback(env.DB, memId);
    await clearKeyboard(botToken, chatId, messageId);
    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});
    return { success: true, action, message: msg };
  }

  if (action === "cancel_forget") {
    await clearKeyboard(botToken, chatId, messageId);
    await env.DB.prepare("UPDATE telegram_updates SET status = 'processed', processed_at = ? WHERE update_id = ?")
      .bind(nowIso, updateId).run().catch(() => {});
    return { success: true, action, message: "Cancelled." };
  }

  // Bulk Operations callbacks
  if (action === "bulk_confirm") {
    const token = payload;
    const op = await env.DB.prepare(
      "SELECT token, action, filter_type, id_snapshot_json, snapshot_hash, expires_at, used FROM bulk_pending_operations WHERE token = ? AND used = 0"
    ).bind(token).first<any>().catch(() => null);

    if (!op) {
      await clearKeyboard(botToken, chatId, messageId);
      return { success: false, action, message: "Bulk operation already confirmed or expired." };
    }
    if (new Date(op.expires_at).getTime() < now.getTime()) {
      await clearKeyboard(botToken, chatId, messageId);
      return { success: false, action, message: "Bulk operation has expired." };
    }

    const ids: string[] = JSON.parse(op.id_snapshot_json || "[]");
    const batchId = "batch_" + Math.random().toString(36).slice(2, 10).toUpperCase();

    if (op.action === "complete_overdue") {
      for (const id of ids) {
        await env.DB.prepare("UPDATE tasks SET status = 'done', completed_via = 'bulk', updated_at = ? WHERE id = ?").bind(nowIso, id).run().catch(() => {});
      }
    } else if (op.action === "stop_reminders") {
      for (const id of ids) {
        await env.DB.prepare("UPDATE notification_log SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(nowIso, id).run().catch(() => {});
      }
    }

    await env.DB.batch([
      env.DB.prepare("INSERT INTO bulk_batches (id, action, affected_ids_json, snapshot_hash, created_at) VALUES (?, ?, ?, ?, ?)").bind(batchId, op.action, op.id_snapshot_json, op.snapshot_hash, nowIso),
      env.DB.prepare("UPDATE bulk_pending_operations SET used = 1 WHERE token = ?").bind(token),
    ]).catch(() => {});

    await clearKeyboard(botToken, chatId, messageId);
    const msg = op.action === "complete_overdue"
      ? `Completed ${ids.length} task(s). Send /undo to revert.`
      : `Stopped ${ids.length} reminder(s). Send /undo to revert.`;
    const { sendTelegramMessage } = await import("./telegram");
    await sendTelegramMessage(botToken, chatId, msg).catch(() => {});
    return { success: true, action, message: msg };
  }

  if (action === "bulk_cancel") {
    const token = payload;
    await env.DB.prepare("UPDATE bulk_pending_operations SET used = 1 WHERE token = ?").bind(token).run().catch(() => {});
    await clearKeyboard(botToken, chatId, messageId);
    const msg = "Bulk action cancelled. Nothing changed.";
    const { sendTelegramMessage } = await import("./telegram");
    await sendTelegramMessage(botToken, chatId, msg).catch(() => {});
    return { success: true, action, message: msg };
  }

  // ---------------------------------------------------------------------------
  // J. Task-level actions: done, snooze, details
  //    These look up by task id/prefix
  // ---------------------------------------------------------------------------
  const task = await env.DB.prepare(
    `SELECT id, title, status, priority, deadline_kind, deadline_local_date, deadline_time_local, snooze_count, recurrence_rule_id
     FROM tasks
     WHERE id = ? OR substr(id, 1, 8) = ?`
  )
    .bind(payload, payload)
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
      message: `Task not found: ${payload}`,
    };
  }

  const auditId = crypto.randomUUID();

  if (action === "done") {
    if (task.status === "done") {
      await clearKeyboard(botToken, chatId, messageId);
      return { success: true, action: "done", taskId: task.id, message: `Task already done: "${task.title}"` };
    }

    const taskStmt = env.DB.prepare(
      "UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?"
    ).bind(nowIso, nowIso, task.id);

    const auditStmt = env.DB.prepare(
      "INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at) VALUES (?, 'task', ?, 'task_done_via_callback', 'owner:telegram', ?, ?)"
    ).bind(auditId, task.id, JSON.stringify({ previous_status: task.status }), nowIso);

    const notifStmt = env.DB.prepare(
      "UPDATE notification_log SET status = 'suppressed', error_code = 'task_completed_via_callback', updated_at = ? WHERE task_id = ? AND status IN ('pending', 'claimed')"
    ).bind(nowIso, task.id);

    const ledgerStmt = env.DB.prepare(
      "UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'callback_done' WHERE update_id = ?"
    ).bind(nowIso, updateId);

    await env.DB.batch([taskStmt, auditStmt, notifStmt, ledgerStmt]);

    if (task.recurrence_rule_id) {
      await materializeRecurringOccurrences(env.DB, now).catch(() => {});
    }

    await clearKeyboard(botToken, chatId, messageId);

    return { success: true, action: "done", taskId: task.id, message: `Done: "${task.title}"` };
  }

  if (action === "snooze") {
    if (task.status === "done" || task.status === "dismissed") {
      return { success: false, action: "snooze", taskId: task.id, message: `Cannot snooze task with status '${task.status}'.` };
    }

    const snoozedUntil = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const newSnoozeCount = task.snooze_count + 1;

    const taskStmt = env.DB.prepare(
      "UPDATE tasks SET status = 'snoozed', snoozed_until = ?, snooze_count = ?, updated_at = ? WHERE id = ?"
    ).bind(snoozedUntil, newSnoozeCount, nowIso, task.id);

    const auditStmt = env.DB.prepare(
      "INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at) VALUES (?, 'task', ?, 'task_snoozed_via_callback', 'owner:telegram', ?, ?)"
    ).bind(auditId, task.id, JSON.stringify({ snoozed_until: snoozedUntil, snooze_count: newSnoozeCount }), nowIso);

    const ledgerStmt = env.DB.prepare(
      "UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'callback_snooze' WHERE update_id = ?"
    ).bind(nowIso, updateId);

    await env.DB.batch([taskStmt, auditStmt, ledgerStmt]);

    return { success: true, action: "snooze", taskId: task.id, message: `Snoozed: "${task.title}" for 1 hour` };
  }

  if (action === "details") {
    const timeStr = task.deadline_time_local ? ` at ${task.deadline_time_local}` : "";
    const dateStr = task.deadline_local_date ? ` (${task.deadline_local_date}${timeStr})` : "none";
    const detailsMsg = `Task Details:\n- ID: [${task.id.slice(0, 8)}]\n- Title: ${task.title}\n- Status: ${task.status}\n- Priority: ${task.priority}\n- Deadline: ${dateStr}\n- Snooze Count: ${task.snooze_count}`;

    const auditStmt = env.DB.prepare(
      "INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at) VALUES (?, 'task', ?, 'task_details_viewed_via_callback', 'owner:telegram', ?, ?)"
    ).bind(auditId, task.id, JSON.stringify({}), nowIso);

    const ledgerStmt = env.DB.prepare(
      "UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'callback_details' WHERE update_id = ?"
    ).bind(nowIso, updateId);

    await env.DB.batch([auditStmt, ledgerStmt]);

    return { success: true, action: "details", taskId: task.id, message: detailsMsg };
  }

  return { success: false, action, message: `Unknown callback action: ${action}` };
}
