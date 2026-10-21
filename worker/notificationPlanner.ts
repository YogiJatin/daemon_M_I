/**
 * notificationPlanner.ts — Block 2A & Block 2B
 *
 * Requirements (AGENTS.md & SRS §8.8, §8.9, §16 TEST-2A.1, TEST-2A.4, TEST-2B.3, TEST-2B.4, TEST-2B.5):
 * - Dedup key for deadline stage: {task_id}:{stage}:{deadline_version}
 * - Plan rows when task data changes; no whole-table re-planning in cron.
 * - Do not invent a midnight timestamp for date-only deadlines.
 * - Title-only edits do not increment deadline_version or re-plan.
 * - Deadline edits increment deadline_version and suppress obsolete pending rows.
 * - Quiet hours (22:00 to 06:30 IST): adjust notification to permitted window before deadline.
 * - Exactly one prep digest row per IST date: prep-digest:{IST_date} at 20:30 IST.
 * - Catch-up digest: catchup:{episode_id} planned on resume.
 */

import { ParsedDeadline, getISTDateParts, istToUtcDate } from "./dateParser";

export interface PlanNotificationInput {
  db: D1Database;
  taskId: string;
  deadlineKind: "none" | "date_only" | "timed";
  deadlineAtUtc: string | null;
  deadlineVersion: number;
  stage?: string;
  now: Date;
}

export interface PlanNotificationResult {
  planned: boolean;
  dedupKey?: string;
  scheduledAt?: string;
  reason: string;
}

/**
 * Checks if a given instant falls in IST Quiet Hours (22:00 to 06:30 IST).
 */
export function isQuietHours(date: Date): boolean {
  const ist = getISTDateParts(date);
  const h = parseInt(ist.hours, 10);
  const m = parseInt(ist.minutes, 10);
  if (h >= 22) return true;
  if (h < 6) return true;
  if (h === 6 && m < 30) return true;
  return false;
}

/**
 * Moves a notification scheduled in quiet hours to a safe permitted time
 * before the deadline when possible (SRS §8.8, TEST-2B.3).
 */
export function adjustForQuietHours(scheduledAtUtc: string, now: Date): string {
  const schedDate = new Date(scheduledAtUtc);
  if (!isQuietHours(schedDate)) {
    return scheduledAtUtc;
  }

  const ist = getISTDateParts(schedDate);
  const h = parseInt(ist.hours, 10);

  // If in evening quiet hours (>= 22:00 IST), move earlier to 21:45 IST same day
  if (h >= 22) {
    const adjusted = istToUtcDate(ist.localDate, "21:45");
    return adjusted.toISOString();
  }

  // If in overnight/early morning quiet hours (< 06:30 IST):
  // Attempt 21:45 IST on the previous evening if still in the future
  const prevDay = new Date(schedDate.getTime() - 24 * 60 * 60 * 1000);
  const prevIST = getISTDateParts(prevDay);
  const eveningBefore = istToUtcDate(prevIST.localDate, "21:45");

  if (eveningBefore.getTime() > now.getTime()) {
    return eveningBefore.toISOString();
  }

  // Otherwise move to 06:30 IST morning (start of wake hours)
  const morningPermitted = istToUtcDate(ist.localDate, "06:30");
  return morningPermitted.toISOString();
}

/**
 * Suppress obsolete pending or claimed rows for earlier deadline versions of a task.
 */
export async function suppressOldNotifications(
  db: D1Database,
  taskId: string,
  currentDeadlineVersion: number,
  nowIso: string
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE notification_log
       SET status = 'suppressed', updated_at = ?
       WHERE task_id = ?
         AND deadline_version < ?
         AND status IN ('pending', 'claimed')`
    )
    .bind(nowIso, taskId, currentDeadlineVersion)
    .run();

  return result.meta?.changes ?? 0;
}

/**
 * Plan a reminder notification row for a timed task.
 */
export async function planNotification(
  input: PlanNotificationInput
): Promise<PlanNotificationResult> {
  const { db, taskId, deadlineKind, deadlineAtUtc, deadlineVersion, now } = input;
  const stage = input.stage || "due";

  if (deadlineKind !== "timed" || !deadlineAtUtc) {
    return {
      planned: false,
      reason:
        deadlineKind === "none"
          ? "no deadline — no reminder planned"
          : "date-only deadline — no timed reminder (no midnight timestamp fabricated)",
    };
  }

  // If deadline is already past at plan time, do not plan future reminder
  if (new Date(deadlineAtUtc).getTime() <= now.getTime()) {
    return {
      planned: false,
      reason: "deadline already passed at plan time",
    };
  }

  // Quiet hours adjustment: move out of 22:00-06:30 IST window if needed (TEST-2B.3)
  const scheduledAt = adjustForQuietHours(deadlineAtUtc, now);

  const notifId = crypto.randomUUID();
  const dedupKey = `${taskId}:${stage}:${deadlineVersion}`;
  const nowIso = now.toISOString();

  await db
    .prepare(
      `INSERT INTO notification_log (
         id, task_id, deadline_version, stage, dedup_key,
         notification_kind, scheduled_at, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'reminder', ?, 'pending', ?, ?)
       ON CONFLICT(dedup_key) DO NOTHING`
    )
    .bind(notifId, taskId, deadlineVersion, stage, dedupKey, scheduledAt, nowIso, nowIso)
    .run();

  return {
    planned: true,
    dedupKey,
    scheduledAt,
    reason: `reminder scheduled for ${scheduledAt}`,
  };
}

/**
 * Plan exactly ONE prep digest for an IST date at 20:30 IST (TEST-2B.4).
 * Deduplicated by prep-digest:{istDate}.
 */
export async function planPrepDigest(
  db: D1Database,
  istDate: string,
  now: Date = new Date()
): Promise<boolean> {
  // Ensure system task exists for FK integrity
  await db
    .prepare(
      `INSERT OR IGNORE INTO tasks (id, title, status, priority, deadline_kind, deadline_version, created_at, updated_at)
       VALUES ('system:digest', 'System Digest', 'open', 'normal', 'none', 1, ?, ?)`
    )
    .bind(now.toISOString(), now.toISOString())
    .run()
    .catch(() => {});

  const notifId = crypto.randomUUID();
  const dedupKey = `prep-digest:${istDate}`;
  const scheduledAtUtc = istToUtcDate(istDate, "20:30").toISOString();
  const nowIso = now.toISOString();

  const res = await db
    .prepare(
      `INSERT INTO notification_log (
         id, task_id, deadline_version, stage, dedup_key,
         notification_kind, scheduled_at, status, created_at, updated_at
       ) VALUES (?, 'system:digest', 1, 'prep', ?, 'individual', ?, 'pending', ?, ?)
       ON CONFLICT(dedup_key) DO NOTHING`
    )
    .bind(notifId, dedupKey, scheduledAtUtc, nowIso, nowIso)
    .run();

  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Plan exactly ONE catch-up digest keyed by a unique episode ID (TEST-2B.5).
 * Deduplicated by catchup:{episodeId}.
 */
export async function planCatchupDigest(
  db: D1Database,
  episodeId: string,
  now: Date = new Date()
): Promise<boolean> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO tasks (id, title, status, priority, deadline_kind, deadline_version, created_at, updated_at)
       VALUES ('system:digest', 'System Digest', 'open', 'normal', 'none', 1, ?, ?)`
    )
    .bind(now.toISOString(), now.toISOString())
    .run()
    .catch(() => {});

  const notifId = crypto.randomUUID();
  const dedupKey = `catchup:${episodeId}`;
  const nowIso = now.toISOString();

  const res = await db
    .prepare(
      `INSERT INTO notification_log (
         id, task_id, deadline_version, stage, dedup_key,
         notification_kind, scheduled_at, status, created_at, updated_at
       ) VALUES (?, 'system:digest', 1, 'catchup', ?, 'individual', ?, 'pending', ?, ?)
       ON CONFLICT(dedup_key) DO NOTHING`
    )
    .bind(notifId, dedupKey, nowIso, nowIso, nowIso)
    .run();

  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Edit a task's title without touching deadline_version or notification_log (TEST-2A.4).
 */
export async function updateTaskTitle(
  db: D1Database,
  taskId: string,
  newTitle: string,
  now: Date = new Date()
): Promise<boolean> {
  const nowIso = now.toISOString();
  const res = await db
    .prepare(
      `UPDATE tasks
       SET title = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(newTitle, nowIso, taskId)
    .run();

  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Edit a task's deadline: increments deadline_version, suppresses old rows, and re-plans (TEST-2A.4).
 */
export async function updateTaskDeadline(
  db: D1Database,
  taskId: string,
  newDeadline: ParsedDeadline,
  now: Date = new Date()
): Promise<{ success: boolean; newVersion: number }> {
  const nowIso = now.toISOString();

  const current = await db
    .prepare(`SELECT id, deadline_version FROM tasks WHERE id = ?`)
    .bind(taskId)
    .first<{ id: string; deadline_version: number }>();

  if (!current) {
    return { success: false, newVersion: 0 };
  }

  const newVersion = current.deadline_version + 1;

  await db
    .prepare(
      `UPDATE tasks
       SET deadline_kind = ?,
           deadline_local_date = ?,
           deadline_time_local = ?,
           deadline_at_utc = ?,
           deadline_version = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      newDeadline.kind,
      newDeadline.localDate,
      newDeadline.localTime,
      newDeadline.utcInstant,
      newVersion,
      nowIso,
      taskId
    )
    .run();

  await suppressOldNotifications(db, taskId, newVersion, nowIso);

  await planNotification({
    db,
    taskId,
    deadlineKind: newDeadline.kind,
    deadlineAtUtc: newDeadline.utcInstant,
    deadlineVersion: newVersion,
    now,
  });

  return { success: true, newVersion };
}
