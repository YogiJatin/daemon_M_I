/**
 * worker/chatSweeper.ts - Cron Sweeper for Inbound Telegram Chat Messages (Part A1 + Fix Brief 0 F4)
 *
 * Requirements (F4):
 * - Sweeper covers 'received', 'queued', AND 'processing' older than 60s.
 * - At most 2 fallback sends per message, then status='failed_final' and never again.
 * - Success on send marks user status='done'.
 * - Skip rows not belonging to the owner chat or the private test group.
 * - Adds attempts and last_attempt_at tracking.
 * - Cleans up expired chat_leases.
 * - Zero AI module imports.
 */

import { sendTelegramMessage } from "./telegram";

function ulid(): string {
  const ts = Date.now().toString(36).padStart(8, "0");
  const rand = Math.random().toString(36).slice(2, 10).padStart(8, "0");
  return (ts + rand).toUpperCase();
}

const DEFAULT_PRIVATE_TEST_GROUP = "-10022334455";

export async function sweepStaleChatMessages(
  db: D1Database,
  botToken: string,
  now: Date = new Date(),
  ownerChatId?: string | number
): Promise<number> {
  const cutoff = new Date(now.getTime() - 60_000).toISOString();
  const nowIso = now.toISOString();

  let sweptCount = 0;
  try {
    const stale = await db
      .prepare(
        `SELECT id, update_id, chat_id, message_id, text, attempts
         FROM chat_messages
         WHERE role = 'user'
           AND status IN ('received', 'queued', 'processing')
           AND status != 'failed_final'
           AND attempts < 2
           AND created_at < ?`
      )
      .bind(cutoff)
      .all<{
        id: string;
        update_id: number;
        chat_id: string;
        message_id: number;
        text: string;
        attempts: number;
      }>();

    for (const row of stale.results || []) {
      const attempts = (row.attempts || 0) + 1;
      const chatIdStr = String(row.chat_id);

      // Skip rows not belonging to the owner chat or the private test group (F4)
      const isAllowedChat =
        (ownerChatId && chatIdStr === String(ownerChatId)) ||
        chatIdStr === DEFAULT_PRIVATE_TEST_GROUP;

      if (!isAllowedChat) {
        // Mark failed_final and never send to unknown / synthetic runner chats
        await db
          .prepare(
            `UPDATE chat_messages
             SET status = 'failed_final', attempts = ?, last_attempt_at = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(attempts, nowIso, nowIso, row.id)
          .run()
          .catch(() => {});
        continue;
      }

      sweptCount++;
      const replyText = "AI is offline right now. Your message was not lost.";
      const markup = {
        inline_keyboard: [
          [
            {
              text: "Save as untimed task",
              callback_data: `save_untimed:${encodeURIComponent((row.text || "").slice(0, 200))}`,
            },
          ],
        ],
      };

      const sendRes = await sendTelegramMessage(botToken, row.chat_id, replyText, markup, { db }).catch(() => null);

      if (sendRes?.sent) {
        const asstId = "msg_" + ulid();
        await db
          .prepare(
            `INSERT INTO chat_messages
               (id, update_id, chat_id, message_id, role, text, status, outcome,
                reply_markup, telegram_message_id, attempts, last_attempt_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'assistant', ?, 'sent', 'sweeper_offline_fallback', ?, ?, 1, ?, ?, ?)`
          )
          .bind(
            asstId,
            row.update_id,
            row.chat_id,
            row.message_id,
            replyText,
            JSON.stringify(markup),
            sendRes?.telegramMessageId ?? null,
            nowIso,
            nowIso,
            nowIso
          )
          .run()
          .catch(() => {});

        // Success on send marks done (F4)
        await db
          .prepare(
            `UPDATE chat_messages
             SET status = 'done', attempts = ?, last_attempt_at = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(attempts, nowIso, nowIso, row.id)
          .run()
          .catch(() => {});
      } else {
        // Failed send: if reached 2 attempts, mark failed_final and never again
        const nextStatus = attempts >= 2 ? "failed_final" : "failed";
        await db
          .prepare(
            `UPDATE chat_messages
             SET status = ?, attempts = ?, last_attempt_at = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(nextStatus, attempts, nowIso, nowIso, row.id)
          .run()
          .catch(() => {});
      }
    }

    // Clean up expired chat_leases
    await db
      .prepare("DELETE FROM chat_leases WHERE expires_at < ?")
      .bind(nowIso)
      .run()
      .catch(() => {});
  } catch (err) {
    console.error("[Sweeper] Error sweeping stale chat messages:", err);
  }

  return sweptCount;
}
