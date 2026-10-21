/**
 * worker/teachRecipeService.ts — Workflow Recipe Lifecycle & Memory Ingestion
 *
 * Requirements:
 * - Recipe management (draft, approved, rejected, archived)
 * - Approving a recipe creates an approved skill and links to a canonical MemoryObject
 * - Non-negotiable: Memory OS is the canonical store of truth
 * - Emits TEACH_RECIPE_APPROVED audit event
 */

import { CompiledRecipeStep } from './teachCompiler';
import { MemoryObjectService } from './memoryObjectService';
import { AuditService } from './auditService';

export interface WorkflowRecipeRecord {
  id: string;
  title: string;
  intent: string;
  triggerType: 'manual' | 'voice_command' | 'shortcut';
  status: 'draft' | 'approved' | 'rejected' | 'archived';
  confidence: number;
  steps: CompiledRecipeStep[];
  memoryObjectId: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class TeachRecipeService {
  /**
   * Retrieves a recipe by ID with parsed steps.
   */
  static async getRecipe(db: D1Database, recipeId: string): Promise<WorkflowRecipeRecord | null> {
    const row = await db
      .prepare(`SELECT * FROM workflow_recipes WHERE id = ?`)
      .bind(recipeId)
      .first<any>();

    if (!row) return null;

    let steps: CompiledRecipeStep[] = [];
    try {
      steps = JSON.parse(row.steps_json);
    } catch {}

    return {
      id: row.id,
      title: row.title,
      intent: row.intent,
      triggerType: row.trigger_type,
      status: row.status,
      confidence: row.confidence,
      steps,
      memoryObjectId: row.memory_object_id,
      approvedAt: row.approved_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * List recipes with optional status filter.
   */
  static async listRecipes(
    db: D1Database,
    status?: string,
    limit: number = 20
  ): Promise<WorkflowRecipeRecord[]> {
    let sql = `SELECT * FROM workflow_recipes`;
    const params: any[] = [];
    if (status) {
      sql += ` WHERE status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = await db.prepare(sql).bind(...params).all<any>();
    return (rows.results || []).map((row) => {
      let steps: CompiledRecipeStep[] = [];
      try {
        steps = JSON.parse(row.steps_json);
      } catch {}
      return {
        id: row.id,
        title: row.title,
        intent: row.intent,
        triggerType: row.trigger_type,
        status: row.status,
        confidence: row.confidence,
        steps,
        memoryObjectId: row.memory_object_id,
        approvedAt: row.approved_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  /**
   * Approves a draft recipe:
   * 1. Marks status = 'approved' and approved_at = now
   * 2. Canonicalizes recipe into Memory OS (MemoryObject with tags ['workflow', 'skill', 'approved'])
   * 3. Emits TEACH_RECIPE_APPROVED audit event
   */
  static async approveRecipe(
    db: D1Database,
    recipeId: string,
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<WorkflowRecipeRecord> {
    const recipe = await this.getRecipe(db, recipeId);
    if (!recipe) {
      throw new Error(`Workflow recipe '${recipeId}' not found.`);
    }
    if (recipe.status === 'approved') {
      return recipe;
    }

    const nowIso = now.toISOString();

    // 1. Index into canonical Memory OS
    const canonicalText = [
      `Workflow: ${recipe.title}`,
      `Intent: ${recipe.intent}`,
      `Trigger: ${recipe.triggerType}`,
      `Steps:`,
      ...recipe.steps.map((s) => `${s.order}. [${s.adapter}] ${s.description} (target: ${s.target})`),
    ].join('\n');

    const memoryRes = await MemoryObjectService.getOrCreateCanonicalObject(
      db,
      {
        type: 'note',
        title: `Workflow Recipe: ${recipe.title}`,
        canonicalText,
        summary: `Approved workflow recipe for ${recipe.intent} with ${recipe.steps.length} sequential steps.`,
        source: 'teach_mode',
        tags: ['workflow', 'skill', 'approved', recipe.triggerType],
        metadata: { recipeId, stepCount: recipe.steps.length },
      },
      env,
      now
    );

    const memoryObjectId = memoryRes.object.id;

    // 2. Update recipe record
    await db
      .prepare(
        `UPDATE workflow_recipes
         SET status = 'approved', approved_at = ?, memory_object_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(nowIso, memoryObjectId, nowIso, recipeId)
      .run();

    // 3. Emit audit event
    await AuditService.emit(
      db,
      {
        eventType: 'TEACH_RECIPE_APPROVED',
        entityType: 'workflow_recipe',
        entityId: recipeId,
        actor: 'owner',
        payload: {
          recipeId,
          title: recipe.title,
          memoryObjectId,
          stepCount: recipe.steps.length,
        },
        metadata: { recipeId, memoryObjectId },
      },
      env
    );

    return {
      ...recipe,
      status: 'approved',
      approvedAt: nowIso,
      memoryObjectId,
      updatedAt: nowIso,
    };
  }

  /**
   * Rejects a draft recipe.
   */
  static async rejectRecipe(
    db: D1Database,
    recipeId: string,
    reason?: string,
    now: Date = new Date()
  ): Promise<boolean> {
    const nowIso = now.toISOString();
    const res = await db
      .prepare(`UPDATE workflow_recipes SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'draft'`)
      .bind(nowIso, recipeId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }
}
