/**
 * worker/historyHygiene.ts - what the model is allowed to see as "recent chat".
 *
 * The transcript shows the bot imitating itself: it answered "Noted, sir." with no
 * action, then repeated "sir" in every later reply, and it echoed its own fallback
 * lines back at the owner. That happens when code-generated replies are fed to the
 * model as if they were conversation.
 *
 * So history is filtered: deterministic answers, guard/linter replacements, offline
 * notices, crisis replies and system notices never reach the prompt. At most six turns
 * of real conversation are sent.
 *
 * The marker is chat_messages.outcome (the column already exists; no migration needed).
 */

import { MODE_FIT_FALLBACK_REPLY } from "./replyStyle";
import { UNGROUNDED_REPLY } from "./groundingVerifier";

export const HISTORY_TURN_LIMIT = 6;

/** Outcomes that mark a reply as code-generated, a guard replacement, or a notice. */
export const HISTORY_EXCLUDED_OUTCOMES = [
  "deterministic_",
  "ai_offline",
  "harm_blocked",
  "secret_redacted",
  "style_update",
  "system_notice",
  "forwarded_data_only",
  "memories_template",
  "budget_exceeded",
  "crisis_support",
  "terse_greeting",
  "multi_intent_processed",
];

/** Text a guard or linter substituted. Feeding these back teaches the model to imitate them. */
export const HISTORY_REPLACEMENT_TEXTS = new Set([
  MODE_FIT_FALLBACK_REPLY,
  UNGROUNDED_REPLY,
  "No data.",
  "No action taken.",
  "AI is temporarily offline. Your message was saved.",
  "AI is temporarily offline. Core reminders, tasks, and schedule still work.",
  "I don't store secrets.",
  "I cannot assist with tasks involving harm or violence.",
]);

/**
 * Bare acknowledgements that mean nothing without a committed action. They are normally
 * caught by the reply linter before being stored, but a stored one still teaches the
 * model to answer "Noted, sir." forever, so they are dropped from history by shape.
 */
const CANNED_ACK =
  /^(?:noted|got it|got you|understood|sure|okay|ok|right|cool)(?:[\s,]+(?:sir|boss|master|ma'am))?[.!]*$/i;

export interface HistoryRow {
  role: string;
  text: string | null;
  outcome: string | null;
}

export function isExcludedFromHistory(row: HistoryRow): boolean {
  const outcome = (row.outcome || "").toLowerCase();
  if (HISTORY_EXCLUDED_OUTCOMES.some((prefix) => outcome.startsWith(prefix))) return true;
  if (row.role === "assistant") {
    const text = (row.text || "").trim();
    if (HISTORY_REPLACEMENT_TEXTS.has(text)) return true;
    if (CANNED_ACK.test(text)) return true;
    if (!text) return true;
  }
  return false;
}

/**
 * Turns newest-first rows into the `role: text` lines the prompt builder expects,
 * oldest first, capped at six turns of real conversation.
 */
export function buildRecentChat(rows: HistoryRow[]): string[] {
  return (rows || [])
    .filter((row) => !isExcludedFromHistory(row))
    .slice(0, HISTORY_TURN_LIMIT * 2)
    .reverse()
    .map((row) => `${row.role}: ${row.text || ""}`);
}
