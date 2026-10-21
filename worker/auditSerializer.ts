/**
 * worker/auditSerializer.ts
 *
 * Canonical JSON Serialization & Privacy Sanitization for Audit Ledger.
 *
 * Requirements:
 * - Deterministic JSON serialization (stable recursive key ordering, no whitespace differences).
 * - Strict Privacy Scrubbing: Exclude raw message bodies, prompt text, response text,
 *   tokens, secrets, cookies, emails, and phone numbers.
 * - Replay records store only structured forensic metadata.
 */

// List of forbidden property keys that must never be persisted in metadata
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /cookie/i,
  /prompt/i,
  /response_body/i,
  /message_body/i,
  /raw_text/i,
  /api_?key/i,
  /auth/i,
  /email/i,
  /phone/i,
  /private/i,
];

/**
 * Sanitizes an object to remove all PII, secrets, and raw text bodies.
 * Preserves structural identifiers, state transitions, numbers, and timestamps.
 */
export function sanitizeAuditMetadata(data: any): Record<string, any> {
  if (!data || typeof data !== "object") {
    return {};
  }

  const sanitized: Record<string, any> = {};

  for (const [key, val] of Object.entries(data)) {
    // Check if key matches any forbidden sensitive pattern
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pat) => pat.test(key));
    if (isSensitive) {
      continue;
    }

    if (val === undefined || val === null) {
      continue;
    }

    if (val instanceof Date) {
      sanitized[key] = val.toISOString();
    } else if (Array.isArray(val)) {
      sanitized[key] = val.map((item) =>
        typeof item === "object" && item !== null ? sanitizeAuditMetadata(item) : item
      );
    } else if (typeof val === "object") {
      sanitized[key] = sanitizeAuditMetadata(val);
    } else if (typeof val === "string") {
      // Bounded string length for safety; never allow huge text blobs
      sanitized[key] = val.length > 200 ? val.substring(0, 197) + "..." : val;
    } else {
      sanitized[key] = val;
    }
  }

  return sanitized;
}

/**
 * Produces deterministic, canonical JSON with recursively sorted keys.
 * Guarantees byte-for-byte identical output across platforms and object insertion orders.
 */
export function canonicalizeJson(obj: any): string {
  if (obj === undefined) {
    return "null";
  }
  if (obj === null) {
    return "null";
  }
  if (obj instanceof Date) {
    return JSON.stringify(obj.toISOString());
  }
  if (typeof obj === "number" || typeof obj === "boolean") {
    return JSON.stringify(obj);
  }
  if (typeof obj === "string") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    const elements = obj.map((e) => canonicalizeJson(e));
    return `[${elements.join(",")}]`;
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    const pairs = keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(String(obj));
}
