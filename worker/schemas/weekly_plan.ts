/**
 * worker/schemas/weekly_plan.ts
 *
 * Schema & validator for weekly_plan capability.
 */

import { ExplainabilityMetadata, validateExplainability } from "./explainability";

export interface PlanProposalItem {
  id?: string;
  title: string;
  suggested_deadline_offset_hours: number;
  priority: "low" | "normal" | "high" | "urgent";
  evidence: string;
}

export interface WeeklyPlanOutput extends ExplainabilityMetadata {
  summary: string;
  focus_areas: string[];
  bottlenecks: string[];
  proposals: PlanProposalItem[];
}

export function validateWeeklyPlanOutput(data: any): { valid: boolean; errors: string[] } {
  const expCheck = validateExplainability(data);
  const errors = [...expCheck.errors];

  if (typeof data.summary !== "string" || !data.summary.trim()) {
    errors.push("Missing or empty field 'summary'");
  }

  if (!Array.isArray(data.focus_areas)) {
    errors.push("Field 'focus_areas' must be an array of strings");
  }

  if (!Array.isArray(data.bottlenecks)) {
    errors.push("Field 'bottlenecks' must be an array of strings");
  }

  if (!Array.isArray(data.proposals)) {
    errors.push("Field 'proposals' must be an array");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
