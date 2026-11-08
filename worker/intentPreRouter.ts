/**
 * worker/intentPreRouter.ts - Deterministic pre-router for memory actions.
 *
 * These intents must work with the AI offline and must not depend on the
 * classifier's mood:
 * - forget/delete-memory always wins over remember in the same message.
 * - "remember to <do something>" is task capture, not a memory write.
 * - A message that asks a question as well as remembering is left to the
 *   classifier so the answer and the confirmation card can both be returned.
 */

export type PreRoutedIntent =
  | { kind: "forget_memory"; query: string; outranksRemember: true }
  | { kind: "remember_memory"; query: string; outranksRemember: false };

const FORGET_PATTERNS: RegExp[] = [
  /^\s*(?:please\s+)?forget\b/i,
  /^\s*(?:please\s+)?(?:delete|remove)\b[^.!?]{0,40}\b(?:memory|memories)\b/i,
  /\b(?:delete|remove)\s+(?:this\s+|that\s+|the\s+)?(?:memory|fact|note)\b/i,
  /\bforget\s+(?:that|about|what)\b/i,
  /\bfrom\s+(?:your|my)\s+memory\b/i,
];

const REMEMBER_PATTERN = /^\s*(?:please\s+)?remember\s+(?:that\s+)?(.{3,})$/i;

function looksLikeForget(text: string): boolean {
  return FORGET_PATTERNS.some((pattern) => pattern.test(text));
}

/** Removes the instruction wrapper so only the fact remains. */
export function extractForgetQuery(text: string): string {
  let value = (text || "").trim();
  value = value.replace(/^(?:please\s+)?/i, "");
  value = value.replace(/^(?:can\s+you|could\s+you|would\s+you)\s+/i, "");
  value = value.replace(
    /^(?:forget|delete|remove)\s+(?:in\s+your\s+memory\s+|from\s+(?:your\s+|my\s+)?memory\s+|the\s+memory\s+|memory\s+)?/i,
    ""
  );
  value = value.replace(/^(?:that|about|the\s+fact\s+that|the\s+fact)\s+/i, "");
  value = value.replace(/\s+from\s+(?:your\s+|my\s+)?memory\s*$/i, "");
  value = value.replace(/^(?:this|that)\s+(?:memory|fact|note)\s*[:\-]?\s*/i, "");
  return value.replace(/[.!?]+$/, "").trim();
}

/**
 * Returns the deterministic memory action for a message, or null.
 * Forget is evaluated first, so it always outranks remember.
 */
export function preRouteIntent(text: string): PreRoutedIntent | null {
  const value = (text || "").trim();
  if (!value) return null;

  if (looksLikeForget(value)) {
    return { kind: "forget_memory", query: extractForgetQuery(value), outranksRemember: true };
  }

  const rememberMatch = value.match(REMEMBER_PATTERN);
  if (rememberMatch) {
    const fact = rememberMatch[1].trim();
    // "remember to buy milk" is task capture, not a stored fact.
    if (/^to\s+/i.test(fact)) return null;
    // Leave mixed remember + question to the classifier (answer + card).
    if (value.includes("?") || /\bwhat\b|\bwhen\b|\bwhere\b|\bwho\b|\bhow\b/i.test(fact.replace(/^that\s+/i, "")) && value.includes("?")) {
      return null;
    }
    return { kind: "remember_memory", query: fact.replace(/^that\s+/i, "").trim(), outranksRemember: false };
  }

  return null;
}
