/**
 * worker/teachCompiler.ts — Trace to Structured Recipe Compiler
 *
 * Requirements:
 * - Compiles raw ordered event trace into a structured Workflow Recipe
 * - Extracts high-level intent, sequential typed steps, and confidence score
 * - Intent-based abstraction instead of brittle screen coordinates
 * - Emits TEACH_RECIPE_COMPILED audit event
 */

import { TeachRecorder } from './teachRecorder';
import { TeachStepRecord } from './teachMode';
import { AuditService } from './auditService';

export interface CompiledRecipeStep {
  stepId: string;
  order: number;
  action: string;
  adapter: 'desktop' | 'browser' | 'filesystem' | 'terminal' | 'clipboard' | 'window';
  target: string;
  description: string;
  parameters: Record<string, any>;
  isOptional?: boolean;
}

export interface CompiledRecipeResult {
  recipeId: string;
  sessionId: string;
  title: string;
  intent: string;
  triggerType: 'manual' | 'voice_command' | 'shortcut';
  status: 'draft';
  confidence: number;
  steps: CompiledRecipeStep[];
  createdAt: string;
}

export class TeachCompiler {
  /**
   * Compiles an active or finished recording session into a draft Workflow Recipe.
   */
  static async compileSession(
    db: D1Database,
    sessionId: string,
    options: {
      title?: string;
      intent?: string;
      triggerType?: 'manual' | 'voice_command' | 'shortcut';
    } = {},
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<CompiledRecipeResult> {
    const session = await db
      .prepare(`SELECT * FROM teach_sessions WHERE id = ?`)
      .bind(sessionId)
      .first<any>();

    if (!session) {
      throw new Error(`Teach session '${sessionId}' not found.`);
    }

    const steps = await TeachRecorder.getSteps(db, sessionId);
    if (steps.length === 0) {
      throw new Error(`Cannot compile empty teach session '${sessionId}'. Zero steps recorded.`);
    }

    const nowIso = now.toISOString();

    // 1. Mark session as compiling then completed
    await db
      .prepare(`UPDATE teach_sessions SET status = 'completed', ended_at = ? WHERE id = ?`)
      .bind(nowIso, sessionId)
      .run();

    // 2. Map trace steps into structured, intent-based recipe steps
    const compiledSteps: CompiledRecipeStep[] = steps.map((s, idx) => {
      const adapter = this.resolveAdapter(s.actionType);
      return {
        stepId: `rstep_${idx + 1}`,
        order: idx + 1,
        action: s.actionType,
        adapter,
        target: s.targetSelector || s.intentSummary,
        description: s.intentSummary,
        parameters: {
          input: s.inputSanitized,
          actionType: s.actionType,
        },
        isOptional: false,
      };
    });

    // 3. Compute compilation confidence based on structure completeness
    const confidence = this.computeConfidence(steps);
    const title = options.title?.trim() || session.title;
    const intent = options.intent?.trim() || `Workflow to ${session.title}`;
    const triggerType = options.triggerType || 'manual';

    const recipeId = `recipe_${crypto.randomUUID()}`;
    const stepsJson = JSON.stringify(compiledSteps);

    // 4. Insert into workflow_recipes as draft
    await db
      .prepare(
        `INSERT INTO workflow_recipes (id, title, intent, trigger_type, status, confidence, steps_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
      )
      .bind(recipeId, title, intent, triggerType, confidence, stepsJson, nowIso, nowIso)
      .run();

    // 5. Create version 1 record
    const versionId = `wver_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO workflow_versions (id, recipe_id, version_number, steps_json, diff_summary, created_at)
         VALUES (?, ?, 1, ?, 'Initial compilation from Teach Mode', ?)`
      )
      .bind(versionId, recipeId, stepsJson, nowIso)
      .run();

    // 6. Audit compilation
    await AuditService.emit(
      db,
      {
        eventType: 'TEACH_RECIPE_COMPILED',
        entityType: 'workflow_recipe',
        entityId: recipeId,
        actor: 'system:compiler',
        payload: {
          recipeId,
          sessionId,
          title,
          stepCount: compiledSteps.length,
          confidence,
        },
        metadata: { recipeId, sessionId },
      },
      env
    );

    return {
      recipeId,
      sessionId,
      title,
      intent,
      triggerType,
      status: 'draft',
      confidence,
      steps: compiledSteps,
      createdAt: nowIso,
    };
  }

  /**
   * Maps trace action type to the responsible typed adapter.
   */
  private static resolveAdapter(
    actionType: TeachStepRecord['actionType']
  ): 'desktop' | 'browser' | 'filesystem' | 'terminal' | 'clipboard' | 'window' {
    switch (actionType) {
      case 'browser_navigate':
      case 'ocr_label':
        return 'browser';
      case 'file_move':
        return 'filesystem';
      case 'terminal_cmd':
        return 'terminal';
      case 'clipboard':
        return 'clipboard';
      case 'window_focus':
        return 'window';
      case 'app_launch':
      case 'click':
      case 'keypress':
      default:
        return 'desktop';
    }
  }

  /**
   * Deterministic confidence score: evaluates action clarity, selector existence, and step count.
   */
  private static computeConfidence(steps: TeachStepRecord[]): number {
    let score = 0.7; // baseline
    if (steps.length >= 2) score += 0.1;
    const hasTargets = steps.filter((s) => Boolean(s.targetSelector)).length;
    score += (hasTargets / steps.length) * 0.15;
    return Math.min(Math.round(score * 100) / 100, 1.0);
  }
}
