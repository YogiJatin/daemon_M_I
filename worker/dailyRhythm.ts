/**
 * worker/dailyRhythm.ts - Block 2 Daily Rhythm Profile, Extended Anchors & Daily Overrides
 *
 * Requirements:
 * 1. Profile in settings:
 *    - wake_time (HH:mm)
 *    - leave_home_time (HH:mm, or per-weekday optional)
 *    - commute_to_college_min (integer)
 *    - commute_home_min (integer)
 *    - buffer_after_class_min (integer)
 *    - bedtime (HH:mm)
 *    - morning_anchor_time (HH:mm)
 *    - evening_anchor_time (HH:mm)
 * 2. Extended Anchors:
 *    - after_last_class: class end
 *    - leaving_college: class end + buffer_after_class_min
 *    - reaching_home: effective leaving_college + commute_home_min
 *    - before_first_class: first class start - commute_to_college_min - buffer_after_class_min
 *    - leaving_home: first class start - commute_to_college_min
 *    - morning: morning_anchor_time
 *    - evening: evening_anchor_time
 *    - none
 * 3. Daily Overrides (schedule_exception):
 *    - Resolver order: active override for date > per-weekday profile > default profile > ask
 *    - Clock disambiguation: nearest expected anchor occurrence
 *    - Reminders shift: lists unsent anchored reminders and offers [Shift][Keep]
 * 4. Learning with Consent:
 *    - Logs anchor adjustments. After 3 consistent corrections, proposes settings change.
 */

export interface DailyProfile {
  wake_time: string;                  // e.g. "06:30"
  leave_home_time?: string;           // e.g. "08:00"
  commute_to_college_min: number;     // e.g. 30
  commute_home_min: number;           // e.g. 40
  buffer_after_class_min: number;     // e.g. 15
  bedtime: string;                    // e.g. "23:00"
  morning_anchor_time: string;        // e.g. "07:30"
  evening_anchor_time: string;        // e.g. "19:00"
}

export type ExtendedAnchor =
  | "after_last_class"
  | "leaving_college"
  | "reaching_home"
  | "before_first_class"
  | "leaving_home"
  | "morning"
  | "evening"
  | "none";

export interface ResolvedAnchorTime {
  ok: boolean;
  needsInfo?: boolean;
  question?: string;
  buttons?: any;
  dateIst: string;
  clockTime: string;                  // HH:mm in IST
  utcInstant?: Date;
  resolutionSource: string;           // override:<id> | timetable | profile
  anchor: ExtendedAnchor;
  offsetMin?: number;
}

export interface DailyOverride {
  id: string;
  date_ist: string;
  anchor_key: "leaving_college" | "class_end" | "first_class_start" | "cancel_class";
  mode: "absolute" | "delta";
  value: string;
  source_chat_message_id?: string;
  status: "active" | "superseded";
  created_at: string;
}

// ---------------------------------------------------------------------------
// Profile Helpers
// ---------------------------------------------------------------------------

export const PROFILE_KEYS = [
  "wake_time",
  "commute_to_college_min",
  "buffer_after_class_min",
  "commute_home_min",
  "bedtime",
  "morning_anchor_time",
  "evening_anchor_time",
] as const;

export async function getProfile(db: D1Database): Promise<Partial<DailyProfile>> {
  try {
    const rows = await db
      .prepare(
        `SELECT key, value FROM settings
         WHERE key IN ('wake_time', 'leave_home_time', 'commute_to_college_min',
                       'commute_home_min', 'buffer_after_class_min', 'bedtime',
                       'morning_anchor_time', 'evening_anchor_time')`
      )
      .all<{ key: string; value: string }>();

    const map: Record<string, string> = {};
    for (const r of rows.results) map[r.key] = r.value;

    return {
      wake_time: map["wake_time"],
      leave_home_time: map["leave_home_time"],
      commute_to_college_min: map["commute_to_college_min"] ? parseInt(map["commute_to_college_min"], 10) : undefined,
      commute_home_min: map["commute_home_min"] ? parseInt(map["commute_home_min"], 10) : undefined,
      buffer_after_class_min: map["buffer_after_class_min"] ? parseInt(map["buffer_after_class_min"], 10) : undefined,
      bedtime: map["bedtime"],
      morning_anchor_time: map["morning_anchor_time"],
      evening_anchor_time: map["evening_anchor_time"],
    };
  } catch {
    return {};
  }
}

export function getMissingProfileKeys(profile: Partial<DailyProfile>): string[] {
  const missing: string[] = [];
  if (!profile.wake_time) missing.push("wake_time");
  if (profile.commute_to_college_min === undefined) missing.push("commute_to_college_min");
  if (profile.buffer_after_class_min === undefined) missing.push("buffer_after_class_min");
  if (profile.commute_home_min === undefined) missing.push("commute_home_min");
  if (!profile.bedtime) missing.push("bedtime");
  if (!profile.morning_anchor_time) missing.push("morning_anchor_time");
  if (!profile.evening_anchor_time) missing.push("evening_anchor_time");
  return missing;
}

export async function setProfileKey(db: D1Database, key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`
    )
    .bind(key, value, now, value, now)
    .run();
}

// ---------------------------------------------------------------------------
// Time arithmetic helpers (IST)
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function addMinutesToClockTime(clockTime: string, deltaMin: number): string {
  const [hStr, mStr] = clockTime.split(":");
  let totalMin = parseInt(hStr, 10) * 60 + parseInt(mStr, 10) + deltaMin;
  totalMin = ((totalMin % 1440) + 1440) % 1440; // clamp to 24h
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function istDateTimeToUtc(dateIst: string, clockTimeIst: string): Date {
  const [year, month, day] = dateIst.split("-").map(Number);
  const [hours, minutes] = clockTimeIst.split(":").map(Number);
  // Construct UTC timestamp representing that IST wall clock
  const utcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - IST_OFFSET_MS;
  return new Date(utcMs);
}

export function formatTime12h(clockTime: string): string {
  const [hStr, mStr] = clockTime.split(":");
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr} ${ampm}`;
}

export function isQuietHours(clockTime: string): boolean {
  const [hStr] = clockTime.split(":");
  const h = parseInt(hStr, 10);
  // Quiet hours: 23:00 - 07:00 IST
  return h >= 23 || h < 7;
}

// ---------------------------------------------------------------------------
// Daily Overrides (schedule_exception)
// ---------------------------------------------------------------------------

export async function getActiveDailyOverrides(db: D1Database, dateIst: string): Promise<DailyOverride[]> {
  try {
    const res = await db
      .prepare(
        `SELECT * FROM daily_overrides
         WHERE date_ist = ? AND status = 'active'
         ORDER BY created_at DESC`
      )
      .bind(dateIst)
      .all<DailyOverride>();
    return res.results;
  } catch {
    return [];
  }
}

export async function createDailyOverride(
  db: D1Database,
  dateIst: string,
  anchorKey: "leaving_college" | "class_end" | "first_class_start" | "cancel_class",
  mode: "absolute" | "delta",
  value: string,
  sourceChatMessageId?: string
): Promise<string> {
  const id = "ovr_" + Math.random().toString(36).slice(2, 10);
  const now = new Date().toISOString();

  // Mark previous active overrides for this date and anchorKey as superseded
  await db
    .prepare(
      `UPDATE daily_overrides SET status = 'superseded'
       WHERE date_ist = ? AND anchor_key = ? AND status = 'active'`
    )
    .bind(dateIst, anchorKey)
    .run();

  // Insert new active override
  await db
    .prepare(
      `INSERT INTO daily_overrides
         (id, date_ist, anchor_key, mode, value, source_chat_message_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .bind(id, dateIst, anchorKey, mode, value, sourceChatMessageId ?? null, now)
    .run();

  return id;
}

// ---------------------------------------------------------------------------
// Extended Anchor Resolution Engine
// ---------------------------------------------------------------------------

export async function resolveExtendedAnchor(
  db: D1Database,
  anchor: ExtendedAnchor,
  dateIst: string,
  now: Date,
  profileOverride?: Partial<DailyProfile>
): Promise<ResolvedAnchorTime> {
  const profile = profileOverride || (await getProfile(db));

  // 1. Morning anchor
  if (anchor === "morning") {
    const clock = profile.morning_anchor_time || "07:30";
    const utc = istDateTimeToUtc(dateIst, clock);
    return {
      ok: true,
      dateIst,
      clockTime: clock,
      utcInstant: utc,
      resolutionSource: "profile",
      anchor,
    };
  }

  // 2. Evening anchor
  if (anchor === "evening") {
    const clock = profile.evening_anchor_time || "19:00";
    const utc = istDateTimeToUtc(dateIst, clock);
    return {
      ok: true,
      dateIst,
      clockTime: clock,
      utcInstant: utc,
      resolutionSource: "profile",
      anchor,
    };
  }

  if (anchor === "none") {
    return {
      ok: true,
      dateIst,
      clockTime: "",
      resolutionSource: "none",
      anchor: "none",
    };
  }

  // 3. Timetable / College related anchors
  // Parse weekday from dateIst (YYYY-MM-DD) -> ISO weekday 1..7 (Mon..Sun)
  const [y, m, d] = dateIst.split("-").map(Number);
  const tempDate = new Date(Date.UTC(y, m - 1, d));
  const jsDay = tempDate.getUTCDay(); // 0=Sun, 1=Mon...
  const isoWeekday = jsDay === 0 ? 7 : jsDay;

  // Check active daily overrides for this date
  const overrides = await getActiveDailyOverrides(db, dateIst);
  const cancelOverride = overrides.find((o) => o.anchor_key === "cancel_class");
  if (cancelOverride) {
    return {
      ok: false,
      needsInfo: true,
      question: `Classes are cancelled for ${dateIst}. What time would you like this reminder?`,
      buttons: {
        inline_keyboard: [
          [
            { text: "Use next class day", callback_data: `resched_next_class:${anchor}` },
            { text: "Pick time", callback_data: `pick_time:${dateIst}` },
          ],
        ],
      },
      dateIst,
      clockTime: "",
      resolutionSource: `override:${cancelOverride.id}`,
      anchor,
    };
  }

  // Fetch timetable slots for this weekday
  let slots: Array<{ start_time: string; end_time: string }> = [];
  try {
    const res = await db
      .prepare(
        `SELECT start_time, end_time FROM timetable_slots
         WHERE weekday = ? AND active = 1
         ORDER BY start_time ASC`
      )
      .bind(isoWeekday)
      .all<{ start_time: string; end_time: string }>();
    slots = res.results;
  } catch {}

  if (!slots.length) {
    // No classes on this day
    return {
      ok: false,
      needsInfo: true,
      question: `You have no classes on ${dateIst}. When would you like to schedule this?`,
      buttons: {
        inline_keyboard: [
          [
            { text: "Use next class day", callback_data: `resched_next_class:${anchor}` },
            { text: "Pick time", callback_data: `pick_time:${dateIst}` },
          ],
        ],
      },
      dateIst,
      clockTime: "",
      resolutionSource: "timetable",
      anchor,
    };
  }

  // First and last class times
  let firstStart = slots[0].start_time;
  let lastEnd = slots[slots.length - 1].end_time;

  // Check overrides on class_end
  const classEndOverride = overrides.find((o) => o.anchor_key === "class_end");
  if (classEndOverride) {
    if (classEndOverride.mode === "absolute") {
      lastEnd = classEndOverride.value;
    } else {
      lastEnd = addMinutesToClockTime(lastEnd, parseInt(classEndOverride.value, 10));
    }
  }

  // Check overrides on first_class_start
  const firstStartOverride = overrides.find((o) => o.anchor_key === "first_class_start");
  if (firstStartOverride) {
    if (firstStartOverride.mode === "absolute") {
      firstStart = firstStartOverride.value;
    } else {
      firstStart = addMinutesToClockTime(firstStart, parseInt(firstStartOverride.value, 10));
    }
  }

  // Check overrides on leaving_college
  const leavingOverride = overrides.find((o) => o.anchor_key === "leaving_college");

  const bufferMin = profile.buffer_after_class_min ?? 15;
  const commuteHomeMin = profile.commute_home_min ?? 40;
  const commuteToMin = profile.commute_to_college_min ?? 30;

  let effectiveLeavingCollege = addMinutesToClockTime(lastEnd, bufferMin);
  let leavingSource = classEndOverride ? `override:${classEndOverride.id}` : "timetable";

  if (leavingOverride) {
    if (leavingOverride.mode === "absolute") {
      effectiveLeavingCollege = leavingOverride.value;
    } else {
      effectiveLeavingCollege = addMinutesToClockTime(effectiveLeavingCollege, parseInt(leavingOverride.value, 10));
    }
    leavingSource = `override:${leavingOverride.id}`;
  }

  // Calculate anchor clock time
  let clockTime = "";
  let source = leavingSource;

  switch (anchor) {
    case "after_last_class":
      // Class end
      clockTime = lastEnd;
      source = classEndOverride ? `override:${classEndOverride.id}` : "timetable";
      break;

    case "leaving_college":
      clockTime = effectiveLeavingCollege;
      source = leavingSource;
      break;

    case "reaching_home":
      // Reaching home derives from effective leaving_college + commute_home
      clockTime = addMinutesToClockTime(effectiveLeavingCollege, commuteHomeMin);
      source = leavingSource;
      break;

    case "leaving_home":
      // First class start - commute_to
      clockTime = addMinutesToClockTime(firstStart, -commuteToMin);
      source = firstStartOverride ? `override:${firstStartOverride.id}` : "timetable";
      break;

    case "before_first_class":
      // First class start - commute_to - buffer
      clockTime = addMinutesToClockTime(firstStart, -commuteToMin - bufferMin);
      source = firstStartOverride ? `override:${firstStartOverride.id}` : "timetable";
      break;
  }

  const utcInstant = istDateTimeToUtc(dateIst, clockTime);

  return {
    ok: true,
    dateIst,
    clockTime,
    utcInstant,
    resolutionSource: source,
    anchor,
  };
}

// ---------------------------------------------------------------------------
// Reminder Shift on New Daily Override
// ---------------------------------------------------------------------------

export interface RemindersToShift {
  taskId: string;
  title: string;
  oldTime: string;
  newTime: string;
  notificationId: string;
}

export async function findRemindersToShift(
  db: D1Database,
  dateIst: string,
  now: Date
): Promise<RemindersToShift[]> {
  // Query unsent reminders for dateIst where remind_anchor is set
  try {
    const rows = await db
      .prepare(
        `SELECT t.id as task_id, t.title, t.remind_anchor, t.remind_offset_min,
                nl.id as notif_id, nl.scheduled_at, t.deadline_time_local
         FROM tasks t
         JOIN notification_log nl ON nl.task_id = t.id
         WHERE t.deadline_local_date = ?
           AND t.remind_anchor IS NOT NULL
           AND t.remind_anchor != 'none'
           AND nl.status = 'scheduled'
           AND nl.sent_at IS NULL
           AND nl.scheduled_at > ?`
      )
      .bind(dateIst, now.toISOString())
      .all<any>();

    const shifts: RemindersToShift[] = [];
    for (const r of rows.results) {
      const resolved = await resolveExtendedAnchor(db, r.remind_anchor, dateIst, now);
      if (resolved.ok && resolved.clockTime) {
        let targetClock = resolved.clockTime;
        if (r.remind_offset_min) {
          targetClock = addMinutesToClockTime(targetClock, r.remind_offset_min);
        }
        if (targetClock !== r.deadline_time_local) {
          shifts.push({
            taskId: r.task_id,
            title: r.title,
            oldTime: r.deadline_time_local || "original",
            newTime: targetClock,
            notificationId: r.notif_id,
          });
        }
      }
    }
    return shifts;
  } catch (e) {
    console.error("[findRemindersToShift] Error:", e);
    return [];
  }
}

export async function applyReminderShifts(
  db: D1Database,
  shifts: RemindersToShift[],
  dateIst: string
): Promise<number> {
  let count = 0;
  for (const s of shifts) {
    const newUtc = istDateTimeToUtc(dateIst, s.newTime);
    // Align to start of minute for guaranteed cron pickup
    const alignedUtc = new Date(Math.floor(newUtc.getTime() / 60000) * 60000).toISOString();
    const nowIso = new Date().toISOString();

    await db
      .prepare(
        `UPDATE notification_log
         SET scheduled_at = ?, updated_at = ?
         WHERE id = ? AND status = 'scheduled' AND sent_at IS NULL`
      )
      .bind(alignedUtc, nowIso, s.notificationId)
      .run();

    await db
      .prepare(
        `UPDATE tasks
         SET deadline_time_local = ?, deadline_at_utc = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(s.newTime, newUtc.toISOString(), nowIso, s.taskId)
      .run();

    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Anchor Corrections & Learning with Consent
// ---------------------------------------------------------------------------

export async function recordAnchorCorrection(
  db: D1Database,
  anchorKey: string,
  requestedTime: string,
  chosenTime: string
): Promise<{ proposalMessage?: string; newBufferMin?: number }> {
  const [reqH, reqM] = requestedTime.split(":").map(Number);
  const [choH, choM] = chosenTime.split(":").map(Number);
  const deltaMin = (choH * 60 + choM) - (reqH * 60 + reqM);

  const id = "cor_" + Math.random().toString(36).slice(2, 10);
  const nowStr = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO anchor_corrections (id, anchor_key, requested_time, chosen_time, delta_min, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, anchorKey, requestedTime, chosenTime, deltaMin, nowStr)
    .run();

  // Check last 3 corrections for this anchor
  const last3 = await db
    .prepare(
      `SELECT delta_min FROM anchor_corrections
       WHERE anchor_key = ?
       ORDER BY created_at DESC LIMIT 3`
    )
    .bind(anchorKey)
    .all<{ delta_min: number }>();

  if (last3.results.length === 3) {
    const d0 = last3.results[0].delta_min;
    const allSame = last3.results.every((r) => r.delta_min === d0);
    if (allSame && d0 !== 0) {
      const profile = await getProfile(db);
      const currentBuffer = profile.buffer_after_class_min ?? 15;
      const proposedBuffer = Math.max(0, currentBuffer + d0);
      return {
        proposalMessage: `You've adjusted your time by ${d0 > 0 ? "+" : ""}${d0} min 3 times. Update your buffer after class from ${currentBuffer} to ${proposedBuffer} min?`,
        newBufferMin: proposedBuffer,
      };
    }
  }

  return {};
}
