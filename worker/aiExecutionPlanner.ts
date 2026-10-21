/**
 * worker/aiExecutionPlanner.ts
 *
 * Platform-Neutral Execution Planner for Personal AI OS.
 *
 * Strict Security Boundaries:
 * - Only generates typed execution plans.
 * - Does NOT execute any actions.
 * - ZERO shell commands, desktop control, browser automation, or OS interaction.
 * - Exclusively prepares typed contracts for future Blocks (Block 9 Desktop Agent).
 */

export interface ExecutionStep {
  stepId: string;
  type: "task_create" | "notification_plan" | "timetable_query" | "desktop_adapter" | "review_checkpoint";
  intent: string;
  target?: string;
  inputs: Record<string, any>;
  preconditions?: string[];
  rollback?: {
    action: string;
    inputs: Record<string, any>;
  };
}

export interface ExecutionPlan {
  planId: string;
  capability: string;
  summary: string;
  status: "draft" | "validated" | "approved" | "rejected";
  requiresApproval: boolean;
  steps: ExecutionStep[];
  estimatedDurationSeconds: number;
  createdAt: string;
}

export class AIExecutionPlanner {
  /**
   * Generates a platform-neutral execution plan from validated steps.
   */
  public static createPlan(
    capability: string,
    summary: string,
    steps: Array<{
      type: ExecutionStep["type"];
      intent: string;
      inputs: Record<string, any>;
      preconditions?: string[];
      rollback?: ExecutionStep["rollback"];
    }>,
    now: Date = new Date()
  ): ExecutionPlan {
    const planId = `plan_${crypto.randomUUID()}`;
    const typedSteps: ExecutionStep[] = steps.map((s, idx) => ({
      stepId: `${planId}_s${idx + 1}`,
      type: s.type,
      intent: s.intent,
      inputs: s.inputs || {},
      preconditions: s.preconditions || [],
      rollback: s.rollback,
    }));

    return {
      planId,
      capability,
      summary,
      status: "draft",
      requiresApproval: true, // Always require approval (Rule 11)
      steps: typedSteps,
      estimatedDurationSeconds: typedSteps.length * 30,
      createdAt: now.toISOString(),
    };
  }
}
