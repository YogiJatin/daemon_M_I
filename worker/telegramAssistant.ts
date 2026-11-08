/**
 * worker/telegramAssistant.ts - telegram_assistant AI Capability
 *
 * Requirements:
 * - Multi-intent (actions[] max 3 items)
 * - Persona prompt with friendly dry humor & register matching
 * - Capture rubric: commitment vs bodily state / wish / joke
 * - Lookup intent spec (weather | web)
 * - General question intent
 * - Schedule query renderer with keyword fallback (never "couldn't understand")
 * - Formatted confirmation dates: "Fri 6 Nov, 3:00 PM"
 * - Separate due_at and remind_at
 * - D1 owns all facts; LLM reply_text discarded for schedule queries
 */

import { AICapabilityRegistry } from "./aiCapabilityRegistry";
import { getCapabilityManifest, renderHelpResponse } from "./capabilityManifest";
import { resolveExtendedAnchor, ExtendedAnchor } from "./dailyRhythm";

export type AssistantIntent =
  | "chat"
  | "explicit_task"
  | "explicit_reminder"
  | "implicit_commitment"
  | "query_schedule"
  | "query_tasks"
  | "modify_pending"
  | "remember"
  | "schedule_exception"
  | "general_question"
  | "lookup"
  | "unclear";

export type AnchorType =
  | "after_last_class"
  | "leaving_college"
  | "reaching_home"
  | "before_first_class"
  | "leaving_home"
  | "evening"
  | "morning"
  | "none";

export interface AssistantTask {
  title: string;
  date_phrase?: string;
  offset_days?: number;
  hour?: number | null;
  minute?: number | null;
  anchor?: AnchorType;
  priority?: "low" | "normal" | "high" | "urgent";
}

export interface AssistantQuery {
  type: "today" | "tomorrow" | "week" | "pending" | "overdue" | "summary" | "classes" | "search";
  date?: string;
  keyword?: string;
}

export interface AssistantMemory {
  text: string;
}

export interface AssistantLookup {
  kind: "weather" | "web";
  query: string;
  place?: string;
  when?: string;
}

export interface AssistantAction {
  intent: AssistantIntent;
  confidence?: number;
  tasks?: AssistantTask[];
  query?: AssistantQuery;
  lookup?: AssistantLookup;
  memory?: AssistantMemory;
  reply_text?: string;
}

export interface TelegramAssistantOutput {
  intent: AssistantIntent;
  confidence: number;
  reply_text: string;
  tasks?: AssistantTask[];
  query?: AssistantQuery;
  memory?: AssistantMemory;
  lookup?: AssistantLookup;
  actions?: AssistantAction[];
  reason?: string;
  evidence?: string;
}

export interface TelegramAssistantInput {
  userText: string;
  chatId: string;
  updateId: number;
  now: Date;
  replyToMessageId?: number;
  db: D1Database;
  env: any;
  settings?: Record<string, string>;
  recentChat?: string[];
  replyToProposal?: any;
}

// ---------------------------------------------------------------------------
// Confirmation Date Formatter: "Fri 6 Nov, 3:00 PM"
// ---------------------------------------------------------------------------
export function formatConfirmationDate(dateIst: string, timeIst?: string | null): string {
  try {
    const [y, m, d] = dateIst.split("-").map(Number);
    // Construct local midday to extract day of week and month
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dayStr = dayNames[dt.getUTCDay()];
    const monStr = monthNames[m - 1];

    let timeStr = "";
    if (timeIst) {
      const [hStr, minStr] = timeIst.split(":");
      let h = parseInt(hStr, 10);
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12;
      if (h === 0) h = 12;
      timeStr = `, ${h}:${minStr.padStart(2, "0")} ${ampm}`;
    }

    return `${dayStr} ${d} ${monStr}${timeStr}`;
  } catch {
    return dateIst + (timeIst ? ` ${timeIst}` : "");
  }
}

// ---------------------------------------------------------------------------
// System Prompt Builder with Persona & Rubric
// ---------------------------------------------------------------------------
export function buildAssistantSystemPrompt(ownerName: string, manifest: string): string {
  return `You are Antigravity OS, the personal AI assistant for ${ownerName}. You understand English, Hinglish, and Telugu-mixed messages.

PERSONA:
- Replies are 1-3 sentences unless asked for more.
- Friendly, dry humor. Match user's language mix (English / Hinglish / Telugu-mixed).
- Treat sarcasm, exaggeration, and jokes as jokes and play along lightly.
- Never answer with only "I can't". Say what is missing in one clause, then give nearest useful thing.
- Only claim abilities listed in the capability manifest below.
- Never state facts about user's tasks, schedule, or progress (code renders them).
- Never use the words "task", "schedule", "track", "progress", or "todo" in chat replies unless the user explicitly asked about them.
- Never invent live facts; use the lookup path.

CAPABILITIES:
${manifest}

INTENTS:
- chat: greetings, banter, insults, sarcasm, complaints.
- explicit_task: user explicitly commands adding a task ("add task...", "order groceries at 5pm").
- explicit_reminder: user explicitly commands a reminder ("remind me at 6pm about dentist appointment").
- implicit_commitment: first-person future obligation passing ALL rubric points below.
- query_schedule: asking about classes, timetable, or day's commitments.
- query_tasks: asking about pending tasks, progress.
- modify_pending: replying to an existing proposal to change title or time.
- remember: user wants to save a durable note, fact, or preference.
- schedule_exception: user reporting a change to today's schedule ("leaving early today", "class cancelled").
- general_question: question answerable from general knowledge.
- lookup: questions needing live data (weather or web prices/facts).
- unclear: ambiguous input.

ANCHOR MAPPINGS (use anchor property in tasks[]):
- "after college" / "after class" -> "after_last_class"
- "on the way home" / "leaving college" -> "leaving_college"
- "when I get home" / "reaching home" -> "reaching_home"
- "before college" / "leaving home" -> "leaving_home"
- "tonight" / "by tonight" -> "evening"
- "tomorrow morning" / "kal subah" -> "morning"
- other / specific clock time -> "none"

SPECIAL INSTRUCTIONS:
- If user says "remind me at <time>" without specifying what (e.g. "remind me at 4"), set intent: "explicit_reminder", tasks: [{ "title": "Reminder", "hour": 4, "offset_days": 0 }].
- For schedule questions, set intent: "query_schedule" with query.type: "today" or "tomorrow".
- For task progress/summary questions, set intent: "query_tasks" with query.type: "summary".
- "remember <fact>" -> intent: "remember", memory: { "text": "<fact>" }.
- Hindi/Telugu task commitments (e.g. "kal subah office jaana hai" / "repu project ivvali") -> intent: "implicit_commitment" with appropriate anchor or offset_days.
- When an input specifies a relative anchor like evening or morning, map to the corresponding anchor ("morning", "evening", "leaving_college", "reaching_home", "after_last_class").

CAPTURE RUBRIC for implicit_commitment:
Suggest ONLY if ALL 4 hold:
(a) First person singular ("I / me / my / nenu / mujhe")
(b) Concrete action (not vague)
(c) Commitment, NOT a bodily/physical state ("I'm tired", "I feel sick", "I need to sleep" alone stay silent as chat), NOT a wish ("wish", "someday"), NOT a routine ("usually")
(d) Not a question, hypothetical, past event, joke, or someone else's task.

CRITICAL INVARIANTS FOR BODILY STATE VS COMMITMENT:
- A body-state message expressing fatigue, drowsiness, headache, illness, or needing sleep/nap alone stays silent (intent: "chat", NO tasks).
- A commitment that happens to contain words like "rest" (e.g. "the rest of the report", "rest the rest of the documentation") or "sleep" (e.g. "sleep study dataset") IS a valid task commitment and STILL triggers implicit_commitment.
- Partial work phrases like "the rest of the report", "remaining slides", "the rest of the project" are actionable tasks.

FEW-SHOT EXAMPLES:
Input: "I feel completely exhausted and need some sleep"
Output: {"intent": "chat", "confidence": 0.95, "reply_text": "Get some good rest!", "tasks": []}

Input: "I am going to wrap up the rest of the report before Friday"
Output: {"intent": "implicit_commitment", "confidence": 0.95, "reply_text": "", "tasks": [{"title": "Wrap up the rest of the report", "date_phrase": "before Friday"}]}

Input: "I need to rest the rest of the report before Friday"
Output: {"intent": "implicit_commitment", "confidence": 0.95, "reply_text": "", "tasks": [{"title": "Rest the rest of the report", "date_phrase": "before Friday"}]}

Input: "I must organize the sleep study notes by 5pm"
Output: {"intent": "implicit_commitment", "confidence": 0.95, "reply_text": "", "tasks": [{"title": "Organize the sleep study notes", "hour": 17, "minute": 0, "offset_days": 0}]}

Input: "I have a headache, need to lie down"
Output: {"intent": "chat", "confidence": 0.95, "reply_text": "Take care and get some quiet time.", "tasks": []}

MULTI-INTENT:
If message has multiple distinct requests (e.g. 2 reminders + 1 class query), output "actions" array (max 3), each with its own intent and fields.

OUTPUT FORMAT (JSON only):
{
  "intent": "<primary_intent>",
  "confidence": <0..1>,
  "reply_text": "<conversational reply>",
  "tasks": [{ "title": "", "date_phrase": "", "offset_days": 0, "hour": null, "minute": null, "anchor": "none", "priority": "normal" }],
  "query": { "type": "today|tomorrow|week|summary|classes", "date": "" },
  "lookup": { "kind": "weather|web", "query": "", "place": "", "when": "now|today|tomorrow" },
  "memory": { "text": "" },
  "actions": []
}`;
}

// ---------------------------------------------------------------------------
// User Prompt Builder with Recent Chat Context
// ---------------------------------------------------------------------------
export function buildAssistantUserPrompt(
  userText: string,
  now: Date,
  settings: Record<string, string>,
  recentTasks: any[],
  replyToProposal?: any,
  recentChat: string[] = []
): string {
  const ist = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);

  const lines: string[] = [];

  lines.push(`<DATA type="context">`);
  lines.push(`Current time (IST): ${ist}`);
  lines.push(`Day of week: ${now.toLocaleDateString("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" })}`);
  if (settings?.owner_name) lines.push(`Owner: ${settings.owner_name}`);
  if (settings?.home_city) lines.push(`Home city: ${settings.home_city}`);
  lines.push(`Morning anchor: ${settings?.morning_anchor_time || "08:00"}`);
  lines.push(`Evening anchor: ${settings?.evening_anchor_time || "20:00"}`);
  lines.push(`Buffer after class: ${settings?.buffer_after_class_min || "15"} min`);
  lines.push(`Commute home: ${settings?.commute_home_min || "40"} min`);
  lines.push(`</DATA>`);

  if (recentChat.length > 0) {
    lines.push(`<DATA type="recent_chat">`);
    for (const turn of recentChat.slice(-8)) {
      lines.push(turn);
    }
    lines.push(`</DATA>`);
  }

  if (recentTasks.length > 0) {
    lines.push(`<DATA type="recent_tasks">`);
    for (const t of recentTasks.slice(0, 5)) {
      lines.push(`- [${t.id}] ${t.title}${t.deadline_local_time ? " @ " + t.deadline_local_time : ""} (${t.status})`);
    }
    lines.push(`</DATA>`);
  }

  if (replyToProposal) {
    lines.push(`<DATA type="referenced_proposal">`);
    lines.push(`id: ${replyToProposal.id}`);
    lines.push(`title: ${replyToProposal.title}`);
    lines.push(`date: ${replyToProposal.proposed_local_date || "today"}`);
    lines.push(`time: ${replyToProposal.proposed_local_time || "none"}`);
    lines.push(`</DATA>`);
  }

  lines.push(`<DATA type="user_message">`);
  lines.push(userText);
  lines.push(`</DATA>`);

  lines.push(`\nClassify and respond in valid JSON.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------
export function validateAssistantOutput(data: any): { valid: boolean; errors: string[] } {
  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Output must be an object"] };
  }

  const validIntents: AssistantIntent[] = [
    "chat", "explicit_task", "explicit_reminder", "implicit_commitment",
    "query_schedule", "query_tasks", "modify_pending", "remember",
    "schedule_exception", "general_question", "lookup", "unclear",
  ];

  if (!validIntents.includes(data.intent)) {
    return { valid: false, errors: [`Invalid intent: ${data.intent}`] };
  }

  if (typeof data.confidence !== "number" || data.confidence < 0 || data.confidence > 1) {
    return { valid: false, errors: ["confidence must be 0..1"] };
  }

  return { valid: true, errors: [] };
}

// ---------------------------------------------------------------------------
// Clock & Anchor Time Resolution in Code
// ---------------------------------------------------------------------------
export async function resolveTaskTime(
  db: D1Database,
  task: AssistantTask,
  now: Date,
  env: any,
  settings: Record<string, string> = {}
): Promise<{
  ok: boolean;
  needsInfo?: boolean;
  question?: string;
  buttons?: any;
  localDate: string;
  localTime: string | null;
  utcInstant?: Date;
  proposalId: string;
  anchor: string;
  dueAtFormatted: string;
  remindAtFormatted?: string;
}> {
  const propId = "prop_" + Math.random().toString(36).slice(2, 10).toUpperCase();

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);

  let offsetDays = task.offset_days ?? 0;

  // Named day-of-week resolution from date_phrase (G16: "by Monday", "by Tuesday", etc.)
  const datePhraseLower = (task.date_phrase || "").toLowerCase();
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayMatch = dayNames.findIndex((d) => datePhraseLower.includes(d));
  if (dayMatch !== -1 && offsetDays === 0) {
    const todayJsDay = istNow.getUTCDay(); // 0=Sun
    let diff = dayMatch - todayJsDay;
    if (diff <= 0) diff += 7; // always next occurrence
    offsetDays = diff;
  }

  const baseDate = new Date(istNow);
  baseDate.setUTCHours(0, 0, 0, 0);
  baseDate.setTime(baseDate.getTime() + offsetDays * 86400000);
  const dateIst = baseDate.toISOString().slice(0, 10);

  let anchor = task.anchor || "none";
  if (anchor === "none") {
    const textToCheck = ((task.title || "") + " " + (task.date_phrase || "")).toLowerCase();
    if (/on the way home|leaving college/i.test(textToCheck)) {
      anchor = "leaving_college";
    } else if (/after college|after class/i.test(textToCheck)) {
      anchor = "after_last_class";
    } else if (/when i get home|reaching home/i.test(textToCheck)) {
      anchor = "reaching_home";
    } else if (/tonight|by tonight/i.test(textToCheck)) {
      anchor = "evening";
    } else if (/tomorrow morning|kal subah/i.test(textToCheck)) {
      anchor = "morning";
    }
  }

  // Case 1: Extended routine anchor
  if (anchor !== "none") {
    const resolved = await resolveExtendedAnchor(db, anchor as ExtendedAnchor, dateIst, now);
    if (!resolved.ok && resolved.needsInfo) {
      return {
        ok: false,
        needsInfo: true,
        question: resolved.question,
        buttons: resolved.buttons,
        localDate: dateIst,
        localTime: null,
        proposalId: propId,
        anchor,
        dueAtFormatted: formatConfirmationDate(dateIst),
      };
    }
    const clock = resolved.clockTime;
    const formatted = formatConfirmationDate(dateIst, clock);
    let remindFormatted = formatted;
    if (anchor === "evening" || /tonight/i.test(task.date_phrase || "") || /tonight/i.test(task.title || "")) {
      // Due at 8:00 PM, remind at 7:00 PM (shown separately G09)
      remindFormatted = formatConfirmationDate(dateIst, "19:00");
    }
    return {
      ok: true,
      localDate: dateIst,
      localTime: clock,
      utcInstant: resolved.utcInstant,
      proposalId: propId,
      anchor,
      dueAtFormatted: formatted,
      remindAtFormatted: remindFormatted,
    };
  }

  // Case 2: Clock time given (e.g. hour/minute)
  if (task.hour !== undefined && task.hour !== null) {
    let h = task.hour;
    const m = task.minute ?? 0;

    // Disambiguation for 12h clock: "at 3", "at 7"
    if (h <= 12) {
      // Current hour in IST
      const curH = istNow.getUTCHours();
      const curM = istNow.getUTCMinutes();
      const curMinutes = curH * 60 + curM;

      const amMinutes = (h === 12 ? 0 : h) * 60 + m;
      const pmMinutes = (h === 12 ? 12 : h + 12) * 60 + m;

      // Nearest future occurrence today
      let chosenH = h;
      if (offsetDays === 0) {
        if (pmMinutes > curMinutes && (amMinutes <= curMinutes || amMinutes < 7 * 60)) {
          chosenH = h === 12 ? 12 : h + 12;
        } else if (amMinutes > curMinutes && amMinutes >= 7 * 60) {
          chosenH = h === 12 ? 0 : h;
        } else if (pmMinutes > curMinutes) {
          chosenH = h === 12 ? 12 : h + 12;
        }
      }

      // Check quiet hours (23:00 - 07:00 IST)
      if (chosenH >= 23 || chosenH < 7) {
        // Ask AM or PM
        return {
          ok: false,
          needsInfo: true,
          question: `Did you mean ${h} AM or ${h} PM?`,
          buttons: {
            inline_keyboard: [[
              { text: `${h} AM`, callback_data: `resched_time:${propId}:${dateIst}:${String(h === 12 ? 0 : h).padStart(2, "0")}:${String(m).padStart(2, "0")}` },
              { text: `${h} PM`, callback_data: `resched_time:${propId}:${dateIst}:${String(h === 12 ? 12 : h + 12).padStart(2, "0")}:${String(m).padStart(2, "0")}` },
            ]],
          },
          localDate: dateIst,
          localTime: null,
          proposalId: propId,
          anchor: "none",
          dueAtFormatted: formatConfirmationDate(dateIst),
        };
      }

      h = chosenH;
    }

    const clockStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const dt = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate(), h, m, 0) - IST_OFFSET_MS);
    const formatted = formatConfirmationDate(dateIst, clockStr);

    return {
      ok: true,
      localDate: dateIst,
      localTime: clockStr,
      utcInstant: dt,
      proposalId: propId,
      anchor: "none",
      dueAtFormatted: formatted,
      remindAtFormatted: formatted,
    };
  }

  // Case 3: No time given -> proposal with date, ask time
  const morningAnchor = settings?.morning_anchor_time || "08:00";
  const eveningAnchor = settings?.evening_anchor_time || "20:00";
  return {
    ok: true,
    needsInfo: true,
    localDate: dateIst,
    localTime: null,
    proposalId: propId,
    anchor: "none",
    dueAtFormatted: formatConfirmationDate(dateIst),
    question: `Picked up: ${task.title}. Nudge you when?`,
    buttons: {
      inline_keyboard: [[
        { text: `Tonight (${eveningAnchor})`, callback_data: `resched_time:${propId}:${dateIst}:${eveningAnchor}` },
        { text: `Tomorrow (${morningAnchor})`, callback_data: `resched_time:${propId}:${new Date(baseDate.getTime() + 86400000).toISOString().slice(0, 10)}:${morningAnchor}` },
        { text: "Pick time", callback_data: `change_time:${propId}` },
      ]],
    },
  };
}

// ---------------------------------------------------------------------------
// Schedule Query Renderer from D1 (B1, G17, G18, G48)
// ---------------------------------------------------------------------------
export async function renderD1ScheduleQuery(
  db: D1Database,
  query: AssistantQuery | undefined,
  userText: string,
  now: Date
): Promise<string> {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const todayIST = istNow.toISOString().slice(0, 10);
  const tomorrowIST = new Date(istNow.getTime() + 86400000).toISOString().slice(0, 10);

  // Keyword-based type inference fallback (B1)
  const lower = userText.toLowerCase();
  let queryType = query?.type || "today";
  if (lower.includes("how am i doing") || lower.includes("progress")) {
    queryType = "summary";
  } else if (lower.includes("tomorrow")) {
    queryType = lower.includes("class") ? "classes" : "tomorrow";
  } else if (lower.includes("today")) {
    queryType = "today";
  }

  const targetDate = (queryType === "tomorrow" || queryType === "classes") ? tomorrowIST : todayIST;
  const targetWeekday = (() => {
    const [y, m, d] = targetDate.split("-").map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return day === 0 ? 7 : day;
  })();

  try {
    // 1. Task progress summary (G48)
    if (queryType === "summary") {
      const pendingRows = await db
        .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status NOT IN ('done', 'cancelled')")
        .first<{ cnt: number }>();
      const overdueRows = await db
        .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status NOT IN ('done', 'cancelled') AND deadline_local_date < ?")
        .bind(todayIST)
        .first<{ cnt: number }>();
      const doneRows = await db
        .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'done' AND completed_at >= ?")
        .bind(todayIST + "T00:00:00.000Z")
        .first<{ cnt: number }>();
      const nextTask = await db
        .prepare("SELECT title, deadline_local_date, deadline_time_local FROM tasks WHERE status NOT IN ('done', 'cancelled') ORDER BY deadline_local_date ASC NULLS LAST, deadline_time_local ASC NULLS LAST LIMIT 1")
        .first<{ title: string; deadline_local_date: string | null; deadline_time_local: string | null }>();

      const openCount = pendingRows?.cnt ?? 0;
      const overdueCount = overdueRows?.cnt ?? 0;
      const doneCount = doneRows?.cnt ?? 0;

      let nextDueStr = "None scheduled";
      if (nextTask) {
        const nextDueFormatted = formatConfirmationDate(nextTask.deadline_local_date || todayIST, nextTask.deadline_time_local);
        nextDueStr = `${nextTask.title} (${nextDueFormatted})`;
      }

      return `Task Progress:\n• Open tasks: ${openCount}\n• Overdue: ${overdueCount}\n• Completed today: ${doneCount}\n• Next due: ${nextDueStr}`;
    }

    // 2. Classes for tomorrow (G18)
    if (queryType === "classes" || (queryType === "tomorrow" && lower.includes("class"))) {
      const slots = await db
        .prepare("SELECT start_time, end_time, room FROM timetable_slots WHERE weekday = ? AND active = 1 ORDER BY start_time ASC")
        .bind(targetWeekday)
        .all<{ start_time: string; end_time: string; room: string | null }>();

      if (!slots.results.length) {
        return `You have no classes scheduled for tomorrow (${targetDate}).`;
      }
      const lines = slots.results.map((s) => `• ${s.start_time} - ${s.end_time}${s.room ? " (" + s.room + ")" : ""}`);
      return `Classes tomorrow (${targetDate}):\n${lines.join("\n")}`;
    }

    // 3. Daily schedule and tasks render (G17)
    const [slots, tasks, overdue] = await Promise.all([
      db.prepare("SELECT start_time, end_time, room FROM timetable_slots WHERE weekday = ? AND active = 1 ORDER BY start_time ASC")
        .bind(targetWeekday)
        .all<{ start_time: string; end_time: string; room: string | null }>(),
      db.prepare("SELECT title, deadline_time_local, priority FROM tasks WHERE deadline_local_date = ? AND status NOT IN ('done', 'cancelled') ORDER BY deadline_time_local ASC NULLS LAST")
        .bind(targetDate)
        .all<{ title: string; deadline_time_local: string | null; priority: string }>(),
      db.prepare("SELECT title, deadline_local_date FROM tasks WHERE deadline_local_date < ? AND status NOT IN ('done', 'cancelled') ORDER BY deadline_local_date ASC LIMIT 5")
        .bind(todayIST)
        .all<{ title: string; deadline_local_date: string | null }>(),
    ]);

    const sections: string[] = [];
    const dateLabel = targetDate === todayIST ? "Today" : "Tomorrow";

    if (slots.results.length > 0) {
      const cLines = slots.results.map((s) => `  • ${s.start_time} - ${s.end_time}${s.room ? " (" + s.room + ")" : ""}`);
      sections.push(`Classes ${dateLabel} (${targetDate}):\n${cLines.join("\n")}`);
    } else {
      sections.push(`Classes ${dateLabel}: None`);
    }

    if (tasks.results.length > 0) {
      const tLines = tasks.results.map((t) => `  • ${t.title}${t.deadline_time_local ? " at " + t.deadline_time_local : ""}`);
      sections.push(`Tasks Due:\n${tLines.join("\n")}`);
    } else {
      sections.push(`Tasks Due: None`);
    }

    if (overdue.results.length > 0) {
      const oLines = overdue.results.map((o) => `  • ${o.title} (${o.deadline_local_date})`);
      sections.push(`⚠️ Overdue Tasks:\n${oLines.join("\n")}`);
    }

    return sections.join("\n\n");
  } catch (e) {
    return "Couldn't load schedule right now. Try /today.";
  }
}

export { resolveTaskTime as resolveAnchorTime };

// ---------------------------------------------------------------------------
// Create Proposal from Task (B2, B3)
// ---------------------------------------------------------------------------
export async function createProposalFromTask(
  db: D1Database,
  task: AssistantTask,
  resolved: { localDate: string; localTime: string | null; anchor?: string; proposalId?: string },
  intent: AssistantIntent,
  now: Date
): Promise<string> {
  const propId = resolved.proposalId || "prop_" + Math.random().toString(36).slice(2, 10).toUpperCase();
  const nowStr = now.toISOString();
  const dateRole = intent === "implicit_commitment" ? "implicit_suggestion" : "manual";

  await db
    .prepare(
      `INSERT INTO task_proposals
         (id, title, proposed_local_date, proposed_local_time, anchor_key, date_role,
          status, advisory_confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0.85, ?, ?)`
    )
    .bind(
      propId,
      task.title.trim().slice(0, 500),
      resolved.localDate || null,
      resolved.localTime || null,
      resolved.anchor || null,
      dateRole,
      nowStr,
      nowStr
    )
    .run()
    .catch(() => {});

  return propId;
}

// ---------------------------------------------------------------------------
// Handle Modify Pending Proposals (G20)
// ---------------------------------------------------------------------------
export async function handleModifyPending(
  db: D1Database,
  output: TelegramAssistantOutput,
  replyToMessageId: number | undefined,
  now: Date,
  userText?: string
): Promise<{ message: string; proposalId?: string }> {
  let row: { id: string; title: string; status: string } | null = null;
  if (replyToMessageId) {
    row = await db
      .prepare(
        `SELECT p.id, p.title, p.status FROM task_proposals p
         JOIN chat_messages cm ON cm.text LIKE '%' || p.id || '%' OR cm.reply_markup LIKE '%' || p.id || '%'
         WHERE (cm.telegram_message_id = ? OR cm.message_id = ?) AND p.status = 'pending'
         LIMIT 1`
      )
      .bind(replyToMessageId, replyToMessageId)
      .first<{ id: string; title: string; status: string }>()
      .catch(() => null);
  }

  if (!row) {
    row = await db
      .prepare("SELECT id, title, status FROM task_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .first<{ id: string; title: string; status: string }>()
      .catch(() => null);
  }

  if (!row) {
    return { message: "No pending proposal found. Create a new task with /add or by typing it." };
  }

  const nowStr = now.toISOString();
  const textStr = (userText || "").trim();

  // Fast-path regex for "make it 8pm" / "change to 8pm" / "make it 8"
  const directTimeMatch = textStr.match(/(?:make\s+it|change\s+(?:time\s+)?to|at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  if (directTimeMatch) {
    const rawTime = directTimeMatch[1].trim().toLowerCase();
    const tParts = rawTime.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (tParts) {
      let h = parseInt(tParts[1], 10);
      const m = tParts[2] ? parseInt(tParts[2], 10) : 0;
      const meridiem = tParts[3]?.toLowerCase();

      if (meridiem === "pm" && h < 12) h += 12;
      else if (meridiem === "am" && h === 12) h = 0;
      else if (!meridiem && h < 12) {
        // Shorthand "8" or "8pm": for evening tasks default to PM if h <= 11
        if (h <= 11) h += 12;
      }

      const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const todayIst = new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

      await db
        .prepare(
          "UPDATE task_proposals SET proposed_local_date = ?, proposed_local_time = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
        )
        .bind(todayIst, timeStr, nowStr, row.id)
        .run()
        .catch(() => {});

      const dateFormatted = formatConfirmationDate(todayIst, timeStr);
      return {
        message: `Updated time to ${dateFormatted}. Confirm?`,
        proposalId: row.id,
      };
    }
  }

  const newTask = output.tasks?.[0];

  // If new time is given (e.g. "make it 8pm" -> hour 20, minute 0)
  if (newTask && newTask.hour !== undefined && newTask.hour !== null) {
    let h = newTask.hour;
    const m = newTask.minute ?? 0;
    // h < 7 means AM hours 1-6, everything else in range 7-12 is ambiguous.
    // If the LLM returns h=8 for "8pm" it already does so only when it has pm context.
    // Guard: if h is 1-6 and no context forces AM, treat as PM for evening-only intents.
    // If h is 7-11 and IST current hour > h (past AM slot), treat as PM.
    if (h < 7) h += 12; // 1am-6am range: very unlikely PM shortcuts -> treat as evening
    // If userText contains explicit "pm" and h is 1-12, treat as PM
    if (userText && /\d\s*pm/i.test(userText) && h <= 12) h = h < 12 ? h + 12 : 12;
    const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const todayIst = new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

    await db
      .prepare(
        "UPDATE task_proposals SET proposed_local_date = ?, proposed_local_time = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
      )
      .bind(todayIst, timeStr, nowStr, row.id)
      .run()
      .catch(() => {});

    const dateFormatted = formatConfirmationDate(todayIst, timeStr);
    return {
      message: `Updated time to ${dateFormatted}. Confirm?`,
      proposalId: row.id,
    };
  }

  if (newTask && newTask.title && newTask.title !== row.title) {
    await db
      .prepare("UPDATE task_proposals SET title = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(newTask.title.trim().slice(0, 500), nowStr, row.id)
      .run()
      .catch(() => {});
    return {
      message: `Updated title to "${newTask.title}". Confirm?`,
      proposalId: row.id,
    };
  }

  return {
    message: `What would you like to change about "${row.title}"?`,
    proposalId: row.id,
  };
}

// ---------------------------------------------------------------------------
// Register Capability in AICapabilityRegistry
// ---------------------------------------------------------------------------
export function registerTelegramAssistantCapability(): void {
  if (AICapabilityRegistry.get("telegram_assistant")) return;

  AICapabilityRegistry.register<TelegramAssistantInput, TelegramAssistantOutput>({
    id: "telegram_assistant",
    promptId: "telegram_assistant_v2",
    promptVersion: "2.0.0",
    checksum: "block2-intelligence-assistant",
    dependencies: ["tasks", "timetable"],
    supportedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
    maxContextTokens: 2500,
    maxOutputTokens: 600,
    timeoutMs: 15000,

    systemRules: buildAssistantSystemPrompt("the owner", getCapabilityManifest()),
    outputContract: JSON.stringify({
      intent: "string",
      confidence: "number 0..1",
      reply_text: "string",
      tasks: "array optional",
      query: "object optional",
      lookup: "object optional",
      memory: "object optional",
      actions: "array optional",
    }),

    contextBuilder: async (_db, input, builder, now) => {
      const prompt = buildAssistantUserPrompt(
        input.userText,
        now,
        input.settings || {},
        [],
        input.replyToProposal,
        input.recentChat || []
      );
      builder.setOwnerRequest(prompt);
    },

    validator: validateAssistantOutput,

    handler: async (_db, parsed) => parsed,
  });
}

// Auto-register upon module load
registerTelegramAssistantCapability();


export async function renderTasksAndRemindersList(db: D1Database, now: Date): Promise<string> {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const todayIST = istNow.toISOString().slice(0, 10);

  // 1. Overdue tasks (top 5, +N more)
  const overdueTotal = await db
    .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'open' AND deadline_local_date < ?")
    .bind(todayIST)
    .first<{ cnt: number }>()
    .catch(() => ({ cnt: 0 }));
  const overdueRows = await db
    .prepare("SELECT title, deadline_local_date, deadline_time_local FROM tasks WHERE status = 'open' AND deadline_local_date < ? ORDER BY deadline_local_date ASC LIMIT 5")
    .bind(todayIST)
    .all<{ title: string; deadline_local_date: string; deadline_time_local: string | null }>()
    .catch(() => ({ results: [] }));

  // 2. Due today
  const todayRows = await db
    .prepare("SELECT title, deadline_time_local FROM tasks WHERE status = 'open' AND deadline_local_date = ? ORDER BY deadline_time_local ASC NULLS LAST")
    .bind(todayIST)
    .all<{ title: string; deadline_time_local: string | null }>()
    .catch(() => ({ results: [] }));

  // 3. Reminders for the next 7 days (top 10)
  const nextReminders = await db
    .prepare(`
      SELECT t.title, nl.scheduled_at, t.deadline_local_date, t.deadline_time_local
      FROM notification_log nl
      JOIN tasks t ON nl.task_id = t.id
      WHERE nl.status = 'pending' AND nl.scheduled_at >= ?
      ORDER BY nl.scheduled_at ASC LIMIT 10
    `)
    .bind(now.toISOString())
    .all<{ title: string; scheduled_at: string; deadline_local_date: string | null; deadline_time_local: string | null }>()
    .catch(() => ({ results: [] }));

  const sections: string[] = ["📋 *Tasks & Reminders*"];

  // Overdue section
  const ovCount = overdueTotal?.cnt ?? 0;
  if (ovCount > 0) {
    const lines = (overdueRows.results || []).map((r: any) => `• ${r.title} (${formatConfirmationDate(r.deadline_local_date, r.deadline_time_local)})`);
    if (ovCount > 5) {
      lines.push(`  +${ovCount - 5} more overdue [Show more]`);
    }
    sections.push(`⚠️ *Overdue (${ovCount}):*\n${lines.join("\n")}`);
  } else {
    sections.push(`⚠️ *Overdue:* None`);
  }

  // Today section
  if ((todayRows.results || []).length > 0) {
    const lines = todayRows.results.map((r: any) => `• ${r.title} (${formatConfirmationDate(todayIST, r.deadline_time_local)})`);
    sections.push(`📅 *Due Today:*\n${lines.join("\n")}`);
  } else {
    sections.push(`📅 *Due Today:* None`);
  }

  // Reminders (next 7 days, top 10)
  if ((nextReminders.results || []).length > 0) {
    const lines = nextReminders.results.map((r: any) => {
      const dt = new Date(new Date(r.scheduled_at).getTime() + IST_OFFSET_MS);
      const dStr = dt.toISOString().slice(0, 10);
      const tStr = dt.toISOString().slice(11, 16);
      return `• ${r.title} (${formatConfirmationDate(dStr, tStr)})`;
    });
    sections.push(`⏰ *Upcoming Reminders (Next 7 Days):*\n${lines.join("\n")}`);
  } else {
    sections.push(`⏰ *Upcoming Reminders:* None`);
  }

  return sections.join("\n\n");
}
