/**
 * worker/aiCapabilities.ts — Block 6 Grounded Analytical AI Capabilities
 *
 * Requirements (Personal_AI_OS_SRS_v2.2.md §§7.8, 10.6, 16 TEST-6.4, TEST-6.9):
 * - Operating assistant capabilities grounded strictly in D1 operational state:
 *   1. task_breakdown: Decomposes tasks into structured subtask proposals
 *   2. weekly_plan: Synthesizes timetable, lab preparation materials, and deadlines
 *   3. prioritize: Ranks open tasks based on deadlines, effort, and timetable constraints
 *   4. suggest_next: Recommends the highest-impact immediate action
 * - Output proposal pattern: Candidate tasks are persisted into task_proposals table
 *   for owner review/confirmation (SRS §8.4). No unconfirmed mutations to tasks table.
 * - Prompt injection quarantine: Untrusted user strings are fenced in <user_data> blocks.
 */

import { AIAdapter, PrivacyClass, AIResponse } from "./aiAdapter";
import { getISTDateParts } from "./dateParser";
import { addDaysYmd } from "./recurrenceEngine";
import { createTaskProposal, TaskProposalInput } from "./inboxService";

export interface TaskBreakdownInput {
  taskId?: string;
  title?: string;
  notes?: string;
}

export interface TaskBreakdownOutput {
  summary: string;
  proposals: Array<{
    id?: string;
    title: string;
    estimated_minutes: number;
    suggested_deadline_offset_hours: number;
    priority: "low" | "normal" | "high" | "urgent";
    evidence: string;
  }>;
}

export interface WeeklyPlanOutput {
  summary: string;
  focus_areas: string[];
  bottlenecks: string[];
  proposals: Array<{
    id?: string;
    title: string;
    suggested_deadline_offset_hours: number;
    priority: "low" | "normal" | "high" | "urgent";
    evidence: string;
  }>;
}

export interface PrioritizeOutput {
  summary: string;
  recommended_order: Array<{
    task_id: string;
    rank: number;
    urgency_score: number;
    reasoning: string;
  }>;
}

export interface SuggestNextOutput {
  next_action: string;
  rationale: string;
  confidence: number;
  related_task_id?: string;
}

export class AICapabilities {
  private adapter: AIAdapter;
  private db: D1Database;

  constructor(env: any, db: D1Database) {
    this.adapter = new AIAdapter(env, db);
    this.db = db;
  }

  /**
   * Capability 1: task_breakdown
   * Breaks down a complex project or existing task into 2-4 concrete subtasks.
   */
  public async taskBreakdown(
    input: TaskBreakdownInput,
    privacyClass: PrivacyClass = "personal",
    simulatedFailure?: any,
    now: Date = new Date()
  ): Promise<AIResponse<TaskBreakdownOutput>> {
    let taskTitle = input.title;
    let taskDescription = input.notes || "";
    let baseDeadline = "";

    // If taskId is provided, fetch ground truth from tasks table
    if (input.taskId) {
      const task = await this.db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .bind(input.taskId)
        .first<any>();

      if (task) {
        taskTitle = task.title;
        taskDescription = task.description || "";
        baseDeadline = task.deadline_local_date ? `${task.deadline_local_date} ${task.deadline_time_local || ""}`.trim() : "";
      }
    }

    if (!taskTitle) {
      return {
        ok: false,
        provider: "none",
        model: "none",
        durationMs: 0,
        fallbackTriggered: false,
        error: { code: "schema_invalid", message: "Task title or valid taskId is required for breakdown" },
      };
    }

    const systemPrompt = `You are the Personal AI OS Analytical Engine.
You break down tasks into concrete, actionable steps.
RULES:
1. Propose 2 to 4 sequential subtasks.
2. Return strictly a JSON object with:
   - "summary": string
   - "subtasks": array of objects with:
     - "title": string (clear, actionable action starting with a verb)
     - "estimated_minutes": number
     - "suggested_deadline_offset_hours": number
     - "priority": "low" | "normal" | "high" | "urgent"
     - "evidence": string (reason for this step)
3. Do NOT invent dates or external dependencies outside the task context.`;

    const userPrompt = `Task Title: "${taskTitle}"
Description: "${taskDescription}"
Current Deadline: "${baseDeadline || "None"}"`;

    const aiRes = await this.adapter.execute<any>(
      {
        capability: "task_breakdown",
        systemPrompt,
        userPrompt,
        inputContext: { taskId: input.taskId, title: taskTitle },
        privacyClass,
        simulatedFailure,
      },
      now
    );

    if (!aiRes.ok || !aiRes.data) {
      return aiRes;
    }

    // Persist proposals to task_proposals table for owner confirmation (SRS §8.4)
    const proposals: any[] = [];
    const subtasks = Array.isArray(aiRes.data.subtasks) ? aiRes.data.subtasks : [];
    const ist = getISTDateParts(now);

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
        advisoryConfidence: 0.95,
      };

      const proposal = await createTaskProposal(this.db, propInput, now);
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
      ...aiRes,
      data: {
        summary: aiRes.data.summary || `Decomposed "${taskTitle}" into subtasks`,
        proposals,
      },
    };
  }

  /**
   * Capability 2: weekly_plan
   * Synthesizes timetable, preparation materials, and open deadlines for the upcoming 7 days.
   */
  public async weeklyPlan(
    privacyClass: PrivacyClass = "personal",
    simulatedFailure?: any,
    now: Date = new Date()
  ): Promise<AIResponse<WeeklyPlanOutput>> {
    const ist = getISTDateParts(now);
    const todayYmd = ist.localDate;
    const weekEndYmd = addDaysYmd(todayYmd, 6);

    // Fetch open tasks due in next 7 days
    const tasksRes = await this.db
      .prepare(
        `SELECT id, title, priority, deadline_local_date, deadline_time_local
         FROM tasks
         WHERE status IN ('open', 'snoozed')
           AND deadline_local_date BETWEEN ? AND ?
         ORDER BY deadline_local_date ASC`
      )
      .bind(todayYmd, weekEndYmd)
      .all<any>();

    // Fetch scheduled class occurrences and materials
    const classesRes = await this.db
      .prepare(
        `SELECT o.occurrence_date, o.start_time, o.end_time, s.name as subject_name,
                (SELECT COUNT(*) FROM timetable_materials m WHERE m.slot_id = o.slot_id AND m.active = 1) as mat_count
         FROM class_occurrences o
         JOIN timetable_subjects s ON o.subject_id = s.id
         WHERE o.occurrence_date BETWEEN ? AND ? AND o.status = 'planned'
         ORDER BY o.occurrence_date ASC, o.start_time ASC`
      )
      .bind(todayYmd, weekEndYmd)
      .all<any>();

    const tasksList = tasksRes.results || [];
    const classesList = classesRes.results || [];

    const systemPrompt = `You are the Personal AI OS Analytical Engine.
You synthesize academic schedules and deadlines into actionable executive planning.
RULES:
1. Highlight preparation requirements (e.g. labs with missing or required materials).
2. Identify deadline clusters (days with multiple tasks).
3. Return strictly a JSON object with:
   - "summary": string
   - "focus_areas": array of strings
   - "bottlenecks": array of strings
   - "proposals": array of objects with "title", "suggested_deadline_offset_hours", "priority", "evidence"`;

    const userPrompt = `Current IST Date: ${todayYmd}
Scheduled Classes: ${JSON.stringify(classesList)}
Upcoming Tasks: ${JSON.stringify(tasksList)}`;

    const aiRes = await this.adapter.execute<any>(
      {
        capability: "weekly_plan",
        systemPrompt,
        userPrompt,
        inputContext: { todayYmd, tasksCount: tasksList.length, classesCount: classesList.length },
        privacyClass,
        simulatedFailure,
      },
      now
    );

    if (!aiRes.ok || !aiRes.data) {
      return aiRes;
    }

    // Persist any generated plan proposals
    const proposals: any[] = [];
    const rawProposals = Array.isArray(aiRes.data.proposals) ? aiRes.data.proposals : [];
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
        advisoryConfidence: 0.9,
      };

      const created = await createTaskProposal(this.db, propInput, now);
      proposals.push({
        id: created.id,
        title: propInput.title,
        suggested_deadline_offset_hours: p.suggested_deadline_offset_hours || 24,
        priority: propInput.priority,
        evidence: propInput.evidenceQuote,
      });
    }

    return {
      ...aiRes,
      data: {
        summary: aiRes.data.summary || "Weekly academic and personal overview",
        focus_areas: Array.isArray(aiRes.data.focus_areas) ? aiRes.data.focus_areas : [],
        bottlenecks: Array.isArray(aiRes.data.bottlenecks) ? aiRes.data.bottlenecks : [],
        proposals,
      },
    };
  }

  /**
   * Capability 3: prioritize
   * Ranks open tasks based on deadlines, effort, and timetable schedule.
   */
  public async prioritize(
    privacyClass: PrivacyClass = "personal",
    simulatedFailure?: any,
    now: Date = new Date()
  ): Promise<AIResponse<PrioritizeOutput>> {
    const tasksRes = await this.db
      .prepare(
        `SELECT id, title, priority, deadline_kind, deadline_local_date, deadline_time_local, snooze_count
         FROM tasks
         WHERE status IN ('open', 'snoozed')
         ORDER BY deadline_local_date ASC, priority DESC
         LIMIT 15`
      )
      .all<any>();

    const tasks = tasksRes.results || [];
    if (tasks.length === 0) {
      return {
        ok: true,
        data: {
          summary: "No open tasks to prioritize",
          recommended_order: [],
        },
        provider: "none",
        model: "none",
        durationMs: 0,
        fallbackTriggered: false,
      };
    }

    const systemPrompt = `You are the Personal AI OS Analytical Engine.
Prioritize open tasks using deadline urgency, priority, and snooze count.
RULES:
1. Every item in "recommended_order" MUST use an exact "task_id" from the input.
2. Return strictly JSON with:
   - "summary": string
   - "recommended_order": array of { "task_id", "rank", "urgency_score", "reasoning" }`;

    const userPrompt = `Open Tasks:\n${JSON.stringify(tasks, null, 2)}`;

    const aiRes = await this.adapter.execute<any>(
      {
        capability: "prioritize",
        systemPrompt,
        userPrompt,
        inputContext: { tasks },
        privacyClass,
        simulatedFailure,
      },
      now
    );

    if (!aiRes.ok || !aiRes.data) {
      return aiRes;
    }

    // Anti-hallucination check: ensure cited task_ids exist in the queried list
    const validTaskIds = new Set(tasks.map((t) => t.id));
    const validatedOrder = (aiRes.data.recommended_order || [])
      .filter((item: any) => validTaskIds.has(item.task_id))
      .map((item: any, idx: number) => ({
        task_id: item.task_id,
        rank: idx + 1,
        urgency_score: typeof item.urgency_score === "number" ? item.urgency_score : 5.0,
        reasoning: String(item.reasoning || "Prioritized according to deadline"),
      }));

    return {
      ...aiRes,
      data: {
        summary: aiRes.data.summary || "Prioritized open task schedule",
        recommended_order: validatedOrder,
      },
    };
  }

  /**
   * Capability 4: suggest_next
   * Recommends the highest-impact immediate action based on current context.
   */
  public async suggestNext(
    ownerQuery?: string,
    privacyClass: PrivacyClass = "personal",
    simulatedFailure?: any,
    now: Date = new Date()
  ): Promise<AIResponse<SuggestNextOutput>> {
    const ist = getISTDateParts(now);

    // Overdue tasks
    const overdueRes = await this.db
      .prepare(
        `SELECT id, title, priority, deadline_local_date FROM tasks
         WHERE status = 'open' AND deadline_local_date < ?
         LIMIT 3`
      )
      .bind(ist.localDate)
      .all<any>();

    // Tasks due today
    const dueTodayRes = await this.db
      .prepare(
        `SELECT id, title, priority, deadline_time_local FROM tasks
         WHERE status = 'open' AND deadline_local_date = ?
         LIMIT 3`
      )
      .bind(ist.localDate)
      .all<any>();

    // Next class today
    const nextClassRes = await this.db
      .prepare(
        `SELECT o.start_time, o.room, s.name as subject_name
         FROM class_occurrences o
         JOIN timetable_subjects s ON o.subject_id = s.id
         WHERE o.occurrence_date = ? AND o.start_time >= ? AND o.status = 'planned'
         ORDER BY o.start_time ASC LIMIT 1`
      )
      .bind(ist.localDate, ist.localTime)
      .first<any>();

    const context = {
      currentTimeIST: `${ist.localDate} ${ist.localTime}`,
      overdueTasks: overdueRes.results || [],
      dueTodayTasks: dueTodayRes.results || [],
      nextClass: nextClassRes || null,
      userQuery: ownerQuery || "What should I focus on next?",
    };

    const systemPrompt = `You are the Personal AI OS Analytical Engine.
Recommend the single highest-impact next action based on current time and commitments.
RULES:
1. Give preference to immediate classes or overdue items.
2. Return strictly JSON with:
   - "next_action": string (one concise imperative sentence)
   - "rationale": string
   - "confidence": number (0.0 to 1.0)
   - "related_task_id": optional string`;

    const userPrompt = JSON.stringify(context, null, 2);

    const aiRes = await this.adapter.execute<any>(
      {
        capability: "suggest_next",
        systemPrompt,
        userPrompt,
        inputContext: context,
        privacyClass,
        simulatedFailure,
      },
      now
    );

    if (!aiRes.ok || !aiRes.data) {
      return aiRes;
    }

    return {
      ...aiRes,
      data: {
        next_action: aiRes.data.next_action || "Review pending tasks and upcoming schedule",
        rationale: aiRes.data.rationale || "Derived from current timetable and task status",
        confidence: typeof aiRes.data.confidence === "number" ? aiRes.data.confidence : 0.9,
        related_task_id: aiRes.data.related_task_id || undefined,
      },
    };
  }
}
