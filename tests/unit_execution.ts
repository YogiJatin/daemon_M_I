/**
 * tests/unit_execution.ts — Block 9 Execution Layer, Safe Browser & Camera Unit Tests
 *
 * Requirements:
 * - Risk Tier Evaluation (Tier 1 safe, Tier 2 moderate, Tier 3 restricted)
 * - Cryptographic Approval Hash binding & Approval Swap defense
 * - Safe Typed Adapters: Desktop, Browser, Filesystem, Terminal
 * - Terminal Security: Zero arbitrary commands; allowlisted keys only
 * - Browser Security Policy & Safe Browser Sandbox launch profile
 * - Camera Capture: Permission gating and content-addressed attachment storage
 */

import { ExecutionPlanner } from "../worker/executionPlanner";
import { ExecutionService } from "../worker/executionService";
import { DesktopAdapter } from "../worker/providers/desktop/desktopAdapter";
import { TerminalAdapter } from "../worker/providers/terminal/terminalAdapter";
import { FilesystemAdapter } from "../worker/providers/filesystem/filesystemAdapter";
import { BrowserPolicyEngine } from "../worker/browserPolicy";
import { SafeBrowserService } from "../worker/safeBrowserService";
import { MockCameraProvider } from "../worker/cameraProvider";
import { CameraIngressService } from "../worker/cameraIngress";
import { createMockD1 } from "./mockD1";

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, name: string, details?: any) {
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
    passCount++;
  } else {
    console.error(`  ❌ FAIL: ${name}`, details ? JSON.stringify(details, null, 2) : "");
    failCount++;
  }
}

async function runExecutionUnitTests() {
  console.log("\n=== RUNNING BLOCK 9 EXECUTION, SAFE BROWSER & CAMERA UNIT TESTS ===\n");
  const db = createMockD1();
  const env = { DB: db, TEST_MODE: "true" };
  const fixedNow = new Date("2026-10-21T10:00:00.000Z");

  // ----------------------------------------------------
  // 1. Risk Tier Evaluation & Tier 3 Defense
  // ----------------------------------------------------
  console.log("--- 1. Risk Tier Evaluation & Tier 3 Defense ---");
  const safeTier = ExecutionPlanner.evaluateRiskTier([
    {
      stepIndex: 0,
      adapter: "desktop",
      action: "media_key",
      parameters: { key: "play_pause" },
      description: "Play/pause media",
    },
  ]);
  assert(safeTier === "tier_1_safe", "Media key evaluated as 'tier_1_safe'");

  const moderateTier = ExecutionPlanner.evaluateRiskTier([
    {
      stepIndex: 0,
      adapter: "desktop",
      action: "launch_app",
      parameters: { app: "spotify" },
      description: "Launch Spotify",
    },
  ]);
  assert(moderateTier === "tier_2_moderate", "App launch evaluated as 'tier_2_moderate'");

  let tier3Blocked = false;
  try {
    await ExecutionPlanner.createPlan(
      db,
      {
        intent: "Malicious execution attempt",
        steps: [
          {
            stepIndex: 0,
            adapter: "terminal",
            action: "powershell_eval",
            parameters: { code: "Remove-Item -Recurse C:\\" },
            description: "Arbitrary code execution",
          },
        ],
      },
      env,
      fixedNow
    );
  } catch (err: any) {
    tier3Blocked = true;
  }
  assert(tier3Blocked, "Tier 3 restricted action (eval/arbitrary command) is strictly blocked");

  // ----------------------------------------------------
  // 2. Cryptographic Approval Hash & Approval Swap Defense
  // ----------------------------------------------------
  console.log("\n--- 2. Cryptographic Approval Hash Binding ---");
  const plan = await ExecutionPlanner.createPlan(
    db,
    {
      intent: "Open project workspace",
      steps: [
        {
          stepIndex: 0,
          adapter: "desktop",
          action: "launch_app",
          parameters: { app: "chrome" },
          description: "Open Chrome",
        },
      ],
    },
    env,
    fixedNow
  );

  assert(plan.status === "pending_approval", "Tier 2 plan starts in 'pending_approval' status");
  assert(typeof plan.approvalHash === "string" && plan.approvalHash.length === 64, "Plan receives 64-char SHA-256 approvalHash");

  // Approval swap attempt with wrong hash must fail
  let swapRejected = false;
  try {
    await ExecutionService.approvePlan(db, plan.id, "wrong_hash_tampered_1234567890abcdef", env, fixedNow);
  } catch {
    swapRejected = true;
  }
  assert(swapRejected, "Mismatched approval hash is rejected (Approval Swap Defense)");

  // Approval with exact matching hash succeeds
  const approvedPlan = await ExecutionService.approvePlan(db, plan.id, plan.approvalHash!, env, fixedNow);
  assert(approvedPlan.status === "approved", "Plan approved successfully with matching hash");

  // ----------------------------------------------------
  // 3. Typed Adapters & Security Allowlist Enforcement
  // ----------------------------------------------------
  console.log("\n--- 3. Typed Adapters & Allowlist Rules ---");
  // DesktopAdapter
  const appLaunch = await DesktopAdapter.launchApp("spotify");
  assert(appLaunch.success === true && appLaunch.target === "spotify:", "Allowlisted app 'spotify' resolves to target");

  let disallowedAppRejected = false;
  try {
    await DesktopAdapter.launchApp("malicious_rootkit.exe");
  } catch {
    disallowedAppRejected = true;
  }
  assert(disallowedAppRejected, "Non-allowlisted app execution is rejected");

  const mediaKey = await DesktopAdapter.sendMediaKey("play_pause");
  assert(mediaKey.success === true, "Allowed media key 'play_pause' succeeds");

  // TerminalAdapter (Zero arbitrary shell strings)
  const termCmd = await TerminalAdapter.executeCommand("git_status");
  assert(termCmd.success === true && termCmd.command === "git status --porcelain", "Fixed command template 'git_status' succeeds");

  let arbitraryCmdBlocked = false;
  try {
    await TerminalAdapter.executeCommand("rm -rf /; echo pwned");
  } catch {
    arbitraryCmdBlocked = true;
  }
  assert(arbitraryCmdBlocked, "Arbitrary terminal command string is strictly rejected");

  // FilesystemAdapter (Path traversal defense)
  const fileCopy = await FilesystemAdapter.copyFile("vault/notes.md", "temp/notes_copy.md");
  assert(fileCopy.success === true, "Filesystem copy within safe roots succeeds");

  let traversalBlocked = false;
  try {
    await FilesystemAdapter.copyFile("../../Windows/System32/config/SAM", "temp/stolen_sam");
  } catch {
    traversalBlocked = true;
  }
  assert(traversalBlocked, "Path traversal escape (../) is strictly blocked");

  // ----------------------------------------------------
  // 4. Execution Plan Execution & Verification
  // ----------------------------------------------------
  console.log("\n--- 4. Plan Execution & Verification ---");
  const execResult = await ExecutionService.executePlan(db, plan.id, env, fixedNow);
  assert(execResult.status === "completed", "Plan execution completed successfully");
  assert(execResult.verified === true, "Plan outcome verified");
  assert(execResult.executedSteps === 1, "Executed 1 planned step");

  // ----------------------------------------------------
  // 5. Browser Policy Engine & Safe Browser Mode
  // ----------------------------------------------------
  console.log("\n--- 5. Browser Policy Engine & Sandbox Launch ---");
  // Streaming / ad-heavy site
  const streamingEval = await BrowserPolicyEngine.evaluate(db, "https://anime-watch.stream/episode1");
  assert(streamingEval.policy === "safe-browser-only", "Streaming site classified as 'safe-browser-only'");
  assert(streamingEval.isolationLevel === "disposable_sandbox", "Streaming site assigned 'disposable_sandbox'");

  // Trusted platform
  const trustedEval = await BrowserPolicyEngine.evaluate(db, "https://github.com/torvalds/linux");
  assert(trustedEval.policy === "trusted", "Allowlisted platform classified as 'trusted'");

  // Prepare safe browser launch plan
  const launchPlan = await SafeBrowserService.prepareLaunch(db, "https://kisscartoon.xyz/watch", env, fixedNow);
  assert(launchPlan.allowed === true, "Launch plan prepared");
  assert(launchPlan.flags.incognito === true, "Safe browser enforces incognito flag");
  assert(launchPlan.flags.disableNotifications === true, "Safe browser blocks notifications");
  assert(typeof launchPlan.userDataDir === "string", "Safe browser isolates user data dir sandbox");

  // ----------------------------------------------------
  // 6. Camera Capture & Permission Gating
  // ----------------------------------------------------
  console.log("\n--- 6. Camera Capture Ingress & Permission Gating ---");
  // Permission denied check
  const deniedProvider = new MockCameraProvider(false);
  let camPermissionBlocked = false;
  try {
    await CameraIngressService.captureAndIngest(db, deniedProvider, "still", {}, env, fixedNow);
  } catch {
    camPermissionBlocked = true;
  }
  assert(camPermissionBlocked, "Camera capture without permission is strictly blocked");

  // Permission granted check
  const allowedProvider = new MockCameraProvider(true);
  const camResult = await CameraIngressService.captureAndIngest(
    db,
    allowedProvider,
    "document",
    { candidateTitle: "Syllabus Whiteboard" },
    env,
    fixedNow
  );
  assert(camResult.captureId.startsWith("cam_"), "Camera capture receives 'cam_' prefix");
  assert(camResult.mode === "document", "Camera mode preserved as 'document'");
  assert(camResult.sha256Hash.length === 64, "Attachment content-addressed via 64-char SHA-256");

  // Verify camera record in D1 database
  const camRow = await db.prepare("SELECT * FROM camera_captures WHERE id = ?").bind(camResult.captureId).first<any>();
  assert(Boolean(camRow), "Camera capture stored in camera_captures table");
  assert(camRow.attachment_id === camResult.attachmentId, "Links to stored attachment row");

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log("\n========================================");
  console.log(`TOTAL: ${passCount + failCount} | PASSED: ${passCount} | FAILED: ${failCount}`);
  console.log("========================================\n");

  if (failCount > 0) {
    process.exit(1);
  }
}

runExecutionUnitTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
