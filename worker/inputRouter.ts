/**
 * worker/inputRouter.ts — Master Ingress Router & Pipeline Orchestrator
 *
 * Implements the complete Ingress path:
 * Outside World -> Ingress Layer -> Normalization -> Extraction ->
 * Interpretation -> Proposal Draft -> Inbox -> Owner Approval -> Business Layer
 *
 * Emits Block 6.2 cryptographic audit events at every step.
 * ZERO direct mutation of business data.
 */

import { RawInput, InputSessionRecord, ExtractionResult, InterpretationResult } from './inputTypes';
import { AttachmentService } from './attachmentService';
import { VoiceIngress } from './voiceIngress';
import { OCRIngress } from './ocrIngress';
import { DocumentIngress } from './documentIngress';
import { InputInterpreter } from './inputInterpreter';
import { AuditService } from './auditService';

export class InputRouter {
  /**
   * Universal ingestion entry point.
   */
  static async routeInput(
    db: D1Database,
    input: RawInput,
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<{
    session: InputSessionRecord;
    extraction?: ExtractionResult;
    interpretation: InterpretationResult;
    proposalId?: string;
  }> {
    const sessionId = `inp_${crypto.randomUUID()}`;
    const nowIso = now.toISOString();

    // 1. Create input session in 'received' status
    await db
      .prepare(
        `INSERT INTO input_sessions (id, source, raw_type, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 'received', ?, ?, ?)`
      )
      .bind(
        sessionId,
        input.source,
        input.rawType,
        JSON.stringify(input.metadata || {}),
        nowIso,
        nowIso
      )
      .run();

    // Audit: INPUT_RECEIVED
    AuditService.emit(
      db,
      {
        eventType: 'INPUT_RECEIVED',
        entityType: 'input_session',
        entityId: sessionId,
        actor: `owner:${input.source}`,
        payload: { source: input.source, raw_type: input.rawType, filename: input.filename },
        metadata: { session_id: sessionId, source: input.source },
      },
      env
    );

    let extractedText = '';
    let extractionResult: ExtractionResult | undefined;
    let attachmentId: string | undefined;

    try {
      // 2. Normalization & Extraction Pipeline
      await this.updateSessionStatus(db, sessionId, 'extracting');

      if (input.rawType === 'text') {
        extractedText = typeof input.payload === 'string'
          ? input.payload.trim()
          : new TextDecoder('utf-8').decode(input.payload).trim();

        extractionResult = {
          text: extractedText,
          mimeType: 'text/plain',
          confidence: 1.0,
          provider: 'direct_input',
        };
      } else if (input.rawType === 'audio') {
        const voicePipeline = VoiceIngress.createDefault(env);
        extractionResult = await voicePipeline.processAudio(
          input.payload,
          input.mimeType || 'audio/ogg'
        );
        extractedText = extractionResult.text;

        // Content-address audio file
        const { attachment } = await AttachmentService.getOrCreateAttachment(
          db,
          input.filename || 'voice_recording.ogg',
          input.mimeType || 'audio/ogg',
          input.payload,
          { source: input.source },
          now
        );
        attachmentId = attachment.id;

        // Audit: VOICE_TRANSCRIBED
        AuditService.emit(
          db,
          {
            eventType: 'VOICE_TRANSCRIBED',
            entityType: 'attachment',
            entityId: attachment.id,
            actor: 'system:speech',
            payload: { provider: extractionResult.provider, duration_ms: extractionResult.durationMs },
            metadata: { session_id: sessionId },
          },
          env
        );
      } else if (input.rawType === 'image') {
        const ocrPipeline = OCRIngress.createDefault(env);
        extractionResult = await ocrPipeline.processImage(
          input.payload,
          input.mimeType || 'image/png'
        );
        extractedText = extractionResult.text;

        // Content-address image
        const { attachment } = await AttachmentService.getOrCreateAttachment(
          db,
          input.filename || 'screenshot.png',
          input.mimeType || 'image/png',
          input.payload,
          { source: input.source },
          now
        );
        attachmentId = attachment.id;

        // Audit: OCR_COMPLETED
        AuditService.emit(
          db,
          {
            eventType: 'OCR_COMPLETED',
            entityType: 'attachment',
            entityId: attachment.id,
            actor: 'system:ocr',
            payload: { provider: extractionResult.provider, confidence: extractionResult.confidence },
            metadata: { session_id: sessionId },
          },
          env
        );
      } else if (input.rawType === 'document') {
        const docPipeline = DocumentIngress.createDefault(env.TEST_MODE === 'true');
        const docRes = await docPipeline.processDocument(
          db,
          input.filename || 'document.txt',
          input.mimeType || 'text/plain',
          input.payload,
          {},
          now
        );
        extractionResult = docRes.extraction;
        extractedText = docRes.extraction.text;
        attachmentId = docRes.attachment.id;

        // Audit: DOCUMENT_PARSED
        AuditService.emit(
          db,
          {
            eventType: 'DOCUMENT_PARSED',
            entityType: 'attachment',
            entityId: docRes.attachment.id,
            actor: 'system:document',
            payload: {
              chunks: docRes.chunks.length,
              byte_size: docRes.attachment.byteSize,
              is_duplicate: docRes.isDuplicate,
            },
            metadata: { session_id: sessionId },
          },
          env
        );
      }

      // 3. Interpretation & Observation Categorization
      await this.updateSessionStatus(db, sessionId, 'interpreting', extractedText, attachmentId);

      const interpretation = InputInterpreter.interpret(
        extractedText,
        {
          source: input.source,
          filename: input.filename,
          mimeType: input.mimeType,
        },
        now
      );

      // Audit: INTERPRETATION_COMPLETED
      AuditService.emit(
        db,
        {
          eventType: 'INTERPRETATION_COMPLETED',
          entityType: 'input_session',
          entityId: sessionId,
          actor: 'system:interpreter',
          payload: { category: interpretation.category, confidence: interpretation.advisoryConfidence },
          metadata: { session_id: sessionId },
        },
        env
      );

      // 4. Draft Proposal Creation (if not ignored noise)
      let proposalId: string | undefined;

      if (interpretation.category !== 'ignore') {
        // source_event_id is for legacy source_events table references only.
        // Input sessions (inp_...) are tracked via input_sessions.id, not source_events.
        proposalId = await InputInterpreter.persistProposal(db, interpretation, undefined, now);

        // Audit: PROPOSAL_CREATED
        AuditService.emit(
          db,
          {
            eventType: 'PROPOSAL_CREATED',
            entityType: 'proposal',
            entityId: proposalId,
            actor: 'system:ingress',
            payload: {
              title: interpretation.candidateTitle,
              category: interpretation.category,
              priority: interpretation.priority,
              confidence: interpretation.advisoryConfidence,
            },
            metadata: { session_id: sessionId, proposal_id: proposalId },
          },
          env
        );
      }

      // 5. Update session to 'proposed'
      await db
        .prepare(
          `UPDATE input_sessions 
           SET status = 'proposed', extracted_text = ?, attachment_id = ?, proposal_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(extractedText, attachmentId || null, proposalId || null, now.toISOString(), sessionId)
        .run();

      const session = await this.getSession(db, sessionId);

      return {
        session: session!,
        extraction: extractionResult,
        interpretation,
        proposalId,
      };
    } catch (err: any) {
      // Mark session as failed with error details
      await db
        .prepare(
          `UPDATE input_sessions 
           SET status = 'failed', error_message = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(err.message || 'Unknown ingress error', now.toISOString(), sessionId)
        .run();

      const failedSession = await this.getSession(db, sessionId);
      throw Object.assign(err, { session: failedSession });
    }
  }

  /**
   * Approves a draft proposal and persists it to live business models (Tasks, Timetable, etc.)
   */
  static async approveProposal(
    db: D1Database,
    proposalId: string,
    edits: { title?: string; priority?: string; deadline?: string; category?: string } = {},
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<{ approved: boolean; taskId?: string; proposal: any }> {
    const proposal = await db
      .prepare('SELECT * FROM task_proposals WHERE id = ?')
      .bind(proposalId)
      .first<any>();

    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }

    if (proposal.status !== 'pending') {
      throw new Error(`Proposal cannot be approved in status '${proposal.status}'`);
    }

    const nowIso = now.toISOString();
    const finalTitle = edits.title !== undefined ? edits.title.trim() : proposal.title;
    const finalPriority = edits.priority || proposal.priority;
    const finalCategory = edits.category || proposal.category;
    const taskId = `tsk_${crypto.randomUUID()}`;

    // Insert live task into business tasks table (Human-in-the-loop approved write)
    await db.batch([
      db
        .prepare(
          `INSERT INTO tasks (
            id, title, description, category, priority, status,
            deadline_kind, deadline_local_date, deadline_time_local,
            deadline_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?)`
        )
        .bind(
          taskId,
          finalTitle,
          proposal.description || null,
          finalCategory,
          finalPriority,
          proposal.date_role === 'deadline' && proposal.proposed_local_date ? 'date_only' : 'none',
          proposal.proposed_local_date || null,
          proposal.proposed_local_time || null,
          nowIso,
          nowIso
        ),
      db
        .prepare(
          `UPDATE task_proposals 
           SET status = 'confirmed', task_id = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(taskId, nowIso, nowIso, proposalId),
    ]);

    // Audit: OWNER_APPROVED
    AuditService.emit(
      db,
      {
        eventType: 'OWNER_APPROVED',
        entityType: 'proposal',
        entityId: proposalId,
        actor: 'owner:web',
        payload: { task_id: taskId, title: finalTitle, priority: finalPriority },
        metadata: { proposal_id: proposalId, task_id: taskId },
      },
      env
    );

    const updated = await db
      .prepare('SELECT * FROM task_proposals WHERE id = ?')
      .bind(proposalId)
      .first<any>();

    return {
      approved: true,
      taskId,
      proposal: updated,
    };
  }

  /**
   * Rejects a draft proposal without creating any business entities.
   */
  static async rejectProposal(
    db: D1Database,
    proposalId: string,
    reason: string = 'Rejected by owner',
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<{ rejected: boolean; proposal: any }> {
    const proposal = await db
      .prepare('SELECT * FROM task_proposals WHERE id = ?')
      .bind(proposalId)
      .first<any>();

    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }

    const nowIso = now.toISOString();

    await db
      .prepare(
        `UPDATE task_proposals 
         SET status = 'rejected', ambiguity_reasons = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(reason, nowIso, nowIso, proposalId)
      .run();

    // Audit: OWNER_REJECTED
    AuditService.emit(
      db,
      {
        eventType: 'OWNER_REJECTED',
        entityType: 'proposal',
        entityId: proposalId,
        actor: 'owner:web',
        payload: { reason },
        metadata: { proposal_id: proposalId },
      },
      env
    );

    const updated = await db
      .prepare('SELECT * FROM task_proposals WHERE id = ?')
      .bind(proposalId)
      .first<any>();

    return {
      rejected: true,
      proposal: updated,
    };
  }

  static async getSession(db: D1Database, sessionId: string): Promise<InputSessionRecord | null> {
    const row = await db
      .prepare('SELECT * FROM input_sessions WHERE id = ?')
      .bind(sessionId)
      .first<any>();

    if (!row) return null;

    return {
      id: row.id,
      source: row.source,
      rawType: row.raw_type,
      status: row.status,
      extractedText: row.extracted_text,
      attachmentId: row.attachment_id,
      proposalId: row.proposal_id,
      errorMessage: row.error_message,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static async updateSessionStatus(
    db: D1Database,
    sessionId: string,
    status: string,
    extractedText?: string,
    attachmentId?: string
  ): Promise<void> {
    await db
      .prepare(
        `UPDATE input_sessions 
         SET status = ?, extracted_text = COALESCE(?, extracted_text), attachment_id = COALESCE(?, attachment_id), updated_at = ?
         WHERE id = ?`
      )
      .bind(status, extractedText || null, attachmentId || null, new Date().toISOString(), sessionId)
      .run();
  }
}
