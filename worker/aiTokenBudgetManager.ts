/**
 * worker/aiTokenBudgetManager.ts
 *
 * Dedicated Token Budget Manager for Personal AI OS.
 *
 * Responsibilities:
 * - Estimate tokens (calibrated 4 chars/token heuristic).
 * - Enforce context ceilings before dispatch.
 * - Prune oldest / low-priority context entities.
 * - Strictly preserve:
 *   1. Today's tasks
 *   2. Overdue tasks
 *   3. Next timetable event / ongoing class
 *   4. Explicitly cited evidence entities
 * - Expose token statistics.
 */

export interface ContextEntity {
  id: string;
  type: "task" | "class" | "material" | "history" | "attachment" | "knowledge" | "memory" | "other";
  priority: "mandatory" | "high" | "normal" | "low";
  payload: any;
  xmlRepresentation?: string;
}

export interface BudgetEnforcementResult {
  entities: ContextEntity[];
  estimatedTokens: number;
  trimmedCount: number;
  budgetCeiling: number;
  exceeded: boolean;
}

export class TokenBudgetManager {
  /**
   * Calibrated heuristic: 1 token ~ 3.8 to 4 characters for English / JSON / XML.
   */
  public static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Enforces token budget on a list of context entities.
   * Preserves mandatory ground-truth entities and prunes lower priority ones.
   */
  public static enforceBudget(
    entities: ContextEntity[],
    maxTokens: number = 2500
  ): BudgetEnforcementResult {
    // 1. Separate mandatory from trim-eligible
    const mandatory: ContextEntity[] = [];
    const high: ContextEntity[] = [];
    const normal: ContextEntity[] = [];
    const low: ContextEntity[] = [];

    for (const ent of entities) {
      if (ent.priority === "mandatory") {
        mandatory.push(ent);
      } else if (ent.priority === "high") {
        high.push(ent);
      } else if (ent.priority === "normal") {
        normal.push(ent);
      } else {
        low.push(ent);
      }
    }

    // Always include mandatory entities
    const kept: ContextEntity[] = [...mandatory];
    let currentTokens = kept.reduce(
      (sum, e) => sum + this.estimateTokens(e.xmlRepresentation || JSON.stringify(e.payload)),
      0
    );

    let trimmedCount = 0;

    // Greedily admit high, normal, low until budget reached
    const candidatePool = [...high, ...normal, ...low];
    for (const cand of candidatePool) {
      const candTokens = this.estimateTokens(cand.xmlRepresentation || JSON.stringify(cand.payload));
      if (currentTokens + candTokens <= maxTokens) {
        kept.push(cand);
        currentTokens += candTokens;
      } else {
        trimmedCount++;
      }
    }

    return {
      entities: kept,
      estimatedTokens: currentTokens,
      trimmedCount,
      budgetCeiling: maxTokens,
      exceeded: currentTokens > maxTokens,
    };
  }
}
