/**
 * worker/inputInterpreter.ts — Intent Interpretation & Proposal Generation
 *
 * Implements OS Philosophy:
 * - Treats every external input as an Observation before proposing actions
 * - Classifies into categories: task, study_material, calendar_proposal, capture_note,
 *   bookmark, reference, question, document, ignore
 * - Extracts candidate title, priority, date phrase, proposed date/time in IST (Asia/Kolkata)
 * - Persists draft proposal to `task_proposals` table (status = 'pending')
 * - NEVER directly mutates live tasks or schedules
 */

import { parseDateShorthand } from './dateParser';
import { ProposalCategory, InterpretationResult } from './inputTypes';

export class InputInterpreter {
  /**
   * Deterministically interprets normalized text into an observation & proposal draft.
   */
  static interpret(
    text: string,
    sourceContext: { source: string; filename?: string; mimeType?: string } = { source: 'api' },
    now: Date = new Date()
  ): InterpretationResult {
    const raw = text.trim();
    if (!raw) {
      return {
        category: 'ignore',
        candidateTitle: 'Empty Input',
        priority: 'normal',
        evidenceQuote: '',
        advisoryConfidence: 1.0,
        actionSummary: 'Empty input ignored',
      };
    }

    const lower = raw.toLowerCase();

    // 1. Detection of URL / Bookmark
    if (/^https?:\/\/[^\s]+$/.test(raw) || (raw.includes('http') && raw.split(/\s+/).length <= 3)) {
      return {
        category: 'bookmark',
        candidateTitle: raw.length > 80 ? raw.slice(0, 77) + '...' : raw,
        description: raw,
        priority: 'normal',
        evidenceQuote: raw,
        advisoryConfidence: 0.95,
        actionSummary: 'Save web reference bookmark',
      };
    }

    // 2. Detection of Questions / Queries
    if (
      lower.startsWith('what ') ||
      lower.startsWith('how ') ||
      lower.startsWith('why ') ||
      lower.startsWith('when ') ||
      lower.startsWith('where ') ||
      lower.startsWith('who ') ||
      lower.endsWith('?')
    ) {
      return {
        category: 'question',
        candidateTitle: raw.length > 80 ? raw.slice(0, 77) + '...' : raw,
        description: raw,
        priority: 'normal',
        evidenceQuote: raw,
        advisoryConfidence: 0.9,
        actionSummary: 'Record question for later review',
      };
    }

    // 3. Detection of Study Materials / Syllabus / Lecture Notes
    if (
      lower.includes('syllabus') ||
      lower.includes('chapter') ||
      lower.includes('lecture notes') ||
      lower.includes('formula sheet') ||
      lower.includes('textbook') ||
      sourceContext.filename?.endsWith('.pdf') ||
      sourceContext.filename?.endsWith('.docx')
    ) {
      const firstLine = raw.split('\n')[0].replace(/^[#\s*]+/, '').trim();
      const title = firstLine || sourceContext.filename || 'Study Reference Document';

      return {
        category: 'study_material',
        candidateTitle: title.slice(0, 80),
        description: raw.slice(0, 500),
        priority: 'normal',
        evidenceQuote: firstLine.slice(0, 120),
        advisoryConfidence: 0.88,
        actionSummary: 'Index study material into Academy references',
      };
    }

    // 4. Detection of Calendar Events / Meetings / Class Schedules
    if (
      lower.includes('class schedule') ||
      lower.includes('exam on') ||
      lower.includes('meeting at') ||
      lower.includes('hall ') ||
      lower.includes('room ')
    ) {
      const parsedDate = this.detectDate(raw, now);
      return {
        category: 'calendar_proposal',
        candidateTitle: this.extractTitle(raw),
        description: raw,
        priority: 'high',
        proposedLocalDate: parsedDate.localDate,
        proposedLocalTime: parsedDate.localTime,
        dateRole: 'event_start',
        evidenceQuote: parsedDate.evidence || raw.slice(0, 100),
        advisoryConfidence: parsedDate.localDate ? 0.9 : 0.75,
        actionSummary: 'Propose calendar schedule entry',
      };
    }

    // 5. Detection of Actionable Tasks / Directives
    const isActionable =
      lower.includes('remind me') ||
      lower.includes('remember to') ||
      lower.includes('due') ||
      lower.includes('submit') ||
      lower.includes('finish') ||
      lower.includes('complete') ||
      lower.includes('assignment') ||
      lower.includes('lab report') ||
      lower.includes('pay ') ||
      lower.includes('book ');

    if (isActionable) {
      const parsedDate = this.detectDate(raw, now);
      const priority = lower.includes('urgent') || lower.includes('asap')
        ? 'urgent'
        : lower.includes('important')
        ? 'high'
        : 'normal';

      let cleanTitle = raw
        .replace(/^(remind me to|remember to|please)\s+/i, '')
        .trim();
      if (cleanTitle.length > 80) cleanTitle = cleanTitle.slice(0, 77) + '...';

      return {
        category: 'task',
        candidateTitle: cleanTitle || 'Untitled Directive',
        description: raw,
        priority,
        proposedLocalDate: parsedDate.localDate,
        proposedLocalTime: parsedDate.localTime,
        dateRole: 'deadline',
        evidenceQuote: parsedDate.evidence || raw.slice(0, 100),
        advisoryConfidence: parsedDate.localDate ? 0.95 : 0.85,
        actionSummary: 'Propose task directive to Memory',
      };
    }

    // 6. Default: General Knowledge Capture Note
    const firstLine = raw.split('\n')[0].trim();
    const candidateTitle = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;

    return {
      category: 'capture_note',
      candidateTitle: candidateTitle || 'Captured Note',
      description: raw,
      priority: 'normal',
      evidenceQuote: raw.slice(0, 120),
      advisoryConfidence: 0.8,
      actionSummary: 'Record observation as capture note',
    };
  }

  /**
   * Helper to detect date/time phrases using dateParser in Asia/Kolkata context.
   */
  private static detectDate(text: string, now: Date): { localDate: string | null; localTime: string | null; evidence: string | null } {
    // Look for common date keywords
    const regex = /\b(by|due|on|at|before)\s+([^,.\n]+)/i;
    const match = regex.exec(text);

    if (match) {
      const phrase = match[2].trim();
      const parsed = parseDateShorthand(phrase, now);
      if (parsed.success && parsed.deadline) {
        return {
          localDate: parsed.deadline.localDate || null,
          localTime: parsed.deadline.localTime || null,
          evidence: match[0],
        };
      }
    }

    // Direct check for "today", "tomorrow", "friday", etc.
    const words = text.toLowerCase().split(/\s+/);
    for (const w of words) {
      if (['today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(w)) {
        const parsed = parseDateShorthand(w, now);
        if (parsed.success && parsed.deadline) {
          return {
            localDate: parsed.deadline.localDate || null,
            localTime: parsed.deadline.localTime || null,
            evidence: w,
          };
        }
      }
    }

    return { localDate: null, localTime: null, evidence: null };
  }

  private static extractTitle(text: string): string {
    const firstLine = text.split('\n')[0].trim();
    return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
  }

  /**
   * Persists an interpretation result as a draft proposal in `task_proposals`.
   */
  static async persistProposal(
    db: D1Database,
    interpretation: InterpretationResult,
    sourceEventId?: string,
    now: Date = new Date()
  ): Promise<string> {
    const proposalId = `prop_${crypto.randomUUID()}`;
    const nowIso = now.toISOString();

    await db
      .prepare(
        `INSERT INTO task_proposals (
          id, source_event_id, title, description, category, priority,
          date_role, proposed_local_date, proposed_local_time, evidence_quote,
          ambiguity_reasons, advisory_confidence, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        proposalId,
        sourceEventId || null,
        interpretation.candidateTitle,
        interpretation.description || null,
        interpretation.category,
        interpretation.priority,
        interpretation.dateRole || 'deadline',
        interpretation.proposedLocalDate || null,
        interpretation.proposedLocalTime || null,
        interpretation.evidenceQuote || null,
        interpretation.ambiguityReasons || null,
        interpretation.advisoryConfidence,
        nowIso,
        nowIso
      )
      .run();

    return proposalId;
  }
}
