/**
 * worker/replyStyle.ts - the last thing every outgoing chat reply passes through.
 *
 * Two persona rules are mechanical, so they belong in code rather than in a prompt:
 *
 * 1. Never instruct the owner. "Specify the request, sir." told him what to do, which
 *    is the same register problem as "No data.": the assistant reports, it does not
 *    issue orders.
 * 2. Never say "sir" twice. The persona addresses him once per reply; a model that
 *    writes "I will call you sir, sir." reads as broken, not deferential.
 *
 * Guard decisions are returned, not logged here, so the caller can record them once
 * per turn (chat_messages.outcome) and `/why` can explain the reply later.
 */

export interface StyleViolation {
  code: string;
  detail: string;
}

export interface StyledReply {
  /** The text that should actually be sent. */
  text: string;
  /** Decisions taken while styling, e.g. "style_collapsed_sir". */
  decisions: string[];
  /** Empty when the reply is safe to send. */
  violations: StyleViolation[];
}

/** Sent instead of a reply that instructs the owner. Short, neutral, no new claims. */
export const STYLE_FALLBACK_REPLY = "Understood, sir.";

/**
 * Imperatives aimed at the owner. Anchored to a sentence start so descriptive uses
 * ("the provider stated a limit") never match.
 */
const OWNER_DIRECTED_IMPERATIVE =
  /(?:^|[.!?]\s+)(specify|provide|state)\b[\s\S]{0,40}\b(sir|the request|the details|what you need)\b/i;

/** "sir, sir", "sir sir", "Sir,  sir." -> "sir" */
export function collapseDuplicateSir(text: string): string {
  if (!text) return text;
  return text.replace(/\bsir\b(?:[\s,;]*\bsir\b)+/gi, (match) =>
    match.startsWith("Sir") ? "Sir" : "sir"
  );
}

/** Checks the reply as it would be sent (call after collapseDuplicateSir). */
export function checkReplyStyle(text: string): StyleViolation[] {
  const violations: StyleViolation[] = [];
  if (!text) return violations;

  const duplicate = /\bsir\b[\s,;]*\bsir\b/i.exec(text);
  if (duplicate) {
    violations.push({ code: "duplicate_sir", detail: duplicate[0] });
  }

  const imperative = OWNER_DIRECTED_IMPERATIVE.exec(text);
  if (imperative) {
    violations.push({
      code: "owner_directed_imperative",
      detail: `${imperative[1].toLowerCase()} ... ${imperative[2].toLowerCase()}`,
    });
  }

  return violations;
}

/**
 * Collapses duplicates, then blocks replies that still instruct the owner.
 * A blocked reply is replaced by STYLE_FALLBACK_REPLY rather than guessed at.
 */
export function applyReplyStyle(text: string): StyledReply {
  const original = typeof text === "string" ? text : "";
  const collapsed = collapseDuplicateSir(original);
  const decisions: string[] = [];
  if (collapsed !== original) {
    decisions.push("style_collapsed_sir");
  }

  const violations = checkReplyStyle(collapsed);
  return {
    text: violations.length > 0 ? STYLE_FALLBACK_REPLY : collapsed,
    decisions,
    violations,
  };
}
