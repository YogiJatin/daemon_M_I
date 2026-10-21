/**
 * worker/schemas/prioritize.ts
 *
 * Schema & validator for prioritize capability.
 */

import { ExplainabilityMetadata, validateExplainability } from "./explainability";

export interface PrioritizedItem {
  task_id: string;
  rank: number;
  urgency_score: number;
  reasoning: string;
}

export interface PrioritizeOutput extends ExplainabilityMetadata {
  summary: string;
  recommended_order: PrioritizedItem[];
}

export function validatePrioritizeOutput(data: any): { valid: boolean; errors: string[] } {
  const expCheck = validateExplainability(data);
  const errors = [...expCheck.errors];

  if (typeof data.summary !== "string" || !data.summary.trim()) {
    errors.push("Missing or empty field 'summary'");
  }

  if (!Array.isArray(data.recommended_order)) {
    errors.push("Field 'recommended_order' must be an array");
  } else {
    for (let i = 0; i < data.recommended_order.length; i++) {
      const item = data.recommended_order[i];
      if (!item || typeof item !== "object") {
        errors.push(`Rank item at index ${i} is not an object`);
        continue;
      }
      if (typeof item.task_id !== "string" || !item.task_id.trim()) {
        errors.push(`Rank item at index ${i} has invalid 'task_id'`);
      }
      if (typeof item.rank !== "number" || item.rank < 1) {
        errors.push(`Rank item at index ${i} has invalid 'rank'`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
