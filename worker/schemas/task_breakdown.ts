/**
 * worker/schemas/task_breakdown.ts
 *
 * Schema & validator for task_breakdown capability.
 */

import { ExplainabilityMetadata, validateExplainability } from "./explainability";

export interface SubtaskItem {
  title: string;
  estimated_minutes: number;
  suggested_deadline_offset_hours: number;
  priority: "low" | "normal" | "high" | "urgent";
  evidence: string;
}

export interface TaskBreakdownRawOutput extends ExplainabilityMetadata {
  summary: string;
  subtasks: SubtaskItem[];
}

export interface TaskBreakdownOutput extends ExplainabilityMetadata {
  summary: string;
  proposals: Array<{
    id?: string;
    title: string;
    estimated_minutes: number;
    suggested_deadline_offset_hours: number;
    priority: "low" | "normal" | "high" | "urgent";
    evidence: string;
  }>;
}

export function validateTaskBreakdownOutput(data: any): { valid: boolean; errors: string[] } {
  const expCheck = validateExplainability(data);
  const errors = [...expCheck.errors];

  if (typeof data.summary !== "string" || !data.summary.trim()) {
    errors.push("Missing or empty field 'summary'");
  }

  const subtasks = data.subtasks || data.proposals;
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    errors.push("Field 'subtasks' (or 'proposals') must be a non-empty array");
  } else {
    for (let i = 0; i < subtasks.length; i++) {
      const st = subtasks[i];
      if (!st || typeof st !== "object") {
        errors.push(`Subtask at index ${i} is not an object`);
        continue;
      }
      if (typeof st.title !== "string" || !st.title.trim()) {
        errors.push(`Subtask at index ${i} has missing or invalid 'title'`);
      }
      if (typeof st.suggested_deadline_offset_hours !== "number" || st.suggested_deadline_offset_hours < 0) {
        errors.push(`Subtask at index ${i} has invalid 'suggested_deadline_offset_hours'`);
      }
      if (!["low", "normal", "high", "urgent"].includes(st.priority)) {
        errors.push(`Subtask at index ${i} has invalid priority: '${st.priority}'`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
