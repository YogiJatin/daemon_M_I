/**
 * timetableEngine.ts — Block 3B College Timetable & Preparation Engine
 *
 * Requirements (Personal_AI_OS_SRS_v2.2.md §§6, 7.4, 8.6, 8.7, 9.1, 12, 16 TEST-3B.1 to TEST-3B.7):
 * - Semester & subject management with section support, external_id for sync, and color
 * - Slot scheduling with weekday (1..7), room, lab_batch, and alternating A/B weeks
 * - Preparation checklist materials (Calculator, Lab Manual, Observation Book, etc.)
 * - Extensible exceptions: cancelled, holiday, moved, extra_class, exam, special_event, no_classes
 * - Holiday calendar with scope (national, college, semester, department)
 * - Dedicated class_occurrences table for operational status, attendance, and analytics
 * - Bounded rolling 14-day horizon materialization with idempotency
 * - Single 20:30 IST prep digest planning (prep-digest:{IST_date}) with rich structured content
 * - Quiet-hours compliant class preparation reminders
 * - Audit events for all state changes
 */

import { getISTDateParts, istToUtcDate } from "./dateParser";
import { planNotification, planPrepDigest } from "./notificationPlanner";
import {
  getIsoWeekday,
  getAlternatingWeekType,
  getMondayOfWeek,
  addDaysYmd,
  formatUtcYmd,
  parseYmdToUtc,
} from "./recurrenceEngine";

export interface SemesterRow {
  id: string;
  name: string;
  start_date: string; // YYYY-MM-DD IST
  end_date: string;   // YYYY-MM-DD IST
  is_active: number;  // 0 or 1
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubjectRow {
  id: string;
  semester_id: string;
  code: string | null;
  name: string;
  faculty: string | null;
  default_room: string | null;
  color: string | null;
  section_name: string | null;
  preparation_minutes: number;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SlotRow {
  id: string;
  semester_id: string;
  subject_id: string;
  weekday: number; // 1=Mon .. 7=Sun
  start_time: string; // HH:mm IST
  end_time: string;   // HH:mm IST
  room: string | null;
  week_pattern: "every_week" | "alternate_a" | "alternate_b";
  lab_batch: string | null;
  week_anchor_monday: string | null;
  section_name: string | null;
  active: number;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaterialRow {
  id: string;
  slot_id: string;
  material_type: string;
  title: string;
  notes: string | null;
  required: number;
  display_order: number;
  active: number;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExceptionRow {
  id: string;
  slot_id: string | null;
  exception_type: string;
  start_date: string;
  end_date: string;
  new_date: string | null;
  new_start_time: string | null;
  new_end_time: string | null;
  reason: string | null;
  external_id: string | null;
  created_at: string;
}

export interface HolidayRow {
  id: string;
  name: string;
  holiday_date: string;
  is_full_day: number;
  holiday_scope: string;
  external_id: string | null;
  created_at: string;
}

export interface ClassOccurrenceRow {
  id: string;
  slot_id: string;
  semester_id: string;
  subject_id: string;
  occurrence_date: string; // YYYY-MM-DD IST
  start_time: string;      // HH:mm IST
  end_time: string;        // HH:mm IST
  room: string | null;
  status: "planned" | "completed" | "attended" | "cancelled" | "missed";
  task_id: string | null;
  prep_notification_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Returns active semester or null.
 */
export async function getActiveSemester(db: D1Database): Promise<SemesterRow | null> {
  return await db
    .prepare("SELECT * FROM timetable_semesters WHERE is_active = 1 LIMIT 1")
    .first<SemesterRow>();
}

/**
 * Activates a semester, deactivating all others.
 */
export async function activateSemester(
  db: D1Database,
  semesterId: string,
  now: Date = new Date()
): Promise<boolean> {
  const nowIso = now.toISOString();

  const sem = await db
    .prepare("SELECT id, name FROM timetable_semesters WHERE id = ?")
    .bind(semesterId)
    .first<{ id: string; name: string }>();

  if (!sem) return false;

  await db.batch([
    db.prepare("UPDATE timetable_semesters SET is_active = 0, updated_at = ? WHERE id != ?").bind(nowIso, semesterId),
    db.prepare("UPDATE timetable_semesters SET is_active = 1, updated_at = ? WHERE id = ?").bind(nowIso, semesterId),
    db.prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, 'timetable_semester', ?, 'semester_activated', 'owner:telegram', ?, ?)`
    ).bind(crypto.randomUUID(), semesterId, JSON.stringify({ name: sem.name }), nowIso),
  ]);

  return true;
}

/**
 * Checks if an IST date is a full-day holiday.
 */
export async function isDateHoliday(db: D1Database, ymd: string): Promise<{ isHoliday: boolean; holidayName?: string }> {
  const hol = await db
    .prepare("SELECT name, is_full_day FROM holiday_calendar WHERE holiday_date = ?")
    .bind(ymd)
    .first<{ name: string; is_full_day: number }>();

  if (hol && hol.is_full_day === 1) {
    return { isHoliday: true, holidayName: hol.name };
  }
  return { isHoliday: false };
}

/**
 * Checks if a global or slot-specific exception applies to an IST date.
 */
export async function checkExceptionForSlot(
  db: D1Database,
  slotId: string,
  ymd: string
): Promise<{ suppressed: boolean; exception?: ExceptionRow }> {
  // Global exception (slot_id is NULL)
  const globalEx = await db
    .prepare(
      `SELECT * FROM timetable_exceptions
       WHERE slot_id IS NULL
         AND start_date <= ? AND end_date >= ?
       LIMIT 1`
    )
    .bind(ymd, ymd)
    .first<ExceptionRow>();

  if (globalEx) {
    return { suppressed: true, exception: globalEx };
  }

  // Slot-specific exception
  const slotEx = await db
    .prepare(
      `SELECT * FROM timetable_exceptions
       WHERE slot_id = ?
         AND start_date <= ? AND end_date >= ?
       LIMIT 1`
    )
    .bind(slotId, ymd, ymd)
    .first<ExceptionRow>();

  if (slotEx && (slotEx.exception_type === "cancelled" || slotEx.exception_type === "skip" || slotEx.exception_type === "holiday" || slotEx.exception_type === "no_classes")) {
    return { suppressed: true, exception: slotEx };
  }

  return { suppressed: false, exception: slotEx || undefined };
}

/**
 * Materializes class occurrences and preparation alerts across a rolling 14-day horizon.
 *
 * Requirements:
 * - Scans active semester slots only (no whole-table rebuild).
 * - Respects semester boundaries (mid-week ends handled cleanly).
 * - Suppresses occurrences on holidays and no_classes exceptions.
 * - Handles alternating weeks (A/B) from anchor Monday.
 * - Monotonically plans preparation reminders before class start.
 * - Idempotent insertion using UNIQUE(slot_id, occurrence_date).
 */
export async function materializeTimetableOccurrences(
  db: D1Database,
  now: Date = new Date(),
  horizonDays: number = 14
): Promise<{ occurrencesCreated: number; remindersPlanned: number; errors: string[] }> {
  const ist = getISTDateParts(now);
  const todayYmd = ist.localDate;
  const horizonEndYmd = addDaysYmd(todayYmd, horizonDays);
  const nowIso = now.toISOString();

  let occurrencesCreated = 0;
  let remindersPlanned = 0;
  const errors: string[] = [];

  const semester = await getActiveSemester(db);
  if (!semester) {
    return { occurrencesCreated: 0, remindersPlanned: 0, errors: [] };
  }

  // Active window bounded by semester start/end
  const fromYmd = todayYmd < semester.start_date ? semester.start_date : todayYmd;
  const toYmd = horizonEndYmd > semester.end_date ? semester.end_date : horizonEndYmd;

  if (fromYmd > toYmd) {
    return { occurrencesCreated: 0, remindersPlanned: 0, errors: [] };
  }

  // Query active slots with subjects
  const slots = await db
    .prepare(
      `SELECT s.*, subj.name as subject_name, subj.code as subject_code,
              subj.faculty, subj.preparation_minutes, subj.color
       FROM timetable_slots s
       JOIN timetable_subjects subj ON s.subject_id = subj.id
       WHERE s.semester_id = ? AND s.active = 1`
    )
    .bind(semester.id)
    .all<SlotRow & {
      subject_name: string;
      subject_code: string | null;
      faculty: string | null;
      preparation_minutes: number;
      color: string | null;
    }>();

  for (const slot of slots.results || []) {
    try {
      let currYmd = fromYmd;
      while (currYmd <= toYmd) {
        const isoDay = getIsoWeekday(currYmd); // 1=Mon .. 7=Sun

        if (isoDay === slot.weekday) {
          // Check alternating week pattern
          let isEligibleWeek = true;
          if (slot.week_pattern === "alternate_a" || slot.week_pattern === "alternate_b") {
            const anchor = slot.week_anchor_monday || getMondayOfWeek(semester.start_date);
            const weekType = getAlternatingWeekType(currYmd, anchor);
            const targetType = slot.week_pattern === "alternate_a" ? "A" : "B";
            if (weekType !== targetType) {
              isEligibleWeek = false;
            }
          }

          if (isEligibleWeek) {
            // Check holiday calendar
            const hol = await isDateHoliday(db, currYmd);
            // Check exceptions
            const ex = await checkExceptionForSlot(db, slot.id, currYmd);

            if (!hol.isHoliday && !ex.suppressed) {
              // Check if occurrence already exists
              const existing = await db
                .prepare("SELECT id FROM class_occurrences WHERE slot_id = ? AND occurrence_date = ?")
                .bind(slot.id, currYmd)
                .first<{ id: string }>();

              if (!existing) {
                const occId = crypto.randomUUID();
                const taskId = crypto.randomUUID();
                const classStartInstant = istToUtcDate(currYmd, slot.start_time);
                const classStartIso = classStartInstant.toISOString();

                // Compute preparation reminder instant (e.g. 45 min before class)
                const prepLeadMin = slot.preparation_minutes > 0 ? slot.preparation_minutes : 45;
                const prepInstant = new Date(classStartInstant.getTime() - prepLeadMin * 60 * 1000);
                const prepIso = prepInstant.toISOString();

                // 1. Insert class_occurrences record
                const occStmt = db.prepare(
                  `INSERT INTO class_occurrences (
                     id, slot_id, semester_id, subject_id, occurrence_date,
                     start_time, end_time, room, status, task_id, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)`
                ).bind(
                  occId,
                  slot.id,
                  slot.semester_id,
                  slot.subject_id,
                  currYmd,
                  slot.start_time,
                  slot.end_time,
                  slot.room || null,
                  taskId,
                  nowIso,
                  nowIso
                );

                // 2. Insert linked academic task
                const titleStr = `${slot.subject_name}${slot.room ? ` (${slot.room})` : ""}`;
                const taskStmt = db.prepare(
                  `INSERT OR IGNORE INTO tasks (
                     id, title, category, status, priority,
                     deadline_kind, deadline_local_date, deadline_time_local, deadline_at_utc,
                     deadline_version, created_at, updated_at
                   ) VALUES (?, ?, 'academic', 'open', 'normal', 'timed', ?, ?, ?, 1, ?, ?)`
                ).bind(
                  taskId,
                  titleStr,
                  currYmd,
                  slot.start_time,
                  classStartIso,
                  nowIso,
                  nowIso
                );

                // 3. Audit events
                const auditOccStmt = db.prepare(
                  `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
                   VALUES (?, 'class_occurrence', ?, 'class_occurrence_generated', 'system:scheduler', ?, ?)`
                ).bind(
                  crypto.randomUUID(),
                  occId,
                  JSON.stringify({
                    subject: slot.subject_name,
                    date: currYmd,
                    start_time: slot.start_time,
                    room: slot.room,
                  }),
                  nowIso
                );

                await db.batch([taskStmt, occStmt, auditOccStmt]);
                occurrencesCreated++;

                // 4. Plan preparation reminder notification
                if (prepInstant.getTime() > now.getTime()) {
                  const planRes = await planNotification({
                    db,
                    taskId,
                    deadlineKind: "timed",
                    deadlineAtUtc: prepIso,
                    deadlineVersion: 1,
                    stage: "prep",
                    now,
                  });
                  if (planRes.planned) {
                    remindersPlanned++;
                  }
                }
              }
            }
          }
        }
        currYmd = addDaysYmd(currYmd, 1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Slot ${slot.id}: ${msg}`);
    }
  }

  // Also plan prep digest for tomorrow if classes/materials exist
  const tomorrowYmd = addDaysYmd(todayYmd, 1);
  await planPrepDigest(db, tomorrowYmd, now).catch(() => {});

  return { occurrencesCreated, remindersPlanned, errors };
}

/**
 * Returns tomorrow's classes and preparation materials formatted for the 20:30 evening digest.
 */
export async function getPrepDigestData(
  db: D1Database,
  targetYmd: string
): Promise<{
  targetDate: string;
  classes: Array<{
    startTime: string;
    endTime: string;
    subjectName: string;
    subjectCode: string | null;
    room: string | null;
    faculty: string | null;
    materials: Array<{ title: string; materialType: string; notes: string | null; required: boolean }>;
  }>;
}> {
  const semester = await getActiveSemester(db);
  if (!semester) {
    return { targetDate: targetYmd, classes: [] };
  }

  // Check holiday
  const hol = await isDateHoliday(db, targetYmd);
  if (hol.isHoliday) {
    return { targetDate: targetYmd, classes: [] };
  }

  const occurrences = await db
    .prepare(
      `SELECT o.*, s.name as subject_name, s.code as subject_code, s.faculty
       FROM class_occurrences o
       JOIN timetable_subjects s ON o.subject_id = s.id
       WHERE o.occurrence_date = ? AND o.status != 'cancelled'
       ORDER BY o.start_time ASC`
    )
    .bind(targetYmd)
    .all<ClassOccurrenceRow & { subject_name: string; subject_code: string | null; faculty: string | null }>();

  const classesWithMaterials = [];

  for (const occ of occurrences.results || []) {
    const materials = await db
      .prepare(
        `SELECT material_type, title, notes, required
         FROM timetable_materials
         WHERE slot_id = ? AND active = 1
         ORDER BY display_order ASC, title ASC`
      )
      .bind(occ.slot_id)
      .all<{ material_type: string; title: string; notes: string | null; required: number }>();

    classesWithMaterials.push({
      startTime: occ.start_time,
      endTime: occ.end_time,
      subjectName: occ.subject_name,
      subjectCode: occ.subject_code,
      room: occ.room,
      faculty: occ.faculty,
      materials: (materials.results || []).map((m) => ({
        materialType: m.material_type,
        title: m.title,
        notes: m.notes,
        required: m.required === 1,
      })),
    });
  }

  return {
    targetDate: targetYmd,
    classes: classesWithMaterials,
  };
}

/**
 * Renders preparation digest message text for tomorrow's classes and materials.
 */
export async function renderPrepDigestMessage(db: D1Database, targetYmd: string): Promise<string> {
  const data = await getPrepDigestData(db, targetYmd);

  if (data.classes.length === 0) {
    return `Tomorrow (${targetYmd}): No classes scheduled. Enjoy your day!`;
  }

  let msg = `📚 Schedule for Tomorrow (${targetYmd}):\n\n`;

  for (const c of data.classes) {
    const roomStr = c.room ? ` | Room ${c.room}` : "";
    const facultyStr = c.faculty ? ` (${c.faculty})` : "";
    msg += `⏰ ${c.startTime} – ${c.endTime}: ${c.subjectName}${roomStr}${facultyStr}\n`;

    if (c.materials.length > 0) {
      msg += `   Bring:\n`;
      for (const m of c.materials) {
        const noteStr = m.notes ? ` (${m.notes})` : "";
        msg += `   • ${m.title}${noteStr}\n`;
      }
    }
    msg += `\n`;
  }

  return msg.trim();
}

/**
 * Returns class occurrences for today or given date.
 */
export async function getClassesForDate(
  db: D1Database,
  ymd: string
): Promise<Array<any>> {
  const res = await db
    .prepare(
      `SELECT o.id, o.occurrence_date, o.start_time, o.end_time, o.room, o.status,
              s.name as subject_name, s.code as subject_code, s.faculty, s.color
       FROM class_occurrences o
       JOIN timetable_subjects s ON o.subject_id = s.id
       WHERE o.occurrence_date = ?
       ORDER BY o.start_time ASC`
    )
    .bind(ymd)
    .all();

  return res.results || [];
}

/**
 * Returns next class starting after `now` today, or the first class tomorrow.
 */
export async function getNextClass(db: D1Database, now: Date = new Date()): Promise<any | null> {
  const ist = getISTDateParts(now);
  const todayYmd = ist.localDate;
  const currentTime = ist.localTime; // "HH:mm"

  // 1. Check later today
  const laterToday = await db
    .prepare(
      `SELECT o.*, s.name as subject_name, s.code as subject_code, s.faculty, s.color
       FROM class_occurrences o
       JOIN timetable_subjects s ON o.subject_id = s.id
       WHERE o.occurrence_date = ? AND o.start_time > ? AND o.status = 'planned'
       ORDER BY o.start_time ASC LIMIT 1`
    )
    .bind(todayYmd, currentTime)
    .first();

  if (laterToday) return laterToday;

  // 2. Check tomorrow
  const tomorrowYmd = addDaysYmd(todayYmd, 1);
  const firstTomorrow = await db
    .prepare(
      `SELECT o.*, s.name as subject_name, s.code as subject_code, s.faculty, s.color
       FROM class_occurrences o
       JOIN timetable_subjects s ON o.subject_id = s.id
       WHERE o.occurrence_date = ? AND o.status = 'planned'
       ORDER BY o.start_time ASC LIMIT 1`
    )
    .bind(tomorrowYmd)
    .first();

  return firstTomorrow || null;
}

/**
 * Returns the currently ongoing class if any (/whereami).
 */
export async function getOngoingClass(db: D1Database, now: Date = new Date()): Promise<any | null> {
  const ist = getISTDateParts(now);
  const todayYmd = ist.localDate;
  const currentTime = ist.localTime;

  return await db
    .prepare(
      `SELECT o.*, s.name as subject_name, s.code as subject_code, s.faculty, s.color
       FROM class_occurrences o
       JOIN timetable_subjects s ON o.subject_id = s.id
       WHERE o.occurrence_date = ?
         AND o.start_time <= ?
         AND o.end_time >= ?
         AND o.status != 'cancelled'
       LIMIT 1`
    )
    .bind(todayYmd, currentTime, currentTime)
    .first();
}

/**
 * Returns day-by-day preview for next N days.
 */
export async function getSchedulePreview(
  db: D1Database,
  fromYmd: string,
  toYmd: string
): Promise<Array<{ date: string; weekday: number; classes: Array<any> }>> {
  const preview: Array<{ date: string; weekday: number; classes: Array<any> }> = [];
  let curr = fromYmd;

  while (curr <= toYmd) {
    const classes = await getClassesForDate(db, curr);
    preview.push({
      date: curr,
      weekday: getIsoWeekday(curr),
      classes,
    });
    curr = addDaysYmd(curr, 1);
  }

  return preview;
}
