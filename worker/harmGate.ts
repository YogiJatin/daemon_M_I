/**
 * worker/harmGate.ts - B7 Harm Gate
 *
 * Refuses tasks or instructions involving violence, killing, physical harm, or illegal acts against persons.
 * Invariants:
 * - One-line plain refusal.
 * - No humor, jokes, or sarcasm in refusal.
 * - 0 proposals, 0 suggestions created.
 * - Audit-logged as harm_blocked.
 */

const HARM_PATTERNS = [
  /\b(kill|killing|murder|murdering|assassinate|assassinating|shoot|stab|poison|attack|hurt|harm)\s+(?:a\s+person|someone|somebody|[A-Z][a-z]+|<[^>]+>)/i,
  /\b(task\s+of\s+killing|kill\s+my|murder\s+my)\b/i,
  /\b(plan\s+to\s+kill|plan\s+to\s+murder|plan\s+to\s+harm)\b/i,
];

export interface HarmCheckResult {
  isHarmBlocked: boolean;
  refusalText?: string;
}

export function checkHarmGate(text: string): HarmCheckResult {
  if (!text) return { isHarmBlocked: false };

  for (const pattern of HARM_PATTERNS) {
    if (pattern.test(text)) {
      return {
        isHarmBlocked: true,
        refusalText: "I cannot assist with tasks involving harm or violence.",
      };
    }
  }

  return { isHarmBlocked: false };
}
