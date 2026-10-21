/**
 * recurrenceEngine.ts — Block 3A Recurring Task Engine
 *
 * Requirements (Personal_AI_OS_SRS_v2.2.md §§7.4, 8.5, 9.1, 16 TEST-3A.1 to TEST-3A.6):
 * - Dedicated recurrence_rules table acts as scheduling template (no duplicate task state).
 * - Patterns supported:
 *     * daily / every N days
 *     * weekly / every N weeks / selected weekdays
 *     * alternate_week_a / alternate_week_b anchored by explicit week_anchor_monday
 *     * monthly (every N months, month_day 1..31 or -1 for last day) with deterministic clamping
 *     * yearly (year_month 1..12, month_day 1..31) with leap year clamping
 * - 14-day lookahead horizon.
 * - Deduplication via unique constraint on (recurrence_rule_id, occurrence_local_date).
 * - Bounded daily maintenance: advances next_generation_date, materializing only missing horizon dates.
 * - Concurrency safety: atomic generation lease (generation_claimed_at, generation_lease_until).
 * - Preserves history: completing an occurrence leaves future occurrences intact; editing/pausing
 *   suppresses only future pending occurrences without mutating completed history.
 * - Notification integration: calls shared planNotification() for timed occurrences.
 * - Audit events: recurrence_created, occurrence_generated, recurrence_updated, recurrence_disabled.
 */

import { getISTDateParts, istToUtcDate } from "./dateParser";
import { planNotification } from "./notificationPlanner";

export type RecurrencePattern =
  | "daily"
  | "weekly"
  | "selected_weekdays"
  | "alternate_week_a"
  | "alternate_week_b"
  | "monthly"
  | "yearly";

export interface RecurrenceRuleRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  pattern: RecurrencePattern;
  interval: number;
  weekdays_json: string | null; // JSON string: [1..7] where 1=Mon, 7=Sun
  month_day: number | null; // 1..31 or -1 for last day
  year_month: number | null; // 1..12
  local_time: string | null; // "HH:mm" IST
  timezone: string;
  start_date: string; // "YYYY-MM-DD" IST
  end_date: string | null; // "YYYY-MM-DD" IST
  week_anchor_monday: string | null; // "YYYY-MM-DD" IST
  next_generation_date: string | null; // "YYYY-MM-DD" IST
  active: number; // 0 or 1
  series_version: number;
  generation_claimed_at: string | null;
  generation_lease_until: string | null;
  last_occurrence_number: number;
  default_priority: "low" | "normal" | "high" | "urgent";
  created_at: string;
  updated_at: string;
}

export interface CreateRecurrenceRuleInput {
  title: string;
  description?: string | null;
  category?: string | null;
  pattern: RecurrencePattern;
  interval?: number;
  weekdays?: number[]; // [1..7] (1=Mon, 7=Sun)
  month_day?: number | null;
  year_month?: number | null;
  local_time?: string | null;
  start_date: string; // "YYYY-MM-DD"
  end_date?: string | null;
  week_anchor_monday?: string | null;
  default_priority?: "low" | "normal" | "high" | "urgent";
}

const DEFAULT_HORIZON_DAYS = 14;
const LEASE_DURATION_MS = 60 * 1000; // 60 seconds lease

/**
 * Format Date to "YYYY-MM-DD" in UTC
 */
export function formatUtcYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse "YYYY-MM-DD" string into UTC Date at 00:00:00Z
 */
export function parseYmdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Add days to a "YYYY-MM-DD" string
 */
export function addDaysYmd(ymd: string, days: number): string {
  const d = parseYmdToUtc(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return formatUtcYmd(d);
}

/**
 * Return ISO weekday for a "YYYY-MM-DD" date: 1=Monday, 2=Tuesday, ..., 7=Sunday
 */
export function getIsoWeekday(ymd: string): number {
  const d = parseYmdToUtc(ymd);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  return day === 0 ? 7 : day;
}

/**
 * Get Monday of the week for a given "YYYY-MM-DD"
 */
export function getMondayOfWeek(ymd: string): string {
  const isoDay = getIsoWeekday(ymd); // 1=Mon .. 7=Sun
  const daysToSubtract = isoDay - 1;
  return addDaysYmd(ymd, -daysToSubtract);
}

/**
 * Number of days in month (1-based: 1=Jan, 2=Feb, etc.)
 */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Check if a date falls in Week A or Week B relative to week_anchor_monday
 */
export function getAlternatingWeekType(ymd: string, anchorMondayYmd: string): "A" | "B" {
  const monCurrent = parseYmdToUtc(getMondayOfWeek(ymd));
  const monAnchor = parseYmdToUtc(anchorMondayYmd);
  const diffDays = Math.round((monCurrent.getTime() - monAnchor.getTime()) / (24 * 60 * 60 * 1000));
  const diffWeeks = Math.floor(diffDays / 7);
  // Modulo 2 handling for negative or positive
  const mod = ((diffWeeks % 2) + 2) % 2;
  return mod === 0 ? "A" : "B";
}

/**
 * Deterministically compute all occurrence local dates for a rule within [fromDateYmd, toDateYmd].
 */
export function calculateNextOccurrenceDates(
  rule: Pick<
    RecurrenceRuleRow,
    | "pattern"
    | "interval"
    | "weekdays_json"
    | "month_day"
    | "year_month"
    | "start_date"
    | "end_date"
    | "week_anchor_monday"
  >,
  fromDateYmd: string,
  toDateYmd: string
): string[] {
  const result: string[] = [];
  const startYmd = rule.start_date;
  const endYmd = rule.end_date;

  // Window bounds
  const actualFrom = fromYmdMax(fromDateYmd, startYmd);
  if (endYmd && actualFrom > endYmd) return [];
  const actualTo = endYmd ? (toDateYmd < endYmd ? toDateYmd : endYmd) : toDateYmd;
  if (actualFrom > actualTo) return [];

  const interval = rule.interval > 0 ? rule.interval : 1;

  switch (rule.pattern) {
    case "daily": {
      // Step by interval days from start_date
      let curr = startYmd;
      while (curr <= actualTo) {
        if (curr >= actualFrom) {
          result.push(curr);
        }
        curr = addDaysYmd(curr, interval);
      }
      break;
    }

    case "weekly":
    case "selected_weekdays": {
      let allowedWeekdays: number[] = [];
      if (rule.weekdays_json) {
        try {
          allowedWeekdays = JSON.parse(rule.weekdays_json);
        } catch {
          allowedWeekdays = [];
        }
      }
      if (allowedWeekdays.length === 0) {
        // Default to start_date weekday if none specified
        allowedWeekdays = [getIsoWeekday(startYmd)];
      }

      if (rule.pattern === "selected_weekdays" || interval === 1) {
        // Every week on specified weekdays
        let curr = actualFrom;
        while (curr <= actualTo) {
          const isoDay = getIsoWeekday(curr);
          if (allowedWeekdays.includes(isoDay) && curr >= startYmd) {
            result.push(curr);
          }
          curr = addDaysYmd(curr, 1);
        }
      } else {
        // Every N weeks (interval > 1)
        // Anchor week is week containing start_date
        const startMonday = getMondayOfWeek(startYmd);
        let currMonday = getMondayOfWeek(actualFrom);
        if (currMonday < startMonday) currMonday = startMonday;

        // Align currMonday with interval from startMonday
        const diffWeeks = Math.round(
          (parseYmdToUtc(currMonday).getTime() - parseYmdToUtc(startMonday).getTime()) /
            (7 * 24 * 60 * 60 * 1000)
        );
        const rem = ((diffWeeks % interval) + interval) % interval;
        if (rem !== 0) {
          currMonday = addDaysYmd(currMonday, (interval - rem) * 7);
        }

        while (currMonday <= actualTo) {
          for (const wd of allowedWeekdays) {
            const occYmd = addDaysYmd(currMonday, wd - 1);
            if (occYmd >= actualFrom && occYmd <= actualTo && occYmd >= startYmd) {
              result.push(occYmd);
            }
          }
          currMonday = addDaysYmd(currMonday, interval * 7);
        }
        result.sort();
      }
      break;
    }

    case "alternate_week_a":
    case "alternate_week_b": {
      const anchorMonday = rule.week_anchor_monday || getMondayOfWeek(startYmd);
      const targetWeekType = rule.pattern === "alternate_week_a" ? "A" : "B";

      let allowedWeekdays: number[] = [];
      if (rule.weekdays_json) {
        try {
          allowedWeekdays = JSON.parse(rule.weekdays_json);
        } catch {
          allowedWeekdays = [];
        }
      }
      if (allowedWeekdays.length === 0) {
        allowedWeekdays = [getIsoWeekday(startYmd)];
      }

      let curr = actualFrom;
      while (curr <= actualTo) {
        if (curr >= startYmd) {
          const weekType = getAlternatingWeekType(curr, anchorMonday);
          if (weekType === targetWeekType) {
            const isoDay = getIsoWeekday(curr);
            if (allowedWeekdays.includes(isoDay)) {
              result.push(curr);
            }
          }
        }
        curr = addDaysYmd(curr, 1);
      }
      break;
    }

    case "monthly": {
      // Month-day clamping:
      // If month_day is 31 and Feb has 28, clamps to 28. Next month clamps to 31.
      // If month_day is -1, clamps to last day of each month.
      const rawMonthDay = rule.month_day ?? parseYmdToUtc(startYmd).getUTCDate();
      const startParts = parseYmdToUtc(startYmd);
      let year = parseYmdToUtc(actualFrom).getUTCFullYear();
      let month = parseYmdToUtc(actualFrom).getUTCMonth() + 1; // 1..12

      // Check up to 2 years ahead or until actualTo
      const toYear = parseYmdToUtc(actualTo).getUTCFullYear();
      const toMonth = parseYmdToUtc(actualTo).getUTCMonth() + 1;

      while (year < toYear || (year === toYear && month <= toMonth)) {
        // Check if this month matches interval from start_date month
        const totalMonthsDiff =
          (year - startParts.getUTCFullYear()) * 12 + (month - (startParts.getUTCMonth() + 1));

        if (totalMonthsDiff >= 0 && totalMonthsDiff % interval === 0) {
          const daysInMonth = getDaysInMonth(year, month);
          let targetDay = rawMonthDay === -1 ? daysInMonth : Math.min(rawMonthDay, daysInMonth);
          const candidateYmd = `${year}-${String(month).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;

          if (candidateYmd >= actualFrom && candidateYmd <= actualTo && candidateYmd >= startYmd) {
            result.push(candidateYmd);
          }
        }

        month++;
        if (month > 12) {
          month = 1;
          year++;
        }
      }
      break;
    }

    case "yearly": {
      // Yearly recurrence: year_month (1..12), month_day (1..31)
      const startParts = parseYmdToUtc(startYmd);
      const rawYearMonth = rule.year_month ?? startParts.getUTCMonth() + 1;
      const rawMonthDay = rule.month_day ?? startParts.getUTCDate();

      let year = parseYmdToUtc(actualFrom).getUTCFullYear();
      const toYear = parseYmdToUtc(actualTo).getUTCFullYear();

      while (year <= toYear) {
        const yearDiff = year - startParts.getUTCFullYear();
        if (yearDiff >= 0 && yearDiff % interval === 0) {
          const daysInMonth = getDaysInMonth(year, rawYearMonth);
          const targetDay = rawMonthDay === -1 ? daysInMonth : Math.min(rawMonthDay, daysInMonth);
          const candidateYmd = `${year}-${String(rawYearMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;

          if (candidateYmd >= actualFrom && candidateYmd <= actualTo && candidateYmd >= startYmd) {
            result.push(candidateYmd);
          }
        }
        year++;
      }
      break;
    }
  }

  return result;
}

function fromYmdMax(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * Materializes occurrences for active recurrence rules across the lookahead horizon.
 *
 * Concurrency & Performance:
 * - Leased acquisition: skips currently leased rules.
 * - Monotonic occurrence_number assigned from recurrence_rules.last_occurrence_number.
 * - Idempotent insertion with ON CONFLICT(recurrence_rule_id, occurrence_local_date) DO NOTHING.
 * - Updates next_generation_date to horizonEnd + 1 day so subsequent daily runs only evaluate the new day.
 */
export async function materializeRecurringOccurrences(
  db: D1Database,
  now: Date,
  horizonDays: number = DEFAULT_HORIZON_DAYS
): Promise<{ rulesEvaluated: number; occurrencesCreated: number; errors: string[] }> {
  const ist = getISTDateParts(now);
  const todayYmd = ist.localDate;
  const horizonEndYmd = addDaysYmd(todayYmd, horizonDays);
  const nowIso = now.toISOString();
  const leaseUntilIso = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();

  let rulesEvaluated = 0;
  let occurrencesCreated = 0;
  const errors: string[] = [];

  // Query eligible rules: active=1 and not leased and (next_generation_date is null or <= horizonEndYmd)
  const rules = await db
    .prepare(
      `SELECT * FROM recurrence_rules
       WHERE active = 1
         AND (generation_lease_until IS NULL OR generation_lease_until < ?)
         AND (next_generation_date IS NULL OR next_generation_date <= ?)
       LIMIT 20`
    )
    .bind(nowIso, horizonEndYmd)
    .all<RecurrenceRuleRow>();

  for (const rule of rules.results || []) {
    rulesEvaluated++;

    // Atomic lease acquisition
    const claimRes = await db
      .prepare(
        `UPDATE recurrence_rules
         SET generation_claimed_at = ?, generation_lease_until = ?
         WHERE id = ?
           AND active = 1
           AND (generation_lease_until IS NULL OR generation_lease_until < ?)`
      )
      .bind(nowIso, leaseUntilIso, rule.id, nowIso)
      .run();

    if ((claimRes.meta?.changes ?? 0) === 0) {
      continue; // Leased by another worker
    }

    try {
      // Determine generation window
      const fromYmd = rule.next_generation_date && rule.next_generation_date > todayYmd
        ? rule.next_generation_date
        : todayYmd;

      const candidateDates = calculateNextOccurrenceDates(rule, fromYmd, horizonEndYmd);

      for (const occYmd of candidateDates) {
        // Check if task already exists for this rule and local date
        const existing = await db
          .prepare(
            `SELECT id FROM tasks WHERE recurrence_rule_id = ? AND occurrence_local_date = ?`
          )
          .bind(rule.id, occYmd)
          .first<{ id: string }>();

        if (existing) {
          continue;
        }

        // Increment monotonic occurrence_number
        const incRes = await db
          .prepare(
            `UPDATE recurrence_rules
             SET last_occurrence_number = last_occurrence_number + 1, updated_at = ?
             WHERE id = ?
             RETURNING last_occurrence_number`
          )
          .bind(nowIso, rule.id)
          .first<{ last_occurrence_number: number }>();

        const occNumber = incRes?.last_occurrence_number ?? (rule.last_occurrence_number + 1);
        const taskId = crypto.randomUUID();
        const deadlineKind = rule.local_time ? "timed" : "date_only";
        const deadlineLocalDate = occYmd;
        const deadlineTimeLocal = rule.local_time || null;
        const deadlineAtUtc = rule.local_time
          ? istToUtcDate(occYmd, rule.local_time).toISOString()
          : null;

        // Insert new occurrence task
        const insertTaskStmt = db.prepare(
          `INSERT OR IGNORE INTO tasks (
             id, title, description, category, status, priority,
             deadline_kind, deadline_local_date, deadline_time_local, deadline_at_utc,
             deadline_version, recurrence_rule_id, occurrence_local_date,
             occurrence_number, series_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
        ).bind(
          taskId,
          rule.title,
          rule.description ?? null,
          rule.category ?? null,
          rule.default_priority ?? "normal",
          deadlineKind,
          deadlineLocalDate,
          deadlineTimeLocal ?? null,
          deadlineAtUtc ?? null,
          rule.id,
          occYmd,
          occNumber,
          rule.series_version,
          nowIso,
          nowIso
        );

        const auditEventId = crypto.randomUUID();
        const auditStmt = db.prepare(
          `INSERT INTO audit_events (
             id, entity_type, entity_id, event_type, actor, details_json, created_at
           ) VALUES (?, 'task', ?, 'occurrence_generated', 'system:scheduler', ?, ?)`
        ).bind(
          auditEventId,
          taskId,
          JSON.stringify({
            recurrence_rule_id: rule.id,
            occurrence_local_date: occYmd,
            occurrence_number: occNumber,
            series_version: rule.series_version,
            deadline_kind: deadlineKind,
          }),
          nowIso
        );

        await db.batch([insertTaskStmt, auditStmt]);
        occurrencesCreated++;

        // Plan notification if timed
        if (deadlineKind === "timed" && deadlineAtUtc) {
          await planNotification({
            db,
            taskId,
            deadlineKind,
            deadlineAtUtc,
            deadlineVersion: 1,
            now,
          });
        }
      }

      // Advance next_generation_date to horizonEndYmd + 1 day and release generation lease
      const nextGenYmd = addDaysYmd(horizonEndYmd, 1);
      await db
        .prepare(
          `UPDATE recurrence_rules
           SET next_generation_date = ?,
               generation_claimed_at = NULL,
               generation_lease_until = NULL,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(nextGenYmd, nowIso, rule.id)
        .run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Rule ${rule.id}: ${msg}`);

      // Release lease on error
      await db
        .prepare(
          `UPDATE recurrence_rules
           SET generation_lease_until = NULL, updated_at = ?
           WHERE id = ?`
        )
        .bind(nowIso, rule.id)
        .run()
        .catch(() => {});
    }
  }

  return { rulesEvaluated, occurrencesCreated, errors };
}

/**
 * Creates a new recurrence rule and immediately materializes occurrences across the horizon.
 */
export async function createRecurrenceRule(
  db: D1Database,
  input: CreateRecurrenceRuleInput,
  now: Date = new Date()
): Promise<{ ruleId: string; occurrencesCreated: number }> {
  const ruleId = crypto.randomUUID();
  const nowIso = now.toISOString();
  const ist = getISTDateParts(now);

  const pattern = input.pattern;
  const interval = input.interval ?? 1;
  const weekdaysJson = input.weekdays ? JSON.stringify(input.weekdays) : null;
  const monthDay = input.month_day ?? null;
  const yearMonth = input.year_month ?? null;
  const localTime = input.local_time ?? null;
  const startDate = input.start_date || ist.localDate;
  const endDate = input.end_date ?? null;
  const weekAnchorMonday = input.week_anchor_monday ?? null;
  const defaultPriority = input.default_priority ?? "normal";

  const ruleStmt = db.prepare(
    `INSERT INTO recurrence_rules (
       id, title, description, category, pattern, interval,
       weekdays_json, month_day, year_month, local_time, timezone,
       start_date, end_date, week_anchor_monday, next_generation_date,
       active, series_version, last_occurrence_number, default_priority,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Asia/Kolkata', ?, ?, ?, ?, 1, 1, 0, ?, ?, ?)`
  ).bind(
    ruleId,
    input.title,
    input.description || null,
    input.category || null,
    pattern,
    interval,
    weekdaysJson,
    monthDay,
    yearMonth,
    localTime,
    startDate,
    endDate,
    weekAnchorMonday,
    startDate,
    defaultPriority,
    nowIso,
    nowIso
  );

  const auditEventId = crypto.randomUUID();
  const auditStmt = db.prepare(
    `INSERT INTO audit_events (
       id, entity_type, entity_id, event_type, actor, details_json, created_at
     ) VALUES (?, 'recurrence_rule', ?, 'recurrence_created', 'owner:telegram', ?, ?)`
  ).bind(
    auditEventId,
    ruleId,
    JSON.stringify({
      title: input.title,
      pattern,
      interval,
      weekdays: input.weekdays,
      start_date: startDate,
      end_date: endDate,
      local_time: localTime,
    }),
    nowIso
  );

  await db.batch([ruleStmt, auditStmt]);

  // Immediately materialize initial horizon
  const matResult = await materializeRecurringOccurrences(db, now);

  return { ruleId, occurrencesCreated: matResult.occurrencesCreated };
}

/**
 * Pause a recurrence rule:
 * - active = 0
 * - Suppresses future pending/open tasks and notification rows.
 * - Preserves completed history.
 * - Writes recurrence_disabled audit event.
 */
export async function pauseRecurrenceRule(
  db: D1Database,
  ruleId: string,
  now: Date = new Date()
): Promise<{ success: boolean; suppressedTasks: number; suppressedNotifications: number }> {
  const nowIso = now.toISOString();
  const ist = getISTDateParts(now);
  const todayYmd = ist.localDate;

  // Verify rule exists
  const rule = await db
    .prepare("SELECT id, title, active FROM recurrence_rules WHERE id = ?")
    .bind(ruleId)
    .first<{ id: string; title: string; active: number }>();

  if (!rule) {
    return { success: false, suppressedTasks: 0, suppressedNotifications: 0 };
  }

  // Deactivate rule
  await db
    .prepare(
      `UPDATE recurrence_rules SET active = 0, updated_at = ? WHERE id = ?`
    )
    .bind(nowIso, ruleId)
    .run();

  // Find future open tasks (occurrence_local_date >= todayYmd)
  const futureTasks = await db
    .prepare(
      `SELECT id FROM tasks
       WHERE recurrence_rule_id = ?
         AND status = 'open'
         AND occurrence_local_date >= ?`
    )
    .bind(ruleId, todayYmd)
    .all<{ id: string }>();

  let suppressedTasks = 0;
  let suppressedNotifications = 0;

  for (const t of futureTasks.results || []) {
    // Suppress open task
    await db
      .prepare(`UPDATE tasks SET status = 'dismissed', updated_at = ? WHERE id = ?`)
      .bind(nowIso, t.id)
      .run();
    suppressedTasks++;

    // Suppress associated notification rows
    const notifRes = await db
      .prepare(
        `UPDATE notification_log
         SET status = 'suppressed', updated_at = ?
         WHERE task_id = ? AND status IN ('pending', 'claimed')`
      )
      .bind(nowIso, t.id)
      .run();
    suppressedNotifications += notifRes.meta?.changes ?? 0;
  }

  // Audit event
  const auditId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, 'recurrence_rule', ?, 'recurrence_disabled', 'owner:telegram', ?, ?)`
    )
    .bind(
      auditId,
      ruleId,
      JSON.stringify({ suppressed_tasks: suppressedTasks, suppressed_notifications: suppressedNotifications }),
      nowIso
    )
    .run();

  return { success: true, suppressedTasks, suppressedNotifications };
}

/**
 * Resume a paused recurrence rule:
 * - active = 1
 * - next_generation_date resets to today
 * - Materializes next occurrence horizon
 * - Writes recurrence_updated audit event
 */
export async function resumeRecurrenceRule(
  db: D1Database,
  ruleId: string,
  now: Date = new Date()
): Promise<{ success: boolean; occurrencesCreated: number }> {
  const nowIso = now.toISOString();
  const ist = getISTDateParts(now);
  const todayYmd = ist.localDate;

  const rule = await db
    .prepare("SELECT id, title, active, local_time FROM recurrence_rules WHERE id = ?")
    .bind(ruleId)
    .first<{ id: string; title: string; active: number; local_time: string | null }>();

  if (!rule) {
    return { success: false, occurrencesCreated: 0 };
  }

  await db
    .prepare(
      `UPDATE recurrence_rules
       SET active = 1,
           next_generation_date = ?,
           generation_lease_until = NULL,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(todayYmd, nowIso, ruleId)
    .run();

  // Reopen future tasks that were dismissed when paused
  const reopenedTasks = await db
    .prepare(
      `SELECT id, deadline_kind, deadline_at_utc, deadline_version
       FROM tasks
       WHERE recurrence_rule_id = ?
         AND status = 'dismissed'
         AND occurrence_local_date >= ?`
    )
    .bind(ruleId, todayYmd)
    .all<{ id: string; deadline_kind: "none" | "date_only" | "timed"; deadline_at_utc: string | null; deadline_version: number }>();

  let reopenedCount = 0;
  for (const t of reopenedTasks.results || []) {
    await db
      .prepare(`UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ?`)
      .bind(nowIso, t.id)
      .run();
    reopenedCount++;

    // Plan notification if timed
    if (t.deadline_kind === "timed" && t.deadline_at_utc) {
      await planNotification({
        db,
        taskId: t.id,
        deadlineKind: "timed",
        deadlineAtUtc: t.deadline_at_utc,
        deadlineVersion: t.deadline_version,
        now,
      });
    }
  }

  const auditId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, 'recurrence_rule', ?, 'recurrence_updated', 'owner:telegram', ?, ?)`
    )
    .bind(auditId, ruleId, JSON.stringify({ action: "resume", reopened_tasks: reopenedCount }), nowIso)
    .run();

  const matRes = await materializeRecurringOccurrences(db, now);
  return { success: true, occurrencesCreated: reopenedCount + matRes.occurrencesCreated };
}

/**
 * Edit a recurrence rule:
 * - Increments series_version.
 * - Suppresses obsolete future pending tasks from older series_version.
 * - Updates rule template fields.
 * - Materializes new occurrences according to updated rule.
 * - Writes recurrence_updated audit event.
 */
export async function editRecurrenceSeries(
  db: D1Database,
  ruleId: string,
  updates: Partial<CreateRecurrenceRuleInput>,
  now: Date = new Date()
): Promise<{ success: boolean; newSeriesVersion: number; suppressedTasks: number; occurrencesCreated: number }> {
  const nowIso = now.toISOString();
  const ist = getISTDateParts(now);
  const todayYmd = ist.localDate;

  const rule = await db
    .prepare("SELECT * FROM recurrence_rules WHERE id = ?")
    .bind(ruleId)
    .first<RecurrenceRuleRow>();

  if (!rule) {
    return { success: false, newSeriesVersion: 0, suppressedTasks: 0, occurrencesCreated: 0 };
  }

  const newSeriesVersion = rule.series_version + 1;

  // Suppress future pending tasks belonging to older series_version
  const futureTasks = await db
    .prepare(
      `SELECT id FROM tasks
       WHERE recurrence_rule_id = ?
         AND status = 'open'
         AND occurrence_local_date >= ?`
    )
    .bind(ruleId, todayYmd)
    .all<{ id: string }>();

  let suppressedTasks = 0;
  for (const t of futureTasks.results || []) {
    await db
      .prepare(`UPDATE tasks SET status = 'dismissed', updated_at = ? WHERE id = ?`)
      .bind(nowIso, t.id)
      .run();

    await db
      .prepare(
        `UPDATE notification_log SET status = 'suppressed', updated_at = ? WHERE task_id = ? AND status IN ('pending', 'claimed')`
      )
      .bind(nowIso, t.id)
      .run();
    suppressedTasks++;
  }

  // Update rule with new series_version and supplied fields
  const updatedTitle = updates.title ?? rule.title;
  const updatedPattern = updates.pattern ?? rule.pattern;
  const updatedInterval = updates.interval ?? rule.interval;
  const updatedWeekdays = updates.weekdays !== undefined ? JSON.stringify(updates.weekdays) : rule.weekdays_json;
  const updatedMonthDay = updates.month_day !== undefined ? updates.month_day : rule.month_day;
  const updatedYearMonth = updates.year_month !== undefined ? updates.year_month : rule.year_month;
  const updatedLocalTime = updates.local_time !== undefined ? updates.local_time : rule.local_time;
  const updatedPriority = updates.default_priority ?? rule.default_priority;

  await db
    .prepare(
      `UPDATE recurrence_rules
       SET title = ?,
           pattern = ?,
           interval = ?,
           weekdays_json = ?,
           month_day = ?,
           year_month = ?,
           local_time = ?,
           default_priority = ?,
           series_version = ?,
           next_generation_date = ?,
           generation_lease_until = NULL,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      updatedTitle,
      updatedPattern,
      updatedInterval,
      updatedWeekdays ?? null,
      updatedMonthDay ?? null,
      updatedYearMonth ?? null,
      updatedLocalTime ?? null,
      updatedPriority,
      newSeriesVersion,
      todayYmd,
      nowIso,
      ruleId
    )
    .run();

  const auditId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, 'recurrence_rule', ?, 'recurrence_updated', 'owner:telegram', ?, ?)`
    )
    .bind(
      auditId,
      ruleId,
      JSON.stringify({
        series_version: newSeriesVersion,
        suppressed_tasks: suppressedTasks,
        updates,
      }),
      nowIso
    )
    .run();

  // Materialize new occurrences with updated series_version
  const matRes = await materializeRecurringOccurrences(db, now);

  return {
    success: true,
    newSeriesVersion,
    suppressedTasks,
    occurrencesCreated: matRes.occurrencesCreated,
  };
}

export interface ParseRecurrenceResult {
  isRecurrence: boolean;
  ruleInput?: CreateRecurrenceRuleInput;
  error?: string;
  summary?: string;
}

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const ISO_WEEKDAY_MAP: Record<string, number> = {
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

/**
 * Parses shorthand recurrence expressions:
 * - every day
 * - every N days
 * - every week
 * - every N weeks
 * - every month
 * - every N months
 * - every year
 * - every N years
 * - every <weekday> [HH:mm] (e.g. every monday 18:00)
 * - every <Month> <Day> [HH:mm] (e.g. every Jan 1, every Dec 25 10:00)
 * - 1st / 15th / Nth day of month [HH:mm]
 * - last day of month [HH:mm]
 * - alternate week A / alternate week B [HH:mm]
 */
export function parseRecurrenceShorthand(
  raw: string,
  now: Date = new Date()
): ParseRecurrenceResult {
  const input = raw.trim().toLowerCase();
  const ist = getISTDateParts(now);
  const todayYmd = ist.localDate;

  // 1. Alternating weeks: "alternate week a", "alternate week b", "every alternate week a"
  const altWeekMatch = input.match(/^(?:every\s+)?alternate\s+week\s+(a|b)(?:\s+(\d{1,2}:\d{2}))?$/);
  if (altWeekMatch) {
    const weekType = altWeekMatch[1] === "a" ? "alternate_week_a" : "alternate_week_b";
    const localTime = altWeekMatch[2] || null;
    const anchorMonday = getMondayOfWeek(todayYmd);
    return {
      isRecurrence: true,
      summary: `Every alternate week ${altWeekMatch[1].toUpperCase()}${localTime ? ` at ${localTime}` : ""}`,
      ruleInput: {
        title: "",
        pattern: weekType,
        interval: 1,
        local_time: localTime,
        start_date: todayYmd,
        week_anchor_monday: anchorMonday,
      },
    };
  }

  // 2. Month day rules: "1st day of month", "15th day of month", "last day of month", "last day"
  const lastDayMatch = input.match(/^(?:every\s+)?last\s+day(?:\s+of\s+month)?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (lastDayMatch) {
    const localTime = lastDayMatch[1] || null;
    return {
      isRecurrence: true,
      summary: `Last day of every month${localTime ? ` at ${localTime}` : ""}`,
      ruleInput: {
        title: "",
        pattern: "monthly",
        interval: 1,
        month_day: -1,
        local_time: localTime,
        start_date: todayYmd,
      },
    };
  }

  const nthDayMatch = input.match(/^(\d+)(?:st|nd|rd|th)?\s+day(?:\s+of\s+month)?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (nthDayMatch) {
    const dayNum = parseInt(nthDayMatch[1], 10);
    if (dayNum < 1 || dayNum > 31) {
      return { isRecurrence: true, error: "Month day must be between 1 and 31." };
    }
    const localTime = nthDayMatch[2] || null;
    return {
      isRecurrence: true,
      summary: `${dayNum}${getOrdinalSuffix(dayNum)} day of every month${localTime ? ` at ${localTime}` : ""}`,
      ruleInput: {
        title: "",
        pattern: "monthly",
        interval: 1,
        month_day: dayNum,
        local_time: localTime,
        start_date: todayYmd,
      },
    };
  }

  // If it doesn't start with "every", it's not a recurrence expression
  if (!input.startsWith("every ") && input !== "daily" && input !== "weekly" && input !== "monthly" && input !== "yearly") {
    return { isRecurrence: false };
  }

  const rest = input.startsWith("every ") ? input.slice(6).trim() : input;

  // 3. "every day" or "every N days"
  const dayMatch = rest.match(/^(?:(\d+)\s+)?days?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (dayMatch) {
    const interval = dayMatch[1] ? parseInt(dayMatch[1], 10) : 1;
    const localTime = dayMatch[2] || null;
    return {
      isRecurrence: true,
      summary: interval === 1 ? "Every day" : `Every ${interval} days`,
      ruleInput: {
        title: "",
        pattern: "daily",
        interval,
        local_time: localTime,
        start_date: todayYmd,
      },
    };
  }

  // 4. "every week" or "every N weeks"
  const weekMatch = rest.match(/^(?:(\d+)\s+)?weeks?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (weekMatch) {
    const interval = weekMatch[1] ? parseInt(weekMatch[1], 10) : 1;
    const localTime = weekMatch[2] || null;
    const todayIsoDay = getIsoWeekday(todayYmd);
    return {
      isRecurrence: true,
      summary: interval === 1 ? "Every week" : `Every ${interval} weeks`,
      ruleInput: {
        title: "",
        pattern: "weekly",
        interval,
        weekdays: [todayIsoDay],
        local_time: localTime,
        start_date: todayYmd,
      },
    };
  }

  // 5. "every month" or "every N months"
  const monthMatch = rest.match(/^(?:(\d+)\s+)?months?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (monthMatch) {
    const interval = monthMatch[1] ? parseInt(monthMatch[1], 10) : 1;
    const localTime = monthMatch[2] || null;
    const currentDay = parseYmdToUtc(todayYmd).getUTCDate();
    return {
      isRecurrence: true,
      summary: interval === 1 ? "Every month" : `Every ${interval} months`,
      ruleInput: {
        title: "",
        pattern: "monthly",
        interval,
        month_day: currentDay,
        local_time: localTime,
        start_date: todayYmd,
      },
    };
  }

  // 6. "every year" or "every N years"
  const yearMatch = rest.match(/^(?:(\d+)\s+)?years?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (yearMatch) {
    const interval = yearMatch[1] ? parseInt(yearMatch[1], 10) : 1;
    const localTime = yearMatch[2] || null;
    const currentMonth = parseYmdToUtc(todayYmd).getUTCMonth() + 1;
    const currentDay = parseYmdToUtc(todayYmd).getUTCDate();
    return {
      isRecurrence: true,
      summary: interval === 1 ? "Every year" : `Every ${interval} years`,
      ruleInput: {
        title: "",
        pattern: "yearly",
        interval,
        year_month: currentMonth,
        month_day: currentDay,
        local_time: localTime,
        start_date: todayYmd,
      },
    };
  }

  // 7. "every <weekday> [HH:mm]" (e.g. "every monday", "every friday 09:00")
  const weekdayMatch = rest.match(/^([a-z]+)(?:\s+(\d{1,2}:\d{2}))?$/);
  if (weekdayMatch && ISO_WEEKDAY_MAP[weekdayMatch[1]] !== undefined) {
    const isoDay = ISO_WEEKDAY_MAP[weekdayMatch[1]];
    const localTime = weekdayMatch[2] || null;
    return {
      isRecurrence: true,
      summary: `Every ${weekdayMatch[1].charAt(0).toUpperCase() + weekdayMatch[1].slice(1)}${localTime ? ` at ${localTime}` : ""}`,
      ruleInput: {
        title: "",
        pattern: "selected_weekdays",
        interval: 1,
        weekdays: [isoDay],
        local_time: localTime,
        start_date: todayYmd,
      },
    };
  }

  // 8. "every <Month> <Day> [HH:mm]" (e.g. "every Jan 1", "every Dec 25 18:00")
  const yearlyMatch = rest.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?$/);
  if (yearlyMatch && MONTH_NAME_MAP[yearlyMatch[1]] !== undefined) {
    const monthNum = MONTH_NAME_MAP[yearlyMatch[1]];
    const dayNum = parseInt(yearlyMatch[2], 10);
    if (dayNum < 1 || dayNum > 31) {
      return { isRecurrence: true, error: "Invalid day of month." };
    }
    const localTime = yearlyMatch[3] || null;
    return {
      isRecurrence: true,
      summary: `Every ${yearlyMatch[1].toUpperCase()} ${dayNum}${localTime ? ` at ${localTime}` : ""}`,
      ruleInput: {
        title: "",
        pattern: "yearly",
        interval: 1,
        year_month: monthNum,
        month_day: dayNum,
        local_time: localTime,
        start_date: todayYmd,
      },
    };
  }

  return { isRecurrence: false };
}

function getOrdinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
