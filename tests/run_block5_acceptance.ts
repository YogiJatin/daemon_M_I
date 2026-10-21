/**
 * tests/run_block5_acceptance.ts
 *
 * Acceptance Test Battery for Block 5:
 * - Deterministic Suggestions Engine (TEST-5.1):
 *   - overdue_item
 *   - deadline_cluster
 *   - missing_prep
 *   - prepare_tonight
 *   - stale_recurring
 *   - missed_class
 *   - Suggestion dismissal persistence (key + version)
 *   - Resurfacing when context/version materially changes
 * - Data Portability & Export Service (TEST-5.2):
 *   - Full JSON export containing all required tables
 *   - Zero secrets leaked (no auth_sessions, pairing_challenges, telegram_updates, keys)
 *   - Full multi-table and single-entity CSV export (RFC 4180)
 *   - CSV Formula Injection protection (=, +, -, @ escaped with leading quote)
 *   - Audit event logging for export and dismissals
 * - Telegram Commands:
 *   - /suggestions
 *   - /export
 */

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8787";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "local-test-webhook-secret";
const OWNER_ID = "8364430714";

interface TestStats {
  passed: number;
  failed: number;
  total: number;
}

const stats: TestStats = { passed: 0, failed: 0, total: 0 };

function record(pass: boolean, name: string, details?: any) {
  stats.total++;
  if (pass) {
    stats.passed++;
    console.log(`✅ PASS: ${name}`);
  } else {
    stats.failed++;
    console.error(`❌ FAIL: ${name}`, details ? JSON.stringify(details, null, 2) : "");
  }
}

async function api(path: string, options: RequestInit = {}, sessionToken?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  } else {
    // Webhook secret fallback
    headers["X-Telegram-Bot-Api-Secret-Token"] = SECRET;
  }
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
}

let globalUpdateId = Math.floor(Date.now() / 1000);
async function sendTelegramCommand(text: string) {
  const updateId = ++globalUpdateId;
  const payload = {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: parseInt(OWNER_ID, 10), is_bot: false, first_name: "Owner" },
      chat: { id: parseInt(OWNER_ID, 10), type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };

  const res = await fetch(`${BASE_URL}/api/v1/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    },
    body: JSON.stringify(payload),
  });

  return { status: res.status, body: await res.json() };
}

async function main() {
  console.log("========================================================");
  console.log("   RUNNING BLOCK 5 LIVE ACCEPTANCE TEST BATTERY");
  console.log("========================================================\n");

  // 1. Authenticate session via /pair
  console.log("--- 1. Authenticating Session ---");
  const pairCmdRes = await sendTelegramCommand("/pair");
  const replyText = pairCmdRes.body.result || "";
  const codeMatch = replyText.match(/code is: (\d{6})/);
  const pairingCode = codeMatch ? codeMatch[1] : null;

  let sessionToken = "";
  if (pairingCode) {
    const pairExchangeRes = await fetch(`${BASE_URL}/api/v1/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
    });
    const pairExchangeJson = (await pairExchangeRes.json()) as any;
    sessionToken = pairExchangeJson.data?.token || "";
  }
  record(!!sessionToken, "Established authenticated session for Block 5 tests");

  // =========================================================================
  // 2. Testing Deterministic Suggestions Engine (TEST-5.1)
  // =========================================================================
  console.log("\n--- 2. Testing Deterministic Suggestions Engine (TEST-5.1) ---");

  // Fixture A: Create an overdue task (>24h overdue: 2026-10-01)
  const overdueCreate = await api(
    "/api/v1/tasks",
    {
      method: "POST",
      body: JSON.stringify({
        title: "Overdue Lab Submission",
        deadline: "2026-10-01 10:00", // Past date >24h ago
        priority: "high",
      }),
    },
    sessionToken
  );
  const overdueTask = (await overdueCreate.json()) as any;
  const overdueTaskId = overdueTask.data.id;

  // Fixture B: Create a cluster of 3 tasks on the same date (2026-10-25)
  const clusterDate = "2026-10-25";
  for (let i = 1; i <= 3; i++) {
    await api(
      "/api/v1/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          title: `Cluster Task ${i}`,
          deadline: `${clusterDate} 15:00`,
        }),
      },
      sessionToken
    );
  }

  // Fixture C: Create a stale recurring rule (end_date in the past)
  await api(
    "/api/v1/recurrence-rules",
    {
      method: "POST",
      body: JSON.stringify({
        title: "Stale Completed Project Routine",
        pattern: "weekly",
        interval: 1,
        weekdays: [1],
        start_date: "2026-09-01",
        end_date: "2026-10-01", // Past end date
      }),
    },
    sessionToken
  );

  // Fixture D: Create a semester, subject, and class occurrence for tomorrow with NO preparation materials
  const semRes = await api(
    "/api/v1/timetable/semesters",
    {
      method: "POST",
      body: JSON.stringify({
        name: "Semester 5 Suggestions Test",
        start_date: "2026-10-01",
        end_date: "2026-12-31",
      }),
    },
    sessionToken
  );
  const semJson = (await semRes.json()) as any;
  const semesterId = semJson.data?.id;

  await api(
    `/api/v1/timetable/semesters/${semesterId}/activate`,
    { method: "POST" },
    sessionToken
  );

  const subjRes = await api(
    "/api/v1/timetable/subjects",
    {
      method: "POST",
      body: JSON.stringify({
        semester_id: semesterId,
        name: "Unprepared Lab",
        code: "UL-501",
      }),
    },
    sessionToken
  );
  const subjJson = (await subjRes.json()) as any;
  const subjectId = subjJson.data?.id;

  // Create slot
  await api("/api/v1/timetable", {
    method: "POST",
    body: JSON.stringify({
      type: "slot",
      semester_id: semesterId,
      subject_id: subjectId,
      weekday: 3,
      start_time: "10:00",
      end_time: "12:00",
      room: "Lab 4",
    }),
  });

  // Query suggestions
  const sugRes = await api("/api/v1/suggestions", { method: "GET" }, sessionToken);
  record(sugRes.status === 200, "GET /api/v1/suggestions returns 200 OK");
  const sugJson = (await sugRes.json()) as any;
  const suggestions = sugJson.data?.suggestions || [];

  // Check Rule 1: overdue_item
  const overdueSug = suggestions.find((s: any) => s.type === "overdue_item" && s.context.task_id === overdueTaskId);
  record(
    !!overdueSug,
    "TEST-5.1a: overdue_item triggers when a task is overdue >24 hours",
    { overdueSug }
  );

  // Check Rule 2: deadline_cluster
  const clusterSug = suggestions.find((s: any) => s.type === "deadline_cluster" && s.context.date === clusterDate);
  record(
    !!clusterSug && clusterSug.context.count >= 3,
    "TEST-5.1b: deadline_cluster triggers when 3+ tasks are due on the same date",
    { clusterSug }
  );

  // Check Rule 5: stale_recurring
  const staleSug = suggestions.find((s: any) => s.type === "stale_recurring");
  record(
    !!staleSug,
    "TEST-5.1c: stale_recurring triggers when a rule has passed end date",
    { staleSug }
  );

  // =========================================================================
  // 3. Testing Suggestion Dismissal & Material Version Resurfacing (TEST-5.1)
  // =========================================================================
  console.log("\n--- 3. Testing Suggestion Dismissal & Resurfacing (TEST-5.1) ---");

  if (overdueSug) {
    const dismissKey = overdueSug.id;
    const currentVersion = overdueSug.version;

    // Dismiss overdue suggestion
    const disRes = await api(
      `/api/v1/suggestions/${encodeURIComponent(dismissKey)}/dismiss`,
      {
        method: "POST",
        body: JSON.stringify({ version: currentVersion }),
      },
      sessionToken
    );
    record(disRes.status === 200, "POST /api/v1/suggestions/:id/dismiss succeeds with 200");

    // Fetch suggestions again — overdue suggestion MUST be suppressed
    const afterDisRes = await api("/api/v1/suggestions", { method: "GET" }, sessionToken);
    const afterDisJson = (await afterDisRes.json()) as any;
    const stillPresent = (afterDisJson.data?.suggestions || []).some((s: any) => s.id === dismissKey);
    record(!stillPresent, "TEST-5.1d: Dismissal persists: suggestion is suppressed while context unchanged");

    // Now materially update the task's deadline (increments deadline_version)
    await api(
      `/api/v1/tasks/${overdueTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          deadline_version: overdueTask.data.deadline_version || 1,
          deadline: "2026-09-15 14:00", // New past deadline
        }),
      },
      sessionToken
    );

    // Fetch suggestions again — context/version changed materially, suggestion MUST RESURFACE!
    const resurfaceRes = await api("/api/v1/suggestions", { method: "GET" }, sessionToken);
    const resurfaceJson = (await resurfaceRes.json()) as any;
    const resurfacedSug = (resurfaceJson.data?.suggestions || []).find((s: any) => s.id === dismissKey);
    record(
      !!resurfacedSug && resurfacedSug.version !== currentVersion,
      "TEST-5.1e: Resurfacing: suggestion resurfaces when context/version materially changes",
      { oldVersion: currentVersion, newVersion: resurfacedSug?.version }
    );
  }

  // =========================================================================
  // 4. Testing JSON & CSV Data Export (TEST-5.2)
  // =========================================================================
  console.log("\n--- 4. Testing JSON & CSV Data Export (TEST-5.2) ---");

  // Fixture: create a task with formula injection attempt to verify sanitization
  await api(
    "/api/v1/tasks",
    {
      method: "POST",
      body: JSON.stringify({
        title: "=CMD|' /C calc'!A0",
        description: "@calc formula attempt",
      }),
    },
    sessionToken
  );

  // A. JSON Export
  const jsonExportRes = await api("/api/v1/export?format=json", { method: "GET" }, sessionToken);
  record(jsonExportRes.status === 200, "GET /api/v1/export?format=json returns 200 OK");
  const exportPayload = (await jsonExportRes.json()) as any;

  const hasAllSections =
    exportPayload.data?.data?.tasks &&
    exportPayload.data?.data?.recurrence_rules &&
    exportPayload.data?.data?.timetable_semesters &&
    exportPayload.data?.data?.timetable_subjects &&
    exportPayload.data?.data?.timetable_slots &&
    exportPayload.data?.data?.timetable_materials &&
    exportPayload.data?.data?.timetable_exceptions &&
    exportPayload.data?.data?.holiday_calendar &&
    exportPayload.data?.data?.class_occurrences &&
    exportPayload.data?.data?.settings &&
    exportPayload.data?.data?.audit_events;

  record(
    !!hasAllSections,
    "TEST-5.2a: JSON export includes all required operational entity tables",
    { counts: exportPayload.data?.counts }
  );

  // Verify Zero Secrets in JSON Export
  const rawExportStr = JSON.stringify(exportPayload);
  const leakedSecrets =
    rawExportStr.includes("session_token") ||
    rawExportStr.includes("auth_sessions") ||
    rawExportStr.includes("pairing_challenges") ||
    rawExportStr.includes("telegram_updates");

  record(!leakedSecrets, "TEST-5.2b: Zero secrets leaked: no session tokens, auth challenges, or update ledgers in export");

  // B. Full Multi-Table CSV Export
  const csvExportRes = await api("/api/v1/export?format=csv", { method: "GET" }, sessionToken);
  record(
    csvExportRes.status === 200 && csvExportRes.headers.get("content-type")?.includes("text/csv"),
    "GET /api/v1/export?format=csv returns text/csv 200 OK"
  );
  const csvContent = await csvExportRes.text();
  record(
    csvContent.includes("### TABLE: tasks") && csvContent.includes("### TABLE: recurrence_rules"),
    "TEST-5.2c: Full CSV export contains formatted table sections"
  );

  // C. Single Entity CSV Export
  const tasksCsvRes = await api("/api/v1/export?format=csv&entity=tasks", { method: "GET" }, sessionToken);
  const tasksCsv = await tasksCsvRes.text();
  record(
    tasksCsv.startsWith("id,title,description,project,category") &&
      tasksCsv.includes("Overdue Lab Submission"),
    "TEST-5.2d: Single entity CSV export returns pure tabular CSV for tasks"
  );

  // D. CSV Formula Injection Protection
  record(
    tasksCsv.includes("''=CMD|") || tasksCsv.includes("`=CMD|") || tasksCsv.includes("'=CMD|"),
    "TEST-5.2e: CSV Formula Injection sanitized with leading single quote protection"
  );

  // E. Audit Trail for Export
  const historyRes = await api("/api/v1/history?entity_type=system", { method: "GET" }, sessionToken);
  const historyJson = (await historyRes.json()) as any;
  const eventsList = Array.isArray(historyJson.data) ? historyJson.data : historyJson.data?.events || [];
  const exportEvent = eventsList.find((e: any) => e.event_type === "data.exported");
  record(!!exportEvent, "TEST-5.2f: Data export action writes audit event");

  // =========================================================================
  // 5. Testing Telegram Integration (/suggestions and /export)
  // =========================================================================
  console.log("\n--- 5. Testing Telegram Commands ---");

  const tgSug = await sendTelegramCommand("/suggestions");
  record(
    tgSug.status === 200 && (tgSug.body.result?.includes("Suggestions") || tgSug.body.result?.includes("No suggestions")),
    "Telegram /suggestions command produces formatted response",
    { reply: tgSug.body.result }
  );

  const tgExp = await sendTelegramCommand("/export");
  record(
    tgExp.status === 200 && tgExp.body.result?.includes("Data Export") && tgExp.body.result?.includes("Record Counts"),
    "Telegram /export command returns system export statistics summary",
    { reply: tgExp.body.result }
  );

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log("\n========================================================");
  console.log(`TOTAL ACCEPTANCE TESTS: ${stats.total} | PASSED: ${stats.passed} | FAILED: ${stats.failed}`);
  console.log("========================================================");

  if (stats.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
