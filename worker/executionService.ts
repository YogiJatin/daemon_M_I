/**
 * worker/executionService.ts — Execution Lifecycle & Approval State Machine
 *
 * Requirements:
 * - Single-use cryptographic approval hash binding
 * - Rejects mismatched approval hashes (Approval Swap Defense)
 * - State machine: draft/pending_approval -> approved -> executing -> completed/failed/rolled_back
 * - Emits EXECUTION_APPROVED, EXECUTION_STARTED, EXECUTION_VERIFIED audit events
 */

import {
  ExecutionPlanRecord,
  ExecutionStepDefinition,
  PlanExecutionResult,
} from './executionTypes';
import { ExecutionRouter } from './executionRouter';
import { ExecutionVerifier } from './executionVerifier';
import { AuditService } from './auditService';

export class ExecutionService {
  /**
   * Retrieves an execution plan with its steps.
   */
  static async getPlan(db: D1Database, planId: string): Promise<ExecutionPlanRecord | null> {
    const row = await db
      .prepare(`SELECT * FROM execution_plans WHERE id = ?`)
      .bind(planId)
      .first<any>();

    if (!row) return null;

    const stepRows = await db
      .prepare(`SELECT * FROM execution_steps WHERE plan_id = ? ORDER BY step_index ASC`)
      .bind(planId)
      .all<any>();

    const steps: ExecutionStepDefinition[] = (stepRows.results || []).map((s) => {
      let params = {};
      try {
        if (s.params_json) params = JSON.parse(s.params_json);
      } catch {}
      return {
        stepIndex: s.step_index,
        adapter: s.adapter,
        action: s.action,
        parameters: params,
        description: `${s.adapter}.${s.action}`,
      };
    });

    return {
      id: row.id,
      intent: row.intent,
      riskTier: row.risk_tier,
      status: row.status,
      approvalHash: row.approval_hash,
      approvedAt: row.approved_at,
      resultSummary: row.result_summary,
      steps,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Approves a plan using the cryptographic payload approval hash.
   */
  static async approvePlan(
    db: D1Database,
    planId: string,
    providedHash: string,
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<ExecutionPlanRecord> {
    const plan = await this.getPlan(db, planId);
    if (!plan) {
      throw new Error(`Execution plan '${planId}' not found.`);
    }

    if (plan.status === 'approved') {
      return plan;
    }

    if (plan.status !== 'pending_approval' && plan.status !== 'draft') {
      throw new Error(`Cannot approve plan '${planId}' with status '${plan.status}'.`);
    }

    // Cryptographic hash validation (Defense against approval swap)
    if (plan.approvalHash !== providedHash) {
      throw new Error(
        `Approval hash mismatch. Expected '${plan.approvalHash}', got '${providedHash}'. Approval rejected.`
      );
    }

    const nowIso = now.toISOString();

    await db
      .prepare(
        `UPDATE execution_plans SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?`
      )
      .bind(nowIso, nowIso, planId)
      .run();

    await AuditService.emit(
      db,
      {
        eventType: 'EXECUTION_APPROVED',
        entityType: 'execution_plan',
        entityId: planId,
        actor: 'owner',
        payload: { planId, approvalHash: providedHash },
        metadata: { planId, approvalHash: providedHash },
      },
      env
    );

    return {
      ...plan,
      status: 'approved',
      approvedAt: nowIso,
      updatedAt: nowIso,
    };
  }

  /**
   * Rejects a plan.
   */
  static async rejectPlan(db: D1Database, planId: string, now: Date = new Date()): Promise<boolean> {
    const nowIso = now.toISOString();
    const res = await db
      .prepare(`UPDATE execution_plans SET status = 'rejected', updated_at = ? WHERE id = ?`)
      .bind(nowIso, planId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * Executes an approved execution plan.
   */
  static async executePlan(
    db: D1Database,
    planId: string,
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<PlanExecutionResult> {
    const plan = await this.getPlan(db, planId);
    if (!plan) {
      throw new Error(`Execution plan '${planId}' not found.`);
    }

    // Tier 2 actions must be approved
    if (plan.riskTier !== 'tier_1_safe' && plan.status !== 'approved') {
      throw new Error(
        `Execution blocked: Plan '${planId}' requires owner approval before execution (status: '${plan.status}').`
      );
    }

    const nowIso = now.toISOString();

    // Mark plan executing
    await db
      .prepare(`UPDATE execution_plans SET status = 'executing', updated_at = ? WHERE id = ?`)
      .bind(nowIso, planId)
      .run();

    await AuditService.emit(
      db,
      {
        eventType: 'EXECUTION_STARTED',
        entityType: 'execution_plan',
        entityId: planId,
        actor: 'system:runner',
        payload: { planId, totalSteps: plan.steps.length },
        metadata: { planId },
      },
      env
    );

    // Dispatch steps through execution router
    const results = await ExecutionRouter.dispatchPlan(db, plan, env);

    // Verify execution results
    const verifiedResult = await ExecutionVerifier.verifyOutcome(db, plan, results, env, now);

    return verifiedResult;
  }
}
