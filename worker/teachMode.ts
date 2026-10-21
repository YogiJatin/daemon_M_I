/**
 * worker/teachMode.ts — Teach Mode Controller & Core Lifecycle
 *
 * Requirements:
 * - Explicit arming / start by the owner (no hidden surveillance)
 * - Session tracking: recording, compiling, completed, cancelled
 * - Invariant: Teach Mode learns; does not execute actions directly
 */

import { AuditService } from './auditService';

export interface TeachSessionRecord {
  id: string;
  status: 'recording' | 'compiling' | 'completed' | 'cancelled';
  title: string;
  appContext: string | null;
  startedAt: string;
  endedAt: string | null;
  metadata: Record<string, any>;
}

export interface TeachStepRecord {
  id: string;
  sessionId: string;
  stepIndex: number;
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
  targetSelector: string | null;
  inputSanitized: string | null;
  timestamp: string;
}

export class TeachModeController {
  /**
   * Start a new explicit teach session.
   */
  static async startSession(
    db: D1Database,
    input: {
      title: string;
      appContext?: string;
      metadata?: Record<string, any>;
    },
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<TeachSessionRecord> {
    const id = `teach_${crypto.randomUUID()}`;
    const nowIso = now.toISOString();

    await db
      .prepare(
        `INSERT INTO teach_sessions (id, status, title, app_context, started_at, metadata_json)
         VALUES (?, 'recording', ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.title.trim(),
        input.appContext?.trim() || null,
        nowIso,
        input.metadata ? JSON.stringify(input.metadata) : null
      )
      .run();

    await AuditService.emit(
      db,
      {
        eventType: 'TEACH_MODE_STARTED',
        entityType: 'teach_session',
        entityId: id,
        actor: 'owner',
        payload: { id, title: input.title, appContext: input.appContext },
        metadata: { title: input.title },
      },
      env
    );

    return {
      id,
      status: 'recording',
      title: input.title.trim(),
      appContext: input.appContext?.trim() || null,
      startedAt: nowIso,
      endedAt: null,
      metadata: input.metadata || {},
    };
  }

  /**
   * Cancel or stop an active session without compiling.
   */
  static async cancelSession(
    db: D1Database,
    sessionId: string,
    now: Date = new Date()
  ): Promise<boolean> {
    const nowIso = now.toISOString();
    const res = await db
      .prepare(`UPDATE teach_sessions SET status = 'cancelled', ended_at = ? WHERE id = ? AND status = 'recording'`)
      .bind(nowIso, sessionId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * Get session by ID.
   */
  static async getSession(db: D1Database, sessionId: string): Promise<TeachSessionRecord | null> {
    const row = await db
      .prepare(`SELECT * FROM teach_sessions WHERE id = ?`)
      .bind(sessionId)
      .first<any>();
    if (!row) return null;

    let metadata: Record<string, any> = {};
    try {
      if (row.metadata_json) metadata = JSON.parse(row.metadata_json);
    } catch {}

    return {
      id: row.id,
      status: row.status,
      title: row.title,
      appContext: row.app_context,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      metadata,
    };
  }

  /**
   * List sessions with optional status filter.
   */
  static async listSessions(
    db: D1Database,
    status?: string,
    limit: number = 20
  ): Promise<TeachSessionRecord[]> {
    let sql = `SELECT * FROM teach_sessions`;
    const params: any[] = [];
    if (status) {
      sql += ` WHERE status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY started_at DESC LIMIT ?`;
    params.push(limit);

    const rows = await db.prepare(sql).bind(...params).all<any>();
    return (rows.results || []).map((row) => {
      let metadata = {};
      try {
        if (row.metadata_json) metadata = JSON.parse(row.metadata_json);
      } catch {}
      return {
        id: row.id,
        status: row.status,
        title: row.title,
        appContext: row.app_context,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        metadata,
      };
    });
  }
}
