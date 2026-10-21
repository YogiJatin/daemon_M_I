/**
 * Telegram sendMessage helper — Block 1, 2A & 2B
 *
 * Sends plain-text messages to the owner's chat.
 * Used for webhook command confirmations and scheduled reminders.
 *
 * Supports:
 * - Real Telegram Bot API calls
 * - Inline keyboard markup for reminders (Done, Snooze, Details)
 * - answerCallbackQuery for Telegram button taps
 * - HTTP 429 detection with retry_after extraction
 * - 5xx / transient error reporting
 * - Unknown outcome detection (timeouts / network interruptions)
 * - Safe mock tokens for local testing (mock:429:<sec>, mock:500, mock:unknown, mock:success)
 */

export interface SendResult {
  sent: boolean;
  statusCode?: number;
  retryAfterSeconds?: number;
  isUnknownOutcome?: boolean;
  telegramMessageId?: number;
  error?: string;
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

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  if (!token || token.startsWith("mock:")) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch {
    // Ignore callback answer failure
  }
}

export async function sendTelegramMessage(
  token: string,
  chatId: number | string,
  text: string,
  replyMarkup?: any
): Promise<SendResult> {
  if (!token) {
    // In dev without a token configured, treat as a local simulated success
    return { sent: true };
  }

  if (
    chatId === undefined ||
    chatId === null ||
    String(chatId).trim() === ""
  ) {
    return {
      sent: false,
      error: "Configuration error: Telegram chat_id is empty",
    };
  }

  // Testing mock support
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
      return {
        sent: false,
        statusCode: status,
        error: `Telegram API ${status}: Server Error`,
      };
    }
    if (mode === "unknown") {
      return {
        sent: false,
        isUnknownOutcome: true,
        error: "Network timeout: request outcome unknown",
      };
    }
    if (mode === "403") {
      return {
        sent: false,
        statusCode: 403,
        error: "Telegram API 403: Forbidden (bot blocked by user)",
      };
    }
    if (mode === "success") {
      return { sent: true, telegramMessageId: 99999 };
    }
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    let resp: Response;
    try {
      const payload: any = { chat_id: chatId, text };
      if (replyMarkup) {
        payload.reply_markup = replyMarkup;
      }
      console.log(payload);

      resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!resp.ok) {
      let retryAfter: number | undefined;
      const rawText = await resp.text().catch(() => "");
      let parsed: any;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        // non-json response
      }

      if (resp.status === 429) {
        if (parsed?.parameters?.retry_after) {
          retryAfter = Number(parsed.parameters.retry_after);
        } else {
          const headerVal = resp.headers.get("Retry-After");
          if (headerVal) retryAfter = parseInt(headerVal, 10);
        }
        if (!retryAfter || isNaN(retryAfter)) {
          retryAfter = 60; // fallback to 60s
        }

        return {
          sent: false,
          statusCode: 429,
          retryAfterSeconds: retryAfter,
          error: `Telegram API 429: ${parsed?.description || rawText}`,
        };
      }

      return {
        sent: false,
        statusCode: resp.status,
        error: `Telegram API ${resp.status}: ${parsed?.description || rawText}`,
      };
    }

    const data = (await resp.json().catch(() => ({}))) as any;
    return {
      sent: true,
      telegramMessageId: data?.result?.message_id,
    };
  } catch (err: any) {
    const isTimeout =
      err?.name === "AbortError" ||
      err?.message?.toLowerCase().includes("timeout") ||
      err?.message?.toLowerCase().includes("network");

    return {
      sent: false,
      isUnknownOutcome: isTimeout,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
