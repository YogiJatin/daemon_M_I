/**
 * worker/aiCapabilities.ts — Block 6.1 Grounded Analytical AI Capabilities
 *
 * Implements hardened architecture:
 * - Capabilities registered in AICapabilityRegistry.
 * - XML Context assembled via AIContextBuilder and TokenBudgetManager.
 * - Outputs validated via AIVerifier and typed Schemas.
 * - Human-in-the-loop proposals persisted into task_proposals table.
 * - Explainability metadata (reason, confidence, evidence, affected_record_ids) strictly enforced.
 */

import { AIAdapter, PrivacyClass, AIResponse } from "./aiAdapter";
import { getISTDateParts } from "./dateParser";
import { addDaysYmd } from "./recurrenceEngine";
import { createTaskProposal, TaskProposalInput } from "./inboxService";
import { AICapabilityRegistry, AICapabilityDefinition } from "./aiCapabilityRegistry";
import { AIContextBuilder } from "./aiContextBuilder";
import { AIVerifier } from "./aiVerifier";
import {
  TaskBreakdownOutput,
  validateTaskBreakdownOutput,
} from "./schemas/task_breakdown";
import {
  WeeklyPlanOutput,
  validateWeeklyPlanOutput,
} from "./schemas/weekly_plan";
import {
  PrioritizeOutput,
  validatePrioritizeOutput,
} from "./schemas/prioritize";
import {
  SuggestNextOutput,
  validateSuggestNextOutput,
} from "./schemas/suggest_next";

export interface TaskBreakdownInput {
  taskId?: string;
  title?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Register Capability 1: task_breakdown
// ---------------------------------------------------------------------------
AICapabilityRegistry.register<TaskBreakdownInput, TaskBreakdownOutput>({
  id: "task_breakdown",
  promptId: "p_task_breakdown",
  promptVersion: "1.1.0",
  checksum: "sha256_tb_v1_1",
  dependencies: ["tasks"],
  supportedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
  maxContextTokens: 2500,
  maxOutputTokens: 800,
  timeoutMs: 6000,
  systemRules: `You are the Personal AI OS Analytical Engine.
You break down tasks into concrete, actionable steps.
RULES:
1. Propose 2 to 4 sequential subtasks.
2. Return strictly a JSON object with:
   - "summary": string
   - "subtasks": array of objects with "title", "estimated_minutes", "suggested_deadline_offset_hours", "priority", "evidence"
   - "reason": string
   - "confidence": number (0.0 to 1.0)
   - "evidence": string
   - "affected_record_ids": array of string IDs cited
3. Do NOT invent dates or external dependencies outside the task context.`,
  outputContract: `JSON format:
{
  "summary": string,
  "subtasks": [
    { "title": string, "estimated_minutes": number, "suggested_deadline_offset_hours": number, "priority": "low"|"normal"|"high"|"urgent", "evidence": string }
  ],
  "reason": string,
  "confidence": number,
  "evidence": string,
  "affected_record_ids": string[]
}`,
  contextBuilder: async (db, input, builder, now) => {
    let taskTitle = input.title;
    let taskDescription = input.notes || "";
    if (input.taskId && db) {
      const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(input.taskId).first<any>();
      if (task) {
        taskTitle = task.title;
        taskDescription = task.description || "";
        builder.addEntity(task.id, "task", task, "mandatory");
      }
    }
    builder.setOwnerRequest(`Decompose project/task: "${taskTitle || ""}". Notes: "${taskDescription}"`);
  },
  validator: (data, indexedIds) => AIVerifier.verify(data, validateTaskBreakdownOutput, indexedIds),
  handler: async (db, validated, input, now) => {
    const proposals: any[] = [];
    const subtasks = Array.isArray(validated.subtasks)
      ? validated.subtasks
      : Array.isArray(validated.proposals)
      ? validated.proposals
      : [];
    const ist = getISTDateParts(now);
    const taskTitle = input.title || validated.summary || "Task";

    for (const st of subtasks) {
      const offsetDays = Math.max(1, Math.round((st.suggested_deadline_offset_hours || 24) / 24));
      const proposedDate = addDaysYmd(ist.localDate, offsetDays);

      const propInput: TaskProposalInput = {
        title: String(st.title || "").trim(),
        description: `Subtask of: ${taskTitle}`,
        category: "academic",
        priority: ["low", "normal", "high", "urgent"].includes(st.priority) ? st.priority : "normal",
        dateRole: "deadline",
        proposedLocalDate: proposedDate,
        proposedLocalTime: "18:00",
        evidenceQuote: String(st.evidence || `Derived from ${taskTitle}`),
        advisoryConfidence: typeof validated.confidence === "number" ? validated.confidence : 0.95,
      };

      const proposal = await createTaskProposal(db, propInput, now);
      proposals.push({
        id: proposal.id,
        title: propInput.title,
        estimated_minutes: st.estimated_minutes || 60,
        suggested_deadline_offset_hours: st.suggested_deadline_offset_hours || 24,
        priority: propInput.priority,
        evidence: propInput.evidenceQuote,
      });
    }

    return {
      summary: validated.summary || `Decomposed "${taskTitle}" into subtasks`,
      proposals,
      reason: validated.reason || "Project milestone decomposition",
      confidence: typeof validated.confidence === "number" ? validated.confidence : 0.95,
      evidence: validated.evidence || "Derived from input task scope",
      affected_record_ids: Array.isArray(validated.affected_record_ids) ? validated.affected_record_ids : [],
    };
  },
});

// ---------------------------------------------------------------------------
// Register Capability 2: weekly_plan
// ---------------------------------------------------------------------------
AICapabilityRegistry.register<void, WeeklyPlanOutput>({
  id: "weekly_plan",
  promptId: "p_weekly_plan",
  promptVersion: "1.1.0",
  checksum: "sha256_wp_v1_1",
  dependencies: ["tasks", "timetable", "materials"],
  supportedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
  maxContextTokens: 3000,
  maxOutputTokens: 1000,
  timeoutMs: 8000,
  systemRules: `You are the Personal AI OS Analytical Engine.
You synthesize academic schedules and deadlines into actionable executive planning.
RULES:
1. Highlight preparation requirements.
2. Identify deadline clusters.
3. Return strictly a JSON object with:
   - "summary": string
   - "focus_areas": array of strings
   - "bottlenecks": array of strings
   - "proposals": array of objects with "title", "suggested_deadline_offset_hours", "priority", "evidence"
   - "reason": string
   - "confidence": number (0.0 to 1.0)
   - "evidence": string
   - "affected_record_ids": array of string IDs cited`,
  outputContract: `JSON format with summary, focus_areas, bottlenecks, proposals, reason, confidence, evidence, affected_record_ids`,
  contextBuilder: async (db, _input, builder, now) => {
    const ist = getISTDateParts(now);
    const todayYmd = ist.localDate;
    const weekEndYmd = addDaysYmd(todayYmd, 6);

    if (db) {
      const tasksRes = await db
        .prepare(
          `SELECT id, title, priority, deadline_local_date, deadline_time_local
           FROM tasks
           WHERE status IN ('open', 'snoozed') AND deadline_local_date BETWEEN ? AND ?
           ORDER BY deadline_local_date ASC`
        )
        .bind(todayYmd, weekEndYmd)
        .all<any>();

      for (const t of tasksRes.results || []) {
        builder.addEntity(t.id, "task", t, "high");
      }

      const classesRes = await db
        .prepare(
          `SELECT o.id, o.occurrence_date, o.start_time, o.end_time, s.name as subject_name
           FROM class_occurrences o
           JOIN timetable_subjects s ON o.subject_id = s.id
           WHERE o.occurrence_date BETWEEN ? AND ? AND o.status = 'planned'
           ORDER BY o.occurrence_date ASC, o.start_time ASC`
        )
        .bind(todayYmd, weekEndYmd)
        .all<any>();

      for (const c of classesRes.results || []) {
        builder.addEntity(c.id, "class", c, "high");
      }
    }

    builder.setOwnerRequest(`Generate weekly executive plan for the next 7 days starting from IST date ${todayYmd}`);
  },
  validator: (data, indexedIds) => AIVerifier.verify(data, validateWeeklyPlanOutput, indexedIds),
  handler: async (db, validated, _input, now) => {
    const ist = getISTDateParts(now);
    const todayYmd = ist.localDate;
    const proposals: any[] = [];
    const rawProposals = Array.isArray(validated.proposals) ? validated.proposals : [];

    for (const p of rawProposals) {
      const propInput: TaskProposalInput = {
        title: String(p.title || "Weekly preparation step").trim(),
        description: "Generated by weekly plan synthesis",
        category: "academic",
        priority: ["low", "normal", "high", "urgent"].includes(p.priority) ? p.priority : "normal",
        dateRole: "deadline",
        proposedLocalDate: addDaysYmd(todayYmd, 1),
        proposedLocalTime: "18:00",
        evidenceQuote: String(p.evidence || "Timetable preparation bottleneck"),
        advisoryConfidence: typeof validated.confidence === "number" ? validated.confidence : 0.9,
      };

      const created = await createTaskProposal(db, propInput, now);
      proposals.push({
        id: created.id,
        title: propInput.title,
        suggested_deadline_offset_hours: p.suggested_deadline_offset_hours || 24,
        priority: propInput.priority,
        evidence: propInput.evidenceQuote,
      });
    }

    return {
      summary: validated.summary || "Weekly academic and personal overview",
      focus_areas: Array.isArray(validated.focus_areas) ? validated.focus_areas : [],
      bottlenecks: Array.isArray(validated.bottlenecks) ? validated.bottlenecks : [],
      proposals,
      reason: validated.reason || "Weekly schedule synthesis",
      confidence: typeof validated.confidence === "number" ? validated.confidence : 0.9,
      evidence: validated.evidence || "Grounded in upcoming timetable classes and tasks",
      affected_record_ids: Array.isArray(validated.affected_record_ids) ? validated.affected_record_ids : [],
    };
  },
});

// ---------------------------------------------------------------------------
// Register Capability 3: prioritize
// ---------------------------------------------------------------------------
AICapabilityRegistry.register<void, PrioritizeOutput>({
  id: "prioritize",
  promptId: "p_prioritize",
  promptVersion: "1.1.0",
  checksum: "sha256_pr_v1_1",
  dependencies: ["tasks"],
  supportedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
  maxContextTokens: 2500,
  maxOutputTokens: 600,
  timeoutMs: 6000,
  systemRules: `You are the Personal AI OS Analytical Engine.
Prioritize open tasks using deadline urgency, priority, and snooze count.
RULES:
1. Every item in "recommended_order" MUST cite an exact "task_id" present in the context.
2. Return strictly JSON with summary, recommended_order, reason, confidence, evidence, affected_record_ids.`,
  outputContract: `JSON format with summary, recommended_order: [{ task_id, rank, urgency_score, reasoning }], reason, confidence, evidence, affected_record_ids`,
  contextBuilder: async (db, _input, builder) => {
    if (db) {
      const tasksRes = await db
        .prepare(
          `SELECT id, title, priority, deadline_kind, deadline_local_date, deadline_time_local, snooze_count
           FROM tasks
           WHERE status IN ('open', 'snoozed')
           ORDER BY deadline_local_date ASC, priority DESC
           LIMIT 15`
        )
        .all<any>();

      for (const t of tasksRes.results || []) {
        builder.addEntity(t.id, "task", t, "mandatory");
      }
    }
    builder.setOwnerRequest("Rank open tasks based on deadlines and effort");
  },
  validator: (data, indexedIds) => AIVerifier.verify(data, validatePrioritizeOutput, indexedIds),
  handler: async (_db, validated) => {
    return {
      summary: validated.summary || "Prioritized open task schedule",
      recommended_order: Array.isArray(validated.recommended_order) ? validated.recommended_order : [],
      reason: validated.reason || "Urgency and deadline scoring",
      confidence: typeof validated.confidence === "number" ? validated.confidence : 0.95,
      evidence: validated.evidence || "Grounded in task deadlines and priority tags",
      affected_record_ids: Array.isArray(validated.affected_record_ids) ? validated.affected_record_ids : [],
    };
  },
});

// ---------------------------------------------------------------------------
// Register Capability 4: suggest_next
// ---------------------------------------------------------------------------
AICapabilityRegistry.register<{ query?: string }, SuggestNextOutput>({
  id: "suggest_next",
  promptId: "p_suggest_next",
  promptVersion: "1.1.0",
  checksum: "sha256_sn_v1_1",
  dependencies: ["tasks", "timetable"],
  supportedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
  maxContextTokens: 2000,
  maxOutputTokens: 400,
  timeoutMs: 5000,
  systemRules: `You are the Personal AI OS Analytical Engine.
Recommend the single highest-impact next action based on current time and commitments.
RULES:
1. Give preference to immediate classes or overdue items.
2. Return strictly JSON with:
   - "next_action": string (one concise imperative sentence)
   - "rationale": string
   - "confidence": number (0.0 to 1.0)
   - "related_task_id": optional string
   - "reason": string
   - "evidence": string
   - "affected_record_ids": array of strings`,
  outputContract: `JSON format with next_action, rationale, confidence, related_task_id, reason, evidence, affected_record_ids`,
  contextBuilder: async (db, input, builder, now) => {
    const ist = getISTDateParts(now);
    if (db) {
      const overdueRes = await db
        .prepare(`SELECT id, title, priority, deadline_local_date FROM tasks WHERE status = 'open' AND deadline_local_date < ? LIMIT 3`)
        .bind(ist.localDate)
        .all<any>();

      for (const t of overdueRes.results || []) {
        builder.addEntity(t.id, "task", t, "mandatory");
      }

      const dueTodayRes = await db
        .prepare(`SELECT id, title, priority, deadline_time_local FROM tasks WHERE status = 'open' AND deadline_local_date = ? LIMIT 3`)
        .bind(ist.localDate)
        .all<any>();

      for (const t of dueTodayRes.results || []) {
        builder.addEntity(t.id, "task", t, "high");
      }

      const nextClassRes = await db
        .prepare(
          `SELECT o.id, o.start_time, o.room, s.name as subject_name
           FROM class_occurrences o
           JOIN timetable_subjects s ON o.subject_id = s.id
           WHERE o.occurrence_date = ? AND o.start_time >= ? AND o.status = 'planned'
           ORDER BY o.start_time ASC LIMIT 1`
        )
        .bind(ist.localDate, ist.localTime)
        .first<any>();

      if (nextClassRes) {
        builder.addEntity(nextClassRes.id, "class", nextClassRes, "mandatory");
      }
    }

    builder.setOwnerRequest(input?.query || "What should I focus on next?");
  },
  validator: (data, indexedIds) => AIVerifier.verify(data, validateSuggestNextOutput, indexedIds),
  handler: async (_db, validated) => {
    return {
      next_action: validated.next_action || "Review pending tasks and upcoming schedule",
      rationale: validated.rationale || validated.reason || "Derived from current timetable and task status",
      confidence: typeof validated.confidence === "number" ? validated.confidence : 0.9,
      related_task_id: validated.related_task_id || undefined,
      reason: validated.reason || validated.rationale || "Immediate schedule optimization",
      evidence: validated.evidence || "Current IST time and upcoming commitments",
      affected_record_ids: Array.isArray(validated.affected_record_ids) ? validated.affected_record_ids : [],
    };
  },
});

// ---------------------------------------------------------------------------
// AICapabilities Facade (Preserves exact Block 6 method signatures)
// ---------------------------------------------------------------------------
export class AICapabilities {
  private adapter: AIAdapter;
  private db: D1Database;

  constructor(env: any, db: D1Database) {
    this.adapter = new AIAdapter(env, db);
    this.db = db;
  }

  public async taskBreakdown(
    input: TaskBreakdownInput,
    privacyClass: PrivacyClass = "personal",
    simulatedFailure?: any,
    now: Date = new Date()
  ): Promise<AIResponse<TaskBreakdownOutput>> {
    return this.adapter.executeCapability<TaskBreakdownInput, TaskBreakdownOutput>(
      "task_breakdown",
      input,
      privacyClass,
      simulatedFailure,
      now
    );
  }

  public async weeklyPlan(
    privacyClass: PrivacyClass = "personal",
    simulatedFailure?: any,
    now: Date = new Date()
  ): Promise<AIResponse<WeeklyPlanOutput>> {
    return this.adapter.executeCapability<void, WeeklyPlanOutput>(
      "weekly_plan",
      undefined as any,
      privacyClass,
      simulatedFailure,
      now
    );
  }

  public async prioritize(
    privacyClass: PrivacyClass = "personal",
    simulatedFailure?: any,
    now: Date = new Date()
  ): Promise<AIResponse<PrioritizeOutput>> {
    return this.adapter.executeCapability<void, PrioritizeOutput>(
      "prioritize",
      undefined as any,
      privacyClass,
      simulatedFailure,
      now
    );
  }

  public async suggestNext(
    ownerQuery?: string,
    privacyClass: PrivacyClass = "personal",
    simulatedFailure?: any,
    now: Date = new Date()
  ): Promise<AIResponse<SuggestNextOutput>> {
    return this.adapter.executeCapability<{ query?: string }, SuggestNextOutput>(
      "suggest_next",
      { query: ownerQuery },
      privacyClass,
      simulatedFailure,
      now
    );
  }
}
