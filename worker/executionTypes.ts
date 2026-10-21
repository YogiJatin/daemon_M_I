/**
 * worker/executionTypes.ts — Execution Layer Types & Risk Tiers
 *
 * Requirements:
 * - Three risk tiers:
 *   Tier 1: Safe / read-only (media keys, status checks)
 *   Tier 2: Moderate side-effects (app launch, draft creation, file copy) — requires hash-bound approval
 *   Tier 3: Restricted / blocked (elevated actions, shell execution, registry, payments) — no adapter
 * - Adapter classifications:
 *   desktop, browser, filesystem, terminal, clipboard, window
 */

export type RiskTier = 'tier_1_safe' | 'tier_2_moderate' | 'tier_3_restricted';

export type ExecutionPlanStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'rolled_back';

export type ExecutionAdapterType =
  | 'desktop'
  | 'browser'
  | 'filesystem'
  | 'terminal'
  | 'clipboard'
  | 'window';

export interface ExecutionStepDefinition {
  stepIndex: number;
  adapter: ExecutionAdapterType;
  action: string;
  parameters: Record<string, any>;
  description: string;
  rollbackAction?: string;
  rollbackParams?: Record<string, any>;
}

export interface ExecutionPlanRecord {
  id: string;
  intent: string;
  riskTier: RiskTier;
  status: ExecutionPlanStatus;
  approvalHash: string | null;
  approvedAt: string | null;
  resultSummary: string | null;
  steps: ExecutionStepDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface StepExecutionResult {
  stepIndex: number;
  success: boolean;
  output?: any;
  error?: string;
  durationMs: number;
  rollbackAvailable: boolean;
}

export interface PlanExecutionResult {
  planId: string;
  status: 'completed' | 'failed' | 'rolled_back';
  totalSteps: number;
  executedSteps: number;
  results: StepExecutionResult[];
  error?: string;
  verified: boolean;
}
