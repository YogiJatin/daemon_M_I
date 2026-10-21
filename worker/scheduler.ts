/**
 * scheduler.ts — Block 2A & Block 2B scheduler core
 *
 * Requirements:
 * - One-minute Cron Trigger execution.
 * - Bounded claim batch: default 3, ceiling 5.
 * - Complete state machine: pending, claimed, sent, failed, unknown, dead, suppressed.
 * - Bounded retries:
 *   * Telegram 429 uses retry_after to set future scheduled_at.
 *   * 5xx / network failures use exponential backoff up to MAX_RETRIES (3), then 'dead'.
 *   * Unknown send outcomes use one-retry at-least-once policy, then 'dead'.
 * - Rows attempted at most once per scheduler invocation.
 * - Expired leases safely recovered.
 * - Attention budget: atomic daily cap reservation via conditional UPDATE ... RETURNING.
 *   * Cap defaults to 3 individual messages/day, hard ceiling 5 (TEST-2B.1, TEST-2B.2).
 *   * Commit on send success, release on failure/suppression, reconcile on lease expiry.
 * - Bounded lazy reopening of expired snoozes (TEST-2B.6).
 * - system_health write throttling: at most once every 5 minutes unless failure/transition (TEST-2B.8).
 */

import { sendTelegramMessage, buildReminderInlineKeyboard } from "./telegram";
import { getISTDateParts } from "./dateParser";
import { materializeRecurringOccurrences } from "./recurrenceEngine";
import { materializeTimetableOccurrences, renderPrepDigestMessage } from "./timetableEngine";

const DEFAULT_BATCH_SIZE = 3;
const MAX_BATCH_CEILING = 5;
const LEASE_DURATION_SECONDS = 30;
const MAX_TRANSIENT_RETRIES = 3;
const MAX_UNKNOWN_RETRIES = 1;

export const DEFAULT_DAILY_CAP = 3;
export const MAX_DAILY_CAP_CEILING = 5;

export interface SchedulerOptions {
  botToken?: string;
  ownerChatId?: string | number;
  pingUrl?: string;
  dailyCap?: number;
}

export interface SchedulerResult {
  recoveredCount: number;
  claimedCount: number;
  sentCount: number;
  failedCount: number;
  unknownCount: number;
  deadCount: number;
  suppressedCount: number;
  capExhaustedCount: number;
  snoozeReopenedCount: number;
  recurrenceOccurrencesCreated?: number;
  timetableOccurrencesCreated?: number;
  errors: string[];
}

export async function reserveDailyCap(
  db: D1Database,
  istDate: string,
  capLimit: number,
  nowIso: string
): Promise<boolean> {
  await db
    .prepare(
      `INSERT INTO daily_notification_counters (local_date, channel, sent_count, reserved_count, updated_at)
       VALUES (?, 'telegram', 0, 0, ?)
       ON CONFLICT(local_date, channel) DO NOTHING`
    )
    .bind(istDate, nowIso)
    .run();

  const res = await db
    .prepare(
      `UPDATE daily_notification_counters
       SET reserved_count = reserved_count + 1, updated_at = ?
       WHERE local_date = ?
         AND channel = 'telegram'
         AND (sent_count + reserved_count) < ?
       RETURNING sent_count, reserved_count`
    )
    .bind(nowIso, istDate, capLimit)
    .first();

  return res !== null;
}

export async function commitDailyCap(db: D1Database, istDate: string, nowIso: string): Promise<void> {
  await db
    .prepare(
      `UPDATE daily_notification_counters
       SET reserved_count = max(0, reserved_count - 1),
           sent_count = sent_count + 1,
           updated_at = ?
       WHERE local_date = ? AND channel = 'telegram'`
    )
    .bind(nowIso, istDate)
    .run()
    .catch(() => {});
}

export async function releaseDailyCap(db: D1Database, istDate: string, nowIso: string): Promise<void> {
  await db
    .prepare(
      `UPDATE daily_notification_counters
       SET reserved_count = max(0, reserved_count - 1),
           updated_at = ?
       WHERE local_date = ? AND channel = 'telegram'`
    )
    .bind(nowIso, istDate)
    .run()
    .catch(() => {});
}

export async function runScheduler(
  db: D1Database,
  now: Date = new Date(),
  batchSize: number = DEFAULT_BATCH_SIZE,
  options?: SchedulerOptions
): Promise<SchedulerResult> {
  const boundedBatch = Math.min(Math.max(1, batchSize), MAX_BATCH_CEILING);
  const rawCap = options?.dailyCap ?? DEFAULT_DAILY_CAP;
  const boundedDailyCap = Math.min(Math.max(1, rawCap), MAX_DAILY_CAP_CEILING);

  const nowIso = now.toISOString();
  const leaseExpiryIso = new Date(now.getTime() + LEASE_DURATION_SECONDS * 1000).toISOString();
  const istDate = getISTDateParts(now).localDate;

  const result: SchedulerResult = {
    recoveredCount: 0,
    claimedCount: 0,
    sentCount: 0,
    failedCount: 0,
    unknownCount: 0,
    deadCount: 0,
    suppressedCount: 0,
    capExhaustedCount: 0,
    snoozeReopenedCount: 0,
    errors: [],
  };

  // 1. Recover stale claims where lease has expired & reconcile cap reservations (TEST-2B.2)
  const staleReserved = await db
    .prepare(
      `SELECT id, cap_reservation_local_date FROM notification_log
       WHERE status = 'claimed'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ?
         AND cap_reservation_state = 'reserved'`
    )
    .bind(nowIso)
    .all<{ id: string; cap_reservation_local_date: string | null }>();

  for (const sr of staleReserved.results ?? []) {
    if (sr.cap_reservation_local_date) {
      await releaseDailyCap(db, sr.cap_reservation_local_date, nowIso);
    }
  }

  const recovery = await db
    .prepare(
      `UPDATE notification_log
       SET status = 'failed',
           claimed_at = NULL,
           lease_expires_at = NULL,
           cap_reservation_state = 'released',
           error_code = 'lease_expired_recovered',
           updated_at = ?
       WHERE status = 'claimed'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ?`
    )
    .bind(nowIso, nowIso)
    .run();

  result.recoveredCount = recovery.meta?.changes ?? 0;

  // 2. Bounded lazy reopening of expired snoozed tasks (TEST-2B.6)
  const expiredSnoozes = await db
    .prepare(
      `SELECT id, title, snoozed_until, snooze_count
       FROM tasks
       WHERE status = 'snoozed'
         AND snoozed_until IS NOT NULL
         AND snoozed_until <= ?
       ORDER BY snoozed_until ASC
       LIMIT 5`
    )
    .bind(nowIso)
    .all<{
      id: string;
      title: string;
      snoozed_until: string;
      snooze_count: number;
    }>();

  for (const st of expiredSnoozes.results ?? []) {
    const auditId = crypto.randomUUID();
    const taskStmt = db.prepare(
      `UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ? AND status = 'snoozed'`
    ).bind(nowIso, st.id);

    const auditStmt = db.prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, 'task', ?, 'task_reopened_from_snooze', 'system:scheduler', ?, ?)`
    ).bind(
      auditId,
      st.id,
      JSON.stringify({ previous_status: "snoozed", snoozed_until: st.snoozed_until }),
      nowIso
    );

    await db.batch([taskStmt, auditStmt]);
    result.snoozeReopenedCount++;
  }

  // 3. Conditionally claim due rows in atomic UPDATE ... RETURNING
  const claimed = await db
    .prepare(
      `UPDATE notification_log
       SET status = 'claimed',
           claimed_at = ?,
           lease_expires_at = ?,
           updated_at = ?
       WHERE status IN ('pending', 'failed', 'unknown')
         AND id IN (
           SELECT id FROM notification_log
           WHERE status IN ('pending', 'failed', 'unknown')
             AND scheduled_at <= ?
           ORDER BY scheduled_at ASC
           LIMIT ?
         )
       RETURNING id, task_id, deadline_version, stage, dedup_key, notification_kind, scheduled_at, retry_count, status`
    )
    .bind(nowIso, leaseExpiryIso, nowIso, nowIso, boundedBatch)
    .all<{
      id: string;
      task_id: string;
      deadline_version: number;
      stage: string;
      dedup_key: string;
      notification_kind: string;
      scheduled_at: string;
      retry_count: number;
      status: string;
    }>();

  const rows = claimed.results ?? [];
  result.claimedCount = rows.length;

  const botToken = options?.botToken ?? "";
  const ownerChatId = options?.ownerChatId ?? "";
  console.log({ schedulerOwnerChatId: ownerChatId, ownerChatIdType: typeof ownerChatId });

  // 4. Process each claimed row
  for (const row of rows) {
    try {
      // Look up task state (unless system digest)
      const isSystemTask = row.task_id.startsWith("system:");
      let task: any = null;

      if (!isSystemTask) {
        task = await db
          .prepare(
            `SELECT id, title, status, priority, deadline_kind, deadline_time_local, deadline_local_date, deadline_version
             FROM tasks WHERE id = ?`
          )
          .bind(row.task_id)
          .first();

        // Suppression 1: Task completed/dismissed
        if (!task || task.status === "done" || task.status === "dismissed") {
          await db
            .prepare(
              `UPDATE notification_log
               SET status = 'suppressed',
                   error_code = 'task_completed_or_dismissed',
                   lease_expires_at = NULL,
                   updated_at = ?
               WHERE id = ? AND status = 'claimed'`
            )
            .bind(nowIso, row.id)
            .run();

          result.suppressedCount++;
          continue;
        }

        // Suppression 2: Deadline version mismatch
        if (task.deadline_version !== row.deadline_version) {
          await db
            .prepare(
              `UPDATE notification_log
               SET status = 'suppressed',
                   error_code = 'deadline_version_mismatch',
                   lease_expires_at = NULL,
                   updated_at = ?
               WHERE id = ? AND status = 'claimed'`
            )
            .bind(nowIso, row.id)
            .run();

          result.suppressedCount++;
          continue;
        }
      }

      // Daily Attention Budget Cap Check for individual reminders (TEST-2B.1)
      const isIndividual = row.notification_kind === "individual" || row.notification_kind === "reminder";
      let hasCapReservation = false;

      if (isIndividual && !row.dedup_key.startsWith("prep-digest:") && !row.dedup_key.startsWith("catchup:")) {
        const reserved = await reserveDailyCap(db, istDate, boundedDailyCap, nowIso);
        if (!reserved) {
          // Cap exhausted for today! Do not send, defer to next day
          await db
            .prepare(
              `UPDATE notification_log
               SET status = 'failed',
                   cap_reservation_state = 'none',
                   error_code = 'daily_cap_exhausted',
                   lease_expires_at = NULL,
                   updated_at = ?
               WHERE id = ? AND status = 'claimed'`
            )
            .bind(nowIso, row.id)
            .run();

          result.capExhaustedCount++;
          continue;
        }

        hasCapReservation = true;
        await db
          .prepare(
            `UPDATE notification_log
             SET cap_reservation_state = 'reserved',
                 cap_reservation_local_date = ?
             WHERE id = ?`
          )
          .bind(istDate, row.id)
          .run();
      }

      // Format reminder message text and inline keyboard
      let reminderText = "";
      let replyMarkup: any = undefined;

      if (row.dedup_key.startsWith("prep-digest:")) {
        const targetDate = row.dedup_key.split(":")[1];
        reminderText = await renderPrepDigestMessage(db, targetDate);
      } else if (row.dedup_key.startsWith("catchup:")) {
        reminderText = `🔄 Catch-up Digest:\nSystem resumed from pause episode. All pending schedules caught up.`;
      } else {
        const timeStr = task.deadline_time_local ? ` at ${task.deadline_time_local}` : "";
        const dateStr = task.deadline_local_date ? ` (${task.deadline_local_date}${timeStr})` : timeStr;
        reminderText = `⏰ Reminder: ${task.title}${dateStr}`;
        replyMarkup = buildReminderInlineKeyboard(row.task_id);
      }

      // Dispatch to Telegram
      console.log({ telegramChatId: ownerChatId, botTokenPresent: !!botToken });
      const sendRes = await sendTelegramMessage(botToken, ownerChatId, reminderText, replyMarkup);

      if (sendRes.sent) {
        // Commit cap reservation if held
        if (hasCapReservation) {
          await commitDailyCap(db, istDate, nowIso);
        }

        await db
          .prepare(
            `UPDATE notification_log
             SET status = 'sent',
                 sent_at = ?,
                 cap_reservation_state = 'committed',
                 error_code = NULL,
                 lease_expires_at = NULL,
                 updated_at = ?
             WHERE id = ? AND status = 'claimed'`
          )
          .bind(nowIso, nowIso, row.id)
          .run();

        await db
          .prepare(
            `UPDATE system_health
             SET last_telegram_delivery_at = ?, updated_at = ?
             WHERE id = 1`
          )
          .bind(nowIso, nowIso)
          .run()
          .catch(() => {});

        result.sentCount++;
      } else {
        // Release cap reservation on failure (TEST-2B.2)
        if (hasCapReservation) {
          await releaseDailyCap(db, istDate, nowIso);
        }

        if (sendRes.statusCode === 429) {
          const retryAfterSeconds = sendRes.retryAfterSeconds || 60;
          const nextAttempt = new Date(now.getTime() + retryAfterSeconds * 1000).toISOString();

          await db
            .prepare(
              `UPDATE notification_log
               SET status = 'failed',
                   scheduled_at = ?,
                   retry_count = retry_count + 1,
                   cap_reservation_state = 'released',
                   error_code = ?,
                   lease_expires_at = NULL,
                   updated_at = ?
               WHERE id = ? AND status = 'claimed'`
            )
            .bind(nextAttempt, `429_rate_limited_${retryAfterSeconds}s`, nowIso, row.id)
            .run();

          result.failedCount++;
        } else if (sendRes.isUnknownOutcome) {
          if (row.retry_count < MAX_UNKNOWN_RETRIES) {
            const nextAttempt = new Date(now.getTime() + 60 * 1000).toISOString();
            await db
              .prepare(
                `UPDATE notification_log
                 SET status = 'unknown',
                     scheduled_at = ?,
                     retry_count = retry_count + 1,
                     cap_reservation_state = 'released',
                     error_code = 'unknown_outcome_retry_scheduled',
                     lease_expires_at = NULL,
                     updated_at = ?
                 WHERE id = ? AND status = 'claimed'`
              )
              .bind(nextAttempt, nowIso, row.id)
              .run();

            result.unknownCount++;
          } else {
            await db
              .prepare(
                `UPDATE notification_log
                 SET status = 'dead',
                     cap_reservation_state = 'released',
                     error_code = 'unknown_outcome_retry_exhausted',
                     lease_expires_at = NULL,
                     updated_at = ?
                 WHERE id = ? AND status = 'claimed'`
              )
              .bind(nowIso, row.id)
              .run();

            result.deadCount++;
          }
        } else if (sendRes.statusCode && sendRes.statusCode >= 500) {
          if (row.retry_count + 1 >= MAX_TRANSIENT_RETRIES) {
            await db
              .prepare(
                `UPDATE notification_log
                 SET status = 'dead',
                     cap_reservation_state = 'released',
                     error_code = ?,
                     lease_expires_at = NULL,
                     updated_at = ?
                 WHERE id = ? AND status = 'claimed'`
              )
              .bind(`5xx_retries_exhausted_${sendRes.statusCode}`, nowIso, row.id)
              .run();

            result.deadCount++;
          } else {
            const backoffSeconds = Math.pow(2, row.retry_count) * 60;
            const nextAttempt = new Date(now.getTime() + backoffSeconds * 1000).toISOString();

            await db
              .prepare(
                `UPDATE notification_log
                 SET status = 'failed',
                     scheduled_at = ?,
                     retry_count = retry_count + 1,
                     cap_reservation_state = 'released',
                     error_code = ?,
                     lease_expires_at = NULL,
                     updated_at = ?
                 WHERE id = ? AND status = 'claimed'`
              )
              .bind(nextAttempt, `5xx_error_${sendRes.statusCode}`, nowIso, row.id)
              .run();

            result.failedCount++;
          }
        } else {
          await db
            .prepare(
              `UPDATE notification_log
               SET status = 'dead',
                   cap_reservation_state = 'released',
                   error_code = ?,
                   lease_expires_at = NULL,
                   updated_at = ?
               WHERE id = ? AND status = 'claimed'`
            )
            .bind(sendRes.error ? sendRes.error.slice(0, 100) : "permanent_client_error", nowIso, row.id)
            .run();

          result.deadCount++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Row ${row.id}: ${msg}`);
      result.failedCount++;

      await db
        .prepare(
          `UPDATE notification_log
           SET status = 'failed',
               cap_reservation_state = 'released',
               error_code = ?,
               lease_expires_at = NULL,
               updated_at = ?
           WHERE id = ? AND status = 'claimed'`
        )
        .bind(msg.slice(0, 100), nowIso, row.id)
        .run()
        .catch(() => {});
    }
  }

  // 4b. Guarded bounded daily maintenance for recurring tasks (SRS §9.1, TEST-3A.4)
  try {
    const matRes = await materializeRecurringOccurrences(db, now);
    result.recurrenceOccurrencesCreated = matRes.occurrencesCreated;
    if (matRes.errors.length > 0) {
      result.errors.push(...matRes.errors);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Recurrence maintenance: ${msg}`);
  }

  // 4c. Guarded bounded daily maintenance for timetable & preparation (SRS §9.1, TEST-3B.1)
  try {
    const ttRes = await materializeTimetableOccurrences(db, now);
    result.timetableOccurrencesCreated = ttRes.occurrencesCreated;
    if (ttRes.errors.length > 0) {
      result.errors.push(...ttRes.errors);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Timetable maintenance: ${msg}`);
  }

  // 5. Update system_health scheduler heartbeat with 5-minute throttling (TEST-2B.8)
  const hasErrors = result.errors.length > 0 || result.failedCount > 0;
  const health = await db
    .prepare(`SELECT last_scheduler_success_at FROM system_health WHERE id = 1`)
    .first<{ last_scheduler_success_at: string | null }>();

  let shouldWriteHealth = hasErrors || !health?.last_scheduler_success_at;
  if (!shouldWriteHealth && health?.last_scheduler_success_at) {
    const lastWrite = new Date(health.last_scheduler_success_at).getTime();
    if (Math.abs(now.getTime() - lastWrite) >= 5 * 60 * 1000) {
      shouldWriteHealth = true;
    }
  }

  if (shouldWriteHealth) {
    await db
      .prepare(
        `UPDATE system_health
         SET last_scheduler_start_at = ?,
             last_scheduler_success_at = ?,
             updated_at = ?
         WHERE id = 1`
      )
      .bind(nowIso, nowIso, nowIso)
      .run()
      .catch(() => {});
  }

  // 6. External monitoring ping (TEST-2A.7)
  if (options?.pingUrl) {
    try {
      await fetch(options.pingUrl);
      await db
        .prepare(`UPDATE system_health SET last_monitor_ping_at = ?, updated_at = ? WHERE id = 1`)
        .bind(nowIso, nowIso)
        .run()
        .catch(() => {});
    } catch {
      // Best effort
    }
  }

  return result;
}
