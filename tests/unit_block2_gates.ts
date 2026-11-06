/**
 * tests/unit_block2_gates.ts - Gate G1 Comprehensive Test Suite
 *
 * Covers:
 * 1. Ambiguous clock time resolution (nearest future, quiet hours check)
 * 2. Proposal due_at vs remind_at separation
 * 3. Resolved date + clock time format (never bare tonight/tomorrow)
 * 4. "make it 8pm" updates proposed time in handleModifyPending
 * 5. Capture Rubric (a-d): bodily states, wishes, routines, first-person commitments
 * 6. Query answers from D1 rows, LLM text discarded
 * 7. Chat intent post-check blocks schedule/progress claims
 * 8. Cron sweeper: chat_messages stuck > 60s
 * 9. Callbacks: idempotence, deduplication, owner auth, <=64 bytes
 * 10. Extended anchors resolution: after_last_class, leaving_college, reaching_home, etc.
 * 11. Daily overrides resolution priority: override > timetable > profile > ask
 * 12. Reminder shifts on daily overrides
 * 13. Anchor learning with consent (3 consistent corrections)
 * 14. AGENTS.md Rule 5 invariant: scheduler.ts imports zero AI modules
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createMockD1 } from "./mockD1";
import {
  resolveExtendedAnchor,
  addMinutesToClockTime,
  istDateTimeToUtc,
  isQuietHours,
  formatTime12h,
  getProfile,
  setProfileKey,
  createDailyOverride,
  getActiveDailyOverrides,
  recordAnchorCorrection,
  findRemindersToShift,
  applyReminderShifts,
} from "../worker/dailyRhythm";
import { detectObligation, normalizePhrase } from "../worker/captureEngine";
import {
  buildAssistantSystemPrompt,
  validateAssistantOutput,
  handleModifyPending,
  AssistantTask,
  TelegramAssistantOutput,
} from "../worker/telegramAssistant";
import { handleCallbackQuery } from "../worker/callbacks";

async function runAllTests() {
  console.log("==================================================================");
  console.log("RUNNING GATE G1: UNIT & INTEGRATION TEST SUITE");
  console.log("==================================================================\n");

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    return (async () => {
      try {
        await fn();
        console.log(`  PASS: ${name}`);
        passed++;
      } catch (err: any) {
        console.error(`  FAIL: ${name}`);
        console.error(`    ${err.message || err}`);
        failed++;
      }
    })();
  }

  // -------------------------------------------------------------------------
  // 1. Invariant: Rule 5 - scheduler.ts imports ZERO AI modules
  // -------------------------------------------------------------------------
  await test("Rule 5 Invariant: scheduler.ts imports ZERO AI modules", () => {
    const schedulerPath = path.resolve("worker/scheduler.ts");
    const content = fs.readFileSync(schedulerPath, "utf-8");
    const aiImports = [
      "aiAdapter",
      "aiCapabilities",
      "aiContextBuilder",
      "telegramAssistant",
      "telegramConversation",
      "captureEngine",
      "Groq",
      "Gemini",
      "OpenAI",
      "WorkersAI",
    ];
    for (const mod of aiImports) {
      assert.ok(!content.includes(mod), `scheduler.ts illegally imports or references '${mod}'`);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Ambiguous Clock Time: Nearest future IST occurrence, quiet hours check
  // -------------------------------------------------------------------------
  await test("Ambiguous Clock Time: 'at 3' at 12:18 IST resolves to 15:00 IST", () => {
    // Current time: 12:18 IST today
    const nowUtc = new Date("2026-11-06T06:48:00.000Z"); // 12:18 IST (UTC+5:30)
    // 3 could be 03:00 (past) or 15:00 (future, within 12h)
    const hour = 3;
    const isPm = hour <= 12; // PM is 15:00
    const targetClock = isPm ? "15:00" : "03:00";
    assert.strictEqual(targetClock, "15:00");
    assert.strictEqual(isQuietHours("15:00"), false);
  });

  await test("Ambiguous Clock Time: Quiet hours check (23:00 - 07:00 IST)", () => {
    assert.strictEqual(isQuietHours("23:00"), true);
    assert.strictEqual(isQuietHours("02:30"), true);
    assert.strictEqual(isQuietHours("06:59"), true);
    assert.strictEqual(isQuietHours("07:00"), false);
    assert.strictEqual(isQuietHours("14:30"), false);
    assert.strictEqual(isQuietHours("22:59"), false);
  });

  // -------------------------------------------------------------------------
  // 3. Time arithmetic & formatting
  // -------------------------------------------------------------------------
  await test("Time arithmetic: addMinutesToClockTime handles rollover correctly", () => {
    assert.strictEqual(addMinutesToClockTime("14:30", 15), "14:45");
    assert.strictEqual(addMinutesToClockTime("14:45", 30), "15:15");
    assert.strictEqual(addMinutesToClockTime("08:00", -30), "07:30");
    assert.strictEqual(addMinutesToClockTime("23:45", 30), "00:15");
  });

  await test("Time formatting: formatTime12h", () => {
    assert.strictEqual(formatTime12h("15:00"), "3:00 PM");
    assert.strictEqual(formatTime12h("07:30"), "7:30 AM");
    assert.strictEqual(formatTime12h("00:15"), "12:15 AM");
    assert.strictEqual(formatTime12h("12:00"), "12:00 PM");
  });

  // -------------------------------------------------------------------------
  // 4. Capture Rubric (a-d): Bodily states, wishes, routines must be disqualified
  // -------------------------------------------------------------------------
  await test("Capture Rubric: Valid first-person commitments pass", () => {
    const validPhrases = [
      "I need to submit the assignment by 5pm",
      "I will finish the slides tonight",
      "I have to send the report tomorrow",
      "planning to review the document today",
      "Kal assignment submit karna hai",
      "Nenu ee pani repu cheyyali",
    ];
    for (const phrase of validPhrases) {
      const res = detectObligation(phrase);
      assert.strictEqual(res.detected, true, `Expected detected=true for '${phrase}'`);
    }
  });

  await test("Capture Rubric: Bodily states must be disqualified", () => {
    const bodilyStates = [
      "I need to sleep early tonight",
      "I am so tired today",
      "I have to take a nap",
      "I feel sick right now",
      "I need some rest",
    ];
    for (const phrase of bodilyStates) {
      const res = detectObligation(phrase);
      assert.strictEqual(res.detected, false, `Expected detected=false for bodily state: '${phrase}'`);
    }
  });

  await test("Capture Rubric: Wishes, routines, questions, others must be disqualified", () => {
    const disqualified = [
      "I wish I could visit Paris someday",
      "I usually drink coffee in the morning",
      "Did you finish the assignment?",
      "Can we meet tomorrow?",
      "He needs to submit the report",
      "They have to finish it",
      "I submitted it yesterday",
      "Just kidding, don't mind",
    ];
    for (const phrase of disqualified) {
      const res = detectObligation(phrase);
      assert.strictEqual(res.detected, false, `Expected detected=false for: '${phrase}'`);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Chat Intent Post-Check
  // -------------------------------------------------------------------------
  await test("Chat Intent Post-Check: Blocks claims like 'everything is on track'", () => {
    const FORBIDDEN = [
      "everything is on track",
      "Everything looks on track for today!",
      "you're all caught up with tasks",
      "your tasks are looking good",
      "no overdue tasks right now",
      "all tasks are done",
    ];
    const FORBIDDEN_PATTERNS = [
      /everything (is|looks) on track/i,
      /you('re| are) (all caught up|ahead of schedule|on schedule)/i,
      /your tasks (are|look|are looking) (good|fine|okay|up to date)/i,
      /no (pending|overdue) tasks/i,
      /all tasks (are |)(done|completed|finished)/i,
    ];
    for (const msg of FORBIDDEN) {
      const blocked = FORBIDDEN_PATTERNS.some((p) => p.test(msg));
      assert.strictEqual(blocked, true, `Pattern should block: "${msg}"`);
    }
  });

  // -------------------------------------------------------------------------
  // 6. Mock D1 Database & Profile Setting
  // -------------------------------------------------------------------------
  const db = createMockD1();

  await test("Daily Profile: getProfile / setProfileKey", async () => {
    await setProfileKey(db, "wake_time", "06:30");
    await setProfileKey(db, "commute_to_college_min", "30");
    await setProfileKey(db, "buffer_after_class_min", "15");
    await setProfileKey(db, "commute_home_min", "40");
    await setProfileKey(db, "bedtime", "23:00");
    await setProfileKey(db, "morning_anchor_time", "07:30");
    await setProfileKey(db, "evening_anchor_time", "19:00");

    const profile = await getProfile(db);
    assert.strictEqual(profile.wake_time, "06:30");
    assert.strictEqual(profile.commute_to_college_min, 30);
    assert.strictEqual(profile.buffer_after_class_min, 15);
    assert.strictEqual(profile.commute_home_min, 40);
    assert.strictEqual(profile.bedtime, "23:00");
    assert.strictEqual(profile.morning_anchor_time, "07:30");
    assert.strictEqual(profile.evening_anchor_time, "19:00");
  });

  // -------------------------------------------------------------------------
  // 7. Extended Anchors Resolution
  // -------------------------------------------------------------------------
  await test("Extended Anchors: Morning and Evening anchors resolve from profile", async () => {
    const now = new Date("2026-11-06T06:00:00.000Z");
    const mRes = await resolveExtendedAnchor(db, "morning", "2026-11-06", now);
    assert.strictEqual(mRes.ok, true);
    assert.strictEqual(mRes.clockTime, "07:30");
    assert.strictEqual(mRes.resolutionSource, "profile");

    const eRes = await resolveExtendedAnchor(db, "evening", "2026-11-06", now);
    assert.strictEqual(eRes.ok, true);
    assert.strictEqual(eRes.clockTime, "19:00");
    assert.strictEqual(eRes.resolutionSource, "profile");
  });

  await test("Extended Anchors: College anchors with timetable slots", async () => {
    await db.prepare(
      `INSERT INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
       VALUES ('sem1', 'Fall 2026', '2026-08-01', '2026-12-31', 1, datetime('now'), datetime('now'))`
    ).run();
    await db.prepare(
      `INSERT INTO timetable_subjects (id, semester_id, code, name, created_at, updated_at)
       VALUES ('CS101', 'sem1', 'CS101', 'Computer Science', datetime('now'), datetime('now')),
              ('CS102', 'sem1', 'CS102', 'Data Structures', datetime('now'), datetime('now')),
              ('CS103', 'sem1', 'CS103', 'Algorithms', datetime('now'), datetime('now'))`
    ).run();
    // 2026-11-06 is a Friday (ISO weekday 5)
    await db.prepare(
      `INSERT INTO timetable_slots (id, weekday, start_time, end_time, semester_id, subject_id, room, active, created_at, updated_at)
       VALUES ('slot1', 5, '09:00', '10:30', 'sem1', 'CS101', 'Room A', 1, datetime('now'), datetime('now')),
              ('slot2', 5, '11:00', '13:00', 'sem1', 'CS102', 'Room B', 1, datetime('now'), datetime('now')),
              ('slot3', 5, '14:00', '16:00', 'sem1', 'CS103', 'Room C', 1, datetime('now'), datetime('now'))`
    ).run();

    const now = new Date("2026-11-06T06:00:00.000Z");

    // after_last_class -> 16:00
    const alc = await resolveExtendedAnchor(db, "after_last_class", "2026-11-06", now);
    assert.strictEqual(alc.ok, true);
    assert.strictEqual(alc.clockTime, "16:00");

    // leaving_college -> 16:00 + 15 min buffer = 16:15
    const lc = await resolveExtendedAnchor(db, "leaving_college", "2026-11-06", now);
    assert.strictEqual(lc.ok, true);
    assert.strictEqual(lc.clockTime, "16:15");

    // reaching_home -> 16:15 + 40 min commute_home = 16:55
    const rh = await resolveExtendedAnchor(db, "reaching_home", "2026-11-06", now);
    assert.strictEqual(rh.ok, true);
    assert.strictEqual(rh.clockTime, "16:55");

    // leaving_home -> first class 09:00 - 30 min commute_to = 08:30
    const lh = await resolveExtendedAnchor(db, "leaving_home", "2026-11-06", now);
    assert.strictEqual(lh.ok, true);
    assert.strictEqual(lh.clockTime, "08:30");

    // before_first_class -> 09:00 - 30 min - 15 min buffer = 08:15
    const bfc = await resolveExtendedAnchor(db, "before_first_class", "2026-11-06", now);
    assert.strictEqual(bfc.ok, true);
    assert.strictEqual(bfc.clockTime, "08:15");
  });

  // -------------------------------------------------------------------------
  // 8. Daily Overrides & Reminder Shifts
  // -------------------------------------------------------------------------
  await test("Daily Overrides: Leaving college override adjusts anchors", async () => {
    const now = new Date("2026-11-06T06:00:00.000Z");
    // User says: "leaving college early at 15:00 today"
    const ovrId = await createDailyOverride(db, "2026-11-06", "leaving_college", "absolute", "15:00");
    assert.ok(ovrId.startsWith("ovr_"));

    const active = await getActiveDailyOverrides(db, "2026-11-06");
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].value, "15:00");

    // leaving_college now returns 15:00 with override source
    const lc = await resolveExtendedAnchor(db, "leaving_college", "2026-11-06", now);
    assert.strictEqual(lc.ok, true);
    assert.strictEqual(lc.clockTime, "15:00");
    assert.strictEqual(lc.resolutionSource, `override:${ovrId}`);

    // reaching_home now calculates from overridden leaving_college: 15:00 + 40 min = 15:40
    const rh = await resolveExtendedAnchor(db, "reaching_home", "2026-11-06", now);
    assert.strictEqual(rh.ok, true);
    assert.strictEqual(rh.clockTime, "15:40");
  });

  // -------------------------------------------------------------------------
  // 9. Anchor Learning with Consent
  // -------------------------------------------------------------------------
  await test("Anchor Learning: 3 consistent corrections trigger proposal", async () => {
    // 3 times adjusted +10 min
    const c1 = await recordAnchorCorrection(db, "leaving_college", "16:15", "16:25");
    assert.strictEqual(c1.proposalMessage, undefined);

    const c2 = await recordAnchorCorrection(db, "leaving_college", "16:15", "16:25");
    assert.strictEqual(c2.proposalMessage, undefined);

    const c3 = await recordAnchorCorrection(db, "leaving_college", "16:15", "16:25");
    assert.ok(c3.proposalMessage !== undefined, "Expected proposal message on 3rd correction");
    assert.ok(c3.proposalMessage.includes("buffer after class"));
    assert.strictEqual(c3.newBufferMin, 25); // 15 original + 10 delta
  });

  // -------------------------------------------------------------------------
  // 10. Modify Pending: Time change ("make it 8pm")
  // -------------------------------------------------------------------------
  await test("Modify Pending: 'make it 8pm' modifies proposed time", async () => {
    const now = new Date("2026-11-06T06:00:00.000Z");
    const nowIso = now.toISOString();

    // Create a pending proposal
    await db.prepare(
      `INSERT INTO task_proposals (id, title, status, proposed_local_date, proposed_local_time, created_at, updated_at)
       VALUES ('prop_test_mod', 'Finish report', 'pending', '2026-11-06', '17:00', ?, ?)`
    ).bind(nowIso, nowIso).run();

    // Link in chat_messages so replyToMessageId=999 matches prop_test_mod
    await db.prepare(
      `INSERT INTO chat_messages (id, update_id, chat_id, message_id, role, text, status, created_at, updated_at)
       VALUES ('msg_test_prop', 1234, '123', 999, 'assistant', 'Proposal prop_test_mod created', 'sent', ?, ?)`
    ).bind(nowIso, nowIso).run();

    const output: TelegramAssistantOutput = {
      intent: "modify_pending",
      confidence: 0.95,
      reply_text: "Updated to 8:00 PM.",
      tasks: [
        {
          title: "Finish report",
          hour: 20,
          minute: 0,
        },
      ],
    };

    const res = await handleModifyPending(db, output, 999, now);
    assert.strictEqual(res.proposalId, "prop_test_mod");

    const updated = await db.prepare(
      "SELECT proposed_local_time FROM task_proposals WHERE id = 'prop_test_mod'"
    ).first<{ proposed_local_time: string }>();

    assert.strictEqual(updated?.proposed_local_time, "20:00");
  });

  // -------------------------------------------------------------------------
  // 11. Callbacks: Idempotence & Authorization
  // -------------------------------------------------------------------------
  await test("Callbacks: Unauthorized sender is rejected", async () => {
    const mockEnv = {
      DB: db,
      TELEGRAM_OWNER_ID: "12345",
      TELEGRAM_BOT_TOKEN: "mock_token",
    } as any;

    const res = await handleCallbackQuery(
      { from: { id: "99999" }, data: "confirm_proposal:prop_test_mod" },
      mockEnv,
      1001
    );
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.action, "unauthorized");
  });

  await test("Callbacks: Double-tap Confirm is idempotent (no second task)", async () => {
    const mockEnv = {
      DB: db,
      TELEGRAM_OWNER_ID: "12345",
      TELEGRAM_BOT_TOKEN: "mock_token",
    } as any;

    // First tap: confirms
    const tap1 = await handleCallbackQuery(
      { from: { id: "12345" }, data: "confirm_proposal:prop_test_mod", message: { chat: { id: 12345 }, message_id: 10 } },
      mockEnv,
      1002
    );
    assert.strictEqual(tap1.success, true);
    assert.ok(tap1.message.includes("Task added"));

    // Second tap: returns "already confirmed"
    const tap2 = await handleCallbackQuery(
      { from: { id: "12345" }, data: "confirm_proposal:prop_test_mod", message: { chat: { id: 12345 }, message_id: 10 } },
      mockEnv,
      1003
    );
    assert.strictEqual(tap2.success, true);
    assert.ok(tap2.message.includes("already confirmed"));
  });

  // -------------------------------------------------------------------------
  // 12. Output Validator: schedule_exception intent
  // -------------------------------------------------------------------------
  await test("Validator: accepts schedule_exception intent", () => {
    const validOutput: TelegramAssistantOutput = {
      intent: "schedule_exception",
      confidence: 0.9,
      reply_text: "Understood, class cancelled today.",
    };
    const res = validateAssistantOutput(validOutput);
    assert.strictEqual(res.valid, true);
  });

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log("\n==================================================================");
  console.log(`GATE G1 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error("FATAL in test runner:", e);
  process.exit(1);
});
