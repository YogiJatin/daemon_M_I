/**
 * worker/intentSchema.ts - Typed action contract for Telegram chat.
 *
 * The classifier returns a JSON object with an `actions` array (max 3) plus
 * `reply_needed`. Actions are declarations only: this module never mutates D1.
 * Legacy fields (intent/tasks/memory/query/lookup) are normalized into actions
 * so existing tests and older model outputs keep working.
 */

export const MAX_ACTIONS = 3;

export const ACTION_TYPES = [
  "forget_memory",
  "remember_memory",
  "create_task",
  "query_schedule",
  "query_tasks",
  "lookup",
  "chat",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export interface ForgetMemoryAction {
  type: "forget_memory";
  query: string;
}

export interface RememberMemoryAction {
  type: "remember_memory";
  text: string;
}

export interface CreateTaskAction {
  type: "create_task";
  title: string;
  date_phrase?: string;
  offset_days?: number;
  hour?: number | null;
  minute?: number | null;
  anchor?: string;
  priority?: string;
}

export interface QueryScheduleAction {
  type: "query_schedule";
  query_type?: string;
}

export interface QueryTasksAction {
  type: "query_tasks";
  query_type?: string;
}

export interface LookupAction {
  type: "lookup";
  kind: "weather" | "web";
  query: string;
  place?: string;
  when?: string;
}

export interface ChatAction {
  type: "chat";
}

export type DaemonAction =
  | ForgetMemoryAction
  | RememberMemoryAction
  | CreateTaskAction
  | QueryScheduleAction
  | QueryTasksAction
  | LookupAction
  | ChatAction;

export interface DaemonIntentOutput {
  intent: string;
  confidence: number;
  reply_needed: boolean;
  reply_text?: string;
  actions: DaemonAction[];
  tasks?: any[];
  query?: any;
  lookup?: any;
  memory?: any;
}

/** Text that asks to remove stored knowledge - never a "remember" proposal. */
export function isMemoryMutation(text: string): boolean {
  const value = (text || "").trim();
  if (!value) return false;
  return (
    /^(?:please\s+)?(?:forget|delete|remove)\b/i.test(value) ||
    /\b(?:delete|remove)\s+(?:this\s+|that\s+|the\s+)?(?:memory|fact|note)\b/i.test(value) ||
    /\bfrom\s+(?:your|my)\s+memory\b/i.test(value)
  );
}

function isActionType(value: any): value is ActionType {
  return typeof value === "string" && (ACTION_TYPES as readonly string[]).includes(value);
}

/** Coerces a raw provider `actions` array into validated typed actions. */
export function normalizeActions(raw: any): DaemonAction[] {
  const output: DaemonAction[] = [];
  const push = (action: DaemonAction | null) => {
    if (!action) return;
    if (output.length >= MAX_ACTIONS) return;
    if (output.some((existing) => existing.type === action.type)) return;
    output.push(action);
  };

  const rawActions = Array.isArray(raw?.actions) ? raw.actions : [];
  for (const action of rawActions) {
    if (!action || typeof action !== "object" || !isActionType(action.type)) continue;
    switch (action.type) {
      case "forget_memory":
        push({ type: "forget_memory", query: String(action.query || "").trim() });
        break;
      case "remember_memory":
        push({ type: "remember_memory", text: String(action.text || "").trim() });
        break;
      case "create_task":
        push({
          type: "create_task",
          title: String(action.title || "").trim(),
          date_phrase: action.date_phrase ? String(action.date_phrase) : undefined,
          offset_days: typeof action.offset_days === "number" ? action.offset_days : undefined,
          hour: typeof action.hour === "number" ? action.hour : null,
          minute: typeof action.minute === "number" ? action.minute : null,
          anchor: action.anchor ? String(action.anchor) : "none",
          priority: action.priority ? String(action.priority) : "normal",
        });
        break;
      case "query_schedule":
        push({ type: "query_schedule", query_type: action.query_type ? String(action.query_type) : undefined });
        break;
      case "query_tasks":
        push({ type: "query_tasks", query_type: action.query_type ? String(action.query_type) : undefined });
        break;
      case "lookup":
        push({
          type: "lookup",
          kind: action.kind === "weather" ? "weather" : "web",
          query: String(action.query || "").trim(),
          place: action.place ? String(action.place) : undefined,
          when: action.when ? String(action.when) : undefined,
        });
        break;
      case "chat":
        push({ type: "chat" });
        break;
    }
  }

  if (output.length > 0) return output;

  // Legacy output compatibility: derive actions from the flat intent fields.
  const legacyIntent = String(raw?.intent || "chat");
  if (legacyIntent === "remember" && raw?.memory?.text) {
    return [{ type: "remember_memory", text: String(raw.memory.text).trim() }];
  }
  if (legacyIntent === "forget_memory") {
    return [{ type: "forget_memory", query: String(raw?.memory?.text || "").trim() }];
  }
  if (
    legacyIntent === "explicit_task" ||
    legacyIntent === "explicit_reminder" ||
    legacyIntent === "implicit_commitment"
  ) {
    return (Array.isArray(raw?.tasks) ? raw.tasks : [])
      .slice(0, MAX_ACTIONS)
      .map((task: any) => ({
        type: "create_task" as const,
        title: String(task?.title || "").trim(),
        date_phrase: task?.date_phrase ? String(task.date_phrase) : undefined,
        offset_days: typeof task?.offset_days === "number" ? task.offset_days : undefined,
        hour: typeof task?.hour === "number" ? task.hour : null,
        minute: typeof task?.minute === "number" ? task.minute : null,
        anchor: task?.anchor ? String(task.anchor) : "none",
        priority: task?.priority ? String(task.priority) : "normal",
      }));
  }
  if (legacyIntent === "query_schedule" || legacyIntent === "query_tasks") {
    return [{ type: legacyIntent, query_type: raw?.query?.type ? String(raw.query.type) : undefined }];
  }
  if (legacyIntent === "lookup") {
    return [
      {
        type: "lookup",
        kind: raw?.lookup?.kind === "weather" ? "weather" : "web",
        query: String(raw?.lookup?.query || "").trim(),
        place: raw?.lookup?.place ? String(raw.lookup.place) : undefined,
        when: raw?.lookup?.when ? String(raw.lookup.when) : undefined,
      },
    ];
  }
  return [{ type: "chat" }];
}

/** Normalizes the full classifier output, including reply_needed. */
export function normalizeIntentOutput(raw: any): DaemonIntentOutput {
  const actions = normalizeActions(raw);
  const replyText = typeof raw?.reply_text === "string" ? raw.reply_text : "";
  return {
    intent: String(raw?.intent || actions[0]?.type || "chat"),
    confidence: typeof raw?.confidence === "number" ? raw.confidence : 0.5,
    reply_needed:
      typeof raw?.reply_needed === "boolean" ? raw.reply_needed : replyText.trim().length > 0,
    reply_text: replyText,
    actions,
    tasks: raw?.tasks,
    query: raw?.query,
    lookup: raw?.lookup,
    memory: raw?.memory,
  };
}
