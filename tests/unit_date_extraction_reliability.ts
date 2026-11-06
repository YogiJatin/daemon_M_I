/**
 * tests/unit_date_extraction_reliability.ts — Automated verification of date/time parsing,
 * natural language title extraction, reminder guarantee, and scheduler heartbeat.
 */

import {
  parseDateShorthand,
  extractTimeAndTitle,
  getISTDateParts,
  istToUtcDate,
} from "../worker/dateParser";
import { handleAdd } from "../worker/commands";
import { planNotification } from "../worker/notificationPlanner";
import { runScheduler } from "../worker/scheduler";
import { createMockD1 } from "./mockD1";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

async function runTests() {
  console.log("\n=== RUNNING RELIABILITY & DATE EXTRACTION SUITE ===\n");

  const fixedNow = new Date("2026-11-06T07:54:17.000Z"); // 13:24:17 IST
  const ist = getISTDateParts(fixedNow);

  // ---------------------------------------------------------------------------
  // 1. Natural Language Date/Time & Relative Duration Parsing
  // ---------------------------------------------------------------------------
  console.log("--- 1. Natural Language Date/Time & Relative Durations ---");

  // A. today HH:MM
  const t1 = parseDateShorthand("today 13:25", fixedNow);
  assert(t1.success === true, "Parses 'today 13:25'");
  assert(t1.deadline?.kind === "timed", "'today 13:25' is timed");
  assert(t1.deadline?.localTime === "13:25", "'today 13:25' localTime is 13:25");

  // B. tomorrow HH:MM
  const t2 = parseDateShorthand("tomorrow 10:00", fixedNow);
  assert(t2.success === true, "Parses 'tomorrow 10:00'");
  assert(t2.deadline?.kind === "timed", "'tomorrow 10:00' is timed");
  assert(t2.deadline?.localTime === "10:00", "'tomorrow 10:00' localTime is 10:00");

  // C. Relative durations (digits, words, singular, plural)
  const rel1 = parseDateShorthand("in 1 minute", fixedNow);
  assert(rel1.success === true && rel1.deadline?.kind === "timed", "Parses 'in 1 minute'");
  const diff1 = new Date(rel1.deadline!.utcInstant!).getTime() - fixedNow.getTime();
  assert(diff1 === 60 * 1000, "'in 1 minute' matches exactly +60s");

  const rel2 = parseDateShorthand("in one minute", fixedNow);
  assert(rel2.success === true && rel2.deadline?.kind === "timed", "Parses 'in one minute'");
  const diff2 = new Date(rel2.deadline!.utcInstant!).getTime() - fixedNow.getTime();
  assert(diff2 === 60 * 1000, "'in one minute' word number matches +60s");

  const rel3 = parseDateShorthand("in 10 minutes", fixedNow);
  assert(rel3.success === true && rel3.deadline?.kind === "timed", "Parses 'in 10 minutes'");
  const diff3 = new Date(rel3.deadline!.utcInstant!).getTime() - fixedNow.getTime();
  assert(diff3 === 10 * 60 * 1000, "'in 10 minutes' matches +600s");

  const rel4 = parseDateShorthand("in an hour", fixedNow);
  assert(rel4.success === true && rel4.deadline?.kind === "timed", "Parses 'in an hour'");
  const diff4 = new Date(rel4.deadline!.utcInstant!).getTime() - fixedNow.getTime();
  assert(diff4 === 60 * 60 * 1000, "'in an hour' matches +3600s");

  const rel5 = parseDateShorthand("after 2 hours", fixedNow);
  assert(rel5.success === true && rel5.deadline?.kind === "timed", "Parses 'after 2 hours'");
  const diff5 = new Date(rel5.deadline!.utcInstant!).getTime() - fixedNow.getTime();
  assert(diff5 === 2 * 60 * 60 * 1000, "'after 2 hours' matches +7200s");

  const rel6 = parseDateShorthand("after two hours", fixedNow);
  assert(rel6.success === true && rel6.deadline?.kind === "timed", "Parses 'after two hours'");

  // ---------------------------------------------------------------------------
  // 2. Title Stripping from Natural Language Inputs
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Title Stripping from Natural Language Inputs ---");

  // User input at end: "test reminder today 13:25"
  const ex1 = extractTimeAndTitle("test reminder today 13:25", fixedNow);
  assert(ex1.title === "test reminder", "Strips 'today 13:25' from title -> 'test reminder'");
  assert(ex1.deadline.kind === "timed", "Identified deadline is timed");
  assert(ex1.deadline.localTime === "13:25", "Deadline localTime is 13:25");

  // User input at start: "in 2 minutes test"
  const ex2 = extractTimeAndTitle("in 2 minutes test", fixedNow);
  assert(ex2.title === "test", "Strips 'in 2 minutes' from prefix -> 'test'");
  assert(ex2.deadline.kind === "timed", "Prefix duration identified as timed");

  // User input at end: "test in 2 minutes"
  const ex3 = extractTimeAndTitle("test in 2 minutes", fixedNow);
  assert(ex3.title === "test", "Strips 'in 2 minutes' from suffix -> 'test'");

  // User input with word number: "call mom after 2 hours"
  const ex4 = extractTimeAndTitle("call mom after 2 hours", fixedNow);
  assert(ex4.title === "call mom", "Strips 'after 2 hours' -> 'call mom'");

  // Pipe format preserved: "today 13:25 | test reminder"
  const ex5 = extractTimeAndTitle("today 13:25 | test reminder", fixedNow);
  assert(ex5.title === "test reminder", "Pipe format extracts title correctly");
  assert(ex5.deadline.kind === "timed", "Pipe format deadline is timed");

  // Untimed task: "Buy milk"
  const ex6 = extractTimeAndTitle("Buy milk", fixedNow);
  assert(ex6.title === "Buy milk", "Untimed task title preserved");
  assert(ex6.hasTimePhrase === false, "hasTimePhrase is false for 'Buy milk'");
  assert(ex6.deadline.kind === "none", "Deadline kind is 'none'");

  // ---------------------------------------------------------------------------
  // 3. Failed Time Phrase Gating (Never Silently Create Untimed Task)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Failed Time Phrase Gating ---");

  const exFail = extractTimeAndTitle("test reminder today 25:99", fixedNow);
  assert(exFail.hasTimePhrase === true, "Flags attempted time phrase in 'today 25:99'");
  assert(!!exFail.parseError, "Flags parse error for invalid time '25:99'");

  // Execute handleAdd with failed time phrase
  const mockDb = createMockD1();
  const addFailRes = await handleAdd("test reminder today 25:99", {
    db: mockDb as any,
    updateId: 101,
    now: fixedNow,
  });

  assert(
    addFailRes.response.includes("Couldn't read that time, saved without a deadline [Set time]"),
    "Replies with exact phrase: 'Couldn't read that time, saved without a deadline [Set time]'"
  );
  assert(!!addFailRes.replyMarkup?.inline_keyboard, "Provides inline keyboard with time-setting buttons");

  // ---------------------------------------------------------------------------
  // 4. Guaranteed Reminder Scheduling (No Silent 'No Reminder' Case)
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Guaranteed Reminder Scheduling ---");

  // Ensure tasks exist for FK constraint
  await mockDb
    .prepare("INSERT OR REPLACE INTO tasks (id, title, status, priority, deadline_kind, deadline_version, created_at, updated_at) VALUES ('task-near-deadline', 'Near', 'open', 'normal', 'timed', 1, ?, ?)")
    .bind(fixedNow.toISOString(), fixedNow.toISOString())
    .run();
  await mockDb
    .prepare("INSERT OR REPLACE INTO tasks (id, title, status, priority, deadline_kind, deadline_version, created_at, updated_at) VALUES ('task-past-deadline', 'Past', 'open', 'normal', 'timed', 1, ?, ?)")
    .bind(fixedNow.toISOString(), fixedNow.toISOString())
    .run();

  // Specific test: task due 14:03 created at 14:01:58
  const created140158 = new Date("2026-11-06T08:31:58.812Z");
  const due1403 = new Date("2026-11-06T08:33:58.812Z"); // 14:03:58 IST
  const planTiming = await planNotification({
    db: mockDb as any,
    taskId: "task-near-deadline",
    deadlineKind: "timed",
    deadlineAtUtc: due1403.toISOString(),
    deadlineVersion: 1,
    now: created140158,
  });
  assert(planTiming.planned === true, "Task 14:03 created at 14:01:58 planned successfully");
  assert(
    new Date(planTiming.scheduledAt!).getTime() <= new Date("2026-11-06T08:33:00.000Z").getTime(),
    "Reminder scheduled at or before 14:03:00 IST so 14:03 cron tick fires on time"
  );
  assert(
    new Date(planTiming.scheduledAt!).getTime() <= due1403.getTime(),
    "Reminder is NEVER scheduled after deadline"
  );

  // Task created at 13:24:17 with deadline in 43s (13:25:00)
  const deadline43s = istToUtcDate(ist.localDate, "13:25").toISOString();
  const plan1 = await planNotification({
    db: mockDb as any,
    taskId: "task-near-deadline",
    deadlineKind: "timed",
    deadlineAtUtc: deadline43s,
    deadlineVersion: 1,
    now: fixedNow,
  });

  assert(plan1.planned === true, "Notification successfully planned for 43s deadline");
  assert(!!plan1.scheduledAt, "Scheduled instant is set");

  // Task with deadline already in the past (e.g. deadline at 13:20, now is 13:24:17)
  const pastDeadline = istToUtcDate(ist.localDate, "13:20").toISOString();
  const plan2 = await planNotification({
    db: mockDb as any,
    taskId: "task-past-deadline",
    deadlineKind: "timed",
    deadlineAtUtc: pastDeadline,
    deadlineVersion: 1,
    now: fixedNow,
  });

  assert(plan2.planned === true, "Past deadline is NOT dropped silently");
  assert(
    new Date(plan2.scheduledAt!).getTime() >= fixedNow.getTime(),
    "Past deadline is rescheduled to nearest valid future tick (now + 1 min)"
  );

  // ---------------------------------------------------------------------------
  // 5. Scheduler Heartbeat Updates on Every Tick
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Scheduler Heartbeat Updates on Every Tick ---");

  // Run scheduler twice with 1 minute difference (previously throttled to 5 minutes)
  const tick1 = new Date("2026-11-06T07:55:00.000Z");
  await runScheduler(mockDb as any, tick1);

  const row1 = await mockDb
    .prepare("SELECT last_scheduler_start_at, last_scheduler_success_at FROM system_health WHERE id = 1")
    .first<any>();
  assert(row1.last_scheduler_success_at === tick1.toISOString(), "Heartbeat updated on tick 1");

  const tick2 = new Date("2026-11-06T07:56:00.000Z"); // only 1 minute later
  await runScheduler(mockDb as any, tick2);

  const row2 = await mockDb
    .prepare("SELECT last_scheduler_start_at, last_scheduler_success_at FROM system_health WHERE id = 1")
    .first<any>();
  assert(row2.last_scheduler_success_at === tick2.toISOString(), "Heartbeat updated on tick 2 (throttling removed!)");

  console.log("\n========================================");
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("========================================\n");

  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
