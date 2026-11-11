/**
 * worker/safetyPath.ts - code-owned self-harm handling, before any model runs.
 *
 * The transcript shows the wrong failure twice: "Lol just kill me" was refused as a
 * policy violation ("I cannot assist with tasks involving harm or violence."), and a
 * classifier alone cannot be trusted to tell venting from real intent. Both decisions
 * are made here, deterministically:
 *
 * - "possible": the message may mean he wants to hurt himself. A fixed, humane reply
 *   goes out with no model call, no memory proposal, and no "policy" wording. It is
 *   never rewritten by the egress guard or the style linter.
 * - "figurative": dark idiom with no real intent ("lol just kill me"). Normal SUPPORT
 *   reply from the model, never a refusal, never a memory proposal.
 * - "none": everything else. Venting and swearing are not risk.
 *
 * The crisis text is stored in settings.crisis_support_text so it is owner-visible and
 * changeable without a deploy; this constant is the seed and the fallback.
 */

export type RiskLevel = "none" | "figurative" | "possible";

export const CRISIS_SUPPORT_SETTING_KEY = "crisis_support_text";

/**
 * Tele-MANAS (India's national tele-mental-health programme): 14416 and
 * 1-800-891-4416, free and open 24/7. Cited in docs/DECISIONS.md (ADR 2026-11-09).
 */
export const CRISIS_SUPPORT_TEXT =
  "That sounds heavy, and I'm taking it seriously. Are you safe right now? If " +
  "you might hurt yourself, please call Tele-MANAS on 14416 (1-800-891-4416), " +
  "free and open 24/7, or tell someone near you right now. I'm here and I'll " +
  "stay in this chat.";

/** Unambiguous self-harm language: English. */
const STRONG_ENGLISH: RegExp[] = [
  /\bkill\s+myself\b/i,
  /\bkill\s+my\s+self\b/i,
  /\bwant\s+to\s+die\b/i,
  /\bwanna\s+die\b/i,
  /\bend\s+my\s+life\b/i,
  /\bend\s+it\s+all\b/i,
  /\bsuicid(?:e|al)\b/i,
  /\bno\s+reason\s+to\s+live\b/i,
  /\bdon'?t\s+want\s+to\s+(?:be\s+alive|live)\b/i,
  /\bnot\s+want\s+to\s+be\s+alive\b/i,
  /\bhurt\s+myself\b/i,
  /\bunalive\s+myself\b/i,
];

/** Unambiguous self-harm language: Hinglish (romanised Hindi). */
const STRONG_HINGLISH: RegExp[] = [
  /\bmar\s+jaun?g?a?\b/i,
  /\bmar\s+jana\s+chahta\b/i,
  /\bmar\s+jaana\s+chahta\b/i,
  /\bkhud\s*ko\s+(?:maar|khatam)\b/i,
  /\bmujhe\s+(?:marna|mar\s+jaana)\s+hai\b/i,
  /\bjeena\s+nahi\s+(?:hai|chahta)\b/i,
  /\bjaan\s+de\s+dun?g?a?\b/i,
  /\bjaan\s+dena\s+chahta\b/i,
  /\bapni\s+jaan\s+le\s+lun?g?a?\b/i,
  /\bkhatam\s+kar\s+lun?\s+(?:khud\s*ko|apne\s+aap\s*ko)\b/i,
];

/** Unambiguous self-harm language: romanised Telugu. */
const STRONG_TELUGU: RegExp[] = [
  /\bchanipoval(?:i|u)\b/i,
  /\bchanipoyi\s+poval(?:i|u)\b/i,
  /\bnaku\s+(?:chaavali|chavali)\b/i,
  /\bnaaku\s+(?:chaavali|chavali)\b/i,
  /\bchaavali\s+ani\b/i,
  /\bpranam\s+(?:theesuk|thisuk|teesuk)/i,
  /\bpraanam\s+(?:theesuk|thisuk|teesuk)/i,
  /\bathma\s+hatya\b/i,
  /\batma\s+hatya\b/i,
];

/** Dark idiom that is not a statement of intent. */
const FIGURATIVE: RegExp[] = [
  /\b(?:lol|lmao|haha|hehe|rofl)\b[\s\S]{0,20}\bkill\s+me\b/i,
  /\bkill\s+me\b[\s\S]{0,40}\b(?:lol|lmao|haha|assignment|exam|deadline|project|homework|report|test|viva)\b/i,
  /\b(?:this|that)\s+(?:assignment|exam|deadline|project|homework|report|test|viva|day)\s+is\s+killing\s+me\b/i,
  /\b(?:dying|dead)\s+(?:of|from)\s+(?:laughter|boredom|hunger|heat|exhaustion)\b/i,
  /\bmar\s+(?:do|dalo|daalo)\s+yaar\b/i,
  /\bmaar\s+(?:do|dalo|daalo)\s+yaar\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Combines the deterministic pre-check with the classifier's `risk` field.
 * Deterministic evidence always outranks the model, in both directions.
 */
export function assessRisk(text: string, classifierRisk?: string): RiskLevel {
  const value = (text || "").trim();
  if (!value) return classifierRisk === "possible" ? "possible" : "none";

  if (matchesAny(value, STRONG_ENGLISH) || matchesAny(value, STRONG_HINGLISH) || matchesAny(value, STRONG_TELUGU)) {
    return "possible";
  }

  // A clear joke/workload frame wins over "kill me" alone.
  if (matchesAny(value, FIGURATIVE)) return "figurative";

  if (classifierRisk === "possible") return "possible";
  if (classifierRisk === "figurative") return "figurative";
  return "none";
}

/** Memory proposals are rejected for any message with risk != none. */
export function memoryProposalAllowed(risk: RiskLevel): boolean {
  return risk === "none";
}
