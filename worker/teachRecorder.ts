/**
 * worker/teachRecorder.ts — Event Trace Recorder & Sanitizer
 *
 * Requirements:
 * - Records ordered user interactions during active Teach Mode
 * - Strict sanitization: strips passwords, credit card numbers, and secret tokens
 * - Emits TEACH_STEP_RECORDED audit event
 */

import { TeachStepRecord } from './teachMode';
import { AuditService } from './auditService';

export interface RecordStepInput {
  sessionId: string;
  actionType:
    | 'app_launch'
    | 'window_focus'
    | 'browser_navigate'
    | 'click'
    | 'keypress'
    | 'clipboard'
    | 'file_move'
    | 'terminal_cmd'
    | 'ocr_label';
  intentSummary: string;
  targetSelector?: string;
  rawInput?: string;
}

export class TeachRecorder {
  private static SECRET_PATTERNS = [
    /password/i,
    /passwd/i,
    /secret/i,
    /api[_-]?key/i,
    /bearer\s+[a-z0-9_\-\.]+/i,
    /token/i,
    /private[_-]?key/i,
    /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/, // Card patterns
  ];

  /**
   * Sanitizes input strings by masking detected passwords, tokens, and secrets.
   */
  static sanitizeInput(input?: string): string | null {
    if (!input) return null;
    let sanitized = input;

    for (const pattern of this.SECRET_PATTERNS) {
      if (pattern.test(sanitized)) {
        return '[REDACTED_SECRET]';
      }
    }

    return sanitized;
  }

  /**
   * Records a new interaction step in an active teach session.
   */
  static async recordStep(
    db: D1Database,
    input: RecordStepInput,
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<TeachStepRecord> {
    // 1. Verify session exists and is actively recording
    const session = await db
      .prepare(`SELECT status FROM teach_sessions WHERE id = ?`)
      .bind(input.sessionId)
      .first<any>();

    if (!session) {
      throw new Error(`Teach session '${input.sessionId}' not found.`);
    }
    if (session.status !== 'recording') {
      throw new Error(`Cannot record step on session '${input.sessionId}' with status '${session.status}'.`);
    }

    // 2. Determine next step index
    const countRow = await db
      .prepare(`SELECT COUNT(*) as count FROM teach_steps WHERE session_id = ?`)
      .bind(input.sessionId)
      .first<{ count: number }>();
    const nextIndex = countRow?.count ?? 0;

    const id = `tstep_${crypto.randomUUID()}`;
    const nowIso = now.toISOString();
    const sanitizedInput = this.sanitizeInput(input.rawInput);

    await db
      .prepare(
        `INSERT INTO teach_steps (id, session_id, step_index, action_type, intent_summary, target_selector, input_sanitized, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.sessionId,
        nextIndex,
        input.actionType,
        input.intentSummary.trim(),
        input.targetSelector?.trim() || null,
        sanitizedInput,
        nowIso
      )
      .run();

    // 3. Audit step
    await AuditService.emit(
      db,
      {
        eventType: 'TEACH_STEP_RECORDED',
        entityType: 'teach_step',
        entityId: id,
        actor: 'owner',
        payload: {
          sessionId: input.sessionId,
          stepIndex: nextIndex,
          actionType: input.actionType,
          intentSummary: input.intentSummary,
        },
        metadata: { sessionId: input.sessionId },
      },
      env
    );

    return {
      id,
      sessionId: input.sessionId,
      stepIndex: nextIndex,
      actionType: input.actionType,
      intentSummary: input.intentSummary.trim(),
      targetSelector: input.targetSelector?.trim() || null,
      inputSanitized: sanitizedInput,
      timestamp: nowIso,
    };
  }

  /**
   * Retrieves all recorded steps for a session in sequential order.
   */
  static async getSteps(db: D1Database, sessionId: string): Promise<TeachStepRecord[]> {
    const rows = await db
      .prepare(`SELECT * FROM teach_steps WHERE session_id = ? ORDER BY step_index ASC`)
      .bind(sessionId)
      .all<any>();

    return (rows.results || []).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      stepIndex: row.step_index,
      actionType: row.action_type,
      intentSummary: row.intent_summary,
      targetSelector: row.target_selector,
      inputSanitized: row.input_sanitized,
      timestamp: row.timestamp,
    }));
  }
}
