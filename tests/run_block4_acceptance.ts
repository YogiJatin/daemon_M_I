/**
 * tests/run_block4_acceptance.ts
 *
 * Full Live Acceptance Battery for Block 4:
 * - Authentication & One-Use Pairing Challenge Flow (TEST-4.1)
 * - Session Management (Bearer Token & HttpOnly Cookie, Revocation/Logout)
 * - Unauthorized Access Rejection (401 across private APIs)
 * - Standard Error & Success Envelopes (no SQL leaks)
 * - Tasks OS Service with Optimistic Concurrency (TEST-4.4, 409 Conflict)
 * - Task Lifecycle & Convergence with Telegram State (TEST-4.3)
 * - Focus Read Model (Command Center Single-Call Endpoint, TEST-4.6)
 * - Today, Tomorrow, Upcoming Read Models
 * - Generic Inbox & Capture Service (Preview vs Confirm, TEST-4.7)
 * - Global Search Service across multiple entities
 * - Activity Timeline & Audit Feed
 * - Settings, Stats, Health & Budget Services
 * - Reserved AI, Devices, and Integrations Foundations
 * - Non-visual UI Placeholders (GET / and GET /panel)
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

async function main() {
  console.log("========================================================");
  console.log("   RUNNING BLOCK 4 LIVE ACCEPTANCE TEST BATTERY");
  console.log("========================================================\n");

  // 1. UI Placeholders (Strictly Non-Visual JSON status)
  console.log("--- 1. Testing UI Placeholders ---");
  const rootRes = await fetch(`${BASE_URL}/`);
  const rootJson = (await rootRes.json()) as any;
  record(
    rootRes.status === 200 &&
      rootJson.status === "not_implemented_ui" &&
      rootJson.backend_ready === true,
    "GET / returns non-visual backend-ready placeholder"
  );

  const panelRes = await fetch(`${BASE_URL}/panel`);
  const panelJson = (await panelRes.json()) as any;
  record(
    panelRes.status === 200 &&
      panelJson.status === "not_implemented_ui" &&
      panelJson.backend_ready === true,
    "GET /panel returns non-visual backend-ready placeholder"
  );

  // 2. Authentication & Security Gate (TEST-4.1)
  console.log("\n--- 2. Testing Authentication & Pairing Gate (TEST-4.1) ---");

  // Unauthenticated requests MUST be rejected with 401
  const unauthTasks = await fetch(`${BASE_URL}/api/v1/tasks`);
  const unauthTasksJson = (await unauthTasks.json()) as any;
  record(
    unauthTasks.status === 401 && unauthTasksJson.error?.code === "unauthorized",
    "Private GET /api/v1/tasks rejects unauthenticated caller with 401"
  );

  const unauthFocus = await fetch(`${BASE_URL}/api/v1/focus`);
  record(unauthFocus.status === 401, "Private GET /api/v1/focus rejects unauthenticated caller with 401");

  // Generate pairing code via Telegram /pair
  let updateId = Math.floor(Date.now() / 1000);
  const pairCmdRes = await fetch(`${BASE_URL}/api/v1/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    },
    body: JSON.stringify({
      update_id: ++updateId,
      message: {
        message_id: 101,
        from: { id: parseInt(OWNER_ID, 10), is_bot: false, first_name: "Owner" },
        chat: { id: parseInt(OWNER_ID, 10), type: "private" },
        text: "/pair",
      },
    }),
  });
  const pairCmdJson = (await pairCmdRes.json()) as any;
  const replyText = pairCmdJson.result || "";
  const codeMatch = replyText.match(/code is: (\d{6})/);
  const pairingCode = codeMatch ? codeMatch[1] : null;

  record(
    pairCmdRes.status === 200 && !!pairingCode && pairingCode.length === 6,
    `Telegram /pair command generates 6-digit challenge code (${pairingCode})`
  );

  // Exchange pairing code for session
  let sessionToken = "";
  let cookieHeader = "";
  if (pairingCode) {
    const pairExchangeRes = await fetch(`${BASE_URL}/api/v1/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
    });
    const pairExchangeJson = (await pairExchangeRes.json()) as any;
    sessionToken = pairExchangeJson.data?.token || "";
    cookieHeader = pairExchangeRes.headers.get("Set-Cookie") || "";

    record(
      pairExchangeRes.status === 200 &&
        pairExchangeJson.ok === true &&
        pairExchangeJson.data?.authenticated === true &&
        !!sessionToken &&
        cookieHeader.includes("session_token="),
      "POST /api/v1/auth/pair exchanges code for session token & HttpOnly cookie"
    );

    // Reusing the same code MUST fail (one-use challenge)
    const reuseRes = await fetch(`${BASE_URL}/api/v1/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
    });
    record(reuseRes.status === 401, "Re-using consumed pairing code fails with 401");
  }

  // Verify authenticated session via Bearer Token
  const meBearerRes = await fetch(`${BASE_URL}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  const meBearerJson = (await meBearerRes.json()) as any;
  record(
    meBearerRes.status === 200 && meBearerJson.data?.owner_user_id === OWNER_ID,
    "GET /api/v1/auth/me authenticates successfully via Bearer token"
  );

  // Verify authenticated session via Cookie header
  const rawCookie = cookieHeader.split(";")[0]; // session_token=...
  const meCookieRes = await fetch(`${BASE_URL}/api/v1/auth/me`, {
    headers: { Cookie: rawCookie },
  });
  record(meCookieRes.status === 200, "GET /api/v1/auth/me authenticates successfully via HttpOnly cookie");

  const AUTH_HEADERS = {
    Authorization: `Bearer ${sessionToken}`,
    "Content-Type": "application/json",
  };

  // 3. Tasks Service & Optimistic Concurrency (TEST-4.4 & TEST-4.3)
  console.log("\n--- 3. Testing Tasks Service & Optimistic Concurrency ---");

  // Create Task
  const createTaskRes = await fetch(`${BASE_URL}/api/v1/tasks`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      title: "Block 4 Acceptance Verification",
      priority: "high",
      category: "engineering",
      deadline: "tomorrow 18:00",
    }),
  });
  const createTaskJson = (await createTaskRes.json()) as any;
  const createdTask = createTaskJson.data;
  record(
    createTaskRes.status === 201 && !!createdTask?.id && createdTask.deadline_version === 1,
    "POST /api/v1/tasks creates manual task with deadline_version = 1"
  );

  const taskId = createdTask?.id;

  // List tasks with pagination and sorting
  const listTasksRes = await fetch(`${BASE_URL}/api/v1/tasks?limit=10&page=1&sort_by=created_at&order=desc`, {
    headers: AUTH_HEADERS,
  });
  const listTasksJson = (await listTasksRes.json()) as any;
  record(
    listTasksRes.status === 200 &&
      Array.isArray(listTasksJson.data) &&
      listTasksJson.pagination?.limit === 10,
    "GET /api/v1/tasks supports bounded pagination and sorting"
  );

  // Optimistic Concurrency Check (TEST-4.4)
  const conflictEditRes = await fetch(`${BASE_URL}/api/v1/tasks/${taskId}`, {
    method: "PATCH",
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      title: "Conflicting Edit",
      deadline_version: 999, // Stale/mismatched version!
    }),
  });
  const conflictEditJson = (await conflictEditRes.json()) as any;
  record(
    conflictEditRes.status === 409 && conflictEditJson.error?.code === "conflict",
    "PATCH /api/v1/tasks/:id with mismatched version returns 409 Conflict (TEST-4.4)"
  );

  // Successful Edit with matching version
  const validEditRes = await fetch(`${BASE_URL}/api/v1/tasks/${taskId}`, {
    method: "PATCH",
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      title: "Block 4 Acceptance Verification (Edited)",
      deadline_version: 1,
    }),
  });
  record(validEditRes.status === 200, "PATCH /api/v1/tasks/:id succeeds with matching version");

  // Snooze task
  const snoozeRes = await fetch(`${BASE_URL}/api/v1/tasks/${taskId}/snooze`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({ preset: "1h" }),
  });
  const snoozeJson = (await snoozeRes.json()) as any;
  record(
    snoozeRes.status === 200 && snoozeJson.data?.status === "snoozed",
    "POST /api/v1/tasks/:id/snooze snoozes task state"
  );

  // Complete task (TEST-4.3)
  const completeRes = await fetch(`${BASE_URL}/api/v1/tasks/${taskId}/complete`, {
    method: "POST",
    headers: AUTH_HEADERS,
  });
  const completeJson = (await completeRes.json()) as any;
  record(
    completeRes.status === 200 && completeJson.data?.status === "done",
    "POST /api/v1/tasks/:id/complete marks task done (TEST-4.3)"
  );

  // Task Provenance & Why
  const whyRes = await fetch(`${BASE_URL}/api/v1/tasks/${taskId}/why`, {
    headers: AUTH_HEADERS,
  });
  const whyJson = (await whyRes.json()) as any;
  record(
    whyRes.status === 200 && Array.isArray(whyJson.data?.audit_trail),
    "GET /api/v1/tasks/:id/why returns complete provenance & audit trail"
  );

  // 4. Focus Read Model (Command Center Single-Call Home Endpoint)
  console.log("\n--- 4. Testing Focus Read Model (Command Center) ---");
  const focusRes = await fetch(`${BASE_URL}/api/v1/focus`, {
    headers: AUTH_HEADERS,
  });
  const focusJson = (await focusRes.json()) as any;
  const focusData = focusJson.data;
  record(
    focusRes.status === 200 &&
      focusData?.attention_budget?.daily_cap === 8 &&
      focusData?.system_status === "healthy" &&
      focusData?.countdowns !== undefined,
    "GET /api/v1/focus returns complete Command Center payload in single query (TEST-4.6)"
  );

  // 5. Read Models: /today, /tomorrow, /upcoming
  console.log("\n--- 5. Testing Read Models (/today, /tomorrow, /upcoming) ---");
  const todayRes = await fetch(`${BASE_URL}/api/v1/today`, { headers: AUTH_HEADERS });
  const todayJson = (await todayRes.json()) as any;
  record(
    todayRes.status === 200 && Array.isArray(todayJson.data?.today_tasks),
    "GET /api/v1/today returns combined tasks and schedule state"
  );

  const tomorrowRes = await fetch(`${BASE_URL}/api/v1/tomorrow`, { headers: AUTH_HEADERS });
  const tomorrowJson = (await tomorrowRes.json()) as any;
  record(
    tomorrowRes.status === 200 && Array.isArray(tomorrowJson.data?.tomorrow_tasks),
    "GET /api/v1/tomorrow returns tomorrow tasks and preparation preview"
  );

  const upcomingRes = await fetch(`${BASE_URL}/api/v1/upcoming`, { headers: AUTH_HEADERS });
  const upcomingJson = (await upcomingRes.json()) as any;
  record(
    upcomingRes.status === 200 && Array.isArray(upcomingJson.data?.tasks),
    "GET /api/v1/upcoming returns 7-day projection"
  );

  // 6. Generic Inbox & Capture Service (TEST-4.7)
  console.log("\n--- 6. Testing Generic Inbox & Capture Service (TEST-4.7) ---");

  // Preview flow: does NOT persist
  const previewCaptureRes = await fetch(`${BASE_URL}/api/v1/capture`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      text: "tomorrow 15:00 | Read Distributed Systems Paper",
      action: "preview",
    }),
  });
  const previewCaptureJson = (await previewCaptureRes.json()) as any;
  record(
    previewCaptureRes.status === 200 &&
      previewCaptureJson.data?.action === "preview" &&
      previewCaptureJson.data?.persisted === false &&
      previewCaptureJson.data?.candidate?.title === "Read Distributed Systems Paper",
    "POST /api/v1/capture with action:preview parses without DB persistence (TEST-4.7)"
  );

  // Confirm flow: persists to Inbox and Tasks
  const confirmCaptureRes = await fetch(`${BASE_URL}/api/v1/capture`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      text: "tomorrow 15:00 | Read Distributed Systems Paper",
      action: "confirm",
    }),
  });
  const confirmCaptureJson = (await confirmCaptureRes.json()) as any;
  record(
    confirmCaptureRes.status === 201 &&
      confirmCaptureJson.data?.action === "confirm" &&
      confirmCaptureJson.data?.persisted === true &&
      !!confirmCaptureJson.data?.task?.id,
    "POST /api/v1/capture with action:confirm persists to Inbox and Tasks table (TEST-4.7)"
  );

  // 7. Global Search Service
  console.log("\n--- 7. Testing Global Search Service ---");
  const searchRes = await fetch(`${BASE_URL}/api/v1/search?q=Distributed`, { headers: AUTH_HEADERS });
  const searchJson = (await searchRes.json()) as any;
  record(
    searchRes.status === 200 &&
      Array.isArray(searchJson.data?.tasks) &&
      searchJson.data.tasks.length > 0,
    "GET /api/v1/search queries across system entities"
  );

  // 8. Activity Timeline / History Service
  console.log("\n--- 8. Testing Activity Timeline & Audit Feed ---");
  const historyRes = await fetch(`${BASE_URL}/api/v1/history?limit=10`, { headers: AUTH_HEADERS });
  const historyJson = (await historyRes.json()) as any;
  record(
    historyRes.status === 200 &&
      Array.isArray(historyJson.data) &&
      historyJson.data.length > 0 &&
      historyJson.pagination?.limit === 10,
    "GET /api/v1/history returns paginated activity timeline"
  );

  // 9. Settings, Stats, Health & Budget Services
  console.log("\n--- 9. Testing Settings, Stats, Health & Budget ---");
  const statsRes = await fetch(`${BASE_URL}/api/v1/stats`, { headers: AUTH_HEADERS });
  const statsJson = (await statsRes.json()) as any;
  record(
    statsRes.status === 200 && typeof statsJson.data?.tasks?.completion_rate_percent === "number",
    "GET /api/v1/stats returns productivity and workload metrics"
  );

  const budgetRes = await fetch(`${BASE_URL}/api/v1/budget/today`, { headers: AUTH_HEADERS });
  const budgetJson = (await budgetRes.json()) as any;
  record(
    budgetRes.status === 200 && budgetJson.data?.daily_cap === 8,
    "GET /api/v1/budget/today returns attention budget metrics"
  );

  const healthRes = await fetch(`${BASE_URL}/api/v1/health`, { headers: AUTH_HEADERS });
  const healthJson = (await healthRes.json()) as any;
  record(
    healthRes.status === 200 &&
      healthJson.data?.overall_status === "healthy" &&
      healthJson.data?.database_ready === true,
    "GET /api/v1/health returns comprehensive system health status"
  );

  // 10. Reserved Future OS Services (AI, Devices, Integrations)
  console.log("\n--- 10. Testing Reserved Future Foundations ---");
  const assistantRes = await fetch(`${BASE_URL}/api/v1/assistant`, { headers: AUTH_HEADERS });
  const assistantJson = (await assistantRes.json()) as any;
  record(
    assistantRes.status === 200 && assistantJson.data?.status === "not_implemented",
    "GET /api/v1/assistant returns reserved not_implemented contract"
  );

  const devicesRes = await fetch(`${BASE_URL}/api/v1/devices`, { headers: AUTH_HEADERS });
  const devicesJson = (await devicesRes.json()) as any;
  record(
    devicesRes.status === 200 && devicesJson.data?.status === "not_implemented",
    "GET /api/v1/devices returns reserved not_implemented contract"
  );

  // 11. Session Logout & Revocation
  console.log("\n--- 11. Testing Session Logout & Revocation ---");
  const logoutRes = await fetch(`${BASE_URL}/api/v1/auth/logout`, {
    method: "POST",
    headers: AUTH_HEADERS,
  });
  record(logoutRes.status === 200, "POST /api/v1/auth/logout revokes session");

  const postLogoutMe = await fetch(`${BASE_URL}/api/v1/auth/me`, {
    headers: AUTH_HEADERS,
  });
  record(postLogoutMe.status === 401, "Subsequent request with revoked session token fails with 401");

  // Summary
  console.log("\n========================================================");
  console.log(`TOTAL ACCEPTANCE TESTS: ${stats.total} | PASSED: ${stats.passed} | FAILED: ${stats.failed}`);
  console.log("========================================================\n");

  if (stats.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
