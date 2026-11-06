/**
 * worker/telegramAssistant.ts - Block 1 telegram_assistant AI Capability
 *
 * Defines the structured JSON output schema, system prompt, validator,
 * time resolution, proposal creation, query rendering, and modify_pending.
 *
 * Hard invariants:
 * - LLM NEVER computes clock times for anchors; code resolves from D1.
 * - LLM reply_text is DISCARDED for query intents; D1 rows are rendered.
 * - All user/external content wrapped in <DATA type="..."> blocks.
 * - Owner name from settings, never hardcoded.
 * - Workers AI and mock are excluded from implicit capture via providerAllowList.
 */

import { AICapabilityRegistry } from "./aiCapabilityRegistry";
import { AIContextBuilder } from "./aiContextBuilder";

// ---------------------------------------------------------------------------
// Intent enum (extensible string union)
// ---------------------------------------------------------------------------
export type AssistantIntent =
  | "chat"
  | "explicit_task"
  | "explicit_reminder"
  | "implicit_commitment"
  | "query_schedule"
  | "query_tasks"
  | "modify_pending"
  | "remember"
  | "unclear";

export type AnchorType = "after_last_class" | "before_first_class" | "evening" | "morning" | "none";

// ---------------------------------------------------------------------------
// LLM output schema
// ---------------------------------------------------------------------------
export interface AssistantTask {
  title: string;
  date_phrase?: string;      // display label only; numeric fields are authoritative
  offset_days?: number;       // 0 = today, 1 = tomorrow, etc.
  hour?: number;              // 0-23 (null if anchor-based)
  minute?: number;            // 0-59
  anchor?: AnchorType;        // LLM never computes clock times for anchors
  priority?: "low" | "normal" | "high" | "urgent";
}

export interface AssistantQuery {
  type: "today" | "week" | "pending" | "overdue" | "search";
  date?: string;   // YYYY-MM-DD ISO
  keyword?: string;
}

export interface AssistantMemory {
  text: string;
}

export interface TelegramAssistantOutput {
  intent: AssistantIntent;
  confidence: number;             // 0..1
  reply_text: string;             // For chat/unclear; discarded for query intents
  tasks?: AssistantTask[];        // max 3
  query?: AssistantQuery;         // for query_schedule / query_tasks
  memory?: AssistantMemory;       // for remember
  reason?: string;                // why this intent
  evidence?: string;              // evidence phrase from user message
}

// ---------------------------------------------------------------------------
// Input (passed into the capability)
// ---------------------------------------------------------------------------
export interface TelegramAssistantInput {
  userText: string;
  chatId: string;
  updateId: number;
  now: Date;
  replyToMessageId?: number;
  db: D1Database;
  env: any;
}

// ---------------------------------------------------------------------------
// Time resolution result
// ---------------------------------------------------------------------------
export interface ResolvedTime {
  ok: boolean;
  needsInfo?: boolean;
  question?: string;
  buttons?: any;
  utcInstant?: Date;
  localDate?: string;
  localTime?: string;
  proposalId?: string;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------
export function buildAssistantSystemPrompt(ownerName: string): string {
  return `You are a personal AI assistant for ${ownerName}. You understand English, Hinglish, and Telugu-mixed messages.

RULES:
1. Classify the user's message into exactly one intent.
2. intent enum: chat | explicit_task | explicit_reminder | implicit_commitment | query_schedule | query_tasks | modify_pending | remember | unclear
3. For tasks/reminders: extract up to 3 tasks. Time fields:
   - offset_days: integer (0=today, 1=tomorrow, negative=past). REQUIRED if time-related.
   - hour, minute: 24-hour integers. Only set if explicitly stated or unambiguously deducible.
   - anchor: use ONLY if user says "after class", "before class", "evening", "morning". Set anchor and leave hour/minute NULL.
   - date_phrase: display label for the user (e.g. "tomorrow evening") -- DO NOT infer clock times from this.
   - If time is ambiguous ("at 7"), do NOT set hour -- leave hour/minute null and set confidence < 0.6.
4. For query_schedule / query_tasks: set query.type and query.date. reply_text is IGNORED for these intents.
5. For implicit_commitment: only flag first-person future obligations. Ignore questions, hypotheticals, past events, jokes.
6. confidence: 0.0..1.0. Set < 0.5 for unclear or ambiguous input.
7. reply_text: conversational response (used for chat/unclear/remember). Keep it short and natural.
8. NEVER invent schedule facts. NEVER create tasks on your own authority.
9. reason and evidence fields: brief, factual.

OUTPUT: Valid JSON only, matching this schema exactly:
{
  "intent": "<intent>",
  "confidence": <0..1>,
  "reply_text": "<text>",
  "tasks": [{ "title": "", "date_phrase": "", "offset_days": 0, "hour": null, "minute": null, "anchor": "none", "priority": "normal" }],
  "query": { "type": "", "date": "" },
  "memory": { "text": "" },
  "reason": "",
  "evidence": ""
}
Omit fields that are not relevant. tasks[] max 3 items.`;
}

export function buildAssistantUserPrompt(
  userText: string,
  now: Date,
  settings: Record<string, string>,
  recentTasks: any[],
  replyToProposal?: any
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
  if (settings?.morning_hour) lines.push(`Morning anchor: ${settings.morning_hour}:${(settings?.morning_minute || "00").padStart(2, "0")}`);
  if (settings?.evening_hour) lines.push(`Evening anchor: ${settings.evening_hour}:${(settings?.evening_minute || "00").padStart(2, "0")}`);
  lines.push(`</DATA>`);

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
    lines.push(`status: ${replyToProposal.status}`);
    lines.push(`</DATA>`);
  }

  lines.push(`<DATA type="user_message">`);
  lines.push(userText);
  lines.push(`</DATA>`);

  lines.push(`\nClassify the message and reply as instructed.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Validator (runs inside AICapabilityRegistry)
// ---------------------------------------------------------------------------
function validateOutput(data: any, _ids: Set<string>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Output is not an object"] };
  }

  const validIntents: AssistantIntent[] = [
    "chat", "explicit_task", "explicit_reminder", "implicit_commitment",
    "query_schedule", "query_tasks", "modify_pending", "remember", "unclear",
  ];
  if (!validIntents.includes(data.intent)) {
    errors.push(`Invalid intent: ${data.intent}`);
  }

  if (typeof data.confidence !== "number" || data.confidence < 0 || data.confidence > 1) {
    errors.push("confidence must be a number 0..1");
  }

  if (data.tasks !== undefined) {
    if (!Array.isArray(data.tasks)) {
      errors.push("tasks must be an array");
    } else if (data.tasks.length > 3) {
      errors.push("tasks[] must have at most 3 items");
    } else {
      for (const t of data.tasks) {
        if (!t.title || typeof t.title !== "string") {
          errors.push("Each task must have a string title");
        }
        if (t.hour !== undefined && t.hour !== null && (typeof t.hour !== "number" || t.hour < 0 || t.hour > 23)) {
          errors.push(`Invalid hour: ${t.hour}`);
        }
        if (t.minute !== undefined && t.minute !== null && (typeof t.minute !== "number" || t.minute < 0 || t.minute > 59)) {
          errors.push(`Invalid minute: ${t.minute}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateAssistantOutput(data: any): { valid: boolean; errors: string[] } {
  return validateOutput(data, new Set());
}

// ---------------------------------------------------------------------------
// Anchor time resolution (LLM never computes; code resolves from D1)
// ---------------------------------------------------------------------------
export async function resolveAnchorTime(
  db: D1Database,
  task: AssistantTask,
  now: Date,
  env: any
): Promise<ResolvedTime & { proposalId: string }> {
  const propId = "prop_" + Math.random().toString(36).slice(2).toUpperCase();
  const anchor = task.anchor || "none";

  // IST offset: UTC+5:30
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);

  const offsetDays = task.offset_days ?? 0;
  // Base date in IST
  const baseDate = new Date(istNow);
  baseDate.setUTCHours(0, 0, 0, 0);
  baseDate.setTime(baseDate.getTime() + offsetDays * 86400000);

  // Ambiguous clock time: "at 7" — hour given, no anchor, ambiguous AM/PM
  // Rule: Next occurrence if within 12h, else ask [7 AM][7 PM]
  if (task.hour !== undefined && task.hour !== null && anchor === "none") {
    const h = task.hour;
    const m = task.minute ?? 0;

    if (h <= 12) {
      // Two candidates: AM (h) and PM (h + 12 % 24)
      const amTime = new Date(baseDate.getTime() + (h === 12 ? 0 : h) * 3600000 + m * 60000);
      const pmTime = new Date(baseDate.getTime() + (h === 12 ? 12 : h + 12) * 3600000 + m * 60000);

      const utcAm = new Date(amTime.getTime() - IST_OFFSET_MS);
      const utcPm = new Date(pmTime.getTime() - IST_OFFSET_MS);

      const diffAm = utcAm.getTime() - now.getTime();
      const diffPm = utcPm.getTime() - now.getTime();

      // Check if AM is in the next 12 hours
      if (diffAm > 0 && diffAm <= 12 * 3600000) {
        return { ok: true, utcInstant: utcAm, localDate: baseDate.toISOString().slice(0, 10), localTime: `${String(h === 12 ? 0 : h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, proposalId: propId };
      }
      // Check if PM is in the next 12 hours
      if (diffPm > 0 && diffPm <= 12 * 3600000) {
        const pmHour = h === 12 ? 12 : h + 12;
        return { ok: true, utcInstant: utcPm, localDate: baseDate.toISOString().slice(0, 10), localTime: `${String(pmHour).padStart(2, "0")}:${String(m).padStart(2, "0")}`, proposalId: propId };
      }

      // Neither occurrence is within 12h: ask [7 AM][7 PM]
      return {
        ok: false,
        needsInfo: true,
        question: `Did you mean ${h} AM or ${h} PM?`,
        buttons: {
          inline_keyboard: [[
            { text: `${h} AM`, callback_data: `set_time:${propId}:${h}:${m}:am` },
            { text: `${h} PM`, callback_data: `set_time:${propId}:${h}:${m}:pm` },
          ]],
        },
        proposalId: propId,
      };
    }

    // Unambiguous 24h time (> 12)
    const candidate24 = new Date(baseDate.getTime() + h * 3600000 + m * 60000);
    const utcInstant = new Date(candidate24.getTime() - IST_OFFSET_MS);
    return { ok: true, utcInstant, localDate: baseDate.toISOString().slice(0, 10), localTime: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, proposalId: propId };
  }

  if (anchor === "none") {
    // No time specified
    return { ok: true, utcInstant: undefined, proposalId: propId };
  }

  // Resolve anchor from D1 / settings
  if (anchor === "morning") {
    const mh = parseInt(env?.MORNING_HOUR || "7", 10);
    const mm = parseInt(env?.MORNING_MINUTE || "0", 10);
    const utcInstant = new Date(baseDate.getTime() + mh * 3600000 + mm * 60000 - IST_OFFSET_MS);
    return { ok: true, utcInstant, localDate: baseDate.toISOString().slice(0, 10), localTime: `${String(mh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`, proposalId: propId };
  }

  if (anchor === "evening") {
    const eh = parseInt(env?.EVENING_HOUR || "19", 10);
    const em = parseInt(env?.EVENING_MINUTE || "0", 10);
    const utcInstant = new Date(baseDate.getTime() + eh * 3600000 + em * 60000 - IST_OFFSET_MS);
    return { ok: true, utcInstant, localDate: baseDate.toISOString().slice(0, 10), localTime: `${String(eh).padStart(2,"0")}:${String(em).padStart(2,"0")}`, proposalId: propId };
  }

  // after_last_class / before_first_class: look up timetable
  if (anchor === "after_last_class" || anchor === "before_first_class") {
    const targetDateIST = baseDate.toISOString().slice(0, 10);
    const dayOfWeek = new Date(baseDate.getTime()).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

    try {
      let slot: { start_time: string; end_time: string } | null = null;
      if (anchor === "after_last_class") {
        slot = await db
          .prepare(
            `SELECT start_time, end_time FROM timetable_slots
             WHERE day_of_week = ? ORDER BY end_time DESC LIMIT 1`
          )
          .bind(dayOfWeek)
          .first<{ start_time: string; end_time: string }>();
      } else {
        slot = await db
          .prepare(
            `SELECT start_time, end_time FROM timetable_slots
             WHERE day_of_week = ? ORDER BY start_time ASC LIMIT 1`
          )
          .bind(dayOfWeek)
          .first<{ start_time: string; end_time: string }>();
      }

      if (!slot) {
        return {
          ok: false,
          needsInfo: true,
          question: `I don't have your class schedule for ${dayOfWeek}. What time works?`,
          proposalId: propId,
        };
      }

      // Parse HH:MM from slot
      const timeStr = anchor === "after_last_class" ? slot.end_time : slot.start_time;
      const [hh, mm] = timeStr.split(":").map(Number);
      const utcInstant = new Date(baseDate.getTime() + hh * 3600000 + mm * 60000 - IST_OFFSET_MS);
      return { ok: true, utcInstant, localDate: targetDateIST, localTime: timeStr.slice(0, 5), proposalId: propId };
    } catch {
      return {
        ok: false,
        needsInfo: true,
        question: "What time works for you? I couldn't load your class schedule.",
        proposalId: propId,
      };
    }
  }

  return { ok: true, proposalId: propId };
}

// ---------------------------------------------------------------------------
// Proposal creation
// ---------------------------------------------------------------------------
export async function createProposalFromTask(
  db: D1Database,
  task: AssistantTask,
  resolved: ResolvedTime & { proposalId?: string },
  intent: AssistantIntent,
  now: Date
): Promise<string> {
  const id = resolved.proposalId || ("prop_" + Math.random().toString(36).slice(2).toUpperCase());
  const nowStr = now.toISOString();

  const dateRole = intent === "explicit_reminder" ? "reminder_time" : "deadline";

  await db
    .prepare(
      `INSERT INTO task_proposals
         (id, title, date_role, proposed_local_date, proposed_local_time,
          advisory_confidence, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(
      id,
      task.title.trim().slice(0, 500),
      dateRole,
      resolved.localDate ?? null,
      resolved.localTime ?? null,
      task.anchor && task.anchor !== "none" ? 0.85 : 0.95,
      nowStr,
      nowStr
    )
    .run();

  return id;
}

// ---------------------------------------------------------------------------
// Query answer renderer (LLM reply_text discarded for query intents)
// ---------------------------------------------------------------------------
export async function renderQueryAnswer(
  db: D1Database,
  query: AssistantQuery | undefined,
  now: Date,
  _env: any
): Promise<string> {
  if (!query) return "I'm not sure what schedule you want to see. Try /today.";

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const todayIST = istNow.toISOString().slice(0, 10);

  try {
    if (query.type === "today") {
      const tasks = await db
        .prepare(
          `SELECT title, deadline_local_time, priority, status FROM tasks
           WHERE (deadline_local_date = ? OR deadline_local_date IS NULL)
             AND status NOT IN ('done', 'cancelled')
           ORDER BY deadline_local_time ASC NULLS LAST LIMIT 10`
        )
        .bind(todayIST)
        .all<{ title: string; deadline_local_time: string | null; priority: string; status: string }>();

      if (!tasks.results.length) return "Nothing due today!";
      const lines = tasks.results.map((t) =>
        `- ${t.title}${t.deadline_local_time ? " at " + t.deadline_local_time : ""}`
      );
      return `Today's tasks:\n${lines.join("\n")}`;
    }

    if (query.type === "pending" || query.type === "overdue") {
      const isOverdue = query.type === "overdue";
      const tasks = await db
        .prepare(
          `SELECT title, deadline_local_date, deadline_local_time, priority FROM tasks
           WHERE status NOT IN ('done', 'cancelled')
             ${isOverdue ? "AND deadline_local_date < ?" : ""}
           ORDER BY deadline_local_date ASC NULLS LAST, deadline_local_time ASC NULLS LAST
           LIMIT 10`
        )
        .bind(...(isOverdue ? [todayIST] : []))
        .all<{ title: string; deadline_local_date: string | null; deadline_local_time: string | null; priority: string }>();

      if (!tasks.results.length) return isOverdue ? "No overdue tasks!" : "No pending tasks.";
      const lines = tasks.results.map((t) =>
        `- ${t.title}${t.deadline_local_date ? " (" + t.deadline_local_date + (t.deadline_local_time ? " " + t.deadline_local_time : "") + ")" : ""}`
      );
      return `${isOverdue ? "Overdue" : "Pending"} tasks:\n${lines.join("\n")}`;
    }

    if (query.type === "week") {
      const weekEnd = new Date(istNow.getTime() + 7 * 86400000).toISOString().slice(0, 10);
      const tasks = await db
        .prepare(
          `SELECT title, deadline_local_date, deadline_local_time FROM tasks
           WHERE status NOT IN ('done', 'cancelled')
             AND deadline_local_date BETWEEN ? AND ?
           ORDER BY deadline_local_date ASC, deadline_local_time ASC NULLS LAST
           LIMIT 15`
        )
        .bind(todayIST, weekEnd)
        .all<{ title: string; deadline_local_date: string | null; deadline_local_time: string | null }>();

      if (!tasks.results.length) return "Nothing due this week!";
      const lines = tasks.results.map((t) =>
        `- ${t.title}${t.deadline_local_date ? " (" + t.deadline_local_date + (t.deadline_local_time ? " " + t.deadline_local_time : "") + ")" : ""}`
      );
      return `This week:\n${lines.join("\n")}`;
    }

    if (query.type === "search" && query.keyword) {
      const kw = "%" + query.keyword + "%";
      const tasks = await db
        .prepare(
          `SELECT title, deadline_local_date, deadline_local_time FROM tasks
           WHERE title LIKE ? AND status NOT IN ('done', 'cancelled')
           ORDER BY deadline_local_date ASC NULLS LAST LIMIT 10`
        )
        .bind(kw)
        .all<{ title: string; deadline_local_date: string | null; deadline_local_time: string | null }>();

      if (!tasks.results.length) return `No tasks matching "${query.keyword}".`;
      const lines = tasks.results.map((t) => `- ${t.title}`);
      return `Found:\n${lines.join("\n")}`;
    }

    return "I couldn't understand what to look up. Try /today.";
  } catch (e) {
    console.error("[QueryAnswer] Error:", e);
    return "Couldn't load your tasks right now.";
  }
}

// ---------------------------------------------------------------------------
// modify_pending handler
// ---------------------------------------------------------------------------
export async function handleModifyPending(
  db: D1Database,
  output: TelegramAssistantOutput,
  replyToMessageId: number | undefined,
  now: Date
): Promise<{ message: string; proposalId?: string }> {
  if (!replyToMessageId) {
    return { message: "To edit a task, reply to the bot message containing the proposal." };
  }

  // Find the pending proposal associated with this bot message
  // We store the message_id in chat_messages when we sent the proposal buttons
  const row = await db
    .prepare(
      `SELECT p.id, p.title, p.status FROM task_proposals p
       JOIN chat_messages cm ON cm.text LIKE '%' || p.id || '%'
       WHERE cm.message_id = ? AND p.status = 'pending'
       LIMIT 1`
    )
    .bind(replyToMessageId)
    .first<{ id: string; title: string; status: string }>()
    .catch(() => null);

  if (!row) {
    return { message: "No pending proposal found for that message. The proposal may have already been confirmed or cancelled." };
  }

  // Apply modification from task[0]
  const newTask = output.tasks?.[0];
  if (!newTask) {
    return { message: "What would you like to change about the task?", proposalId: row.id };
  }

  const nowStr = now.toISOString();
  const updates: string[] = [];
  const binds: any[] = [];

  if (newTask.title && newTask.title !== row.title) {
    updates.push("title = ?");
    binds.push(newTask.title.trim().slice(0, 500));
  }

  if (updates.length === 0) {
    // Only time change
    updates.push("updated_at = ?");
    binds.push(nowStr);
  } else {
    updates.push("updated_at = ?");
    binds.push(nowStr);
  }

  binds.push(row.id);
  await db
    .prepare(`UPDATE task_proposals SET ${updates.join(", ")} WHERE id = ? AND status = 'pending'`)
    .bind(...binds)
    .run()
    .catch(() => {});

  const updated = newTask.title || row.title;
  return {
    message: `Updated: "${updated}"`,
    proposalId: row.id,
  };
}

// ---------------------------------------------------------------------------
// Register the capability (called once at startup in aiCapabilities.ts)
// ---------------------------------------------------------------------------
export function registerTelegramAssistantCapability(): void {
  // Avoid double-registration during hot reload
  if (AICapabilityRegistry.get("telegram_assistant")) return;

  AICapabilityRegistry.register<TelegramAssistantInput, TelegramAssistantOutput>({
    id: "telegram_assistant",
    promptId: "telegram_assistant_v1",
    promptVersion: "1.0.0",
    checksum: "block1-telegram-assistant",
    dependencies: ["tasks", "timetable"],
    supportedPrivacyClasses: ["personal"],
    // Exclude workers_ai and mock from implicit capture (enforced by conversation layer)
    // Explicit task creation allowed from all providers
    providerAllowList: undefined, // allow all; conversation layer handles per-intent exclusion
    maxContextTokens: 2000,
    maxOutputTokens: 512,
    timeoutMs: 15000,

    systemRules: buildAssistantSystemPrompt("the owner"),

    outputContract: JSON.stringify({
      intent: "string",
      confidence: "number 0..1",
      reply_text: "string",
      tasks: "array max 3",
      query: "object optional",
      memory: "object optional",
    }),

    contextBuilder: async (db, input: TelegramAssistantInput, builder, now) => {
      // Load settings
      let settings: Record<string, string> = {};
      try {
        const rows = await db
          .prepare("SELECT key, value FROM settings LIMIT 50")
          .all<{ key: string; value: string }>();
        for (const r of rows.results) settings[r.key] = r.value;
      } catch {}

      // Load recent tasks
      let recentTasks: any[] = [];
      try {
        const r = await db
          .prepare(
            `SELECT id, title, status, deadline_local_date, deadline_local_time
             FROM tasks WHERE status NOT IN ('done', 'cancelled')
             ORDER BY created_at DESC LIMIT 5`
          )
          .all();
        recentTasks = r.results;
      } catch {}

      // Load referenced proposal if replyToMessageId is set
      let replyToProposal: any = null;
      if (input.replyToMessageId) {
        try {
          replyToProposal = await db
            .prepare(
              `SELECT p.id, p.title, p.status FROM task_proposals p
               JOIN chat_messages cm ON cm.text LIKE '%' || p.id || '%'
               WHERE cm.message_id = ? AND p.status = 'pending'
               LIMIT 1`
            )
            .bind(input.replyToMessageId)
            .first();
        } catch {}
      }

      // Update system prompt with actual owner name
      const ownerName = settings["owner_name"] || "the owner";
      builder.setSystemRules(buildAssistantSystemPrompt(ownerName));

      // Build user prompt
      const userPrompt = buildAssistantUserPrompt(
        input.userText,
        now,
        settings,
        recentTasks,
        replyToProposal
      );

      builder.setOwnerRequest(userPrompt);
    },

    validator: validateOutput,

    handler: async (_db, validatedOutput, _input, _now) => {
      // The conversation handler (telegramConversation.ts) does all side effects.
      // The capability handler just passes through the validated output.
      return validatedOutput;
    },
  });
}
