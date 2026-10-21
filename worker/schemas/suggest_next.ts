/**
 * worker/schemas/suggest_next.ts
 *
 * Schema & validator for suggest_next capability.
 */

import { ExplainabilityMetadata, validateExplainability } from "./explainability";

export interface SuggestNextOutput extends ExplainabilityMetadata {
  next_action: string;
  rationale: string;
  related_task_id?: string;
}

export function validateSuggestNextOutput(data: any): { valid: boolean; errors: string[] } {
  // Ensure reason is populated from rationale if needed
  if (!data.reason && data.rationale) {
    data.reason = data.rationale;
  }
  if (!data.evidence) {
    data.evidence = data.rationale || "Derived from current schedule and task status";
  }
  if (!Array.isArray(data.affected_record_ids)) {
    data.affected_record_ids = data.related_task_id ? [data.related_task_id] : [];
  }

  const expCheck = validateExplainability(data);
  const errors = [...expCheck.errors];

  if (typeof data.next_action !== "string" || !data.next_action.trim()) {
    errors.push("Missing or empty field 'next_action'");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
