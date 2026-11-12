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

export const NO_ACTION_TEXT = "Nothing was saved.";

const COMMITTED_VERBS =
  "removed|deleted|saved|set|scheduled|completed|added|updated|marked|cleared|archived|created|cancelled|canceled|rescheduled|logged|recorded|pinned|wiped|purged";

/**
 * First-person / leading completed-action claims. Deliberately narrow:
 * mid-sentence factual uses ("the report completed early") must not trip it.
 *
 * These patterns only ever see text that has passed through normalizeForClaimCheck(),
 * so a curly apostrophe or a full-width letter cannot slip past them.
 */
const CLAIM_PATTERNS: RegExp[] = [
  new RegExp(`^(?:done\\b[.,:;-]?\\s*)?(?:i(?:'ve| have)\\s+)?(?:${COMMITTED_VERBS})\\b`, "i"),
  new RegExp(`^got it[,!.]?\\s*(?:${COMMITTED_VERBS})\\b`, "i"),
  new RegExp(`\\bi(?:'ve| have)\\s+(?:now\\s+|just\\s+|successfully\\s+|already\\s+|gone ahead and\\s+)?(?:${COMMITTED_VERBS})\\b`, "i"),
  /\bi(?:'m| am)\s+(?:removing|deleting|saving|setting|scheduling|completing|adding|updating|marking|clearing)\b/i,
  new RegExp(
    `\\b(?:all|both|those|the)\\s+(?:tasks?|memories|reminders?|notes?|events?)\\s+(?:have been|were|are|has been|is now)\\s+(?:${COMMITTED_VERBS})\\b`,
    "i"
  ),
  new RegExp(`\\b(?:your|the)\\s+(?:task|reminder|note|memory)\\s+(?:has been|was|is now)\\s+(?:${COMMITTED_VERBS})\\b`, "i"),
  new RegExp(`\\bsuccessfully\\s+(?:${COMMITTED_VERBS})\\b`, "i"),
  /^(?:done|consider it done|all set)\b/i,
  /\b(?:marked|set)\s+it\s+(?:as\s+)?(?:done|complete)\b/i,
  /\b(?:closing|closed)\s+(?:all\s+)?(?:the\s+)?windows\b/i,
];

/**
 * Canonical form used for claim detection: NFKC-normalised, curly/full-width
 * punctuation folded to ASCII, whitespace collapsed, lowercased.
 *
 * Without this, "I\u2019ve removed it" (typographic apostrophe) or a full-width
 * "\uff29\uff07\uff56\uff45" bypassed every ASCII pattern in the list below.
 */
export function normalizeForClaimCheck(value: string): string {
  if (!value) return "";
  let out = value;
  try {
    out = out.normalize("NFKC");
  } catch {
    // Lone surrogates can make normalize() throw; fall back to the raw text.
  }
  return out
    .replace(/[\u2018\u2019\u201B\u02BC\uFF07\u2032]/g, "'")
    .replace(/[\u201C\u201D\uFF02\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function containsActionClaim(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForClaimCheck(text);
  return CLAIM_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalize(value: string): string {
  return normalizeForClaimCheck(value);
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
