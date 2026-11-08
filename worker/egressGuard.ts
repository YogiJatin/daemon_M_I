/**
 * worker/egressGuard.ts - F7 action-claim egress guard.
 *
 * Purpose: an LLM reply must never claim that an action happened unless the
 * code committed that action in the SAME turn. This guard is opt-in: callers
 * pass an EgressContext for chat replies only, so reminders, digests and
 * scheduler messages are never rewritten.
 *
 * Behavior:
 * - No context            -> text is returned unchanged (reminders/digests).
 * - Claim + committed text -> the committed code-generated text is sent.
 * - Clean reply           -> text is returned unchanged.
 * - Claim, nothing committed -> "No action taken."
 */

export interface EgressContext {
  /** Code-generated result strings for actions that actually committed this turn. */
  actionResults?: string[];
  /** Optional label used in logs. Never sent to the user. */
  turnId?: string;
}

export interface EgressVerdict {
  text: string;
  blocked: boolean;
  reason?: "action_claim_without_commit";
}

export const NO_ACTION_TEXT = "No action taken.";

/**
 * First-person / leading completed-action claims. Deliberately narrow:
 * mid-sentence factual uses ("the report completed early") must not trip it.
 */
const CLAIM_PATTERNS: RegExp[] = [
  /^(?:done\b[.,:;\u2014-]?\s*)?(?:i(?:'ve| have)\s+)?(?:removed|deleted|saved|set|scheduled|completed|added|updated|marked|cleared|archived|created)\b/i,
  /^got it[,!.]?\s*(?:removed|deleted|saved|set|scheduled|completed|added|updated|marked|cleared)\b/i,
  /\bi(?:'ve| have)\s+(?:now\s+|successfully\s+)?(?:removed|deleted|saved|set|scheduled|completed|added|updated|marked|cleared|archived|created)\b/i,
  /\bi(?:'m| am)\s+(?:removing|deleting|saving|setting|scheduling|completing|adding|updating|marking|clearing)\b/i,
  /\b(?:all|both|those|the)\s+(?:tasks?|memories|reminders?|notes?|events?)\s+(?:have been|were|are)\s+(?:deleted|removed|completed|marked|saved|scheduled|updated|cleared)\b/i,
  /\bsuccessfully\s+(?:removed|deleted|saved|scheduled|completed|added|updated|marked|cleared)\b/i,
  /\b(?:closing|closed)\s+(?:all\s+)?(?:the\s+)?windows\b/i,
];

export function containsActionClaim(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return CLAIM_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function guardReply(text: string, ctx?: EgressContext): EgressVerdict {
  const original = typeof text === "string" ? text : "";

  // Opt-in: no chat context means this is a reminder/digest/scheduler send.
  if (!ctx) {
    return { text: original, blocked: false };
  }

  const committed = (ctx.actionResults || [])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());

  // The reply IS the committed code result -> allowed verbatim.
  const normalizedOriginal = normalize(original);
  if (committed.some((item) => normalize(item) === normalizedOriginal)) {
    return { text: original, blocked: false };
  }

  if (!containsActionClaim(original)) {
    return { text: original, blocked: false };
  }

  const replacement = committed.length > 0 ? committed[0] : NO_ACTION_TEXT;
  console.warn(
    `[EGRESS GUARD] Blocked action claim without committed result (${ctx.turnId || "chat"}):`,
    original.slice(0, 120)
  );
  return { text: replacement, blocked: true, reason: "action_claim_without_commit" };
}
