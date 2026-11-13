/**
 * worker/bulkOps.ts - owner-initiated bulk operations.
 *
 * Every operation is explicit, counted, audited, and idempotent: running it twice
 * reports 0 instead of failing. Nothing here is called by cron or by the model;
 * only a confirmed Telegram action reaches it.
 */

export type BulkKind = "complete_tasks" | "delete_tasks" | "delete_classes" | "delete_all";

export interface BulkResult {
  ok: boolean;
  kind: BulkKind;
  tasksTouched: number;
  proposalsTouched: number;
  classesTouched: number;
  message: string;
}

async function audit(
  db: D1Database,
  entityType: string,
  entityId: string,
  eventType: string,
  nowIso: string,
  details: Record<string, unknown>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
       VALUES (?, ?, ?, ?, 'owner:telegram', ?, ?)`
    )
    .bind(crypto.randomUUID(), entityType, entityId, eventType, JSON.stringify(details), nowIso)
    .run()
    .catch(() => {});
}

async function count(db: D1Database, sql: string, bind?: unknown): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...(bind === undefined ? [] : [bind]))
    .first<{ n: number }>()
    .catch(() => null);
  return Number(row?.n || 0);
}

export async function runBulk(db: D1Database, kind: BulkKind, nowIso: string): Promise<BulkResult> {
  let tasksTouched = 0;
  let proposalsTouched = 0;
  let classesTouched = 0;

  const wantsTasks = kind === "complete_tasks" || kind === "delete_tasks" || kind === "delete_all";
  const wantsDelete = kind === "delete_tasks" || kind === "delete_all";
  const wantsClasses = kind === "delete_classes" || kind === "delete_all";

  if (wantsTasks) {
    if (wantsDelete) {
      const open = await count(db, "SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'");
      const done = await count(db, "SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'");
      tasksTouched = open + done;
      if (tasksTouched > 0) {
        await db.prepare("DELETE FROM tasks").run();
      }
      const pendingProposals = await count(db, "SELECT COUNT(*) AS n FROM task_proposals WHERE status = 'pending'");
      proposalsTouched = pendingProposals;
      if (pendingProposals > 0) {
        await db
          .prepare("UPDATE task_proposals SET status = 'rejected', updated_at = ? WHERE status = 'pending'")
          .bind(nowIso)
          .run();
      }
    } else {
      tasksTouched = await count(db, "SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'");
      if (tasksTouched > 0) {
        await db
          .prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE status != 'done'")
          .bind(nowIso, nowIso)
          .run();
      }
    }
    await audit(db, "task", "bulk", kind, nowIso, {
      tasks: tasksTouched,
      proposals: proposalsTouched,
    });
  }

  if (wantsClasses) {
    classesTouched = await count(db, "SELECT COUNT(*) AS n FROM timetable_slots WHERE active = 1");
    if (classesTouched > 0) {
      await db
        .prepare("UPDATE timetable_slots SET active = 0, updated_at = ? WHERE active = 1")
        .bind(nowIso)
        .run();
    }
    await audit(db, "timetable_slot", "bulk", "delete_classes", nowIso, { classes: classesTouched });
  }

  let message: string;
  if (kind === "complete_tasks") {
    message = tasksTouched > 0 ? `Marked ${tasksTouched} task(s) done.` : "No open tasks to complete.";
  } else if (kind === "delete_tasks") {
    message =
      tasksTouched > 0 || proposalsTouched > 0
        ? `Deleted ${tasksTouched} task(s). ${proposalsTouched > 0 ? `Rejected ${proposalsTouched} pending proposal(s).` : ""}`.trim()
        : "No tasks to delete.";
  } else if (kind === "delete_classes") {
    message = classesTouched > 0 ? `Removed ${classesTouched} class slot(s) from the timetable.` : "No classes to remove.";
  } else {
    message = `Deleted ${tasksTouched} task(s), rejected ${proposalsTouched} proposal(s), removed ${classesTouched} class slot(s).`;
  }

  return { ok: true, kind, tasksTouched, proposalsTouched, classesTouched, message };
}

/**
 * Maps owner phrasing to a bulk kind. Returns null when the message is not a
 * bulk command, so normal conversation is untouched.
 */
export function matchBulkCommand(text: string): { kind: BulkKind; label: string } | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (!t) return null;

  const mentionsAll = /\b(all|everything|every)\b/.test(t);
  const taskWord = /\b(tasks?|dues?|to-?dos?)\b/.test(t);
  const classWord = /\b(classes|class(?:es)?\s*schedule|timetable|lectures)\b/.test(t);
  const deleteWord = /\b(delete|remove|clear|wipe|erase)\b/.test(t);
  const completeWord = /\b(complete|completed|done|finish(?:ed)?|mark)\b/.test(t);

  if (!mentionsAll) return null;

  if (deleteWord && classWord && !taskWord) return { kind: "delete_classes", label: "Remove every class from the timetable" };
  if (deleteWord && taskWord && classWord) return { kind: "delete_all", label: "Delete every task, proposal and class" };
  if (deleteWord && taskWord) return { kind: "delete_tasks", label: "Delete every task and reject pending proposals" };
  if (completeWord && taskWord && !deleteWord) return { kind: "complete_tasks", label: "Mark every task done" };
  if (deleteWord && (t === "delete all" || t === "remove all" || t === "clear all"))
    return { kind: "delete_all", label: "Delete every task, proposal and class" };

  return null;
}
