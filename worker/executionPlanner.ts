/**
 * worker/executionPlanner.ts — Deterministic Execution Plan Builder
 *
 * Requirements:
 * - Compiles intent or approved recipes into deterministic execution steps
 * - Evaluates Risk Tier (Tier 1 safe, Tier 2 moderate, Tier 3 restricted)
 * - Cryptographically binds approval to SHA-256 hash of canonicalized step payload
 * - Rejects Tier 3 restricted actions at planning time (Rule 27: Tier 3 has no adapter)
 * - Emits EXECUTION_PLAN_CREATED audit event
 */

import {
  ExecutionPlanRecord,
  ExecutionStepDefinition,
  RiskTier,
} from './executionTypes';
import { canonicalizeJson } from './auditSerializer';
import { sha256Hex } from './auditHasher';
import { AuditService } from './auditService';

export class ExecutionPlanner {
  private static TIER_3_ACTIONS = [
    'elevated_exec',
    'sudo',
    'powershell_eval',
    'bash_eval',
    'registry_write',
    'payment_submit',
    'delete_system_file',
    'auto_send_email',
    'auto_send_whatsapp',
  ];

  /**
   * Evaluates maximum risk tier across all steps.
   */
  static evaluateRiskTier(steps: ExecutionStepDefinition[]): RiskTier {
    for (const step of steps) {
      if (this.TIER_3_ACTIONS.includes(step.action.toLowerCase())) {
        return 'tier_3_restricted';
      }
    }

    const hasTier2 = steps.some((step) => {
      if (step.adapter === 'terminal' || step.adapter === 'filesystem') return true;
      if (step.adapter === 'desktop' && step.action === 'launch_app') return true;
      if (step.adapter === 'browser' && step.action === 'fill_form') return true;
      return false;
    });

    return hasTier2 ? 'tier_2_moderate' : 'tier_1_safe';
  }

  /**
   * Builds an execution plan.
   */
  static async createPlan(
    db: D1Database,
    input: {
      intent: string;
      steps: ExecutionStepDefinition[];
    },
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<ExecutionPlanRecord> {
    const riskTier = this.evaluateRiskTier(input.steps);
    if (riskTier === 'tier_3_restricted') {
      throw new Error(
        'Execution plan blocked: contains restricted Tier 3 actions (elevated commands, raw eval, or payment).'
      );
    }

    const id = `exec_${crypto.randomUUID()}`;
    const nowIso = now.toISOString();

    // Canonical approval hash of the ordered step payload
    const canonicalPayload = canonicalizeJson(input.steps);
    const approvalHash = await sha256Hex(canonicalPayload);

    // Initial status: Tier 1 safe starts draft, Tier 2 moderate starts pending_approval
    const status = riskTier === 'tier_2_moderate' ? 'pending_approval' : 'draft';

    // 1. Insert execution_plans row
    await db
      .prepare(
        `INSERT INTO execution_plans (id, intent, risk_tier, status, approval_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, input.intent.trim(), riskTier, status, approvalHash, nowIso, nowIso)
      .run();

    // 2. Insert execution_steps rows
    const stepStatements = input.steps.map((step) =>
      db
        .prepare(
          `INSERT INTO execution_steps (id, plan_id, step_index, adapter, action, params_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
        )
        .bind(
          `estep_${crypto.randomUUID()}`,
          id,
          step.stepIndex,
          step.adapter,
          step.action,
          JSON.stringify(step.parameters || {}),
          nowIso
        )
    );

    if (stepStatements.length > 0) {
      await db.batch(stepStatements);
    }

    // 3. Emit audit event
    await AuditService.emit(
      db,
      {
        eventType: 'EXECUTION_PLAN_CREATED',
        entityType: 'execution_plan',
        entityId: id,
        actor: 'system:planner',
        payload: {
          id,
          intent: input.intent,
          riskTier,
          status,
          approvalHash,
          stepCount: input.steps.length,
        },
        metadata: { id, approvalHash },
      },
      env
    );

    return {
      id,
      intent: input.intent.trim(),
      riskTier,
      status,
      approvalHash,
      approvedAt: null,
      resultSummary: null,
      steps: input.steps,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }
}
