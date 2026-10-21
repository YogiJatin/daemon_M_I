/**
 * worker/suggestionsEngine.ts — Block 5 Deterministic Suggestions Engine
 *
 * Implements 6 deterministic suggestion rules without any LLM dependency (SRS FR-AI-002, TEST-5.1):
 * 1. overdue_item: An open task has been overdue for >24 hours
 * 2. deadline_cluster: 3+ tasks due on the same IST date within the next 7 days
 * 3. missing_prep: A scheduled class tomorrow has no preparation materials linked
 * 4. prepare_tonight: Evening (>= 18:00 IST) alert if tomorrow has scheduled classes or tasks
 * 5. stale_recurring: An active recurring rule has stalled, expired, or has no active occurrences
 * 6. missed_class: A past class occurrence is still marked 'planned' (unconfirmed attendance)
 *
 * Supports dismissal with stable keys and context-version hashing (resurfaces when context changes).
 */

import { getISTDateParts } from "./dateParser";
import { addDaysYmd } from "./recurrenceEngine";

export interface SuggestionAction {
  type: string;
  label: string;
  payload?: Record<string, any>;
}

export interface Suggestion {
  id: string; // Stable suggestion_key
  type: "overdue_item" | "deadline_cluster" | "missing_prep" | "prepare_tonight" | "stale_recurring" | "missed_class";
  priority: "high" | "medium" | "low";
  title: string;
  message: string;
  context: Record<string, any>;
  version: string; // Hex hash of triggering context
  actions: SuggestionAction[];
  created_at: string;
}

export interface SuggestionDismissalRow {
  id: string;
  suggestion_key: string;
  dismissed_version: string;
  dismissed_at: string;
  expires_at: string | null;
  created_at: string;
}

/**
 * Computes a deterministic short 16-character hex hash from a context string.
 */
export async function computeVersionHash(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const fullHex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return fullHex.slice(0, 16);
}

/**
 * Evaluates all 6 deterministic suggestion rules against D1 and filters out active dismissals.
 */
export async function evaluateSuggestions(
  db: D1Database,
  now: Date = new Date()
): Promise<Suggestion[]> {
  const ist = getISTDateParts(now);
  const todayYmd = ist.localDate;
  const currentTime = ist.localTime;
  const currentHour = ist.hour;
  const nowIso = now.toISOString();
  const yesterdayYmd = addDaysYmd(todayYmd, -1);
  const tomorrowYmd = addDaysYmd(todayYmd, 1);
  const nowMs = now.getTime();
  const twentyFourHoursAgoMs = nowMs - 24 * 60 * 60 * 1000;

  const candidates: Suggestion[] = [];

  // =========================================================================
  // Rule 1: overdue_item (>24h overdue open tasks)
  // =========================================================================
  const openTasksRes = await db
    .prepare(
      `SELECT id, title, deadline_kind, deadline_local_date, deadline_time_local,
              deadline_at_utc, deadline_version, status
       FROM tasks
       WHERE status = 'open' AND deadline_kind != 'none'`
    )
    .all<any>();

  for (const task of openTasksRes.results || []) {
    let isOverdue24h = false;
    if (task.deadline_kind === "timed" && task.deadline_at_utc) {
      const deadlineMs = new Date(task.deadline_at_utc).getTime();
      if (!isNaN(deadlineMs) && deadlineMs < twentyFourHoursAgoMs) {
        isOverdue24h = true;
      }
    } else if (task.deadline_kind === "date_only" && task.deadline_local_date) {
      // Date-only becomes overdue the day after its deadline. If it's strictly before yesterday,
      // more than 24 hours of overdue status have passed.
      if (task.deadline_local_date < yesterdayYmd) {
        isOverdue24h = true;
      }
    }

    if (isOverdue24h) {
      const contextStr = `${task.id}:${task.status}:${task.deadline_version}:${task.deadline_local_date}:${task.deadline_time_local || ""}`;
      const version = await computeVersionHash(contextStr);
      candidates.push({
        id: `overdue_item:${task.id}`,
        type: "overdue_item",
        priority: "high",
        title: `Overdue Task: ${task.title}`,
        message: `"${task.title}" has been overdue for more than 24 hours (deadline was ${task.deadline_local_date}${task.deadline_time_local ? " " + task.deadline_time_local : ""}).`,
        context: {
          task_id: task.id,
          title: task.title,
          deadline_local_date: task.deadline_local_date,
          deadline_time_local: task.deadline_time_local,
          deadline_kind: task.deadline_kind,
        },
        version,
        actions: [
          { type: "complete", label: "Mark Done", payload: { task_id: task.id } },
          { type: "snooze", label: "Snooze", payload: { task_id: task.id } },
          { type: "dismiss", label: "Dismiss" },
        ],
        created_at: nowIso,
      });
    }
  }

  // =========================================================================
  // Rule 2: deadline_cluster (3+ tasks due on the same date in the next 7 days)
  // =========================================================================
  const next7DaysEnd = addDaysYmd(todayYmd, 6);
  const clusterTasksRes = await db
    .prepare(
      `SELECT id, title, deadline_local_date, deadline_version
       FROM tasks
       WHERE status IN ('open', 'snoozed')
         AND deadline_local_date BETWEEN ? AND ?
       ORDER BY deadline_local_date ASC, created_at ASC`
    )
    .bind(todayYmd, next7DaysEnd)
    .all<any>();

  const dateGroups = new Map<string, Array<{ id: string; title: string; version: number }>>();
  for (const t of clusterTasksRes.results || []) {
    if (!t.deadline_local_date) continue;
    const group = dateGroups.get(t.deadline_local_date) || [];
    group.push({ id: t.id, title: t.title, version: t.deadline_version });
    dateGroups.set(t.deadline_local_date, group);
  }

  for (const [date, tasks] of dateGroups.entries()) {
    if (tasks.length >= 3) {
      const sortedIds = tasks.map((t) => `${t.id}:${t.version}`).sort().join(",");
      const contextStr = `${date}:${tasks.length}:${sortedIds}`;
      const version = await computeVersionHash(contextStr);
      candidates.push({
        id: `deadline_cluster:${date}`,
        type: "deadline_cluster",
        priority: "medium",
        title: `Deadline Cluster: ${date}`,
        message: `You have ${tasks.length} tasks scheduled for ${date}. Consider spreading the workload.`,
        context: {
          date,
          count: tasks.length,
          tasks: tasks.map((t) => ({ id: t.id, title: t.title })),
        },
        version,
        actions: [
          { type: "view_day", label: "View Schedule", payload: { date } },
          { type: "dismiss", label: "Dismiss" },
        ],
        created_at: nowIso,
      });
    }
  }

  // =========================================================================
  // Rule 3: missing_prep (Tomorrow's scheduled classes with no materials linked)
  // =========================================================================
  const tomorrowClassesRes = await db
    .prepare(
      `SELECT o.id as occurrence_id, o.slot_id, o.subject_id, o.start_time, o.end_time,
              s.name as subject_name, s.code as subject_code
       FROM class_occurrences o
       JOIN timetable_subjects s ON o.subject_id = s.id
       WHERE o.occurrence_date = ? AND o.status = 'planned'
       ORDER BY o.start_time ASC`
    )
    .bind(tomorrowYmd)
    .all<any>();

  for (const occ of tomorrowClassesRes.results || []) {
    const matCountRes = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM timetable_materials
         WHERE slot_id = ? AND active = 1`
      )
      .bind(occ.slot_id)
      .first<{ cnt: number }>();

    if (!matCountRes || matCountRes.cnt === 0) {
      const contextStr = `${occ.slot_id}:${tomorrowYmd}:${occ.subject_name}`;
      const version = await computeVersionHash(contextStr);
      candidates.push({
        id: `missing_prep:${occ.slot_id}`,
        type: "missing_prep",
        priority: "medium",
        title: `Missing Preparation: ${occ.subject_name}`,
        message: `"${occ.subject_name}" is scheduled tomorrow at ${occ.start_time}, but no preparation materials are assigned.`,
        context: {
          slot_id: occ.slot_id,
          subject_id: occ.subject_id,
          subject_name: occ.subject_name,
          date: tomorrowYmd,
          start_time: occ.start_time,
        },
        version,
        actions: [
          { type: "add_material", label: "Add Material", payload: { slot_id: occ.slot_id } },
          { type: "dismiss", label: "Dismiss" },
        ],
        created_at: nowIso,
      });
    }
  }

  // =========================================================================
  // Rule 4: prepare_tonight (Evening >= 18:00 IST reminder for tomorrow)
  // =========================================================================
  if (currentHour >= 18) {
    const tomorrowTasksCount = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM tasks
         WHERE status IN ('open', 'snoozed') AND deadline_local_date = ?`
      )
      .bind(tomorrowYmd)
      .first<{ cnt: number }>();

    const classCount = tomorrowClassesRes.results?.length || 0;
    const taskCount = tomorrowTasksCount?.cnt || 0;

    if (classCount > 0 || taskCount > 0) {
      const contextStr = `${tomorrowYmd}:${classCount}:${taskCount}`;
      const version = await computeVersionHash(contextStr);
      candidates.push({
        id: `prepare_tonight:${tomorrowYmd}`,
        type: "prepare_tonight",
        priority: "low",
        title: `Prepare Tonight for Tomorrow`,
        message: `Tomorrow (${tomorrowYmd}) has ${classCount} class(es) and ${taskCount} task(s). Review your checklist tonight.`,
        context: {
          date: tomorrowYmd,
          class_count: classCount,
          task_count: taskCount,
        },
        version,
        actions: [
          { type: "view_tomorrow", label: "View Tomorrow", payload: { date: tomorrowYmd } },
          { type: "dismiss", label: "Dismiss" },
        ],
        created_at: nowIso,
      });
    }
  }

  // =========================================================================
  // Rule 5: stale_recurring (Active recurring rules with passed end_date or stalled)
  // =========================================================================
  const staleRulesRes = await db
    .prepare(
      `SELECT id, title, pattern, start_date, end_date, next_generation_date, series_version, active
       FROM recurrence_rules
       WHERE active = 1`
    )
    .all<any>();

  for (const rule of staleRulesRes.results || []) {
    let isStale = false;
    let reason = "";

    if (rule.end_date && rule.end_date < todayYmd) {
      isStale = true;
      reason = "End date has passed";
    } else if (rule.next_generation_date && rule.next_generation_date < yesterdayYmd) {
      isStale = true;
      reason = "Occurrence generation has stalled";
    }

    if (isStale) {
      const contextStr = `${rule.id}:${rule.series_version}:${rule.active}:${rule.end_date || ""}:${rule.next_generation_date || ""}`;
      const version = await computeVersionHash(contextStr);
      candidates.push({
        id: `stale_recurring:${rule.id}`,
        type: "stale_recurring",
        priority: "low",
        title: `Review Routine: ${rule.title}`,
        message: `Recurring rule "${rule.title}" needs review (${reason}). Consider pausing or updating it.`,
        context: {
          rule_id: rule.id,
          title: rule.title,
          end_date: rule.end_date,
          next_generation_date: rule.next_generation_date,
          reason,
        },
        version,
        actions: [
          { type: "pause_rule", label: "Pause Rule", payload: { rule_id: rule.id } },
          { type: "dismiss", label: "Dismiss" },
        ],
        created_at: nowIso,
      });
    }
  }

  // =========================================================================
  // Rule 6: missed_class (Past class_occurrences still marked 'planned')
  // =========================================================================
  const unconfirmedClassesRes = await db
    .prepare(
      `SELECT o.id as occurrence_id, o.occurrence_date, o.start_time, o.end_time, o.status,
              s.name as subject_name
       FROM class_occurrences o
       JOIN timetable_subjects s ON o.subject_id = s.id
       WHERE o.status = 'planned'
         AND (o.occurrence_date < ? OR (o.occurrence_date = ? AND o.end_time < ?))
       ORDER BY o.occurrence_date DESC, o.start_time DESC
       LIMIT 5`
    )
    .bind(todayYmd, todayYmd, currentTime)
    .all<any>();

  for (const occ of unconfirmedClassesRes.results || []) {
    const contextStr = `${occ.occurrence_id}:${occ.status}:${occ.occurrence_date}:${occ.start_time}`;
    const version = await computeVersionHash(contextStr);
    candidates.push({
      id: `missed_class:${occ.occurrence_id}`,
      type: "missed_class",
      priority: "medium",
      title: `Unconfirmed Class: ${occ.subject_name}`,
      message: `"${occ.subject_name}" on ${occ.occurrence_date} (${occ.start_time}) is still marked as planned. Confirm your attendance.`,
      context: {
        occurrence_id: occ.occurrence_id,
        subject_name: occ.subject_name,
        date: occ.occurrence_date,
        time: occ.start_time,
      },
      version,
      actions: [
        { type: "mark_attended", label: "Attended", payload: { occurrence_id: occ.occurrence_id } },
        { type: "mark_missed", label: "Missed", payload: { occurrence_id: occ.occurrence_id } },
        { type: "dismiss", label: "Dismiss" },
      ],
      created_at: nowIso,
    });
  }

  // =========================================================================
  // Filter out dismissed suggestions where context version has NOT changed
  // =========================================================================
  const dismissalsRes = await db
    .prepare(
      `SELECT suggestion_key, dismissed_version, expires_at
       FROM suggestion_dismissals
       WHERE expires_at IS NULL OR expires_at > ?`
    )
    .bind(nowIso)
    .all<SuggestionDismissalRow>();

  const dismissalMap = new Map<string, SuggestionDismissalRow>();
  for (const d of dismissalsRes.results || []) {
    dismissalMap.set(d.suggestion_key, d);
  }

  const activeSuggestions: Suggestion[] = [];
  for (const candidate of candidates) {
    const existingDismissal = dismissalMap.get(candidate.id);
    if (existingDismissal && existingDismissal.dismissed_version === candidate.version) {
      // Dismissal matches current context version -> suppress
      continue;
    }
    activeSuggestions.push(candidate);
  }

  // Sort by priority (high > medium > low), then title
  const priorityWeight: Record<string, number> = { high: 3, medium: 2, low: 1 };
  activeSuggestions.sort((a, b) => {
    const pDiff = (priorityWeight[b.priority] || 0) - (priorityWeight[a.priority] || 0);
    if (pDiff !== 0) return pDiff;
    return a.title.localeCompare(b.title);
  });

  return activeSuggestions;
}

/**
 * Dismisses a suggestion by recording its key and context version in suggestion_dismissals.
 */
export async function dismissSuggestion(
  db: D1Database,
  suggestionKey: string,
  version: string,
  expiresAt: string | null = null,
  now: Date = new Date()
): Promise<boolean> {
  const nowIso = now.toISOString();
  const id = `sug_dis_${crypto.randomUUID()}`;

  await db
    .prepare(
      `INSERT INTO suggestion_dismissals (
         id, suggestion_key, dismissed_version, dismissed_at, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(suggestion_key) DO UPDATE SET
         dismissed_version = excluded.dismissed_version,
         dismissed_at = excluded.dismissed_at,
         expires_at = excluded.expires_at`
    )
    .bind(id, suggestionKey, version, nowIso, expiresAt, nowIso)
    .run();

  return true;
}
