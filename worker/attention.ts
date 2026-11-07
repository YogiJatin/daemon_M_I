/**
 * worker/attention.ts — Attention Budget Engine and Telegram /attention command
 *
 * Implements Phase 1 (Block 4) attention budget governance:
 * - Pool A: First-fire reminders I set are NEVER capped, delayed, or suppressed.
 *           Re-nudges capped at 4/day.
 * - Pool B: Autonomous briefings capped at 2/day (morning & evening).
 *           Urgent pings capped at 1/day.
 * - Quiet hours: 23:00 to 07:00 IST. Suppresses everything except first-fire reminders.
 * - Deterministic /attention command renderer (ZERO LLM calls).
 */

import { getISTDateParts } from "./dateParser";

export type AttentionPool = "pool_a" | "pool_b";
export type AttentionReason =
  | "first_fire"
  | "re_nudge"
  | "briefing"
  | "urgent_ping"
  | "heartbeat"
  | "system";

export interface AttentionCheckResult {
  allowed: boolean;
  reason?: string;
  isQuietHours: boolean;
  pool: AttentionPool;
}

export const ATTENTION_LIMITS = {
  pool_a: {
    first_fire: Infinity, // Rule: never capped, never delayed
    re_nudge: 4,          // max 4 re-nudges per IST day
  },
  pool_b: {
    briefing: 2,          // Morning (08:00) & Evening (20:30)
    urgent_ping: 1,       // max 1 urgent ping per day
  },
};

/**
 * Check if the given time is within quiet hours (23:00 - 07:00 IST)
 */
export function isQuietHoursIST(now: Date = new Date()): boolean {
  const parts = getISTDateParts(now);
  const hour = parseInt(parts.hours, 10); // 0 to 23
  return hour >= 23 || hour < 7;
}

/**
 * Get the IST date boundaries (UTC ISO start and end) for today
 */
export function getISTDayRange(now: Date = new Date()): { localDate: string; startIso: string; endIso: string } {
  const parts = getISTDateParts(now);
  const localDate = parts.localDate; // YYYY-MM-DD
  // IST is UTC+05:30. Day starts at localDate 00:00:00 IST = (previous day 18:30:00 UTC)
  const [year, month, day] = localDate.split("-").map(Number);
  const startUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - 5.5 * 3600 * 1000);
  const endUtc = new Date(startUtc.getTime() + 24 * 3600 * 1000);

  return {
    localDate,
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
  };
}

/**
 * Query current day's usage counts from attention_log
 */
export async function getAttentionUsageToday(
  db: D1Database,
  now: Date = new Date()
): Promise<{
  first_fire: number;
  re_nudge: number;
  briefing: number;
  urgent_ping: number;
}> {
  const { startIso, endIso } = getISTDayRange(now);
  const rows = await db
    .prepare(
      `SELECT reason, COUNT(*) as cnt
       FROM attention_log
       WHERE created_at >= ? AND created_at < ?
       GROUP BY reason`
    )
    .bind(startIso, endIso)
    .all<{ reason: string; cnt: number }>();

  const usage = {
    first_fire: 0,
    re_nudge: 0,
    briefing: 0,
    urgent_ping: 0,
  };

  for (const r of rows.results || []) {
    if (r.reason === "first_fire") usage.first_fire = r.cnt;
    else if (r.reason === "re_nudge") usage.re_nudge = r.cnt;
    else if (r.reason === "briefing") usage.briefing = r.cnt;
    else if (r.reason === "urgent_ping") usage.urgent_ping = r.cnt;
  }

  return usage;
}

/**
 * Determines whether an outbound notification can be dispatched under attention constraints
 */
export async function canDispatchAttention(
  db: D1Database,
  reason: AttentionReason,
  now: Date = new Date()
): Promise<AttentionCheckResult> {
  const quietHours = isQuietHoursIST(now);

  // Hard Rule: A reminder explicitly set is NEVER capped, delayed, or suppressed by quiet hours
  if (reason === "first_fire") {
    return {
      allowed: true,
      isQuietHours: quietHours,
      pool: "pool_a",
    };
  }

  // During quiet hours (23:00 - 07:00 IST), everything else is suppressed
  if (quietHours) {
    return {
      allowed: false,
      reason: "Suppressed: Quiet hours active (23:00 - 07:00 IST)",
      isQuietHours: true,
      pool: reason === "re_nudge" ? "pool_a" : "pool_b",
    };
  }

  const usage = await getAttentionUsageToday(db, now);

  if (reason === "re_nudge") {
    if (usage.re_nudge >= ATTENTION_LIMITS.pool_a.re_nudge) {
      return {
        allowed: false,
        reason: `Suppressed: Pool A re-nudge daily cap exhausted (${usage.re_nudge}/${ATTENTION_LIMITS.pool_a.re_nudge})`,
        isQuietHours: false,
        pool: "pool_a",
      };
    }
    return { allowed: true, isQuietHours: false, pool: "pool_a" };
  }

  if (reason === "briefing") {
    if (usage.briefing >= ATTENTION_LIMITS.pool_b.briefing) {
      return {
        allowed: false,
        reason: `Suppressed: Pool B briefing daily cap exhausted (${usage.briefing}/${ATTENTION_LIMITS.pool_b.briefing})`,
        isQuietHours: false,
        pool: "pool_b",
      };
    }
    return { allowed: true, isQuietHours: false, pool: "pool_b" };
  }

  if (reason === "urgent_ping") {
    if (usage.urgent_ping >= ATTENTION_LIMITS.pool_b.urgent_ping) {
      return {
        allowed: false,
        reason: `Suppressed: Pool B urgent ping daily cap exhausted (${usage.urgent_ping}/${ATTENTION_LIMITS.pool_b.urgent_ping})`,
        isQuietHours: false,
        pool: "pool_b",
      };
    }
    return { allowed: true, isQuietHours: false, pool: "pool_b" };
  }

  // System/heartbeat logs
  return { allowed: true, isQuietHours: false, pool: "pool_b" };
}

/**
 * Log an outbound send to attention_log
 */
export async function logAttentionSend(
  db: D1Database,
  channel: "telegram" | "web_push",
  pool: AttentionPool,
  reason: AttentionReason,
  chatId: string | number,
  textSnippet: string,
  messageId?: string | number,
  now: Date = new Date()
): Promise<void> {
  const id = `attn_${crypto.randomUUID()}`;
  const snippet = (textSnippet || "").slice(0, 120);
  const nowIso = now.toISOString();

  await db
    .prepare(
      `INSERT INTO attention_log (id, channel, pool, reason, message_id, chat_id, text_snippet, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      channel,
      pool,
      reason,
      messageId ? String(messageId) : null,
      String(chatId),
      snippet,
      nowIso
    )
    .run()
    .catch(() => {});
}

/**
 * Renders the /attention command reply deterministically
 */
export async function renderAttentionReport(db: D1Database, now: Date = new Date()): Promise<string> {
  const { localDate } = getISTDayRange(now);
  const parts = getISTDateParts(now);
  const quietHours = isQuietHoursIST(now);
  const usage = await getAttentionUsageToday(db, now);

  const timeStr = `${String(parts.hours).padStart(2, "0")}:${String(parts.minutes).padStart(2, "0")} IST`;

  return [
    `📊 *Attention Budget Status* (${localDate} ${timeStr})`,
    "",
    `🌙 *Quiet Hours (23:00–07:00 IST)*: ${quietHours ? "ACTIVE (Suppression enabled)" : "Inactive"}`,
    "",
    "🎯 *Pool A (Reminders & Tasks)*",
    `• First-Fire Reminders: ${usage.first_fire} sent (Uncapped)`,
    `• Automated Re-nudges: ${usage.re_nudge} / ${ATTENTION_LIMITS.pool_a.re_nudge} used`,
    "",
    "🤖 *Pool B (Autonomous OS Proactivity)*",
    `• Scheduled Briefings: ${usage.briefing} / ${ATTENTION_LIMITS.pool_b.briefing} used`,
    `• Urgent Pings: ${usage.urgent_ping} / ${ATTENTION_LIMITS.pool_b.urgent_ping} used`,
    "",
    `_Policy: User-scheduled reminders are never capped or suppressed._`,
  ].join("\n");
}
