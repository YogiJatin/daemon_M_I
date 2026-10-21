const SECRET = "local-test-webhook-secret";
const BASE_URL = "http://127.0.0.1:8787";

async function main() {
  console.log("\n========================================================");
  console.log("   RUNNING BLOCK 3A LIVE ACCEPTANCE TEST BATTERY");
  console.log("========================================================\n");

  let totalPassed = 0;
  let totalFailed = 0;

  function record(pass: boolean, name: string, extra?: any) {
    if (pass) {
      console.log(`✅ PASS: ${name}`);
      totalPassed++;
    } else {
      console.error(`❌ FAIL: ${name}`, extra ? JSON.stringify(extra, null, 2) : "");
      totalFailed++;
    }
  }

  // 1. Health check
  const healthRes = await fetch(`${BASE_URL}/health/public`);
  const healthJson = (await healthRes.json()) as any;
  record(healthRes.status === 200 && healthJson.ok === true, "Health check /health/public");

  // 2. Canonical Acceptance Tests (TEST-3A.1 to TEST-3A.6 + Month/Leap + Parser)
  console.log("\n--- Calling /api/v1/internal/test/recurrence ---");
  const testSuiteRes = await fetch(`${BASE_URL}/api/v1/internal/test/recurrence`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    },
    body: JSON.stringify({ action: "ALL" }),
  });

  const testSuiteJson = (await testSuiteRes.json()) as any;
  const results = testSuiteJson.results || {};

  record(
    results["TEST-3A.1"]?.passed === true,
    "TEST-3A.1: daily, weekly and selected-weekday rules create expected IST occurrences",
    results["TEST-3A.1"]
  );

  record(
    results["TEST-3A.2"]?.passed === true,
    "TEST-3A.2: alternating A/B rules produce expected sequence from explicit anchor Monday",
    results["TEST-3A.2"]
  );

  record(
    results["TEST-3A.3"]?.passed === true,
    "TEST-3A.3: repeated materialization creates no duplicate occurrence or notification rows",
    results["TEST-3A.3"]
  );

  record(
    results["TEST-3A.4"]?.passed === true,
    "TEST-3A.4: daily maintenance adds only the next missing date without full horizon rebuild",
    results["TEST-3A.4"]
  );

  record(
    results["TEST-3A.5"]?.passed === true,
    "TEST-3A.5: pause/edit suppresses obsolete future work while preserving completed history",
    results["TEST-3A.5"]
  );

  record(
    results["TEST-3A.6"]?.passed === true,
    "TEST-3A.6: completing one occurrence does not accidentally complete future occurrences",
    results["TEST-3A.6"]
  );

  record(
    results["TEST-3A.MONTH_LEAP"]?.passed === true,
    "Month Clamping & Leap Year: Jan 31 -> Feb 28 -> Mar 31 and Feb 29 preserved on leap year",
    results["TEST-3A.MONTH_LEAP"]
  );

  record(
    results["TEST-3A.PARSER"]?.passed === true,
    "Shorthand Recurrence Parser: all standard intervals and weekday/month expressions",
    results["TEST-3A.PARSER"]
  );

  // 3. REST API CRUD: Create, List, Pause, Resume, Edit
  console.log("\n--- Testing REST Recurrence Endpoints ---");

  // Create via REST
  const createRes = await fetch(`${BASE_URL}/api/v1/recurrence-rules`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    },
    body: JSON.stringify({
      title: "Gym Workout",
      pattern: "selected_weekdays",
      weekdays: [1, 3, 5],
      local_time: "07:00",
      start_date: "2026-10-21",
    }),
  });
  const createJson = (await createRes.json()) as any;
  record(createRes.status === 200 && !!createJson.ruleId, "REST: Create rule (POST /api/v1/recurrence-rules)");
  const gymRuleId = createJson.ruleId;

  // List rules
  const listRes = await fetch(`${BASE_URL}/api/v1/recurrence-rules`, {
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
  });
  const listJson = (await listRes.json()) as any;
  const foundRule = (listJson.rules || []).some((r: any) => r.id === gymRuleId);
  record(foundRule, "REST: List rules (GET /api/v1/recurrence-rules)");

  // Pause rule
  const pauseRes = await fetch(`${BASE_URL}/api/v1/recurrence-rules/${gymRuleId}/pause`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    },
  });
  const pauseJson = (await pauseRes.json()) as any;
  record(pauseJson.ok === true && pauseJson.suppressedTasks > 0, "REST: Pause rule suppresses future occurrences");

  // Resume rule
  const resumeRes = await fetch(`${BASE_URL}/api/v1/recurrence-rules/${gymRuleId}/resume`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    },
  });
  const resumeJson = (await resumeRes.json()) as any;
  record(resumeJson.ok === true && resumeJson.occurrencesCreated > 0, "REST: Resume rule materializes occurrences");

  // Edit rule
  const editRes = await fetch(`${BASE_URL}/api/v1/recurrence-rules/${gymRuleId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    },
    body: JSON.stringify({
      title: "Gym Workout (Intense)",
      local_time: "06:30",
    }),
  });
  const editJson = (await editRes.json()) as any;
  record(editJson.ok === true && editJson.newSeriesVersion === 2, "REST: Edit rule increments series_version");

  // 4. Telegram Webhook Integration: /add every monday 18:00 | Project Sync
  console.log("\n--- Testing Telegram Webhook /add Recurrence & /done ---");
  const updateId = Math.floor(Date.now() / 1000);
  const webhookAddRes = await fetch(`${BASE_URL}/api/v1/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: 101,
        from: { id: 8364430714, first_name: "Owner" },
        chat: { id: 8364430714, type: "private" },
        text: "/add every monday 18:00 | Project Sync",
      },
    }),
  });

  const webhookAddJson = (await webhookAddRes.json()) as any;
  record(
    webhookAddJson.ok === true && webhookAddJson.command === "add" && webhookAddJson.result.includes("Recurring task created"),
    "Telegram: /add every monday 18:00 | Project Sync creates recurrence rule",
    webhookAddJson
  );

  // 5. Test Scheduler Integration: Cron Trigger Execution
  console.log("\n--- Testing Scheduler Integration ---");
  const schedRes = await fetch(`${BASE_URL}/api/v1/internal/scheduler/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    },
    body: JSON.stringify({
      now: new Date().toISOString(),
    }),
  });
  const schedJson = (await schedRes.json()) as any;
  record(
    schedRes.status === 200 && schedJson.ok === true && Array.isArray(schedJson.result?.errors) && schedJson.result?.errors.length === 0,
    "Scheduler: Cron run executes bounded maintenance with 0 errors",
    schedJson
  );

  console.log(`\n========================================================`);
  console.log(`TOTAL ACCEPTANCE TESTS: ${totalPassed + totalFailed} | PASSED: ${totalPassed} | FAILED: ${totalFailed}`);
  console.log(`========================================================\n`);

  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in test runner:", err);
  process.exit(1);
});
