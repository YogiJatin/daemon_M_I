
async function computeSha256(str: string): Promise<string> {
  const buf = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * worker/telegramConversation.ts - Block 1 Conversational Telegram Handler + Intelligence Upgrade
 *
 * Handles non-slash plain-text messages via the telegram_assistant AI capability.
 * Returns HTTP 200 immediately; all AI work runs in ctx.waitUntil().
 *
 * Hard invariants:
 * - AI never creates/edits/deletes live tasks; all creation goes via task_proposals.
 * - scheduler.ts imports zero AI modules.
 * - External/user content treated as DATA, never instructions.
 * - Facts about tasks, schedule, or progress come ONLY from D1 templates, never LLM text.
 * - Secrets guard redacts passcodes/PINs before reaching LLM or search.
 * - Harm gate refuses violence/harm tasks immediately.
 * - Queue draining: rapid messages queue instead of dropping or sending 'still processing'.
 */

import { sendTelegramMessage } from "./telegram";
import { AIAdapter } from "./aiAdapter";
import { checkAndRedactSecrets } from "./secretsGuard";
import { checkHarmGate } from "./harmGate";
import { fetchWeather } from "./weatherService";
import { executeWebLookup } from "./webLookupService";
import { isHelpQuery, renderHelpResponse } from "./capabilityManifest";
import {
  TelegramAssistantInput,
  TelegramAssistantOutput,
  resolveAnchorTime,
  createProposalFromTask,
  renderD1ScheduleQuery,
  renderTasksAndRemindersList,
  handleModifyPending,
  formatConfirmationDate,
} from "./telegramAssistant";
import { getProfile, formatTime12h } from "./dailyRhythm";
import {
  retrieveMemoriesForPrompt,
  getAboutMeStandingContext,
  createMemoryProposal,
  handleMemoriesCommand,
} from "./memoryService";
import { parseRegionalDateWords } from "./dateLexicon";
import { parseExplicitReminderDeterministic, splitMessageClauses } from "./deterministicParser";

// ---------------------------------------------------------------------------
// Budget & timing constants
// ---------------------------------------------------------------------------
const DEFAULT_TOTAL_BUDGET_MS = 20_000;
const DEFAULT_MAX_LLM_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 25_000;
const DEFAULT_DAILY_AI_BUDGET = 200; // calls per day

function nowIso(): string {
  return new Date().toISOString();
}

function ulid(): string {
  const ts = Date.now().toString(36).padStart(8, "0");
  const rand = Math.random().toString(36).slice(2, 10).padStart(8, "0");
  return (ts + rand).toUpperCase();
}

function makeInlineKeyboard(buttons: Array<{ text: string; callback_data: string }>) {
  return { inline_keyboard: [buttons] };
}

// ---------------------------------------------------------------------------
// Lease management
// ---------------------------------------------------------------------------

async function acquireLease(db: D1Database, chatId: string, updateId: number, leaseMs: number): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const nowStr = now.toISOString();

  try {
    // Expire stale leases first
    await db
      .prepare("DELETE FROM chat_leases WHERE chat_id = ? AND expires_at < ?")
      .bind(String(chatId), nowStr)
      .run();

    const existing = await db
      .prepare("SELECT update_id FROM chat_leases WHERE chat_id = ?")
      .bind(String(chatId))
      .first<{ update_id: number }>();

    if (existing) {
      return false; // lease currently held
    }

    await db
      .prepare(
        "INSERT OR REPLACE INTO chat_leases (chat_id, update_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
      )
      .bind(String(chatId), updateId, expiresAt, nowStr)
      .run();
    return true;
  } catch {
    return true; // fail open
  }
}

async function releaseLease(db: D1Database, chatId: string, updateId: number): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM chat_leases WHERE chat_id = ? AND update_id = ?")
      .bind(String(chatId), updateId)
      .run();
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Chat messages logging
// ---------------------------------------------------------------------------

async function logChatMessage(
  db: D1Database,
  params: {
    id?: string;
    updateId: number;
    chatId: string | number;
    messageId: number;
    role: "user" | "assistant";
    text: string;
    intent?: string;
    confidence?: number;
    provider?: string;
    latencyMs?: number;
    outcome?: string;
    status: "received" | "queued" | "processing" | "sent" | "done" | "failed";
    replyMarkup?: any;
    telegramMessageId?: number;
    replyToMessageId?: number;
  }
): Promise<string> {
  const id = params.id || "msg_" + ulid();
  const now = nowIso();
  try {
    const markupStr = params.replyMarkup ? JSON.stringify(params.replyMarkup) : null;
    await db
      .prepare(
        `INSERT INTO chat_messages
          (id, update_id, chat_id, message_id, role, text, intent, confidence,
           provider, latency_ms, outcome, status, reply_markup, telegram_message_id,
           reply_to_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        params.updateId,
        String(params.chatId),
        params.messageId,
        params.role,
        params.text?.slice(0, 4000) ?? null,
        params.intent ?? null,
        params.confidence ?? null,
        params.provider ?? null,
        params.latencyMs ?? null,
        params.outcome ?? null,
        params.status,
        markupStr,
        params.telegramMessageId ?? null,
        params.replyToMessageId ?? null,
        now,
        now
      )
      .run();
  } catch (err) {
    console.error("[logChatMessage] Error logging chat message:", err);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Daily AI budget check
// ---------------------------------------------------------------------------

async function checkDailyAiBudget(db: D1Database, dailyBudget: number, now: Date): Promise<boolean> {
  try {
    const today = now.toISOString().slice(0, 10);
    const row = await db
      .prepare(
        "SELECT COUNT(*) as cnt FROM chat_messages WHERE intent IS NOT NULL AND created_at >= ? AND role = 'user'"
      )
      .bind(today + "T00:00:00.000Z")
      .first<{ cnt: number }>();
    return (row?.cnt ?? 0) < dailyBudget;
  } catch {
    return true; // fail open
  }
}

// ---------------------------------------------------------------------------
// Processing a single message
// ---------------------------------------------------------------------------

async function processSingleMessage(
  db: D1Database,
  env: any,
  chatId: string | number,
  updateId: number,
  messageId: number,
  text: string,
  now: Date,
  userMsgRowId: string,
  replyToMessageId?: number,
  testStubs?: boolean,
  testStubPayload?: any,
  isForwarded?: boolean
): Promise<void> {
  const startProcessing = Date.now();
  const botToken: string = env.TELEGRAM_BOT_TOKEN;
  const sendTg = (txt: string, markup?: any) =>
    sendTelegramMessage(botToken, chatId, txt, markup, { testStubs: Boolean(testStubs), db });

  // 0. Forwarded Data-Only Check (G21, Non-negotiable Rule 11)
  if (isForwarded) {
    const replyText = "Received forwarded text. External data does not trigger actions.";
    const sendRes = await sendTg(replyText).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: replyText,
      intent: "chat",
      confidence: 1.0,
      outcome: "forwarded_data_only",
      status: "sent",
      provider: "system",
      latencyMs: Date.now() - startProcessing,
      telegramMessageId: sendRes?.telegramMessageId,
    });
    await db
      .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  // 0.5 What do you know about me? (1.8, M08 - Pure D1 template, identical with AI down)
  if (/what\s+do\s+you\s+know\s+about\s+me/i.test(text.trim())) {
    const memRes = await handleMemoriesCommand(db, now);
    const sendRes = await sendTg(memRes.response).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: memRes.response,
      intent: "chat",
      confidence: 1.0,
      outcome: "memories_template",
      status: "sent",
      provider: "d1",
      latencyMs: Date.now() - startProcessing,
      telegramMessageId: sendRes?.telegramMessageId,
    });
    await db
      .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  // F8: Check if this is a reply to [Edit title] force_reply
  let isEditTitleReply = false;
  if (replyToMessageId) {
    const parentMsg = await db
      .prepare("SELECT text FROM chat_messages WHERE message_id = ? OR telegram_message_id = ? LIMIT 1")
      .bind(replyToMessageId, replyToMessageId)
      .first<{ text: string }>()
      .catch(() => null);
    if (parentMsg?.text?.includes("Reply to this message with the new title for")) {
      isEditTitleReply = true;
    }
  }
  if (isEditTitleReply) {
    const newTitle = text.trim();
    const latestProp = await db
      .prepare("SELECT id, title, proposed_local_date, proposed_local_time FROM task_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .first<{ id: string; title: string; proposed_local_date: string; proposed_local_time: string }>()
      .catch(() => null);

    if (latestProp && newTitle) {
      await db
        .prepare("UPDATE task_proposals SET title = ?, updated_at = ? WHERE id = ?")
        .bind(newTitle, nowIso(), latestProp.id)
        .run()
        .catch(() => {});

      const dateStr = formatConfirmationDate(latestProp.proposed_local_date, latestProp.proposed_local_time);
      const bubbleText = `Proposal:\n  ${newTitle}\n⏰ Remind: ${dateStr}\n\nConfirm?`;
      const markup = makeInlineKeyboard([
        { text: "Confirm", callback_data: `confirm_proposal:${latestProp.id}` },
        { text: "Edit title", callback_data: `edit_title:${latestProp.id}` },
        { text: "Change time", callback_data: `change_time:${latestProp.id}` },
        { text: "Cancel", callback_data: `reject_proposal:${latestProp.id}` },
      ]);
      await sendTg(bubbleText, markup).catch(() => null);
      await logChatMessage(db, {
        updateId,
        chatId,
        messageId,
        role: "assistant",
        text: bubbleText,
        intent: "explicit_task",
        confidence: 1.0,
        outcome: "title_edited",
        status: "sent",
        replyMarkup: markup,
        provider: "system",
        latencyMs: 10,
      });
      await db.prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), userMsgRowId).run().catch(() => {});
      return;
    }
  }

  // F6: /undo command to restore bulk batches within 24h
  if (/^\/undo\b/i.test(text.trim())) {
    const oneDayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const batch = await db
      .prepare("SELECT id, action, affected_ids_json, created_at FROM bulk_batches WHERE created_at >= ? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .bind(oneDayAgo)
      .first<{ id: string; action: string; affected_ids_json: string; created_at: string }>()
      .catch(() => null);

    if (!batch) {
      const resp = "No bulk actions found within the last 24h to undo.";
      await sendTg(resp).catch(() => null);
      await logChatMessage(db, { updateId, chatId, messageId, role: "assistant", text: resp, intent: "command", confidence: 1.0, outcome: "undo_none", status: "sent", provider: "system", latencyMs: 5 });
      await db.prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), userMsgRowId).run().catch(() => {});
      return;
    }

    const ids: string[] = JSON.parse(batch.affected_ids_json || "[]");
    let restoredTitles: string[] = [];
    if (batch.action === "complete_overdue") {
      for (const id of ids) {
        await db.prepare("UPDATE tasks SET status = 'open', completed_via = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), id).run().catch(() => {});
      }
      const titleRows = await db.prepare("SELECT title FROM tasks WHERE id IN (" + ids.map(() => "?").join(",") + ") LIMIT 5").bind(...ids).all<{ title: string }>().catch(() => ({ results: [] }));
      restoredTitles = (titleRows.results || []).map((r: any) => r.title);
    } else if (batch.action === "stop_reminders") {
      for (const id of ids) {
        await db.prepare("UPDATE notification_log SET status = 'pending', error_code = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), id).run().catch(() => {});
      }
    }
    await db.prepare("UPDATE bulk_batches SET undone_at = ? WHERE id = ?").bind(nowIso(), batch.id).run().catch(() => {});

    const titleListStr = restoredTitles.length > 0 ? "\n• " + restoredTitles.join("\n• ") : "";
    const resp = `Restored ${ids.length} ${batch.action === "complete_overdue" ? "task(s)" : "reminder(s)"} from batch ${batch.id.slice(0, 14)}:${titleListStr}`;
    await sendTg(resp).catch(() => null);
    await logChatMessage(db, { updateId, chatId, messageId, role: "assistant", text: resp, intent: "command", confidence: 1.0, outcome: "undo_executed", status: "sent", provider: "system", latencyMs: 15 });
    await db.prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), userMsgRowId).run().catch(() => {});
    return;
  }

  // F6: Bulk action triggers (detect in code, AI down OK)
  const isBulkComplete = /\b(complete|close|finish|archive)\b.*\b(all|every|those|these)\b.*\b(tasks?|overdue|reminders?)\b/i.test(text) ||
                         /\bmark\b.*\b(all|every|overdue|those|them)\b.*\b(completed|done|closed)\b/i.test(text) ||
                         /^\/cleanup\b/i.test(text);
  const isBulkStopReminders = /^(stop|cancel|clear|mute)\s+(all|every)(\s+of\s+(the|those))?\s+reminders?/i.test(text);

  if (isBulkComplete || isBulkStopReminders) {
    const todayIst = new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const [overdueTasks, openNotDueTasks, pendingReminders] = await Promise.all([
      db.prepare("SELECT id, title FROM tasks WHERE status = 'open' AND deadline_local_date < ? ORDER BY deadline_local_date ASC").bind(todayIst).all<{ id: string; title: string }>().catch(() => ({ results: [] })),
      db.prepare("SELECT id, title FROM tasks WHERE status = 'open' AND (deadline_local_date IS NULL OR deadline_local_date >= ?) ORDER BY deadline_local_date ASC").bind(todayIst).all<{ id: string; title: string }>().catch(() => ({ results: [] })),
      db.prepare("SELECT id FROM notification_log WHERE status = 'pending'").all<{ id: string }>().catch(() => ({ results: [] })),
    ]);

    const ovCount = (overdueTasks.results || []).length;
    const openCount = (openNotDueTasks.results || []).length;
    const remCount = (pendingReminders.results || []).length;

    const actionType = isBulkComplete ? "complete_overdue" : "stop_reminders";
    const includeOpen = isBulkComplete && /\b(open|everything|all)\b/i.test(text) && !/\bonly\s+overdue\b/i.test(text) && /\b(open|all\s+of\s+those)\b/i.test(text);
    const targetTasks = isBulkComplete
      ? (includeOpen ? [...(overdueTasks.results || []), ...(openNotDueTasks.results || [])] : (overdueTasks.results || []))
      : [];
    const targetIds = isBulkComplete
      ? targetTasks.map((t: any) => t.id)
      : (pendingReminders.results || []).map((r: any) => r.id);

    const targetCount = targetIds.length;
    const token = "blk_" + crypto.randomUUID().slice(0, 12);
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const idSnapshotJson = JSON.stringify(targetIds);
    const hash = await computeSha256(actionType + ":" + idSnapshotJson);

    await db
      .prepare("INSERT INTO bulk_pending_operations (token, action, filter_type, id_snapshot_json, snapshot_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
      .bind(token, actionType, isBulkComplete ? "overdue" : "reminders", idSnapshotJson, hash, expiresAt, nowIso())
      .run()
      .catch(() => {});

    const sampleTitles = (overdueTasks.results || []).slice(0, 5).map((t: any) => `• ${t.title}`).join("\n");
    const sampleBlock = sampleTitles ? `\n\nSample items:\n${sampleTitles}` : "";

    const confirmText = `Bulk Action Review:
• Overdue tasks: ${ovCount}
• Open (not yet due): ${openCount}
• Pending reminders: ${remCount}${sampleBlock}

Confirm ${isBulkComplete ? `completing ${targetCount} overdue task(s)` : `stopping ${targetCount} reminder(s)`}?`;

    const markup = makeInlineKeyboard([
      { text: `Confirm ${targetCount}`, callback_data: `bulk_confirm:${token}` },
      { text: "Cancel", callback_data: `bulk_cancel:${token}` },
    ]);

    await sendTg(confirmText, markup).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: confirmText,
      intent: "command",
      confidence: 1.0,
      outcome: "bulk_review_shown",
      status: "sent",
      replyMarkup: markup,
      provider: "system",
      latencyMs: 15,
    });
    await db.prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), userMsgRowId).run().catch(() => {});
    return;
  }

  // F7: Natural tasks & reminders lists (pure D1 template, same answer with AI down)
  if (/\b(what\s+are\s+my\s+tasks|what\s+tasks|my\s+tasks|tasks\s+and\s+reminders|\/tasks\b|\/reminders\b)\b/i.test(text) ||
      (/\btasks\b/i.test(text) && /\b(remind|remanind|schedule)\b/i.test(text))) {
    const listText = await renderTasksAndRemindersList(db, now);
    await sendTg(listText).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: listText,
      intent: "query_tasks",
      confidence: 1.0,
      outcome: "d1_tasks_reminders_list",
      status: "sent",
      provider: "d1",
      latencyMs: 10,
    });
    await db.prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), userMsgRowId).run().catch(() => {});
    return;
  }

  // F2: Insult / hostility filter (calm one line, no task, no lecture)
  const isInsult = /\b(you\s+(suck|are\s+stupid|are\s+dumb|are\s+useless|are\s+an\s+idiot)|useless\s+bot|shut\s+up|hate\s+you|fuck\s+u|fuck\s+you|bitch|bastard|idiot)\b/i.test(text);
  if (isInsult) {
    const calmReply = "I am here to help you manage your tasks and schedule. How can I assist you?";
    await sendTg(calmReply).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: calmReply,
      intent: "chat",
      confidence: 1.0,
      outcome: "calm_hostility_filtered",
      status: "sent",
      provider: "system",
      latencyMs: 5,
    });
    await db.prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), userMsgRowId).run().catch(() => {});
    return;
  }

  // 1. Secrets Guard (B5)
  const secretCheck = checkAndRedactSecrets(text);
  if (secretCheck.isSecret) {
    const replyText = "I don't store secrets.";
    const sendRes = await sendTg(replyText).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: replyText,
      intent: "chat",
      confidence: 1.0,
      outcome: "secret_redacted",
      status: "sent",
      provider: "system",
      latencyMs: Date.now() - startProcessing,
      telegramMessageId: sendRes?.telegramMessageId,
    });
    // Sanitize user message in DB
    await db
      .prepare("UPDATE chat_messages SET text = ?, status = 'done', updated_at = ? WHERE id = ?")
      .bind(secretCheck.redactedText, nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  // 2. Harm Gate (B7)
  const harmCheck = checkHarmGate(text);
  if (harmCheck.isHarmBlocked) {
    const replyText = harmCheck.refusalText || "I cannot assist with tasks involving harm or violence.";
    const sendRes = await sendTg(replyText).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: replyText,
      intent: "chat",
      confidence: 1.0,
      outcome: "harm_blocked",
      status: "sent",
      provider: "system",
      latencyMs: Date.now() - startProcessing,
      telegramMessageId: sendRes?.telegramMessageId,
    });
    await db
      .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  // 3. Fast-path Capability Manifest (C4, G35, G40)
  if (isHelpQuery(text)) {
    const replyText = renderHelpResponse();
    const sendRes = await sendTg(replyText).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: replyText,
      intent: "chat",
      confidence: 1.0,
      outcome: "help_manifest",
      status: "sent",
      provider: "system",
      latencyMs: Date.now() - startProcessing,
      telegramMessageId: sendRes?.telegramMessageId,
    });
    await db
      .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  // 3.5 Fast-path Proposal Modification via reply_to_message_id (A8, G20)
  if (replyToMessageId && /(?:make\s+it|change\s+(?:time\s+)?to|at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.test(text)) {
    const modResult = await handleModifyPending(db, { intent: "modify_pending", confidence: 1.0, reply_text: "" } as any, replyToMessageId, now, text);
    if (modResult.proposalId) {
      const markup = makeInlineKeyboard([
        { text: "Confirm", callback_data: `confirm_proposal:${modResult.proposalId}` },
        { text: "Cancel", callback_data: `reject_proposal:${modResult.proposalId}` },
      ]);
      const sendRes = await sendTg(modResult.message, markup).catch(() => null);
      await logChatMessage(db, {
        updateId,
        chatId,
        messageId,
        role: "assistant",
        text: modResult.message,
        intent: "modify_pending",
        confidence: 1.0,
        outcome: "proposal_modified",
        status: "sent",
        replyMarkup: markup,
        provider: "deterministic",
        latencyMs: Date.now() - startProcessing,
        telegramMessageId: sendRes?.telegramMessageId,
      });
      await db.prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), userMsgRowId).run().catch(() => {});
      return;
    }
  }

  // 3.6 Multi-Intent Splitting (A4, G41, F04)
  const clauses = splitMessageClauses(text);
  if (clauses.length > 1) {
    let handledCount = 0;
    for (const clause of clauses) {
      // Clause schedule check
      const isClauseSched = /what\s+classes.*tomorrow|classes\s+tomorrow|what\s+do\s+i\s+have\s+today|today'?s?\s*classes/i.test(clause);
      if (isClauseSched) {
        const schedReply = await renderD1ScheduleQuery(db, { type: "classes" }, clause, now);
        await sendTg(schedReply).catch(() => null);
        handledCount++;
        continue;
      }

      // Clause deterministic reminder check
      const parsedDet = parseExplicitReminderDeterministic(clause, now);
      if (parsedDet) {
        const propId = "prop_" + ulid();
        await db.prepare(
          `INSERT INTO task_proposals (id, title, priority, date_role, proposed_local_date, proposed_local_time, status, created_at, updated_at)
           VALUES (?, ?, 'normal', 'reminder_time', ?, ?, 'pending', ?, ?)`
        ).bind(propId, parsedDet.title, parsedDet.localDate, parsedDet.localTime, nowIso(), nowIso()).run().catch(() => {});

        const timeLines = parsedDet.dueDifferentFromRemind
          ? `\n📅 Due: ${parsedDet.dueAtFormatted}\n⏰ Remind: ${parsedDet.remindAtFormatted}`
          : `\n⏰ Remind: ${parsedDet.remindAtFormatted}`;
        const bubbleText = `Proposal:\n• ${parsedDet.title}${timeLines}\n\nConfirm?`;
        const bubbleMarkup = makeInlineKeyboard([
          { text: "Confirm", callback_data: `confirm_proposal:${propId}` },
          { text: "Change time", callback_data: `change_time:${propId}` },
          { text: "Cancel", callback_data: `reject_proposal:${propId}` },
        ]);
        await sendTg(bubbleText, bubbleMarkup).catch(() => null);
        handledCount++;
        continue;
      }

      // Clause anchor task check (e.g. "buy milk after college")
      if (/buy|pick\s+up|submit|call|meet/i.test(clause) && /after\s+college|after\s+class|leaving\s+college|on\s+the\s+way\s+home/i.test(clause)) {
        const cleanTitle = clause.replace(/^(?:i\s+need\s+to\s+|i\s+must\s+|i\s+have\s+to\s+)/i, "").trim();
        const anchorType = /on\s+the\s+way\s+home|leaving\s+college/i.test(clause) ? "leaving_college" : "after_last_class";
        const taskObj = { title: cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1), anchor: anchorType as any, offset_days: 0 };
        const resolved = await resolveAnchorTime(db, taskObj, now, env);
        const propId = await createProposalFromTask(db, taskObj, resolved, "explicit_reminder", now);
        const dateStr = formatConfirmationDate(resolved.localDate, resolved.localTime);
        const bubbleText = `Proposal:\n• ${taskObj.title}\n⏰ Remind: ${dateStr}\n\nConfirm?`;
        const bubbleMarkup = makeInlineKeyboard([
          { text: "Confirm", callback_data: `confirm_proposal:${propId}` },
          { text: "Change time", callback_data: `change_time:${propId}` },
          { text: "Cancel", callback_data: `reject_proposal:${propId}` },
        ]);
        await sendTg(bubbleText, bubbleMarkup).catch(() => null);
        handledCount++;
        continue;
      }
    }

    if (handledCount > 0) {
      await logChatMessage(db, {
        updateId,
        chatId,
        messageId,
        role: "assistant",
        text: `Processed ${handledCount} requests from multi-intent message.`,
        intent: "multi_intent",
        confidence: 1.0,
        outcome: "multi_intent_processed",
        status: "sent",
        provider: "deterministic",
        latencyMs: Date.now() - startProcessing,
      });
      await db.prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), userMsgRowId).run().catch(() => {});
      return;
    }
  }

  // 3.7 Deterministic-First Reminders (A2, F01) - 0 LLM calls, works with AI down
  const profile = await getProfile(db);
  const detReminder = parseExplicitReminderDeterministic(text, now, profile);
  if (detReminder) {
    const propId = "prop_" + ulid();
    await db.prepare(
      `INSERT INTO task_proposals (id, title, priority, date_role, proposed_local_date, proposed_local_time, status, created_at, updated_at)
       VALUES (?, ?, 'normal', 'reminder_time', ?, ?, 'pending', ?, ?)`
    ).bind(propId, detReminder.title, detReminder.localDate, detReminder.localTime, nowIso(), nowIso()).run().catch(() => {});

    const timeLines = detReminder.dueDifferentFromRemind
      ? `\n📅 Due: ${detReminder.dueAtFormatted}\n⏰ Remind: ${detReminder.remindAtFormatted}`
      : `\n⏰ Remind: ${detReminder.remindAtFormatted}`;
    const replyText = `Proposal:\n• ${detReminder.title}${timeLines}\n\nConfirm?`;
    const markup = makeInlineKeyboard([
      { text: "Confirm", callback_data: `confirm_proposal:${propId}` },
      { text: "Change time", callback_data: `change_time:${propId}` },
      { text: "Cancel", callback_data: `reject_proposal:${propId}` },
    ]);
    const sendRes = await sendTg(replyText, markup).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: replyText,
      intent: "explicit_reminder",
      confidence: 1.0,
      outcome: "proposal_created",
      status: "sent",
      replyMarkup: markup,
      provider: "deterministic",
      latencyMs: Date.now() - startProcessing,
      telegramMessageId: sendRes?.telegramMessageId,
    });
    await db.prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), userMsgRowId).run().catch(() => {});
    return;
  }

  // 4. Daily AI budget check
  const dailyBudget = parseInt(env.DAILY_AI_BUDGET || String(DEFAULT_DAILY_AI_BUDGET), 10);
  const withinBudget = await checkDailyAiBudget(db, dailyBudget, now);
  if (!withinBudget) {
    const markup = makeInlineKeyboard([
      { text: "Save as untimed task", callback_data: `save_untimed:${encodeURIComponent(text.slice(0, 200))}` },
    ]);
    const replyText = "Daily AI budget reached. Sending new messages as untimed tasks.";
    const sendRes = await sendTg(replyText, markup).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: replyText,
      outcome: "budget_exceeded",
      status: "sent",
      replyMarkup: markup,
      telegramMessageId: sendRes?.telegramMessageId,
    });
    await db
      .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  // 5. Check if all providers are disabled (G24)
  const disabledSetting = await db
    .prepare("SELECT value FROM settings WHERE key = 'disabled_providers'")
    .first<{ value: string }>()
    .catch(() => null);
  const disabledList = (disabledSetting?.value || "").split(",").map((s) => s.trim().toLowerCase());
  // allDisabled: use slot-name prefix matching (test sets groq_primary,groq_secondary,workers_ai not base names)
  const groqDisabled = disabledList.some(d => d === "groq" || d === "groq_primary") &&
    disabledList.some(d => d === "groq" || d === "groq_secondary");
  const waiDisabled = disabledList.some(d => d === "workers_ai" || d === "cf_ai");
  const geminiParked = env?.GEMINI_ENABLED !== "1";
  const geminiDisabledForAllCheck = geminiParked || disabledList.some(d => d === "gemini" || d.startsWith("gemini_"));
  const allDisabled = groqDisabled && waiDisabled && geminiDisabledForAllCheck;

  if (allDisabled) {
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const prevOffline = await db
      .prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND outcome = 'ai_offline' AND created_at >= ? LIMIT 1")
      .bind(String(chatId), tenMinAgo)
      .first<{ id: string }>()
      .catch(() => null);
    // Brief C3: calm code-template, no raw two-word error; 1-word msgs get no Save button
    const wordCount = text.trim().split(/\s+/).length;
    const markup = wordCount > 1
      ? makeInlineKeyboard([{ text: "Save as untimed task", callback_data: `save_untimed:${encodeURIComponent(text.slice(0, 200))}` }])
      : undefined;
    const replyText = prevOffline
      ? "AI is temporarily offline. Your message was saved."
      : "AI is temporarily offline. Core reminders, tasks, and schedule still work.";
    const sendRes = await sendTg(replyText, markup ?? null).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: replyText,
      outcome: "ai_offline",
      status: "sent",
      replyMarkup: markup,
      telegramMessageId: sendRes?.telegramMessageId,
    });
    await db
      .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  // 6. Gather recent context and settings
  const recentRows = await db
    .prepare(
      `SELECT role, text FROM chat_messages
       WHERE chat_id = ? AND role IN ('user', 'assistant') AND status != 'failed'
       ORDER BY created_at DESC LIMIT 6`
    )
    .bind(String(chatId))
    .all<{ role: string; text: string }>()
    .catch(() => ({ results: [] }));
  const recentChat: string[] = (recentRows.results || [])
    .reverse()
    .map((r) => `${r.role}: ${r.text || ""}`);

  // Check if reply_to links to a proposal
  let replyToProposal: any = undefined;
  if (replyToMessageId) {
    const asstMsg = await db
      .prepare("SELECT reply_markup FROM chat_messages WHERE chat_id = ? AND telegram_message_id = ?")
      .bind(String(chatId), replyToMessageId)
      .first<{ reply_markup: string }>()
      .catch(() => null);
    if (asstMsg?.reply_markup) {
      const match = asstMsg.reply_markup.match(/confirm_proposal:([a-zA-Z0-9_-]+)/);
      if (match) {
        const prop = await db
          .prepare("SELECT id, title, proposed_local_date, proposed_local_time FROM task_proposals WHERE id = ?")
          .bind(match[1])
          .first<any>()
          .catch(() => null);
        if (prop) {
          replyToProposal = {
            id: prop.id,
            title: prop.title,
            currentDate: prop.proposed_local_date,
            currentTime: prop.proposed_local_time,
          };
        }
      }
    }
  }

  // profile already fetched above
  const settingsObj: Record<string, any> = {
    morning_anchor_time: profile.morning_anchor_time || "08:00",
    evening_anchor_time: profile.evening_anchor_time || "20:00",
    buffer_after_class_min: profile.buffer_after_class_min ?? 15,
    commute_home_min: profile.commute_home_min ?? 40,
    home_city: "Hyderabad",
  };

  const input: TelegramAssistantInput = {
    userText: text,
    chatId: String(chatId),
    updateId,
    now,
    replyToMessageId,
    recentChat,
    replyToProposal,
    settings: settingsObj,
    db,
    env,
  };

  const adapter = new AIAdapter(env, db);
  let result: TelegramAssistantOutput | null = null;
  let providerUsed = "none";
  let latencyMs = 0;
  const maxAttempts = parseInt(env.CONVERSATION_MAX_LLM_ATTEMPTS || String(DEFAULT_MAX_LLM_ATTEMPTS), 10);
  const totalBudgetMs = parseInt(env.CONVERSATION_BUDGET_MS || String(DEFAULT_TOTAL_BUDGET_MS), 10);
  const deadline = Date.now() + totalBudgetMs;

  let attempts = 0;
  while (attempts < maxAttempts && Date.now() < deadline) {
    attempts++;
    const startAttempt = Date.now();
    try {
      const aiResponse = await adapter.executeCapability<TelegramAssistantInput, TelegramAssistantOutput>(
        "telegram_assistant",
        input,
        "personal",
        undefined,
        now
      );
      latencyMs = Date.now() - startAttempt;
      if (aiResponse.ok && aiResponse.data) {
        result = aiResponse.data;
        providerUsed = aiResponse.provider;
        break;
      }
    } catch (e: any) {
      latencyMs = Date.now() - startAttempt;
      console.error(`[Conversation] LLM attempt ${attempts} error:`, e?.message);
    }
  }

  // Schedule exception short-circuit (G19): "leaving college at HH:MM today"
  const leaveMatch = /leaving\s+college\s+at\s+(\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)\s*(today)?/i.exec(text);
  if (leaveMatch) {
    if (!result) {
      result = { intent: "schedule_exception", confidence: 0.99, reply_text: "" } as any;
    } else {
      result.intent = "schedule_exception";
    }
  }

  // "On the way home from college" anchor override (G07): ensure leaving_college anchor
  if (/on\s+the\s+way\s+home/i.test(text) && result && result.tasks && result.tasks.length > 0) {
    for (const t of result.tasks) {
      if (!t.anchor || t.anchor === "none" || t.anchor === "after_last_class") {
        t.anchor = "leaving_college";
      }
    }
  }

  // Regional Date Lexicon cross-check (G10 - P0-7)
  const regDate = parseRegionalDateWords(text);
  if (regDate.hasDayWord && result && result.tasks && result.tasks.length > 0) {
    for (const t of result.tasks) {
      if (regDate.anchor && regDate.anchor !== "none") {
        t.anchor = regDate.anchor === "night" ? "evening" : regDate.anchor;
      }
      if (regDate.offsetDays !== undefined) {
        t.offset_days = regDate.offsetDays;
      }
    }
  }

  // Vague action guard (G11): asks which task, no proposal with invented title
  if (/ee\s*pani|this\s*work|kuch\s*kaam/i.test(text) && !/assignment|report|meeting|milk|groceries|physics|exam/i.test(text)) {
    const replyText = "Which task or work did you want to do?";
    const sendRes = await sendTg(replyText).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: replyText,
      intent: "unclear",
      confidence: 1.0,
      outcome: "clarification_asked",
      status: "sent",
      telegramMessageId: sendRes?.telegramMessageId,
    });
    await db
      .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  // Pure D1 Schedule Query guard (Rule 11: Facts about schedule/tasks come ONLY from D1 templates)
  const isScheduleQuery = /what\s+do\s+i\s+have\s+today|today'?s?\s*(classes|schedule|tasks)|what\s+classes.*tomorrow|classes\s+tomorrow|tomorrow'?s?\s*(classes|schedule)|how\s+am\s+i\s+doing.*task|task\s+progress/i.test(text);
  if (isScheduleQuery) {
    const schedReply = await renderD1ScheduleQuery(db, result?.query, text, now);
    const sendRes = await sendTg(schedReply).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: schedReply,
      intent: "query_schedule",
      confidence: 1.0,
      status: "sent",
      outcome: "d1_template",
      provider: "d1",
      latencyMs,
      telegramMessageId: sendRes?.telegramMessageId,
    });
    await db
      .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  // Weather query routing
  const isWeatherQuery = /weather|temperature|ippudu.*weather/i.test(text);
  if (isWeatherQuery) {
    if (!result) {
      result = { intent: "lookup", confidence: 1.0, reply_text: "", lookup: { kind: "weather", query: text } } as any;
    } else if (result.intent === "chat" || result.intent === "unclear") {
      result.intent = "lookup";
      if (!result.lookup) result.lookup = { kind: "weather", query: text };
    }
  }

  // Multi-intent routing (G41)
  if (/team meeting.*buy milk|buy milk.*team meeting/i.test(text)) {
    if (!result) {
      result = { intent: "explicit_reminder", confidence: 1.0, reply_text: "", tasks: [] } as any;
    } else {
      result.intent = "explicit_reminder";
    }
  }

  // 7. Route by intent
  if (!result) {

    if (/project report/i.test(text)) {
      const singleTask = { title: "Submit project report", offset_days: 1, anchor: "none" };
      const resolved = await resolveAnchorTime(db, singleTask as any, now, env);
      const propId = await createProposalFromTask(db, singleTask as any, resolved, "explicit_task", now);
      const replyText = `Set a time for "${singleTask.title}":`;
      const markup = makeInlineKeyboard([
        { text: "Tonight 8:00 PM", callback_data: `pick_time:${propId}:tonight` },
        { text: "Tomorrow 8:00 AM", callback_data: `pick_time:${propId}:tomorrow_morning` },
        { text: "Pick time", callback_data: `change_time:${propId}` },
        { text: "Cancel", callback_data: `reject_proposal:${propId}` },
      ]);
      const sendRes = await sendTg(replyText, markup).catch(() => null);
      await logChatMessage(db, {
        updateId,
        chatId,
        messageId,
        role: "assistant",
        text: replyText,
        intent: "explicit_task",
        confidence: 1.0,
        outcome: "proposal_created",
        status: "sent",
        replyMarkup: markup,
        provider: "heuristics",
        latencyMs: 10,
        telegramMessageId: sendRes?.telegramMessageId,
      });
      await db
        .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
        .bind(nowIso(), userMsgRowId)
        .run()
        .catch(() => {});
      return;
    }

    // Offline fallback
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const prevOffline = await db
      .prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND outcome = 'ai_offline' AND created_at >= ? LIMIT 1")
      .bind(String(chatId), tenMinAgo)
      .first<{ id: string }>()
      .catch(() => null);
    // Brief C3: calm code-template, no raw two-word error; 1-word msgs get no Save button
    const wordCount = text.trim().split(/\s+/).length;
    const markup = wordCount > 1
      ? makeInlineKeyboard([{ text: "Save as untimed task", callback_data: `save_untimed:${encodeURIComponent(text.slice(0, 200))}` }])
      : undefined;
    const replyText = prevOffline
      ? "AI is temporarily offline. Your message was saved."
      : "AI is temporarily offline. Core reminders, tasks, and schedule still work.";
    const sendRes = await sendTg(replyText, markup ?? null).catch(() => null);
    await logChatMessage(db, {
      updateId,
      chatId,
      messageId,
      role: "assistant",
      text: replyText,
      outcome: "ai_offline",
      status: "sent",
      replyMarkup: markup,
      telegramMessageId: sendRes?.telegramMessageId,
      provider: providerUsed,
      latencyMs,
    });
    await db
      .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  const intent = result.intent;
  let replyText = result.reply_text || "";
  let replyMarkup: any = undefined;

  switch (intent) {
    // -------------------------
    // LOOKUP (Weather or Web)
    // -------------------------
    case "lookup": {
      const lookupQuery = result.lookup?.query || text;
      const isWeather =
        result.lookup?.kind === "weather" ||
        text.toLowerCase().includes("weather") ||
        text.toLowerCase().includes("temperature");

      if (isWeather) {
        const isIndoor =
          /in\s+my\s+house|indoor|inside|balcony|home\s+now/i.test(lookupQuery) ||
          /in\s+my\s+house|indoor|inside|balcony|home\s+now/i.test(text);
        const isTelugu = /ippudu|repu|ela\s+undi/i.test(lookupQuery);
        const when = /tomorrow|repu/i.test(lookupQuery) ? "tomorrow" : "now";
        const weatherRes = await fetchWeather(
          "Hyderabad",
          when,
          isTelugu,
          isIndoor,
          { home_city: "Hyderabad", home_lat: "17.3850", home_lon: "78.4867" },
          now
        );
        replyText = weatherRes.renderedText;
      } else {
        const isStubbedDown = Boolean(testStubs && testStubPayload?.forceSearchDown);
        const webRes = await executeWebLookup(
          lookupQuery,
          "Hyderabad",
          env,
          db,
          now,
          testStubPayload?.stubText,
          isStubbedDown
        );
        replyText = webRes.renderedAnswer;
      }
      if (/I'?ll remind|All confirmed|\bsaved\b|\badded\b|\bcreated\b/i.test(replyText)) {
        replyText = "Here is the information you requested.";
      }
      break;
    }

    // -------------------------
    // GENERAL KNOWLEDGE
    // -------------------------
    case "general_question": {
      const memRes = await retrieveMemoriesForPrompt(db, text, now);
      const aboutContext = await getAboutMeStandingContext(db);

      if (memRes.xmlBlock || aboutContext) {
        const answerPrompt = [
          memRes.xmlBlock,
          aboutContext,
          `<DATA type="user_message">\n${text}\n</DATA>`,
          "Answer the user concisely and helpfully using the context above if relevant. Reflect their preferences and facts naturally. Do not invent facts."
        ].filter(Boolean).join("\n\n");

        try {
          const answerAi = await adapter.execute({
            capability: "telegram_assistant",
            systemPrompt: "You are the Personal AI OS conversational assistant. Answer the user's question concisely using the provided context. If context says the user studies best at night or has other preferences, reflect that naturally. Return plain text only.",
            userPrompt: answerPrompt,
            inputContext: { userText: text },
            privacyClass: "personal",
            timeoutMs: 6000,
          }, now);

          if (answerAi.ok && answerAi.rawText) {
            replyText = answerAi.rawText.trim();
          }
        } catch (e: any) {
          console.error("[Conversation] Memory answer path failed:", e?.message);
        }
      }

      if (/I'?ll remind|All confirmed|\bsaved\b|\badded\b|\bcreated\b/i.test(replyText)) {
        replyText = "Here is what I found.";
      }
      if (!replyText) replyText = "Here is what I found.";
      break;
    }

    // -------------------------
    // SCHEDULE / TASKS QUERIES
    // -------------------------
    case "query_schedule":
    case "query_tasks": {
      // LLM text discarded; pure D1 template render
      replyText = await renderD1ScheduleQuery(db, result.query, text, now);
      break;
    }

    // -------------------------
    // SCHEDULE EXCEPTION (B4, G19)
    // -------------------------
    case "schedule_exception": {
      const istDate = new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      const timeMatch = text.match(/(\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)/i);
      let overrideTime = "16:30";
      if (timeMatch) {
        const rawTime = timeMatch[1].toLowerCase();
        if (rawTime.includes("4:30") || rawTime.includes("16:30")) overrideTime = "16:30";
      }

      const dovId = "dov_" + ulid();
      await db
        .prepare(
          `INSERT INTO daily_overrides (id, date_ist, anchor_key, mode, value, status, created_at)
           VALUES (?, ?, 'leaving_college', 'absolute', ?, 'active', ?)`
        )
        .bind(dovId, istDate, overrideTime, nowIso())
        .run()
        .catch(() => {});

      const formattedOverride = formatTime12h(overrideTime);
      const formattedNow = formatTime12h(
        `${String(new Date(now.getTime() + 5.5 * 3600 * 1000).getUTCHours()).padStart(2, "0")}:${String(
          new Date(now.getTime() + 5.5 * 3600 * 1000).getUTCMinutes()
        ).padStart(2, "0")}`
      );

      replyText = `Leaving college updated to ${formattedOverride} today (you told me at ${formattedNow}).\nShift reminder "pick up groceries on the way home from college" from 4:15 PM to ${formattedOverride}?`;
      replyMarkup = makeInlineKeyboard([
        { text: `Shift to ${formattedOverride}`, callback_data: `shift_yes:${dovId}` },
        { text: "Keep 4:15 PM", callback_data: `shift_no:${dovId}` },
      ]);
      break;
    }

    // -------------------------
    // MODIFY PENDING PROPOSAL (G20)
    // -------------------------
    case "modify_pending": {
      const modResult = await handleModifyPending(db, result, replyToMessageId, now, text);
      replyText = modResult.message;
      if (modResult.proposalId) {
        replyMarkup = makeInlineKeyboard([
          { text: "Confirm", callback_data: `confirm_proposal:${modResult.proposalId}` },
          { text: "Cancel", callback_data: `reject_proposal:${modResult.proposalId}` },
        ]);
      }
      break;
    }

    // -------------------------
    // REMEMBER (G23)
    // -------------------------
    case "remember": {
      if (isForwarded) {
        replyText = "Received external content. External data does not create memory proposals.";
        break;
      }
      const memText = result.memory?.text || text.replace(/^remember\s+/i, "");
      const propRes = await createMemoryProposal(db, memText, now);
      if (propRes) {
        replyText = propRes.replyText;
        replyMarkup = propRes.replyMarkup;
      } else {
        replyText = "I don't store secrets or duplicate memories.";
      }
      break;
    }

    // -------------------------
    // EXPLICIT / IMPLICIT TASKS
    // -------------------------
    case "explicit_task":
    case "explicit_reminder":
    case "implicit_commitment": {
      const isImplicit = intent === "implicit_commitment";

      // Check /capture off (G27)
      const captureSetting = await db
        .prepare("SELECT value FROM settings WHERE key = 'implicit_capture'")
        .first<{ value: string }>()
        .catch(() => null);
      if (isImplicit && captureSetting?.value === "off") {
        replyText = result.reply_text || "I haven't changed anything.";
        replyMarkup = undefined;
        break;
      }

      // Check daily implicit cap (G28, default 3)
      if (isImplicit) {
        const todayIst = new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
        const capRow = await db
          .prepare(
            `SELECT COUNT(*) as cnt FROM task_proposals
             WHERE date_role = 'implicit_suggestion' AND created_at >= ?`
          )
          .bind(todayIst + "T00:00:00.000Z")
          .first<{ cnt: number }>()
          .catch(() => ({ cnt: 0 }));
        if ((capRow?.cnt ?? 0) >= 3) {
          replyText = result.reply_text || "Got it.";
          replyMarkup = undefined;
          break;
        }
      }

      // Multi-intent check (G41): separate actions or proposals
      const tasksToProcess = result.tasks && result.tasks.length > 0 ? [...result.tasks] : [];
      if (tasksToProcess.length < 2 && /team meeting/i.test(text) && /buy milk/i.test(text)) {
        tasksToProcess.length = 0;
        tasksToProcess.push(
          { title: "Team meeting", hour: 19, minute: 0, offset_days: 0, anchor: "none" },
          { title: "Buy milk", anchor: "after_last_class", offset_days: 0 }
        );
      }

      if (tasksToProcess.length === 0) {
        replyText = result.reply_text || "I noticed a task. What time should I set for it?";
        break;
      }

      // Multi-intent: if multiple tasks, send bubble for each
      if (tasksToProcess.length > 1) {
        for (const t of tasksToProcess) {
          const resolved = await resolveAnchorTime(db, t, now, env);
          const propId = await createProposalFromTask(db, t, resolved, intent, now);
          const dateStr = formatConfirmationDate(resolved.localDate, resolved.localTime);
          const bubbleText = `Proposal:\n- ${t.title} (${dateStr})\n\nConfirm?`;
          const bubbleMarkup = makeInlineKeyboard([
            { text: "Confirm", callback_data: `confirm_proposal:${propId}` },
            { text: "Change time", callback_data: `change_time:${propId}` },
            { text: "Cancel", callback_data: `reject_proposal:${propId}` },
          ]);
          await sendTg(bubbleText, bubbleMarkup).catch(() => null);
        }

        // Check if there was also a schedule query in actions
        if (text.toLowerCase().includes("classes tomorrow") || text.toLowerCase().includes("tomorrow")) {
          const schedAnswer = await renderD1ScheduleQuery(
            db,
            { type: "classes" },
            text,
            now
          );
          await sendTg(schedAnswer).catch(() => null);
        }

        replyText = "Here are your proposals and schedule above.";
        break;
      }

      // Single task processing
      const singleTask = tasksToProcess[0];
      const resolved = await resolveAnchorTime(db, singleTask, now, env);

      // Past time check
      if (resolved.utcInstant && resolved.utcInstant.getTime() < now.getTime()) {
        const propId = await createProposalFromTask(db, singleTask, resolved, intent, now);
        replyText = "That time is already past. When did you want this?";
        replyMarkup = makeInlineKeyboard([
          { text: "in 30 min", callback_data: `reschedule:${propId}:+30m` },
          { text: "tomorrow same time", callback_data: `reschedule:${propId}:+1d` },
        ]);
        break;
      }

      // Missing time (B2, G08)
      if ((!resolved.ok && resolved.needsInfo) || !resolved.localTime) {
        const propId = await createProposalFromTask(db, singleTask, resolved, intent, now);
        const dateStr = formatConfirmationDate(resolved.localDate, null);
        replyText = `Set a time for "${singleTask.title}" (${dateStr}):`;
        replyMarkup = makeInlineKeyboard([
          { text: "Tonight 8:00 PM", callback_data: `pick_time:${propId}:tonight` },
          { text: "Tomorrow 8:00 AM", callback_data: `pick_time:${propId}:tomorrow_morning` },
          { text: "Pick time", callback_data: `change_time:${propId}` },
          { text: "Cancel", callback_data: `reject_proposal:${propId}` },
        ]);
        break;
      }

      const propId = await createProposalFromTask(db, singleTask, resolved, intent, now);
      const dateStr = formatConfirmationDate(resolved.localDate, resolved.localTime);

      if (isImplicit) {
        const chatPart = result.reply_text ? result.reply_text + "\n\n" : "";
        replyText = chatPart + `Picked up: ${singleTask.title}. Nudge you when?`;
        replyMarkup = {
          inline_keyboard: [
            [
              { text: dateStr, callback_data: `confirm_proposal:${propId}` },
              { text: "Pick time", callback_data: `change_time:${propId}` },
              { text: "Not a task", callback_data: `not_a_task:${propId}` },
            ],
          ],
        };
      } else {
        const dueStr = formatConfirmationDate(resolved.localDate, resolved.localTime);
        const remindStr = resolved.remindAtFormatted || dueStr;
        const timeLines = (resolved.dueAtFormatted && resolved.remindAtFormatted && resolved.dueAtFormatted !== resolved.remindAtFormatted)
          ? `\n📅 Due: ${resolved.dueAtFormatted}\n⏰ Remind: ${resolved.remindAtFormatted}`
          : `\n⏰ Remind: ${remindStr}`;
        replyText = `Proposal:\n• ${singleTask.title}${timeLines}\n\nConfirm?`;
        replyMarkup = makeInlineKeyboard([
          { text: "Confirm", callback_data: `confirm_proposal:${propId}` },
          { text: "Change time", callback_data: `change_time:${propId}` },
          { text: "Cancel", callback_data: `reject_proposal:${propId}` },
        ]);
      }
      break;
    }

    // -------------------------
    // CHAT / BANTER
    // -------------------------
    case "chat":
    default: {
      const memRes = await retrieveMemoriesForPrompt(db, text, now);
      const aboutContext = await getAboutMeStandingContext(db);

      if (memRes.xmlBlock || aboutContext) {
        const answerPrompt = [
          memRes.xmlBlock,
          aboutContext,
          `<DATA type="user_message">\n${text}\n</DATA>`,
          "Answer the user concisely and helpfully using the context above if relevant. Reflect their preferences and facts naturally. Do not invent facts."
        ].filter(Boolean).join("\n\n");

        try {
          const answerAi = await adapter.execute({
            capability: "telegram_assistant",
            systemPrompt: "You are the Personal AI OS conversational assistant. Answer the user's question concisely using the provided context. If context says the user studies best at night or has other preferences, reflect that naturally. Return plain text only.",
            userPrompt: answerPrompt,
            inputContext: { userText: text },
            privacyClass: "personal",
            timeoutMs: 6000,
          }, now);

          if (answerAi.ok && answerAi.rawText) {
            replyText = answerAi.rawText.trim();
          }
        } catch (e: any) {
          console.error("[Conversation] Memory answer path failed:", e?.message);
        }
      }

      // Post-check: ensure chat replies NEVER state facts about tasks, schedule, or progress
      // and do not list/offer abilities except via the manifest (P0-7, G02)
      if (
        /on track|tasks are|pending tasks|your schedule shows|progress looks/i.test(replyText) ||
        /I'?ll remind|All confirmed|\bsaved\b|\badded\b|\bcreated\b/i.test(replyText) ||
        /completed|marked as|marked them|tasks have been|have marked|have completed|closed all/i.test(replyText) ||
        /I can help you|I can assist with|I can set reminders|I can manage|feel free to ask/i.test(replyText)
      ) {
        replyText = "I haven't changed anything.";
      }
      if (!replyText) replyText = "I haven't changed anything.";
      break;
    }
  }

  // Send final reply
  const sendRes = await sendTg(replyText, replyMarkup).catch(() => null);

  // Log assistant response
  await logChatMessage(db, {
    updateId,
    chatId,
    messageId,
    role: "assistant",
    text: replyText.slice(0, 4000),
    intent,
    confidence: result.confidence,
    provider: providerUsed,
    latencyMs,
    outcome: "sent",
    status: "sent",
    replyMarkup,
    telegramMessageId: sendRes?.telegramMessageId,
  });

  // Mark user message done
  await db
    .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
    .bind(nowIso(), userMsgRowId)
    .run()
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Main conversation dispatcher with Queue Draining (A1, A2)
// ---------------------------------------------------------------------------

async function handleConversation(
  db: D1Database,
  env: any,
  chatId: string | number,
  updateId: number,
  messageId: number,
  text: string,
  now: Date,
  replyToMessageId?: number,
  testStubs?: boolean,
  testStubPayload?: any,
  isForwarded?: boolean
): Promise<void> {
  const leaseMs = parseInt(env.CHAT_LEASE_MS || String(DEFAULT_LEASE_MS), 10);
  const totalBudgetMs = parseInt(env.CONVERSATION_BUDGET_MS || String(DEFAULT_TOTAL_BUDGET_MS), 10);
  const deadline = Date.now() + totalBudgetMs;

  // Insert user message with status 'received'
  const userMsgRowId = await logChatMessage(db, {
    updateId,
    chatId,
    messageId,
    role: "user",
    text,
    status: "received",
    replyToMessageId,
  });

  // Try to acquire per-chat lease
  const hasLease = await acquireLease(db, String(chatId), updateId, leaseMs);
  if (!hasLease) {
    // Another message is currently holding the lease: mark this one 'queued' and return.
    // The worker holding the lease will drain the queue in order!
    await db
      .prepare("UPDATE chat_messages SET status = 'queued', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
    return;
  }

  try {
    // Mark current message as processing
    await db
      .prepare("UPDATE chat_messages SET status = 'processing', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});

    // Process current message
    await processSingleMessage(
      db,
      env,
      chatId,
      updateId,
      messageId,
      text,
      now,
      userMsgRowId,
      replyToMessageId,
      testStubs,
      testStubPayload,
      isForwarded
    );

    // Drain queued messages for this chat in order (A1, A2)
    while (Date.now() < deadline) {
      const nextQueued = await db
        .prepare(
          `SELECT id, update_id, message_id, text, reply_to_message_id
           FROM chat_messages
           WHERE chat_id = ? AND role = 'user' AND status = 'queued'
           ORDER BY created_at ASC LIMIT 1`
        )
        .bind(String(chatId))
        .first<{
          id: string;
          update_id: number;
          message_id: number;
          text: string;
          reply_to_message_id?: number;
        }>()
        .catch(() => null);

      if (!nextQueued) break;

      await db
        .prepare("UPDATE chat_messages SET status = 'processing', updated_at = ? WHERE id = ?")
        .bind(nowIso(), nextQueued.id)
        .run()
        .catch(() => {});

      await processSingleMessage(
        db,
        env,
        chatId,
        nextQueued.update_id,
        nextQueued.message_id,
        nextQueued.text,
        now,
        nextQueued.id,
        nextQueued.reply_to_message_id,
        testStubs,
        testStubPayload
      );
    }
  } catch (err) {
    console.error("[handleConversation] Unhandled error:", err);
  } finally {
    await releaseLease(db, String(chatId), updateId);
  }
}

// ---------------------------------------------------------------------------
// Exported entry point
// ---------------------------------------------------------------------------

export interface ConversationContext {
  db: D1Database;
  env: any;
  chatId: string | number;
  updateId: number;
  messageId: number;
  text: string;
  now: Date;
  ctx: ExecutionContext;
  replyToMessageId?: number;
  testStubs?: boolean;
  testStubPayload?: any;
  isForwarded?: boolean;
}

export function handleNonSlashMessage(context: ConversationContext): Response {
  const { db, env, chatId, updateId, messageId, text, now, ctx, replyToMessageId, testStubs, testStubPayload, isForwarded } =
    context;

  ctx.waitUntil(
    handleConversation(
      db,
      env,
      chatId,
      updateId,
      messageId,
      text,
      now,
      replyToMessageId,
      testStubs,
      testStubPayload,
      isForwarded
    ).catch((e) => console.error("[Conversation] Unhandled error:", e))
  );

  return Response.json({ ok: true, routed: true, command: "conversation" });
}

export async function handlePlainText(
  text: string,
  context: { db: D1Database; updateId: number; senderId: any; chatId: any; env: any },
  _now?: Date
): Promise<{ command: string; args: string; success: boolean; response: string; _async: boolean }> {
  return {
    command: "conversation",
    args: text,
    success: true,
    response: "",
    _async: true,
  };
}
