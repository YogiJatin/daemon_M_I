/**
 * worker/inboxService.ts — Block 6 Task Proposals & Inbox Review Service
 *
 * Requirements (Personal_AI_OS_SRS_v2.2.md §§7.8, 8.4, 11.2, 16 TEST-6.8, TEST-6.9):
 * - Stores AI-generated candidate tasks in task_proposals table for owner review.
 * - Human-in-the-loop: proposals become tasks ONLY when confirmed by owner.
 * - Confirmed proposals create durable task in tasks table, plan notifications, and audit.
 * - Rejections record reason and update status without deleting audit history.
 * - Records opt-in evaluation feedback in ai_evaluations table.
 */

import { istToUtcDate } from "./dateParser";
import { planNotification } from "./notificationPlanner";

export interface TaskProposalInput {
  title: string;
  description?: string;
  category?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  dateRole?: "deadline" | "event_start" | "event_end" | "reminder_time" | "unknown";
  proposedLocalDate?: string; // YYYY-MM-DD
  proposedLocalTime?: string; // HH:mm
  evidenceQuote?: string;
  ambiguityReasons?: string;
  advisoryConfidence?: number;
  sourceEventId?: string;
}

export interface TaskProposalRecord {
  id: string;
  source_event_id: string | null;
  title: string;
  description: string | null;
  category: string;
  priority: string;
  date_role: string;
  proposed_local_date: string | null;
  proposed_local_time: string | null;
  evidence_quote: string | null;
  ambiguity_reasons: string | null;
  advisory_confidence: number;
  status: "pending" | "confirmed" | "rejected" | "failed";
  task_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Creates a pending task proposal.
 */
export async function createTaskProposal(
  db: D1Database,
  input: TaskProposalInput,
  now: Date = new Date()
): Promise<TaskProposalRecord> {
  const id = `prop_${crypto.randomUUID()}`;
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
      id,
      input.sourceEventId || null,
      input.title.trim(),
      input.description?.trim() || null,
      input.category?.trim() || "general",
      input.priority || "normal",
      input.dateRole || "deadline",
      input.proposedLocalDate || null,
      input.proposedLocalTime || null,
      input.evidenceQuote || null,
      input.ambiguityReasons || null,
      input.advisoryConfidence !== undefined ? input.advisoryConfidence : 1.0,
      nowIso,
      nowIso
    )
    .run();

  return {
    id,
    source_event_id: input.sourceEventId || null,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    category: input.category?.trim() || "general",
    priority: input.priority || "normal",
    date_role: input.dateRole || "deadline",
    proposed_local_date: input.proposedLocalDate || null,
    proposed_local_time: input.proposedLocalTime || null,
    evidence_quote: input.evidenceQuote || null,
    ambiguity_reasons: input.ambiguityReasons || null,
    advisory_confidence: input.advisoryConfidence !== undefined ? input.advisoryConfidence : 1.0,
    status: "pending",
    task_id: null,
    reviewed_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Lists proposals with optional status filter and bounded pagination.
 */
export async function listTaskProposals(
  db: D1Database,
  status: string = "pending",
  limit: number = 20,
  offset: number = 0
): Promise<{ proposals: TaskProposalRecord[]; total: number }> {
  const boundedLimit = Math.min(Math.max(1, limit), 100);

  const countRow = await db
    .prepare("SELECT count(*) as count FROM task_proposals WHERE status = ?")
    .bind(status)
    .first<{ count: number }>();

  const total = countRow?.count || 0;

  const res = await db
    .prepare(
      `SELECT * FROM task_proposals
       WHERE status = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(status, boundedLimit, offset)
    .all<TaskProposalRecord>();

  return { proposals: res.results || [], total };
}

/**
 * Confirms a proposal, creating a durable task and scheduling notifications.
 */
export async function confirmProposal(
  db: D1Database,
  proposalId: string,
  overrides?: Partial<TaskProposalInput>,
  now: Date = new Date()
): Promise<{ success: boolean; task?: any; proposal?: TaskProposalRecord; error?: string }> {
  const proposal = await db
    .prepare("SELECT * FROM task_proposals WHERE id = ?")
    .bind(proposalId)
    .first<TaskProposalRecord>();

  if (!proposal) {
    return { success: false, error: "Proposal not found" };
  }

  if (proposal.status !== "pending") {
    return { success: false, error: `Proposal already ${proposal.status}` };
  }

  const nowIso = now.toISOString();
  const taskId = crypto.randomUUID();

  // Merge overrides
  const finalTitle = (overrides?.title || proposal.title).trim();
  const finalDescription = (overrides?.description !== undefined ? overrides.description : proposal.description) || null;
  const finalCategory = (overrides?.category || proposal.category || "general").trim();
  const finalPriority = overrides?.priority || proposal.priority || "normal";
  const finalLocalDate = overrides?.proposedLocalDate !== undefined ? overrides.proposedLocalDate : proposal.proposed_local_date;
  const finalLocalTime = overrides?.proposedLocalTime !== undefined ? overrides.proposedLocalTime : proposal.proposed_local_time;

  let deadlineKind: "none" | "date_only" | "timed" = "none";
  let deadlineAtUtc: string | null = null;

  if (finalLocalDate) {
    if (finalLocalTime) {
      deadlineKind = "timed";
      deadlineAtUtc = istToUtcDate(finalLocalDate, finalLocalTime).toISOString();
    } else {
      deadlineKind = "date_only";
    }
  }

  // 1. Create durable task
  await db
    .prepare(
      `INSERT INTO tasks (
         id, title, description, category, priority, status,
         deadline_kind, deadline_local_date, deadline_time_local, deadline_at_utc,
         deadline_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      taskId,
      finalTitle,
      finalDescription,
      finalCategory,
      finalPriority,
      deadlineKind,
      finalLocalDate,
      finalLocalTime,
      deadlineAtUtc,
      nowIso,
      nowIso
    )
    .run();

  // 2. Plan notification if timed deadline
  if (deadlineKind === "timed" && deadlineAtUtc) {
    await planNotification({
      db,
      taskId,
      deadlineKind,
      deadlineAtUtc,
      deadlineVersion: 1,
      now,
    });
  }

  // 3. Update proposal row
  await db
    .prepare(
      `UPDATE task_proposals
       SET status = 'confirmed', task_id = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(taskId, nowIso, nowIso, proposalId)
    .run();

  // 4. Log AI evaluation feedback (SRS §7.8 FR-AI-010)
  const isEdited = overrides && Object.keys(overrides).length > 0;
  await db
    .prepare(
      `INSERT INTO ai_evaluations (id, capability, proposal_id, action, owner_edits_json, created_at)
       VALUES (?, 'proposal_review', ?, ?, ?, ?)`
    )
    .bind(
      `eval_${crypto.randomUUID()}`,
      proposalId,
      isEdited ? "edited" : "accepted",
      isEdited ? JSON.stringify(overrides) : null,
      nowIso
    )
    .run();

  // 5. Audit event
  await db
    .prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, 'proposal', ?, 'proposal_confirmed', 'owner:web', ?, ?)`
    )
    .bind(
      `aud_${crypto.randomUUID()}`,
      proposalId,
      JSON.stringify({ proposal_id: proposalId, task_id: taskId, edited: isEdited }),
      nowIso
    )
    .run();

  const createdTask = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
  const updatedProposal = await db.prepare("SELECT * FROM task_proposals WHERE id = ?").bind(proposalId).first<TaskProposalRecord>();

  return { success: true, task: createdTask, proposal: updatedProposal || undefined };
}

/**
 * Rejects a proposal.
 */
export async function rejectProposal(
  db: D1Database,
  proposalId: string,
  reason?: string,
  now: Date = new Date()
): Promise<{ success: boolean; proposal?: TaskProposalRecord; error?: string }> {
  const proposal = await db
    .prepare("SELECT * FROM task_proposals WHERE id = ?")
    .bind(proposalId)
    .first<TaskProposalRecord>();

  if (!proposal) {
    return { success: false, error: "Proposal not found" };
  }

  if (proposal.status !== "pending") {
    return { success: false, error: `Proposal already ${proposal.status}` };
  }

  const nowIso = now.toISOString();

  await db
    .prepare(
      `UPDATE task_proposals
       SET status = 'rejected', ambiguity_reasons = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(reason || "Rejected by owner", nowIso, nowIso, proposalId)
    .run();

  // Evaluation feedback
  await db
    .prepare(
      `INSERT INTO ai_evaluations (id, capability, proposal_id, action, feedback_notes, created_at)
       VALUES (?, 'proposal_review', ?, 'rejected', ?, ?)`
    )
    .bind(`eval_${crypto.randomUUID()}`, proposalId, reason || null, nowIso)
    .run();

  // Audit event
  await db
    .prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, 'proposal', ?, 'proposal_rejected', 'owner:web', ?, ?)`
    )
    .bind(`aud_${crypto.randomUUID()}`, proposalId, JSON.stringify({ reason }), nowIso)
    .run();

  const updated = await db.prepare("SELECT * FROM task_proposals WHERE id = ?").bind(proposalId).first<TaskProposalRecord>();
  return { success: true, proposal: updated || undefined };
}
