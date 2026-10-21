/**
 * tests/run_block9_acceptance.ts — Block 9 Live Acceptance Test Battery
 *
 * Requirements:
 * - TEST-9.1: Scheduler Isolation Invariant (Rule 4)
 * - TEST-9.2: Teach Mode Session Arming & Recording (/api/v1/teach/start, /api/v1/teach/step)
 * - TEST-9.3: Trace Compilation into Structured Recipe (/api/v1/teach/compile)
 * - TEST-9.4: Recipe Approval & Memory OS Ingestion (/api/v1/teach/:id/approve)
 * - TEST-9.5: Safe Browser Policy & Sandboxed Boundary Launch (/api/v1/browser/*)
 * - TEST-9.6: Permission-Gated Camera Capture Ingress (/api/v1/camera/capture)
 * - TEST-9.7: Cryptographic Approval Hash Binding & Execution (/api/v1/execution/*)
 * - TEST-9.8: Obsidian Mirror Markdown Generation & Export (/api/v1/obsidian/*)
 * - TEST-9.9: System Portability Export includes Block 9 Tables (/api/v1/export)
 */

import { handleApiRequest } from "../worker/apiRouter";
import { createMockD1 } from "./mockD1";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, name: string, details?: any) {
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
    passedCount++;
  } else {
    console.error(`  ❌ FAIL: ${name}`, details ? JSON.stringify(details, null, 2) : "");
    failedCount++;
  }
}

async function request(
  method: string,
  urlPath: string,
  body: any = null,
  env: any,
  now: Date
): Promise<{ status: number; json: any; res: Response }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const init: RequestInit = {
    method,
    headers,
  };
  if (body) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const req = new Request(`https://personal-ai-os.local${urlPath}`, init);
  const session = {
    token_hash: "hash_test_owner",
    label: "Test Session",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86400000).toISOString(),
    last_seen_at: now.toISOString(),
  };

  const res = await handleApiRequest(req, env, session, now);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, res };
}

async function runBlock9Acceptance() {
  console.log("\n========================================================");
  console.log("   BLOCK 9 — DESKTOP INTELLIGENCE & TEACH MODE ACCEPTANCE");
  console.log("========================================================\n");

  const db = createMockD1();
  const env = {
    DB: db,
    TELEGRAM_OWNER_ID: "8364430714",
    TELEGRAM_BOT_TOKEN: "mock_token",
    TEST_MODE: "true",
  };
  const fixedNow = new Date("2026-10-21T10:00:00.000Z");

  // ----------------------------------------------------
  // TEST-9.1: Scheduler Isolation Invariant (Rule 4)
  // ----------------------------------------------------
  console.log("--- 1. Scheduler Isolation Invariant (Rule 4) ---");
  const schedulerCode = fs.readFileSync(path.join(__dirname, "../worker/scheduler.ts"), "utf8");
  const recurrenceCode = fs.readFileSync(path.join(__dirname, "../worker/recurrenceEngine.ts"), "utf8");
  const timetableCode = fs.readFileSync(path.join(__dirname, "../worker/timetableEngine.ts"), "utf8");
  const notificationCode = fs.readFileSync(path.join(__dirname, "../worker/notificationPlanner.ts"), "utf8");
  const capabilityRegistryCode = fs.readFileSync(path.join(__dirname, "../worker/aiCapabilityRegistry.ts"), "utf8");
  const executionPlannerCode = fs.readFileSync(path.join(__dirname, "../worker/aiExecutionPlanner.ts"), "utf8");

  const desktopRegex = /teachMode|teachRecorder|teachCompiler|safeBrowser|executionService|obsidianMirror/i;
  assert(!desktopRegex.test(schedulerCode), "Rule 4: worker/scheduler.ts has 0 references to Desktop/Teach Layer");
  assert(!desktopRegex.test(recurrenceCode), "Rule 4: worker/recurrenceEngine.ts has 0 references to Desktop/Teach Layer");
  assert(!desktopRegex.test(timetableCode), "Rule 4: worker/timetableEngine.ts has 0 references to Desktop/Teach Layer");
  assert(!desktopRegex.test(notificationCode), "Rule 4: worker/notificationPlanner.ts has 0 references to Desktop/Teach Layer");
  assert(!desktopRegex.test(capabilityRegistryCode), "Rule 4: worker/aiCapabilityRegistry.ts has 0 references to Desktop/Teach Layer");
  assert(!desktopRegex.test(executionPlannerCode), "Rule 4: worker/aiExecutionPlanner.ts has 0 references to Desktop/Teach Layer");

  // ----------------------------------------------------
  // TEST-9.2 & 9.3: Teach Mode Arming, Tracing & Compilation
  // ----------------------------------------------------
  console.log("\n--- 2. Teach Mode Arming & Recipe Compilation ---");
  const startRes = await request(
    "POST",
    "/api/v1/teach/start",
    {
      title: "Archive Research Papers to Vault",
      appContext: "browser:desktop",
    },
    env,
    fixedNow
  );
  assert(startRes.status === 201, "POST /api/v1/teach/start returns HTTP 201 Created");
  assert(startRes.json.data.session.id.startsWith("teach_"), "Teach session ID assigned");
  const sessionId = startRes.json.data.session.id;

  // Record Step 1: Navigation
  const stepRes1 = await request(
    "POST",
    "/api/v1/teach/step",
    {
      sessionId,
      actionType: "browser_navigate",
      intentSummary: "Navigate to arXiv cs.OS latest papers",
      targetSelector: "https://arxiv.org/list/cs.OS/recent",
    },
    env,
    fixedNow
  );
  assert(stepRes1.status === 201, "Step 1 recorded successfully");

  // Record Step 2: Keypress with sensitive input
  const stepRes2 = await request(
    "POST",
    "/api/v1/teach/step",
    {
      sessionId,
      actionType: "keypress",
      intentSummary: "Type vault token key",
      rawInput: "api_key_secret_12345",
    },
    env,
    fixedNow
  );
  assert(stepRes2.status === 201, "Step 2 recorded successfully");
  assert(stepRes2.json.data.step.inputSanitized === "[REDACTED_SECRET]", "Secret input masked to [REDACTED_SECRET]");

  // Compile trace to recipe
  const compileRes = await request(
    "POST",
    "/api/v1/teach/compile",
    {
      sessionId,
      title: "arXiv OS Papers Archiver",
      intent: "Download and mirror latest OS papers",
      triggerType: "manual",
    },
    env,
    fixedNow
  );
  assert(compileRes.status === 201, "POST /api/v1/teach/compile returns HTTP 201");
  assert(compileRes.json.data.recipe.recipeId.startsWith("recipe_"), "Recipe ID generated");
  assert(compileRes.json.data.recipe.status === "draft", "Compiled recipe starts in 'draft' status");
  const recipeId = compileRes.json.data.recipe.recipeId;

  // ----------------------------------------------------
  // TEST-9.4: Recipe Inspection & Approval
  // ----------------------------------------------------
  console.log("\n--- 3. Recipe Inspection & Memory OS Ingestion ---");
  const getRecipeRes = await request("GET", `/api/v1/teach/recipes/${recipeId}`, null, env, fixedNow);
  assert(getRecipeRes.status === 200, "GET /api/v1/teach/recipes/:id returns HTTP 200");
  assert(getRecipeRes.json.data.recipe.id === recipeId, "Returns expected recipe ID");

  // Approve recipe -> Canonicalize into Memory OS
  const approveRes = await request("POST", `/api/v1/teach/${recipeId}/approve`, {}, env, fixedNow);
  assert(approveRes.status === 200, "POST /api/v1/teach/:id/approve returns HTTP 200");
  assert(approveRes.json.data.approved === true, "Recipe approval acknowledged");
  assert(approveRes.json.data.recipe.status === "approved", "Recipe status updated to 'approved'");
  assert(typeof approveRes.json.data.recipe.memoryObjectId === "string", "Recipe links to canonical MemoryObject");

  // ----------------------------------------------------
  // TEST-9.5: Safe Browser Mode & Policies
  // ----------------------------------------------------
  console.log("\n--- 4. Safe Browser Mode & Policy Enforcement ---");
  // Set custom policy
  const setPolRes = await request(
    "POST",
    "/api/v1/browser/policy",
    {
      pattern: "*.anime-hub.xyz",
      policy: "safe-browser-only",
      isolationLevel: "disposable_sandbox",
      reason: "Ad-heavy streaming mirror",
    },
    env,
    fixedNow
  );
  assert(setPolRes.status === 201, "POST /api/v1/browser/policy updates policy rule");

  // Observe URL policy
  const obsRes = await request("POST", "/api/v1/browser/observe", { url: "https://sub.anime-hub.xyz/play" }, env, fixedNow);
  assert(obsRes.status === 200, "POST /api/v1/browser/observe returns HTTP 200");
  assert(obsRes.json.data.evaluation.policy === "safe-browser-only", "Evaluates to 'safe-browser-only'");
  assert(obsRes.json.data.evaluation.isolationLevel === "disposable_sandbox", "Evaluates to 'disposable_sandbox'");

  // Open safe browser
  const openRes = await request("POST", "/api/v1/browser/open", { url: "https://sub.anime-hub.xyz/play" }, env, fixedNow);
  assert(openRes.status === 200, "POST /api/v1/browser/open returns HTTP 200");
  assert(openRes.json.data.launchPlan.flags.incognito === true, "Enforces incognito boundary");
  assert(openRes.json.data.launchPlan.flags.disableNotifications === true, "Enforces notification blocking");

  // ----------------------------------------------------
  // TEST-9.6: Permission-Gated Camera Capture
  // ----------------------------------------------------
  console.log("\n--- 5. Permission-Gated Camera Capture Ingress ---");
  const camRes = await request(
    "POST",
    "/api/v1/camera/capture",
    {
      mode: "whiteboard",
      permission: true,
      title: "Lecture 5 Page Tables Diagram",
    },
    env,
    fixedNow
  );
  assert(camRes.status === 201, "POST /api/v1/camera/capture returns HTTP 201 Created");
  assert(camRes.json.data.capture.captureId.startsWith("cam_"), "Capture receives 'cam_' ID");
  assert(typeof camRes.json.data.capture.attachmentId === "string", "Snapshot stored in content-addressed attachments table");

  // ----------------------------------------------------
  // TEST-9.7: Cryptographic Approval Hash & Execution
  // ----------------------------------------------------
  console.log("\n--- 6. Cryptographic Approval Hash Binding & Execution ---");
  const planRes = await request(
    "POST",
    "/api/v1/execution/plan",
    {
      intent: "Refresh developer environment",
      steps: [
        {
          stepIndex: 0,
          adapter: "terminal",
          action: "run_command",
          parameters: { commandKey: "git_status" },
          description: "Check working directory git status",
        },
      ],
    },
    env,
    fixedNow
  );
  assert(planRes.status === 201, "POST /api/v1/execution/plan returns HTTP 201 Created");
  assert(planRes.json.data.plan.riskTier === "tier_2_moderate", "Plan classified as 'tier_2_moderate'");
  const execPlanId = planRes.json.data.plan.id;
  const approvalHash = planRes.json.data.plan.approvalHash;

  // Approve plan with exact hash
  const approvePlanRes = await request(
    "POST",
    `/api/v1/execution/${execPlanId}/approve`,
    { approvalHash },
    env,
    fixedNow
  );
  assert(approvePlanRes.status === 200, "POST /api/v1/execution/:id/approve returns HTTP 200");
  assert(approvePlanRes.json.data.plan.status === "approved", "Plan status is 'approved'");

  // Run execution
  const runPlanRes = await request("POST", `/api/v1/execution/${execPlanId}/execute`, {}, env, fixedNow);
  assert(runPlanRes.status === 200, "POST /api/v1/execution/:id/execute returns HTTP 200");
  assert(runPlanRes.json.data.execution.status === "completed", "Execution finished with status 'completed'");

  // ----------------------------------------------------
  // TEST-9.8: Obsidian Mirror Markdown Generation
  // ----------------------------------------------------
  console.log("\n--- 7. Obsidian Mirror Markdown Generation ---");
  const obsWorkflowsRes = await request("GET", "/api/v1/obsidian/workflows", null, env, fixedNow);
  assert(obsWorkflowsRes.status === 200, "GET /api/v1/obsidian/workflows returns HTTP 200");
  assert(obsWorkflowsRes.json.data.count >= 1, "Obsidian mirror contains at least 1 approved recipe");

  const firstNote = obsWorkflowsRes.json.data.workflows[0];
  assert(firstNote.filename.endsWith(".md"), "Exported note filename has .md extension");
  assert(
    firstNote.markdown.includes(
      "Approved teach recipes are exported to Obsidian as Markdown, but the Personal AI OS database remains the canonical source of truth for workflow state, versions, and approvals."
    ),
    "Note includes mandatory canonical OS source of truth notice"
  );
  assert(
    obsWorkflowsRes.json.data.canonicalNotice.includes("canonical source of truth"),
    "Response payload includes canonical source notice"
  );

  // ----------------------------------------------------
  // TEST-9.9: System Portability Export Integration
  // ----------------------------------------------------
  console.log("\n--- 8. System Portability Export (/api/v1/export) ---");
  const exportRes = await request("GET", "/api/v1/export", null, env, fixedNow);
  assert(exportRes.status === 200, "GET /api/v1/export returns HTTP 200");
  assert(typeof exportRes.json.data.counts.teach_sessions === "number", "Export counts include teach_sessions");
  assert(typeof exportRes.json.data.counts.workflow_recipes === "number", "Export counts include workflow_recipes");
  assert(typeof exportRes.json.data.counts.browser_policies === "number", "Export counts include browser_policies");
  assert(typeof exportRes.json.data.counts.execution_plans === "number", "Export counts include execution_plans");
  assert(Array.isArray(exportRes.json.data.data.workflow_recipes), "Export payload contains workflow_recipes array");

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log("\n========================================================");
  console.log(`TOTAL ACCEPTANCE TESTS: ${passedCount + failedCount}`);
  console.log(`PASSED: ${passedCount}`);
  console.log(`FAILED: ${failedCount}`);
  console.log("========================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runBlock9Acceptance().catch((err) => {
  console.error("Acceptance test runner crashed:", err);
  process.exit(1);
});
