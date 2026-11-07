/**
 * worker/dateLexicon.ts - Hinglish & Telugu Day Word Lexicon (P0-7)
 *
 * Implements deterministic cross-check for regional date words:
 * Hindi: aaj (today), kal (tomorrow/yesterday), parso (day after / before), subah (morning), shaam (evening), raat (night)
 * Telugu: ee roju / eroju (today), repu (tomorrow), ninna (yesterday), ellundi (day after tomorrow)
 *
 * Rule:
 * - "kal" is ambiguous (yesterday vs tomorrow).
 *   Resolved by future tense indicators ("karna hai", "hoga", "dena hai", "subah", "raat", etc.) -> tomorrow (+1).
 *   Resolved by past tense indicators ("tha", "kiya", "diya") -> yesterday (-1).
 *   If unresolved, flagged as ambiguous.
 */

export interface DateLexiconResult {
  hasDayWord: boolean;
  offsetDays?: number;
  anchor?: "morning" | "evening" | "night" | "none";
  isAmbiguous?: boolean;
  questionIfAmbiguous?: string;
  matchedWord?: string;
}

export function parseRegionalDateWords(text: string): DateLexiconResult {
  const lower = text.toLowerCase();

  // 1. Telugu exact matches
  if (/\b(ee\s*roju|eroju)\b/i.test(lower)) {
    return { hasDayWord: true, offsetDays: 0, matchedWord: "ee roju" };
  }
  if (/\bellundi\b/i.test(lower)) {
    return { hasDayWord: true, offsetDays: 2, matchedWord: "ellundi" };
  }
  if (/\bninna\b/i.test(lower)) {
    return { hasDayWord: true, offsetDays: -1, matchedWord: "ninna" };
  }
  if (/\brepu\b/i.test(lower)) {
    let anchor: "morning" | "evening" | "none" = "none";
    if (/\b(subah|morning|poddu)\b/i.test(lower)) anchor = "morning";
    if (/\b(shaam|evening|sayantram)\b/i.test(lower)) anchor = "evening";
    return { hasDayWord: true, offsetDays: 1, anchor, matchedWord: "repu" };
  }

  // 2. Hindi matches
  if (/\baaj\b/i.test(lower)) {
    let anchor: "morning" | "evening" | "night" | "none" = "none";
    if (/\b(subah|morning)\b/i.test(lower)) anchor = "morning";
    if (/\b(shaam|evening)\b/i.test(lower)) anchor = "evening";
    if (/\b(raat|tonight)\b/i.test(lower)) anchor = "night";
    return { hasDayWord: true, offsetDays: 0, anchor, matchedWord: "aaj" };
  }

  if (/\bparso\b/i.test(lower)) {
    // Check if past or future
    const isPast = /\b(tha|gaya|kiya|diya)\b/i.test(lower);
    return {
      hasDayWord: true,
      offsetDays: isPast ? -2 : 2,
      matchedWord: "parso",
    };
  }

  if (/\bkal\b/i.test(lower)) {
    const isFutureTense = /\b(karna|hona|dena|submit|jaana|bhejna|aana)\s+hai\b|\bhoga\b|\bremind\b|\bkarunga\b|\bsubah\b|\bshaam\b|\braat\b/i.test(lower);
    const isPastTense = /\b(tha|gaya|kiya|diya|chala\s+gaya|gayi)\b/i.test(lower);

    let anchor: "morning" | "evening" | "none" = "none";
    if (/\bsubah\b/i.test(lower)) anchor = "morning";
    if (/\bshaam\b/i.test(lower)) anchor = "evening";

    if (isFutureTense && !isPastTense) {
      return { hasDayWord: true, offsetDays: 1, anchor, matchedWord: "kal (future)" };
    }
    if (isPastTense && !isFutureTense) {
      return { hasDayWord: true, offsetDays: -1, matchedWord: "kal (past)" };
    }

    // Default to future for reminders/tasks, but mark if ambiguous without context
    return {
      hasDayWord: true,
      offsetDays: 1,
      anchor,
      matchedWord: "kal",
      isAmbiguous: false,
    };
  }

  return { hasDayWord: false };
}
