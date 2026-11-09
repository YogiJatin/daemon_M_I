/**
 * tests/unit_scheduler_suppression.ts - scheduler suppression and cap semantics.
 *
 * The scheduler used to suppress only done/dismissed, so archived tasks kept pending
 * notifications forever, and the daily cap applied to first-fire reminders as well as
 * re-nudges. These tests pin the rules from SRS §9.7:
 *   1. done / dismissed / archived tasks suppress their due notifications.
 *   2. Closing a task cancels its other still-pending notifications in the same tick.
 *   3. A first-fire reminder is never counted against the cap.
 *   4. A re-nudge for a task+stage that already fired is capped, and being capped
 *      records 'suppressed', not 'failed'.
 */

import assert from "node:assert";
import { runScheduler } from "../worker/scheduler";
import { createMockD1 } from "./mockD1";

let passed = 0;
let failed = 0;

async function it(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL: ${name}\n     ${err.message}`);
  }
}

const NOW = new Date("2026-11-08T10:00:00.000Z");
const DUE = new Date(NOW.getTime() - 60_000).toISOString();
const NOW_ISO = NOW.toISOString();

async function insertTask(db: any, id: string, status: string) {
  await db
    .prepare(
      `INSERT INTO tasks (id, title, status, priority, deadline_kind, deadline_version, created_at, updated_at)
       VALUES (?, ?, ?, 'normal', 'timed', 1, ?, ?)`
    )
    .bind(id, `Task ${id}`, status, NOW_ISO, NOW_ISO)
    .run();
}

async function insertNotification(
  db: any,
  opts: { id: string; taskId: string; status?: string; stage?: string; kind?: string; scheduledAt?: string }
) {
  await db
    .prepare(
      `INSERT INTO notification_log
         (id, task_id, deadline_version, stage, dedup_key, notification_kind, scheduled_at, status, retry_count, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(
      opts.id,
      opts.taskId,
      opts.stage || "due",
      `${opts.taskId}:${opts.stage || "due"}:${opts.id}`,
      opts.kind || "individual",
      opts.scheduledAt || DUE,
      opts.status || "pending",
      NOW_ISO,
      NOW_ISO
    )
    .run();
}

async function statusOf(db: any, id: string) {
  return db.prepare("SELECT status, error_code FROM notification_log WHERE id = ?").bind(id).first<any>();
}

async function runSuppressionTests() {
  console.log("\n=== Scheduler suppression ===\n");

  await it("an archived task suppresses its due notification", async () => {
    const db = createMockD1();
    await insertTask(db, "task_archived", "archived");
    await insertNotification(db, { id: "n_archived", taskId: "task_archived" });

    await runScheduler(db, NOW, 5, { botToken: "", ownerChatId: "", dailyCap: 3 });

    const row = await statusOf(db, "n_archived");
    assert.strictEqual(row.status, "suppressed");
    assert.strictEqual(row.error_code, "task_archived");
  });

  await it("a done task still suppresses with the completed reason", async () => {
    const db = createMockD1();
    await insertTask(db, "task_done", "done");
    await insertNotification(db, { id: "n_done", taskId: "task_done" });

    await runScheduler(db, NOW, 5, { botToken: "", ownerChatId: "", dailyCap: 3 });

    const row = await statusOf(db, "n_done");
    assert.strictEqual(row.status, "suppressed");
    assert.strictEqual(row.error_code, "task_completed_or_dismissed");
  });

  await it("closing a task cancels its other pending notifications in the same tick", async () => {
    const db = createMockD1();
    await insertTask(db, "task_later", "done");
    // Scheduled in the future, so the claim step never sees it.
    await insertNotification(db, {
      id: "n_future",
      taskId: "task_later",
      scheduledAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    });

    await runScheduler(db, NOW, 5, { botToken: "", ownerChatId: "", dailyCap: 3 });

    const row = await statusOf(db, "n_future");
    assert.strictEqual(row.status, "suppressed");
    assert.strictEqual(row.error_code, "task_closed");
  });

  await it("a first-fire reminder is never counted against the daily cap", async () => {
    const db = createMockD1();
    await insertTask(db, "task_first", "open");
    await insertNotification(db, { id: "n_first", taskId: "task_first" });
    // Budget is already fully spent today.
    await db
      .prepare(
        `INSERT INTO daily_notification_counters (local_date, channel, sent_count, reserved_count, updated_at)
         VALUES ('2026-11-08', 'telegram', 9, 0, ?)`
      )
      .bind(NOW_ISO)
      .run();

    await runScheduler(db, NOW, 5, { botToken: "", ownerChatId: "", dailyCap: 1 });

    const row = await statusOf(db, "n_first");
    assert.notStrictEqual(row.error_code, "renudge_cap_exhausted");
    assert.notStrictEqual(row.status, "suppressed");
  });

  await it("a re-nudge is capped and recorded as suppressed, not failed", async () => {
    const db = createMockD1();
    await insertTask(db, "task_renudge", "open");
    // The first fire already went out for this task+stage. Its scheduled_at differs, as
    // a real re-nudge is a separate planned slot (unique per task+stage+instant).
    await insertNotification(db, {
      id: "n_first_fire",
      taskId: "task_renudge",
      status: "sent",
      scheduledAt: new Date(NOW.getTime() - 120_000).toISOString(),
    });
    await insertNotification(db, { id: "n_renudge", taskId: "task_renudge" });
    await db
      .prepare(
        `INSERT INTO daily_notification_counters (local_date, channel, sent_count, reserved_count, updated_at)
         VALUES ('2026-11-08', 'telegram', 9, 0, ?)`
      )
      .bind(NOW_ISO)
      .run();

    await runScheduler(db, NOW, 5, { botToken: "", ownerChatId: "", dailyCap: 1 });

    const row = await statusOf(db, "n_renudge");
    assert.strictEqual(row.status, "suppressed");
    assert.strictEqual(row.error_code, "renudge_cap_exhausted");
  });

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runSuppressionTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
