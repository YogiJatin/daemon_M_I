/**
 * worker/harmGate.ts - B7 Harm Gate
 *
 * Blocks task-level instructions involving violence, killing, physical harm or illegal
 * acts against a person.
 *
 * Invariants:
 * - One-line plain refusal.
 * - No humor, jokes, or sarcasm in refusal.
 * - 0 proposals, 0 suggestions created.
 * - Audit-logged as harm_blocked.
 *
 * Not blocked here (and deliberately so):
 * - Self-harm language. That is the safety path in safetyPath.ts, which answers with the
 *   crisis template instead of a refusal.
 * - Venting dark talk ("Lol just kill me", "this exam is killing me"). Every pattern below
 *   needs a victim target or an explicit plan, so a joke with no victim never fires.
 */

/** A person, or a named public figure, as the object of the harm verb. */
const TARGET =
  "(?:someone|somebody|anyone|anybody|a\\s+person|people|him|her|them|his\\s+family|" +
  "the\\s+(?:president|prime\\s+minister|minister|teacher|professor|boss|neighbour|neighbor))";

const HARM_VERB =
  "(?:kill|killing|murder|murdering|assassinate|assassinating|shoot|shooting|stab|stabbing|" +
  "poison|poisoning|attack|attacking|hurt|hurting|harm|harming)";

const PERSONAL_TARGET =
  "(?:boss|teacher|professor|principal|wife|husband|partner|girlfriend|boyfriend|parents?|" +
  "mother|father|sister|brother|friend|roommate|classmate|coworker|neighbour|neighbor)";

const HARM_PATTERNS: RegExp[] = [
  // "kill the president", "hurt someone", "attack the neighbour"
  new RegExp(`\\b${HARM_VERB}\\s+(?:a\\s+|an\\s+|the\\s+)?${TARGET}\\b`, "i"),
  // "kill my boss", "shoot my teacher"
  new RegExp(`\\b${HARM_VERB}\\s+(?:my|his|her|their)\\s+${PERSONAL_TARGET}\\b`, "i"),
  // "plan to kill ...", "planning to harm ...". A 25-character window also catches an
  // escaped pattern source such as "plan\s+to\s+kill", which is how an injected
  // instruction reads.
  new RegExp(`\\bplan\\b[^\\n]{0,25}\\b${HARM_VERB}\\b`, "i"),
  // "task of killing", "todo to hurt someone"
  new RegExp(`\\b(?:task|todo|reminder|job)s?\\s+(?:of|to)\\s+${HARM_VERB}\\b`, "i"),
  // "help me kill", "teach me how to poison"
  new RegExp(`\\b(?:help|teach|show)\\s+me\\s+(?:how\\s+to\\s+)?${HARM_VERB}\\b`, "i"),
];

export interface HarmCheckResult {
  isHarmBlocked: boolean;
  refusalText?: string;
}

export function checkHarmGate(text: string): HarmCheckResult {
  if (!text) return { isHarmBlocked: false };
  const value = String(text);

  for (const pattern of HARM_PATTERNS) {
    if (pattern.test(value)) {
      return {
        isHarmBlocked: true,
        refusalText: "I cannot assist with tasks involving harm or violence.",
      };
    }
  }

  return { isHarmBlocked: false };
}
