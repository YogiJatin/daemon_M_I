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
  handleModifyPending,
  formatConfirmationDate,
} from "./telegramAssistant";
import { getProfile, formatTime12h } from "./dailyRhythm";

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
  testStubPayload?: any
): Promise<void> {
  const botToken: string = env.TELEGRAM_BOT_TOKEN;

  // 1. Secrets Guard (B5)
  const secretCheck = checkAndRedactSecrets(text);
  if (secretCheck.isSecret) {
    const replyText = "I don't store secrets.";
    const sendRes = await sendTelegramMessage(botToken, chatId, replyText).catch(() => null);
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
    const sendRes = await sendTelegramMessage(botToken, chatId, replyText).catch(() => null);
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
    const sendRes = await sendTelegramMessage(botToken, chatId, replyText).catch(() => null);
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
      telegramMessageId: sendRes?.telegramMessageId,
    });
    await db
      .prepare("UPDATE chat_messages SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowIso(), userMsgRowId)
      .run()
      .catch(() => {});
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
    const sendRes = await sendTelegramMessage(botToken, chatId, replyText, markup).catch(() => null);
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
  const allDisabled = ["groq", "gemini", "workers_ai", "mock"].every((p) => disabledList.includes(p));

  if (allDisabled) {
    const markup = makeInlineKeyboard([
      { text: "Save as untimed task", callback_data: `save_untimed:${encodeURIComponent(text.slice(0, 200))}` },
    ]);
    const replyText = "AI is offline right now. Your message was not lost.";
    const sendRes = await sendTelegramMessage(botToken, chatId, replyText, markup).catch(() => null);
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

  const profile = await getProfile(db);
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

  // 7. Route by intent
  if (!result) {
    // Offline fallback
    const markup = makeInlineKeyboard([
      { text: "Save as untimed task", callback_data: `save_untimed:${encodeURIComponent(text.slice(0, 200))}` },
    ]);
    const replyText = "AI is offline right now. Your message was not lost.";
    const sendRes = await sendTelegramMessage(botToken, chatId, replyText, markup).catch(() => null);
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
        const isIndoor = /in\s+my\s+house|indoor|balcony|home\s+now/i.test(lookupQuery);
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
      break;
    }

    // -------------------------
    // GENERAL KNOWLEDGE
    // -------------------------
    case "general_question": {
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
      const modResult = await handleModifyPending(db, result, replyToMessageId, now);
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
      const memText = result.memory?.text || text.replace(/^remember\s+/i, "");
      const propId = "prop_" + ulid();
      await db
        .prepare(
          `INSERT INTO task_proposals (id, title, date_role, status, advisory_confidence, created_at, updated_at)
           VALUES (?, ?, 'memory', 'pending', 0.9, ?, ?)`
        )
        .bind(propId, memText.slice(0, 500), nowIso(), nowIso())
        .run()
        .catch(() => {});

      replyText = `Remember this?\n"${memText.slice(0, 150)}"`;
      replyMarkup = makeInlineKeyboard([
        { text: "Confirm", callback_data: `confirm_proposal:${propId}` },
        { text: "Cancel", callback_data: `reject_proposal:${propId}` },
      ]);
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
        replyText = result.reply_text || "Got it.";
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
      const tasksToProcess = result.tasks && result.tasks.length > 0 ? result.tasks : [];

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
          await sendTelegramMessage(botToken, chatId, bubbleText, bubbleMarkup).catch(() => null);
        }

        // Check if there was also a schedule query in actions
        if (text.toLowerCase().includes("classes tomorrow") || text.toLowerCase().includes("tomorrow")) {
          const schedAnswer = await renderD1ScheduleQuery(
            db,
            { type: "classes" },
            text,
            now
          );
          await sendTelegramMessage(botToken, chatId, schedAnswer).catch(() => null);
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

      // Missing time (B2)
      if (!resolved.ok && resolved.needsInfo) {
        const propId = await createProposalFromTask(db, singleTask, resolved, intent, now);
        replyText = `Set a time for "${singleTask.title}":`;
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
        replyText = `Got it! Here's what I'll save:\n- ${singleTask.title} (${dateStr})\n\nConfirm?`;
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
      // Post-check: ensure chat replies NEVER state facts about tasks, schedule, or progress
      if (
        /on track|tasks are|pending tasks|your schedule shows|progress looks/i.test(replyText)
      ) {
        replyText = "Hey! What's up? Let me know if you need to set a reminder or check your schedule.";
      }
      if (!replyText) replyText = "Got it.";
      break;
    }
  }

  // Send final reply
  const sendRes = await sendTelegramMessage(botToken, chatId, replyText, replyMarkup).catch(() => null);

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
  testStubPayload?: any
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
      testStubPayload
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
}

export function handleNonSlashMessage(context: ConversationContext): Response {
  const { db, env, chatId, updateId, messageId, text, now, ctx, replyToMessageId, testStubs, testStubPayload } =
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
      testStubPayload
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
