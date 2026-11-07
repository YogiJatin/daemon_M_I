/**
 * worker/secretsGuard.ts - B5 Secrets Guard
 *
 * Intercepts passcode, password, PIN, OTP, CVV, payment card, and Aadhaar numbers.
 * Invariants:
 * - Redacted content never goes to any LLM, search call, or external service.
 * - Redacted in chat_messages.
 * - Direct plain-text reply: "I don't store secrets."
 */

export interface SecretCheckResult {
  isSecret: boolean;
  redactedText: string;
}

// Regex patterns for secrets
const SECRET_PATTERNS = [
  // Passcode / Password / PIN / OTP / CVV with value
  /\b(passcode|password|pin|otp|cvv|secret|token)\s*(?:is|:|==?|=)\s*([^\s,.]+)/i,
  /\b(passcode|password|pin|otp|cvv)\s+([a-z0-9!@#$%^&*-_]{3,})\b/i,
  // Card numbers (13-19 digits with spaces or hyphens)
  /\b(?:\d[ -]*?){13,19}\b/,
  // Indian Aadhaar format (12 digits, often in 4-4-4 blocks or prefixed by Aadhaar)
  /\b\d{4}\s\d{4}\s\d{4}\b/,
  /\baadhaar(?:\s+number)?\s*(?:is|:|==?|=)?\s*\d{12}\b/i,
];

export function checkAndRedactSecrets(text: string): SecretCheckResult {
  if (!text) return { isSecret: false, redactedText: text };

  let isSecret = false;
  let redacted = text;

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      isSecret = true;
      redacted = text.replace(pattern, "[REDACTED SECRET]");
    }
  }

  return { isSecret, redactedText: isSecret ? "[REDACTED SECRET]" : text };
}
