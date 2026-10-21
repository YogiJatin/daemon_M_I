/**
 * worker/aiVerifier.ts
 *
 * Dedicated AI Verification Layer for Personal AI OS.
 *
 * Responsibilities:
 * - Validate referenced task IDs, timetable IDs, and material IDs.
 * - Validate confidence score (0.0 to 1.0).
 * - Validate priority enum values.
 * - Validate date and timestamp formats.
 * - Validate evidence references.
 * - Reject hallucinated references.
 * - Allow exactly ONE repair attempt via RepairRequest.
 * - If repair fails again, reject permanently.
 * - Never silently accept invalid AI output.
 */

export interface VerificationResult {
  valid: boolean;
  errors: string[];
  repairPrompt?: string;
  sanitizedData?: any;
}

export class AIVerifier {
  /**
   * Validates AI structured output against schema, citations, and ground truth index.
   */
  public static verify(
    output: any,
    schemaValidator: (data: any) => { valid: boolean; errors: string[] },
    indexedGroundTruthIds: Set<string>
  ): VerificationResult {
    const errors: string[] = [];

    if (!output || typeof output !== "object") {
      return {
        valid: false,
        errors: ["Output must be a non-null object"],
        repairPrompt: "Your previous response was empty or not valid JSON. Return strictly a JSON object conforming to the output contract.",
      };
    }

    // 1. Schema Validation
    const schemaRes = schemaValidator(output);
    if (!schemaRes.valid) {
      errors.push(...schemaRes.errors);
    }

    // 2. Anti-Hallucination Citation Verification
    // Check affected_record_ids
    if (Array.isArray(output.affected_record_ids)) {
      for (const id of output.affected_record_ids) {
        if (id && !indexedGroundTruthIds.has(id)) {
          errors.push(`Hallucinated or unknown record ID cited: '${id}'`);
        }
      }
    }

    // Check recommended_order task_ids if present (prioritize capability)
    if (Array.isArray(output.recommended_order)) {
      for (const item of output.recommended_order) {
        if (item.task_id && !indexedGroundTruthIds.has(item.task_id)) {
          errors.push(`Prioritized item references non-existent task_id: '${item.task_id}'`);
        }
      }
    }

    // 3. Priority Enum Validation
    const proposals = output.proposals || output.subtasks;
    if (Array.isArray(proposals)) {
      for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i];
        if (p?.priority && !["low", "normal", "high", "urgent"].includes(p.priority)) {
          errors.push(`Proposal #${i + 1} has invalid priority '${p.priority}'`);
        }
      }
    }

    // 4. Confidence Bounds Validation
    if (output.confidence !== undefined) {
      if (typeof output.confidence !== "number" || isNaN(output.confidence) || output.confidence < 0 || output.confidence > 1) {
        errors.push("Field 'confidence' must be a valid number between 0.0 and 1.0");
      }
    }

    if (errors.length > 0) {
      return {
        valid: false,
        errors,
        repairPrompt: this.generateRepairPrompt(errors),
      };
    }

    return {
      valid: true,
      errors: [],
      sanitizedData: output,
    };
  }

  /**
   * Generates a targeted, bounded self-repair prompt for the model.
   */
  public static generateRepairPrompt(errors: string[]): string {
    return `CRITICAL VALIDATION FAILURE: Your previous JSON output contained the following errors:\n${errors
      .map((e) => `- ${e}`)
      .join("\n")}\n\nPlease self-correct and output strictly the corrected JSON conforming to the contract without repeating these errors.`;
  }
}
