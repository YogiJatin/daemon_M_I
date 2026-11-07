/**
 * worker/briefings.ts — Autonomous Morning & Evening Briefings
 *
 * Implements Phase 1 (Block 4) briefing dispatch:
 * - Morning Briefing (08:00 IST): Timetable for today, tasks due, weather line, daily note mirror job.
 * - Evening Briefing (20:30 IST): Tomorrow's timetable preview, completed vs remaining tasks, proposal review.
 * - Strict deduplication via briefing_runs table.
 * - Bound to Pool B attention budget (max 2/day).
 * - ZERO LLM calls: Pure deterministic D1 data templates.
 */

import { getISTDateParts } from "./dateParser";
import { canDispatchAttention, logAttentionSend } from "./attention";
import { sendTelegramMessage } from "./telegram";
import { fetchWeather } from "./weatherService";
import { enqueueMirrorJob } from "./desktopMirrorService";

export interface BriefingResult {
  dispatched: boolean;
  type?: "morning" | "evening";
  message?: string;
  error?: string;
}

/**
 * Check whether a briefing should be triggered on this cron tick and dispatch it if due.
 */
export async function checkAndDispatchBriefings(
  db: D1Database,
  botToken?: string,
  ownerChatId?: string | number,
  now: Date = new Date()
): Promise<BriefingResult> {
  if (!botToken || !ownerChatId) {
    return { dispatched: false, error: "Missing bot credentials" };
  }

  const ist = getISTDateParts(now);
  const localDate = ist.localDate; // YYYY-MM-DD
  const hour = parseInt(ist.hours, 10);
  const minute = parseInt(ist.minutes, 10);

  // Morning briefing window: 08:00 - 08:14 IST
  const isMorningWindow = hour === 8 && minute < 15;
  // Evening briefing window: 20:30 - 20:44 IST
  const isEveningWindow = hour === 20 && minute >= 30 && minute < 45;

  if (!isMorningWindow && !isEveningWindow) {
    return { dispatched: false };
  }

  const briefingType = isMorningWindow ? "morning" : "evening";

  // 1. Check if already dispatched today
  const existing = await db
    .prepare(
      `SELECT id FROM briefing_runs WHERE briefing_type = ? AND run_date = ?`
    )
    .bind(briefingType, localDate)
    .first();

  if (existing) {
    return { dispatched: false, message: `${briefingType} briefing already run today` };
  }

  // 2. Check attention budget
  const attn = await canDispatchAttention(db, "briefing", now);
  if (!attn.allowed) {
    await db
      .prepare(
        `INSERT INTO briefing_runs (id, briefing_type, run_date, sent_at, status)
         VALUES (?, ?, ?, ?, 'suppressed')
         ON CONFLICT(briefing_type, run_date) DO NOTHING`
      )
      .bind(`brf_${crypto.randomUUID()}`, briefingType, localDate, now.toISOString())
      .run()
      .catch(() => {});
    return { dispatched: false, error: attn.reason };
  }

  // 3. Build template content
  let text = "";
  if (briefingType === "morning") {
    text = await buildMorningBriefingText(db, localDate, ist.dayOfWeek, now);
  } else {
    text = await buildEveningBriefingText(db, localDate, ist.dayOfWeek, now);
  }

  // 4. Send via Telegram
  const sendRes = await sendTelegramMessage(botToken, ownerChatId, text, undefined, { parseMode: "Markdown" });
  const nowIso = now.toISOString();

  if (sendRes.sent) {
    const runId = `brf_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO briefing_runs (id, briefing_type, run_date, sent_at, status)
         VALUES (?, ?, ?, ?, 'sent')
         ON CONFLICT(briefing_type, run_date) DO NOTHING`
      )
      .bind(runId, briefingType, localDate, nowIso)
      .run();

    await logAttentionSend(
      db,
      "telegram",
      "pool_b",
      "briefing",
      ownerChatId,
      text,
      sendRes.telegramMessageId,
      now
    );

    // If morning briefing, enqueue morning Obsidian daily note mirror job
    if (briefingType === "morning") {
      try {
        const noteContent = `# Daily Log - ${localDate}\n\n## Briefing\n${text}\n\n## Tasks\n- [ ] Morning check completed\n`;
        await enqueueMirrorJob(db, {
          targetFolder: "Briefings",
          filename: `${localDate}.md`,
          content: noteContent,
          dedupeKey: `briefing-${localDate}`,
        });
      } catch {}
    }

    return { dispatched: true, type: briefingType, message: "Sent successfully" };
  } else {
    return { dispatched: false, error: sendRes.error };
  }
}

/**
 * Builds deterministic Morning Briefing text
 */
export async function buildMorningBriefingText(
  db: D1Database,
  localDate: string,
  weekday: number,
  now: Date
): Promise<string> {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = days[weekday] || "Today";

  // Read settings for weather
  const settingRows = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN ('home_city', 'home_lat', 'home_lon')`)
    .all<{ key: string; value: string }>();
  const settings: Record<string, string> = {};
  for (const r of settingRows.results || []) settings[r.key] = r.value;

  // Weather line
  let weatherLine = "☀️ Weather: Clear in Hyderabad";
  try {
    const wRes = await fetchWeather(undefined, "today", false, false, settings, now);
    if (wRes && wRes.renderedText) {
      weatherLine = `🌤️ ${wRes.renderedText}`;
    }
  } catch {}

  // Classes for today (weekday: 0=Sun .. 6=Sat)
  const classRows = await db
    .prepare(
      `SELECT s.name as subject_name, ts.start_time, ts.end_time, ts.room
       FROM timetable_slots ts
       JOIN timetable_subjects s ON ts.subject_id = s.id
       JOIN timetable_semesters sem ON ts.semester_id = sem.id
       WHERE sem.is_active = 1 AND ts.active = 1 AND ts.weekday = ?
       ORDER BY ts.start_time ASC`
    )
    .bind(weekday)
    .all<{ subject_name: string; start_time: string; end_time: string; room?: string }>();

  let classSection = "• No classes scheduled today";
  if (classRows.results && classRows.results.length > 0) {
    classSection = classRows.results
      .map((c) => `• *${c.subject_name}*: ${c.start_time} - ${c.end_time}${c.room ? ` (${c.room})` : ""}`)
      .join("\n");
  }

  // Tasks due today
  const taskRows = await db
    .prepare(
      `SELECT title, due_date_time_local FROM tasks
       WHERE due_date_time_local LIKE ? AND status = 'open'
       ORDER BY due_date_time_local ASC LIMIT 5`
    )
    .bind(`${localDate}%`)
    .all<{ title: string; due_date_time_local: string }>();

  let taskSection = "• No critical tasks due today";
  if (taskRows.results && taskRows.results.length > 0) {
    taskSection = taskRows.results
      .map((t) => {
        const timePart = t.due_date_time_local.split("T")[1]?.slice(0, 5) || "";
        return `• [ ] ${t.title}${timePart ? ` (Due: ${timePart})` : ""}`;
      })
      .join("\n");
  }

  return [
    `🌅 *Morning Briefing* — ${dayName}, ${localDate}`,
    "",
    weatherLine,
    "",
    "📚 *Today's Schedule:*",
    classSection,
    "",
    "✅ *Tasks Due Today:*",
    taskSection,
    "",
    "_Have a focused and productive day!_",
  ].join("\n");
}

/**
 * Builds deterministic Evening Briefing text
 */
export async function buildEveningBriefingText(
  db: D1Database,
  localDate: string,
  weekday: number,
  now: Date
): Promise<string> {
  const nextDay = (weekday + 1) % 7;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const tomorrowName = days[nextDay];

  // Completed tasks today
  const doneRows = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM tasks
       WHERE status = 'completed' AND updated_at >= ?`
    )
    .bind(now.toISOString().slice(0, 10))
    .first<{ cnt: number }>();

  // Open tasks still remaining
  const openRows = await db
    .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE status = 'open'`)
    .first<{ cnt: number }>();

  // Tomorrow's classes preview
  const tomorrowClasses = await db
    .prepare(
      `SELECT s.name as subject_name, ts.start_time, ts.end_time, ts.room
       FROM timetable_slots ts
       JOIN timetable_subjects s ON ts.subject_id = s.id
       JOIN timetable_semesters sem ON ts.semester_id = sem.id
       WHERE sem.is_active = 1 AND ts.active = 1 AND ts.weekday = ?
       ORDER BY ts.start_time ASC`
    )
    .bind(nextDay)
    .all<{ subject_name: string; start_time: string; end_time: string; room?: string }>();

  let tmrClassSection = `• No classes scheduled for ${tomorrowName}`;
  if (tomorrowClasses.results && tomorrowClasses.results.length > 0) {
    tmrClassSection = tomorrowClasses.results
      .map((c) => `• *${c.subject_name}*: ${c.start_time} - ${c.end_time}${c.room ? ` (${c.room})` : ""}`)
      .join("\n");
  }

  // Pending proposals count
  const pendingProps = await db
    .prepare(`SELECT COUNT(*) as cnt FROM task_proposals WHERE status = 'pending'`)
    .first<{ cnt: number }>();

  return [
    `🌙 *Evening Briefing* — Review & Tomorrow's Outlook`,
    "",
    `📊 *Today's Progress:*`,
    `• Completed: ${doneRows?.cnt ?? 0} tasks`,
    `• Open tasks remaining: ${openRows?.cnt ?? 0}`,
    pendingProps && pendingProps.cnt > 0 ? `• Unreviewed proposals: ${pendingProps.cnt} pending` : "",
    "",
    `🗓️ *Tomorrow (${tomorrowName}):*`,
    tmrClassSection,
    "",
    `_Wind down and get ready for tomorrow._`,
  ]
    .filter(Boolean)
    .join("\n");
}
