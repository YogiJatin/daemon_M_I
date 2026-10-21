const SECRET = "local-test-webhook-secret";
const BASE_URL = "http://127.0.0.1:8787";

async function main() {
  console.log("\n========================================================");
  console.log("   RUNNING BLOCK 3B LIVE ACCEPTANCE TEST BATTERY");
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

  // 2. Canonical Acceptance Tests (TEST-3B.1 to TEST-3B.7 + Edge cases)
  console.log("\n--- Calling /api/v1/internal/test/timetable ---");
  const testSuiteRes = await fetch(`${BASE_URL}/api/v1/internal/test/timetable`, {
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
    results["TEST-3B.1"]?.passed === true,
    "TEST-3B.1: Class timetable for a normal week creates expected occurrences",
    results["TEST-3B.1"]
  );

  record(
    results["TEST-3B.2"]?.passed === true,
    "TEST-3B.2: Alternating A/B or lab-batch timetable entries follow anchor",
    results["TEST-3B.2"]
  );

  record(
    results["TEST-3B.3"]?.passed === true,
    "TEST-3B.3: Tomorrow's lab materials appear in single 20:30 prep digest",
    results["TEST-3B.3"]
  );

  record(
    results["TEST-3B.4"]?.passed === true,
    "TEST-3B.4: Global vacation & per-entry exceptions suppress affected classes",
    results["TEST-3B.4"]
  );

  record(
    results["TEST-3B.5"]?.passed === true,
    "TEST-3B.5: Editing material/class updates future unsent digests dynamically",
    results["TEST-3B.5"]
  );

  record(
    results["TEST-3B.6"]?.passed === true,
    "TEST-3B.6: IST midnight/date boundaries do not shift classes to prior UTC date",
    results["TEST-3B.6"]
  );

  record(
    results["TEST-3B.7"]?.passed === true,
    "TEST-3B.7: Owner can preview next 7–14 days of class schedule",
    results["TEST-3B.7"]
  );

  record(
    results["EDGE_CASES"]?.passed === true,
    "Edge Cases: Mid-week semester end & simultaneous class slots captured",
    results["EDGE_CASES"]
  );

  // 3. REST API Endpoints Verification
  console.log("\n--- Testing REST Endpoints ---");

  // Create semester via REST
  const semRes = await fetch(`${BASE_URL}/api/v1/timetable`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify({
      type: "semester",
      name: "Spring 2027",
      start_date: "2027-01-04",
      end_date: "2027-05-15",
      is_active: true,
    }),
  });
  const semJson = (await semRes.json()) as any;
  record(semRes.status === 200 && !!semJson.id, "REST: Create semester (POST /api/v1/timetable type:semester)");

  // Create subject via REST
  const subjRes = await fetch(`${BASE_URL}/api/v1/timetable`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify({
      type: "subject",
      semester_id: semJson.id,
      code: "AI301",
      name: "Artificial Intelligence",
      faculty: "Prof. Turing",
      default_room: "Room 401",
      preparation_minutes: 30,
    }),
  });
  const subjJson = (await subjRes.json()) as any;
  record(subjRes.status === 200 && !!subjJson.id, "REST: Create subject (POST /api/v1/timetable type:subject)");

  // Query timetable preview via REST
  const previewRes = await fetch(`${BASE_URL}/api/v1/timetable?preview=14`, {
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
  });
  const previewJson = (await previewRes.json()) as any;
  record(previewRes.status === 200 && Array.isArray(previewJson.preview), "REST: GET /api/v1/timetable?preview=14");

  // Query preparation for tomorrow
  const prepRes = await fetch(`${BASE_URL}/api/v1/preparation/tomorrow`, {
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
  });
  const prepJson = (await prepRes.json()) as any;
  record(prepRes.status === 200 && prepJson.ok === true && typeof prepJson.renderedMessage === "string", "REST: GET /api/v1/preparation/tomorrow");

  // Query classes today & week
  const todayRes = await fetch(`${BASE_URL}/api/v1/classes/today`, {
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
  });
  const todayJson = (await todayRes.json()) as any;
  record(todayRes.status === 200 && Array.isArray(todayJson.classes), "REST: GET /api/v1/classes/today");

  const weekRes = await fetch(`${BASE_URL}/api/v1/classes/week`, {
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
  });
  const weekJson = (await weekRes.json()) as any;
  record(weekRes.status === 200 && Array.isArray(weekJson.preview), "REST: GET /api/v1/classes/week");

  // 4. Telegram Webhook Commands Verification
  console.log("\n--- Testing Telegram Webhook Commands ---");
  const updateId = Math.floor(Date.now() / 1000);

  // Helper to send telegram command
  async function sendCmd(text: string) {
    const res = await fetch(`${BASE_URL}/api/v1/telegram/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
      body: JSON.stringify({
        update_id: updateId + Math.floor(Math.random() * 1000),
        message: {
          message_id: Math.floor(Math.random() * 1000),
          from: { id: 8364430714, first_name: "Owner" },
          chat: { id: 8364430714, type: "private" },
          text,
        },
      }),
    });
    return (await res.json()) as any;
  }

  const semListCmd = await sendCmd("/semester list");
  record(semListCmd.ok === true && semListCmd.command === "semester", "Telegram: /semester list");

  const todayCmd = await sendCmd("/today");
  record(todayCmd.ok === true && todayCmd.command === "today", "Telegram: /today");

  const tomorrowCmd = await sendCmd("/tomorrow");
  record(tomorrowCmd.ok === true && tomorrowCmd.command === "tomorrow", "Telegram: /tomorrow");

  const nextClassCmd = await sendCmd("/nextclass");
  record(nextClassCmd.ok === true && nextClassCmd.command === "nextclass", "Telegram: /nextclass");

  const whereamiCmd = await sendCmd("/whereami");
  record(whereamiCmd.ok === true && whereamiCmd.command === "whereami", "Telegram: /whereami");

  const scheduleCmd = await sendCmd("/schedule");
  record(scheduleCmd.ok === true && scheduleCmd.command === "schedule", "Telegram: /schedule");

  const holidayListCmd = await sendCmd("/holiday list");
  record(holidayListCmd.ok === true && holidayListCmd.command === "holiday", "Telegram: /holiday list");

  const materialsCmd = await sendCmd("/materials");
  record(materialsCmd.ok === true && materialsCmd.command === "materials", "Telegram: /materials");

  // 5. Scheduler Cron Trigger Execution
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
    "Scheduler: Cron run executes timetable maintenance with 0 errors",
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
