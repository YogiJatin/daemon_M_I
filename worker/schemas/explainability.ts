/**
 * worker/schemas/explainability.ts
 *
 * Mandatory Explainability Metadata for all Personal AI OS AI outputs.
 * Every capability response must include reason, confidence, evidence, and affected_record_ids.
 */

export interface ExplainabilityMetadata {
  reason: string;
  confidence: number;
  evidence: string;
  affected_record_ids: string[];
}

export function validateExplainability(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    errors.push("Output must be a non-null JSON object");
    return { valid: false, errors };
  }

  if (typeof data.reason !== "string" || !data.reason.trim()) {
    errors.push("Missing or empty mandatory field 'reason'");
  }

  if (typeof data.confidence !== "number" || isNaN(data.confidence) || data.confidence < 0 || data.confidence > 1) {
    errors.push("Mandatory field 'confidence' must be a number between 0.0 and 1.0");
  }

  if (typeof data.evidence !== "string" || !data.evidence.trim()) {
    errors.push("Missing or empty mandatory field 'evidence'");
  }

  if (!Array.isArray(data.affected_record_ids)) {
    errors.push("Mandatory field 'affected_record_ids' must be an array of strings");
  } else {
    for (const id of data.affected_record_ids) {
      if (typeof id !== "string" || !id.trim()) {
        errors.push("All items in 'affected_record_ids' must be non-empty strings");
        break;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
