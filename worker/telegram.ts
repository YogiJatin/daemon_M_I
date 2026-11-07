/**
 * worker/telegram.ts - Hardened Telegram Client (Block 1, 2A, 2B + Fix Brief 0)
 *
 * Unified outbound Telegram client fulfilling F2, F3, F6:
 * - 429: wait parameters.retry_after (cap 30s), retry once.
 * - 400 "can't parse entities": resend ONCE as plain text.
 * - 400 permanent ("message is not modified", "message to edit not found", "query is too old", "chat not found", "message to delete not found"): logged, skipped, no retry.
 * - 403 (bot blocked / chat deactivated): stop sending to that chat.
 * - 5xx or network: max 2 retries, 1s then 3s backoff.
 * - Per-chat pacing >= 1.1s; global <= 20 sends/s.
 * - Circuit breaker: 5 consecutive failures pause outbound for 60s.
 * - Cosmetic calls (answerCallbackQuery, editMessageReplyMarkup) are best-effort.
 * - Test isolation (ALLOW_TEST_STUBS): synthetic runner chats stubbed, never hitting real API.
 */

export interface SendResult {
  sent: boolean;
  statusCode?: number;
  retryAfterSeconds?: number;
  isUnknownOutcome?: boolean;
  telegramMessageId?: number;
  error?: string;
  isPermanent?: boolean;
  isStub?: boolean;
}

export interface TelegramOptions {
  testStubs?: boolean;
  db?: D1Database;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
}

// Global in-memory state across requests within isolate
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const lastChatSendTime = new Map<string, number>();
const blockedChats = new Set<string>();

let globalWindowStart = Date.now();
let globalSendCount = 0;
let stubMessageCounter = 900000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Allowed real message chat IDs / whitelist for G03, G06, G07, G17, G19, G23, G35, G41 in test group
const ALLOWED_TEST_REAL_CASES = new Set(["G03", "G06", "G07", "G17", "G19", "G23", "G35", "G41"]);

export function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

export function recordSuccess() {
  consecutiveFailures = 0;
}

export function recordFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= 5) {
    circuitOpenUntil = Date.now() + 60_000;
    console.error(`[Telegram Outbound] Circuit breaker triggered: 5 consecutive failures. Outbound paused for 60s.`);
  }
}

/**
 * Enforces per-chat (>= 1.1s) and global (<= 20 sends/s) pacing
 */
async function enforcePacing(chatIdStr: string) {
  const now = Date.now();

  // 1. Global pacing: max 20 sends / sec
  if (now - globalWindowStart < 1000) {
    if (globalSendCount >= 20) {
      const waitMs = 1000 - (now - globalWindowStart);
      await sleep(waitMs);
      globalWindowStart = Date.now();
      globalSendCount = 0;
    }
  } else {
    globalWindowStart = now;
    globalSendCount = 0;
  }
  globalSendCount++;

  // 2. Per-chat pacing: >= 1.1s
  const lastSend = lastChatSendTime.get(chatIdStr) || 0;
  const elapsed = now - lastSend;
  if (elapsed < 1100) {
    const delay = 1100 - elapsed;
    await sleep(delay);
  }
  lastChatSendTime.set(chatIdStr, Date.now());
}

export function buildReminderInlineKeyboard(taskId: string) {
  const shortId = taskId.slice(0, 8);
  return {
    inline_keyboard: [
      [
        { text: "✅ Done", callback_data: `done:${shortId}` },
        { text: "💤 Snooze", callback_data: `snooze:${shortId}` },
        { text: "ℹ️ Details", callback_data: `details:${shortId}` },
      ],
    ],
  };
}

/**
 * Answer callback query - cosmetic & best-effort (F3)
 */
export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
  options?: TelegramOptions
): Promise<void> {
  if (!token || token.startsWith("mock:")) return;
  if (!callbackQueryId) return;

  // Test stub isolation: fake callback query IDs never reach real API
  if (options?.testStubs || callbackQueryId.startsWith("stub_") || callbackQueryId.startsWith("cb_") || callbackQueryId === "fake_id") {
    return;
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
    const data = (await resp.json().catch(() => ({}))) as any;
    if (!resp.ok) {
      console.warn(`[answerCallbackQuery] Non-2xx response: ${resp.status} ${data?.description || ""}`);
    }
  } catch (err: any) {
    console.warn(`[answerCallbackQuery] Best-effort failure ignored:`, err?.message || err);
  }
}

/**
 * Edit message reply markup - cosmetic & best-effort (F3)
 */
export async function editMessageReplyMarkup(
  token: string,
  chatId: number | string,
  messageId: number,
  replyMarkup: any,
  options?: TelegramOptions
): Promise<void> {
  if (!token || token.startsWith("mock:")) return;
  const chatIdStr = String(chatId);

  if (options?.testStubs || chatIdStr.startsWith("-100223300")) {
    return;
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as any;
    if (!resp.ok) {
      console.warn(`[editMessageReplyMarkup] Non-2xx ignored: ${resp.status} ${data?.description || ""}`);
    }
  } catch (err: any) {
    console.warn(`[editMessageReplyMarkup] Best-effort failure ignored:`, err?.message || err);
  }
}

/**
 * Core outbound Telegram sendMessage with full resilience (F2, F3, F6)
 */
export async function sendTelegramMessage(
  token: string,
  chatId: number | string,
  text: string,
  replyMarkup?: any,
  options?: TelegramOptions
): Promise<SendResult> {
  if (!token) {
    return { sent: true };
  }

  if (chatId === undefined || chatId === null || String(chatId).trim() === "") {
    return { sent: false, error: "Configuration error: Telegram chat_id is empty", isPermanent: true };
  }

  const chatIdStr = String(chatId).trim();

  // Blocked chats check (403 bot blocked / deactivated)
  if (blockedChats.has(chatIdStr)) {
    return { sent: false, statusCode: 403, error: `Chat ${chatIdStr} is blocked or deactivated`, isPermanent: true };
  }

  // Circuit breaker check
  if (isCircuitOpen()) {
    return { sent: false, error: "Circuit breaker open: outbound Telegram paused for 60s" };
  }

  // F6 Test isolation: stub synthetic runner chats (chatId starts with -100223300)
  // Only allowed cases in the real private group reach Telegram API
  const isSyntheticTestChat = chatIdStr.startsWith("-100223300");
  if (options?.testStubs || isSyntheticTestChat) {
    // Record into outbound_telegram_stubs if DB available
    const stubMsgId = ++stubMessageCounter;
    if (options?.db) {
      await options.db
        .prepare(
          `INSERT OR REPLACE INTO outbound_telegram_stubs (id, chat_id, text, reply_markup, created_at)
           VALUES (?, ?, ?, ?, datetime('now'))`
        )
        .bind(`stub_${stubMsgId}`, chatIdStr, text, replyMarkup ? JSON.stringify(replyMarkup) : null)
        .run()
        .catch(() => {});
    }
    return {
      sent: true,
      telegramMessageId: stubMsgId,
      isStub: true,
    };
  }

  // Mock token support for local testing
  if (token.startsWith("mock:")) {
    const parts = token.split(":");
    const mode = parts[1];
    if (mode === "429") {
      const retryAfter = parts[2] ? parseInt(parts[2], 10) : 30;
      return {
        sent: false,
        statusCode: 429,
        retryAfterSeconds: retryAfter,
        error: `Telegram API 429: Too Many Requests (retry after ${retryAfter}s)`,
      };
    }
    if (mode === "500" || mode === "502" || mode === "503") {
      const status = parseInt(mode, 10);
      return { sent: false, statusCode: status, error: `Telegram API ${status}: Server Error` };
    }
    if (mode === "403") {
      blockedChats.add(chatIdStr);
      return { sent: false, statusCode: 403, error: "Telegram API 403: Forbidden (bot blocked by user)", isPermanent: true };
    }
    if (mode === "success") {
      return { sent: true, telegramMessageId: ++stubMessageCounter };
    }
  }

  // Enforce per-chat pacing (>= 1.1s) and global rate (<= 20/s)
  await enforcePacing(chatIdStr);

  const payload: any = { chat_id: chatId, text };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  if (options?.parseMode) {
    payload.parse_mode = options.parseMode;
  }

  const executePost = async (p: any): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      return await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  let resp: Response | null = null;
  let attempts = 0;
  const maxNetworkAttempts = 3; // initial + up to 2 retries on 5xx/network

  while (attempts < maxNetworkAttempts) {
    attempts++;
    try {
      resp = await executePost(payload);
    } catch (networkErr: any) {
      if (attempts < maxNetworkAttempts) {
        const backoffMs = attempts === 1 ? 1000 : 3000;
        await sleep(backoffMs);
        continue;
      }
      recordFailure();
      return {
        sent: false,
        isUnknownOutcome: true,
        error: `Network error sending message to ${chatIdStr}: ${networkErr?.message || networkErr}`,
      };
    }

    if (resp.ok) {
      recordSuccess();
      const data = (await resp.json().catch(() => ({}))) as any;
      return {
        sent: true,
        telegramMessageId: data?.result?.message_id,
      };
    }

    const rawText = await resp.text().catch(() => "");
    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {}

    const desc = parsed?.description || rawText;

    // 429 Flood control
    if (resp.status === 429) {
      let retryAfter = parsed?.parameters?.retry_after ? Number(parsed.parameters.retry_after) : 30;
      if (isNaN(retryAfter) || retryAfter <= 0) retryAfter = 30;

      // Cap at 30s
      if (retryAfter <= 30) {
        console.warn(`[Telegram Outbound] 429 received, waiting retry_after ${retryAfter}s once...`);
        await sleep(retryAfter * 1000);
        try {
          const retryResp = await executePost(payload);
          if (retryResp.ok) {
            recordSuccess();
            const data = (await retryResp.json().catch(() => ({}))) as any;
            return { sent: true, telegramMessageId: data?.result?.message_id };
          }
        } catch {}
      }

      recordFailure();
      return {
        sent: false,
        statusCode: 429,
        retryAfterSeconds: retryAfter,
        error: `Telegram API 429: ${desc}`,
      };
    }

    // 400 "can't parse entities" -> resend ONCE as plain text
    if (resp.status === 400 && /can't parse entities|entity/i.test(desc)) {
      console.warn(`[Telegram Outbound] 400 entity parse error, resending once as plain text...`);
      const plainPayload = { ...payload };
      delete plainPayload.parse_mode;
      try {
        const retryResp = await executePost(plainPayload);
        if (retryResp.ok) {
          recordSuccess();
          const data = (await retryResp.json().catch(() => ({}))) as any;
          return { sent: true, telegramMessageId: data?.result?.message_id };
        }
      } catch {}
      recordFailure();
      return { sent: false, statusCode: 400, error: `Telegram 400 entity parse error: ${desc}`, isPermanent: true };
    }

    // 400 Permanent errors: "message is not modified", "message to edit not found", "query is too old", "chat not found", "message to delete not found"
    if (
      resp.status === 400 &&
      /message is not modified|message to edit not found|query is too old|chat not found|message to delete not found/i.test(desc)
    ) {
      console.warn(`[Telegram Outbound] 400 permanent skipped: ${desc}`);
      return {
        sent: false,
        statusCode: 400,
        isPermanent: true,
        error: `Telegram permanent 400: ${desc}`,
      };
    }

    // 403 Forbidden: bot blocked by user or chat deactivated
    if (resp.status === 403) {
      blockedChats.add(chatIdStr);
      console.warn(`[Telegram Outbound] Chat ${chatIdStr} blocked bot, marked deactivated`);
      return {
        sent: false,
        statusCode: 403,
        isPermanent: true,
        error: `Telegram API 403: ${desc}`,
      };
    }

    // 5xx Server errors: retry up to 2 times with 1s and 3s backoff
    if (resp.status >= 500 && resp.status < 600) {
      if (attempts < maxNetworkAttempts) {
        const backoffMs = attempts === 1 ? 1000 : 3000;
        await sleep(backoffMs);
        continue;
      }
      recordFailure();
      return {
        sent: false,
        statusCode: resp.status,
        error: `Telegram API ${resp.status}: ${desc}`,
      };
    }

    // Other 4xx client errors
    recordFailure();
    return {
      sent: false,
      statusCode: resp.status,
      error: `Telegram API ${resp.status}: ${desc}`,
    };
  }

  recordFailure();
  return { sent: false, error: "Outbound Telegram send failed after retries" };
}
