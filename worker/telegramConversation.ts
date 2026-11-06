/**
 * worker/telegramConversation.ts - Block 1 Conversational Telegram Handler
 *
 * Handles non-slash plain-text messages via the telegram_assistant AI capability.
 * Returns HTTP 200 immediately; all AI work runs in ctx.waitUntil().
 *
 * Hard invariants:
 * - AI never creates/edits/deletes live tasks; all creation goes via task_proposals.
 * - scheduler.ts imports zero AI modules.
 * - External/user content treated as DATA, never instructions.
 * - Mock output is labeled "AI offline", never presented as an AI answer.
 * - Implicit capture disabled when provider is workers_ai or mock.
 */

import { sendTelegramMessage } from "./telegram";
import { CommandContext } from "./commands";
import { AIAdapter } from "./aiAdapter";
import {
  TelegramAssistantInput,
  TelegramAssistantOutput,
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  validateAssistantOutput,
  resolveAnchorTime,
  createProposalFromTask,
  renderQueryAnswer,
  handleModifyPending,
} from "./telegramAssistant";

// ---------------------------------------------------------------------------
// Budget constants (all configurable via env)
// ---------------------------------------------------------------------------
const DEFAULT_TOTAL_BUDGET_MS = 20_000;
const DEFAULT_MAX_LLM_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 25_000;
const DEFAULT_DAILY_AI_BUDGET = 200; // calls per day

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Per-chat lease (serialises rapid messages; >=25s per spec)
// ---------------------------------------------------------------------------

async function acquireLease(db: D1Database, chatId: string, updateId: number, leaseMs: number): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const nowStr = now.toISOString();

  try {
    // Expire stale leases first, then try to claim
    await db
      .prepare("DELETE FROM chat_leases WHERE chat_id = ? AND expires_at < ?")
      .bind(String(chatId), nowStr)
      .run();

    const existing = await db
      .prepare("SELECT update_id FROM chat_leases WHERE chat_id = ?")
      .bind(String(chatId))
      .first<{ update_id: number }>();

    if (existing) {
      // Another message is being processed for this chat
      return false;
    }

    await db
      .prepare(
        "INSERT OR REPLACE INTO chat_leases (chat_id, update_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
      )
      .bind(String(chatId), updateId, expiresAt, nowStr)
      .run();
    return true;
  } catch {
    return true; // fail open to avoid blocking legitimate messages
  }
}

async function releaseLease(db: D1Database, chatId: string, updateId: number): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM chat_leases WHERE chat_id = ? AND update_id = ?")
      .bind(String(chatId), updateId)
      .run();
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Daily AI budget check
// ---------------------------------------------------------------------------

async function checkDailyAiBudget(
  db: D1Database,
  dailyBudget: number,
  now: Date
): Promise<boolean> {
  try {
    // Use daily_notification_counters or just count chat_messages today
    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
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
// Log chat message to D1
// ---------------------------------------------------------------------------

async function logChatMessage(
  db: D1Database,
  params: {
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
    status: "received" | "processing" | "sent" | "failed";
  }
): Promise<void> {
  try {
    const id = "msg_" + ulid();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO chat_messages
          (id, update_id, chat_id, message_id, role, text, intent, confidence,
           provider, latency_ms, outcome, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now,
        now
      )
      .run();
  } catch {
    // telemetry failure must not block user response
  }
}

// ---------------------------------------------------------------------------
// "Save as untimed task" button callback handler
// ---------------------------------------------------------------------------

export async function handleSaveUntimed(
  db: D1Database,
  chatId: string | number,
  botToken: string,
  rawText: string
): Promise<void> {
  try {
    const id = "prop_" + ulid();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO task_proposals
           (id, title, status, advisory_confidence, created_at, updated_at)
         VALUES (?, ?, 'pending', 0.5, ?, ?)`
      )
      .bind(id, rawText.slice(0, 500).trim(), now, now)
      .run();

    await sendTelegramMessage(
      botToken,
      chatId,
      `Saved as untimed proposal. Tap Confirm to create the task.`,
      makeInlineKeyboard([
        { text: "Confirm", callback_data: `confirm_proposal:${id}` },
        { text: "Cancel", callback_data: `reject_proposal:${id}` },
      ])
    );
  } catch (e) {
    console.error("[SaveUntimed] Error:", e);
  }
}

// ---------------------------------------------------------------------------
// Main async handler (runs inside ctx.waitUntil)
// ---------------------------------------------------------------------------

async function handleConversation(
  db: D1Database,
  env: any,
  chatId: string | number,
  updateId: number,
  messageId: number,
  text: string,
  now: Date,
  replyToMessageId?: number
): Promise<void> {
  const botToken: string = env.TELEGRAM_BOT_TOKEN;
  const totalBudgetMs = parseInt(env.CONVERSATION_BUDGET_MS || String(DEFAULT_TOTAL_BUDGET_MS), 10);
  const maxAttempts = parseInt(env.CONVERSATION_MAX_LLM_ATTEMPTS || String(DEFAULT_MAX_LLM_ATTEMPTS), 10);
  const dailyBudget = parseInt(env.DAILY_AI_BUDGET || String(DEFAULT_DAILY_AI_BUDGET), 10);
  const leaseMs = parseInt(env.CHAT_LEASE_MS || String(DEFAULT_LEASE_MS), 10);

  const startMs = Date.now();
  const deadline = startMs + totalBudgetMs;

  // Log user message receipt
  await logChatMessage(db, {
    updateId,
    chatId,
    messageId,
    role: "user",
    text,
    status: "received",
  });

  // Acquire per-chat lease (serialise rapid messages)
  const hasLease = await acquireLease(db, String(chatId), updateId, leaseMs);
  if (!hasLease) {
    // Another message is processing; queue a brief note or silently drop
    await sendTelegramMessage(
      botToken,
      chatId,
      "Still processing your previous message, please wait a moment."
    ).catch(() => {});
    return;
  }

  try {
    // Check daily AI budget
    const withinBudget = await checkDailyAiBudget(db, dailyBudget, now);
    if (!withinBudget) {
      await sendTelegramMessage(
        botToken,
        chatId,
        "Daily AI budget reached. Sending new messages as untimed tasks.",
        makeInlineKeyboard([
          { text: "Save as untimed task", callback_data: `save_untimed:${encodeURIComponent(text.slice(0, 200))}` },
        ])
      ).catch(() => {});
      await logChatMessage(db, {
        updateId, chatId, messageId, role: "assistant",
        text: "Daily AI budget reached.",
        outcome: "budget_exceeded", status: "sent",
      });
      return;
    }

    // Build input for the assistant capability
    const input: TelegramAssistantInput = {
      userText: text,
      chatId: String(chatId),
      updateId,
      now,
      replyToMessageId,
      db,
      env,
    };

    const adapter = new AIAdapter(env, db);

    // Determine which providers to allow (exclude workers_ai/mock for implicit capture)
    // The capability registry handles this via providerAllowList; we pass it through.

    let result: TelegramAssistantOutput | null = null;
    let providerUsed = "none";
    let latencyMs = 0;
    let attempts = 0;
    let lastError = "";

    // Attempt loop: max 3 LLM attempts (including repair)
    while (attempts < maxAttempts && Date.now() < deadline) {
      attempts++;
      const attemptStart = Date.now();
      try {
        const aiResponse = await adapter.executeCapability<TelegramAssistantInput, TelegramAssistantOutput>(
          "telegram_assistant",
          input,
          "personal",
          undefined,
          now
        );
        latencyMs = Date.now() - attemptStart;

        if (aiResponse.ok && aiResponse.data) {
          result = aiResponse.data;
          providerUsed = aiResponse.provider;
          break;
        }
        lastError = aiResponse.error?.message || "Unknown AI error";
      } catch (e: any) {
        latencyMs = Date.now() - attemptStart;
        lastError = e?.message || "Exception in AI call";
        console.error(`[Conversation] Attempt ${attempts} failed:`, lastError);
      }
    }

    // --- Route by intent ---
    if (!result) {
      // All providers failed or timed out
      await sendTelegramMessage(
        botToken,
        chatId,
        "AI is offline right now. Your message was not lost.",
        makeInlineKeyboard([
          { text: "Save as untimed task", callback_data: `save_untimed:${encodeURIComponent(text.slice(0, 200))}` },
        ])
      ).catch(() => {});
      await logChatMessage(db, {
        updateId, chatId, messageId, role: "assistant",
        text: "AI is offline.",
        outcome: "ai_offline", status: "sent",
        provider: providerUsed, latencyMs,
      });
      return;
    }

    const intent = result.intent;
    const isMockOrWorkers = providerUsed.includes("workers_ai") || providerUsed.includes("mock") || providerUsed.includes("(cached)");

    let replyText = result.reply_text || "";
    let replyMarkup: any = undefined;

    switch (intent) {
      // -------------------------
      case "chat":
      case "unclear": {
        // Just reply with the LLM's text
        if (!replyText) replyText = "Got it.";
        break;
      }

      // -------------------------
      case "explicit_task":
      case "explicit_reminder":
      case "implicit_commitment": {
        // Create proposal(s) in task_proposals; reply with confirm buttons
        if (!result.tasks || result.tasks.length === 0) {
          replyText = "I noticed a task but couldn't extract enough detail. Could you rephrase?";
          break;
        }

        const isImplicit = intent === "implicit_commitment";

        // For implicit capture: disabled when provider is workers_ai/mock
        if (isImplicit && isMockOrWorkers) {
          // Silently skip — no capture suggestion from degraded provider
          replyText = result.reply_text || "";
          break;
        }

        const proposals: string[] = [];
        for (const task of result.tasks.slice(0, 3)) {
          // Resolve anchor times (never let LLM produce clock times for anchors)
          const resolved = await resolveAnchorTime(db, task, now, env);
          if (!resolved.ok && resolved.needsInfo) {
            // Ask user for the missing info
            replyText = resolved.question || "What time should I schedule this?";
            replyMarkup = resolved.buttons;
            break;
          }

          // Check for past time — offer alternatives
          if (resolved.utcInstant && resolved.utcInstant.getTime() < now.getTime()) {
            replyText = "That time is already past. When did you want this?";
            replyMarkup = makeInlineKeyboard([
              { text: "In 30 min", callback_data: `reschedule:${resolved.proposalId}:+30m` },
              { text: "Tomorrow same time", callback_data: `reschedule:${resolved.proposalId}:+1d` },
            ]);
            break;
          }

          // Duplicate guard: same title+time within 5 min
          const dupCheck = await db
            .prepare(
              `SELECT id FROM task_proposals
               WHERE title = ? AND status = 'pending'
                 AND created_at >= datetime('now', '-5 minutes')`
            )
            .bind(task.title)
            .first<{ id: string }>();
          if (dupCheck) {
            proposals.push(dupCheck.id);
            continue;
          }

          const propId = await createProposalFromTask(db, task, resolved, intent, now);
          proposals.push(propId);
        }

        if (proposals.length > 0 && !replyText.startsWith("That time") && !replyText.includes("What time")) {
          const taskSummary = result.tasks
            .slice(0, proposals.length)
            .map((t) => `- ${t.title}${t.date_phrase ? " (" + t.date_phrase + ")" : ""}`)
            .join("\n");

          if (isImplicit) {
            // Send normal reply first, then compact one-line implicit suggestion (Part 1 Item 3)
            const task0 = result.tasks[0];
            const resolvedTimeStr = (() => {
              try {
                const r = { localDate: task0.date_phrase || "today", localTime: task0.hour !== null && task0.hour !== undefined ? `${String(task0.hour).padStart(2,"0")}:${String(task0.minute||0).padStart(2,"0")}` : null };
                if (r.localDate && r.localTime) return `${r.localDate} ${r.localTime}`;
                if (r.localDate) return r.localDate;
                return "Pick time";
              } catch { return "Pick time"; }
            })();
            const chatPart = result.reply_text ? result.reply_text + "\n\n" : "";
            replyText = chatPart +
              `Picked up: ${task0.title}. Nudge you when?`;
            replyMarkup = { inline_keyboard: [[
              { text: resolvedTimeStr !== "Pick time" ? resolvedTimeStr : "Pick time", callback_data: `confirm_proposal:${proposals[0]}` },
              { text: "Pick time", callback_data: `change_time:${proposals[0]}` },
              { text: "Not a task", callback_data: `not_a_task:${proposals[0]}` },
            ]] };
          } else {
            replyText = `Got it! Here's what I'll save:\n${taskSummary}\n\nConfirm?`;
            replyMarkup = makeInlineKeyboard([
              { text: "Confirm", callback_data: `confirm_proposal:${proposals[0]}` },
              { text: "Change time", callback_data: `change_time:${proposals[0]}` },
              { text: "Cancel", callback_data: `reject_proposal:${proposals[0]}` },
            ]);
          }
        }
        break;
      }

      // -------------------------
      case "query_schedule":
      case "query_tasks": {
        // LLM reply_text is DISCARDED for query intents; render from D1 rows
        const queryResult = await renderQueryAnswer(db, result.query, now, env);
        replyText = queryResult;
        // No replyMarkup for queries
        break;
      }

      // -------------------------
      case "modify_pending": {
        // Edits ONLY pending proposals, bound by reply_to_message_id
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
      case "remember": {
        // remember goes through a confirm proposal like tasks (Part 1 Item 6)
        if (result.memory?.text) {
          const memText = result.memory.text.slice(0, 500);
          const propId = "prop_" + ulid();
          const nowStr = now.toISOString();
          try {
            await db
              .prepare(
                `INSERT INTO task_proposals
                   (id, title, date_role, status, advisory_confidence, created_at, updated_at)
                 VALUES (?, ?, 'memory', 'pending', 0.9, ?, ?)`
              )
              .bind(propId, memText, nowStr, nowStr)
              .run();
            replyText = `Remember this?\n"${memText.slice(0, 150)}"`;
            replyMarkup = makeInlineKeyboard([
              { text: "Confirm", callback_data: `confirm_proposal:${propId}` },
              { text: "Cancel", callback_data: `reject_proposal:${propId}` },
            ]);
          } catch {
            replyText = "Couldn't save that memory right now.";
          }
        } else {
          replyText = result.reply_text || "What would you like me to remember?";
        }
        break;
      }

      default: {
        replyText = result.reply_text || "I'm not sure what you mean. Could you clarify?";
      }
    }

    // Send reply
    if (!replyText) replyText = "Done.";

    await sendTelegramMessage(botToken, chatId, replyText, replyMarkup).catch(() => {});

    // Audit log
    await logChatMessage(db, {
      updateId, chatId, messageId, role: "assistant",
      text: replyText.slice(0, 500),
      intent,
      confidence: result.confidence,
      provider: providerUsed,
      latencyMs,
      outcome: "sent",
      status: "sent",
    });

  } finally {
    await releaseLease(db, String(chatId), updateId);
  }
}

// ---------------------------------------------------------------------------
// Exported entry point (called from index.ts webhook handler)
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
}

/**
 * Handle a non-slash plain-text Telegram message.
 * Returns HTTP 200 immediately; AI work runs in ctx.waitUntil.
 */
export function handleNonSlashMessage(context: ConversationContext): Response {
  const { db, env, chatId, updateId, messageId, text, now, ctx, replyToMessageId } = context;

  ctx.waitUntil(
    handleConversation(db, env, chatId, updateId, messageId, text, now, replyToMessageId).catch(
      (e) => console.error("[Conversation] Unhandled error:", e)
    )
  );

  return Response.json({ ok: true, routed: true, command: "conversation" });
}

/**
 * Legacy export kept for backward compatibility with index.ts callsite.
 * Synchronously persists nothing; always returns a stub result so the caller
 * can send HTTP 200 and the real work runs async.
 */
export async function handlePlainText(
  text: string,
  context: { db: D1Database; updateId: number; senderId: any; chatId: any; env: any },
  _now?: Date
): Promise<{ command: string; args: string; success: boolean; response: string; _async: boolean }> {
  // Legacy path: return a stub — the caller in index.ts now routes to handleNonSlashMessage.
  // This export is kept so old tests that import it don't break.
  return {
    command: "conversation",
    args: text,
    success: true,
    response: "",
    _async: true,
  };
}
