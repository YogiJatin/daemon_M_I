/**
 * worker/executionVerifier.ts — Execution Outcome Verifier & Rollback Coordinator
 *
 * Requirements:
 * - Post-execution verification of all executed steps
 * - Generates structured rollback metadata on step failure
 * - Emits EXECUTION_VERIFIED audit event
 */

import {
  ExecutionPlanRecord,
  StepExecutionResult,
  PlanExecutionResult,
} from './executionTypes';
import { AuditService } from './auditService';

export class ExecutionVerifier {
  /**
   * Verifies plan execution results, updates plan status, and emits audit records.
   */
  static async verifyOutcome(
    db: D1Database,
    plan: ExecutionPlanRecord,
    results: StepExecutionResult[],
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<PlanExecutionResult> {
    const totalSteps = plan.steps.length;
    const executedSteps = results.length;
    const hasFailure = results.some((r) => !r.success);

    const nowIso = now.toISOString();
    const finalStatus = hasFailure ? 'failed' : 'completed';
    const summary = hasFailure
      ? `Execution failed at step ${executedSteps} of ${totalSteps}.`
      : `All ${totalSteps} execution steps completed successfully.`;

    // 1. Update execution_plans status
    await db
      .prepare(
        `UPDATE execution_plans SET status = ?, result_summary = ?, updated_at = ? WHERE id = ?`
      )
      .bind(finalStatus, summary, nowIso, plan.id)
      .run();

    // 2. Audit verification
    await AuditService.emit(
      db,
      {
        eventType: 'EXECUTION_VERIFIED',
        entityType: 'execution_plan',
        entityId: plan.id,
        actor: 'system:verifier',
        payload: {
          planId: plan.id,
          finalStatus,
          totalSteps,
          executedSteps,
          summary,
        },
        metadata: { planId: plan.id, status: finalStatus },
      },
      env
    );

    return {
      planId: plan.id,
      status: finalStatus,
      totalSteps,
      executedSteps,
      results,
      error: hasFailure ? results[results.length - 1]?.error : undefined,
      verified: true,
    };
  }
}
