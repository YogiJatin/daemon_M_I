/**
 * tests/unit_teach.ts — Block 9 Teach Mode & Obsidian Mirror Unit Tests
 *
 * Requirements:
 * - Rule 4 Invariant: worker/scheduler.ts and core engines untouched
 * - Teach Mode: explicit arming, step recording, credential sanitization
 * - Trace Compiler: compiles event traces into structured intent-based recipes
 * - Recipe Approval: approves recipe and canonicalizes into Memory OS
 * - Obsidian Mirror: exports approved recipes as human-readable Markdown notes
 * - Invariant: Personal AI OS remains canonical source of truth; zero secrets in Obsidian
 */

import { TeachModeController } from "../worker/teachMode";
import { TeachRecorder } from "../worker/teachRecorder";
import { TeachCompiler } from "../worker/teachCompiler";
import { TeachRecipeService } from "../worker/teachRecipeService";
import { ObsidianMirror } from "../worker/obsidianMirror";
import { ObsidianExportService } from "../worker/obsidianExport";
import { createMockD1 } from "./mockD1";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function runTeachUnitTests() {
  console.log("\n=== RUNNING BLOCK 9 TEACH MODE & OBSIDIAN MIRROR UNIT TESTS ===\n");
  const db = createMockD1();
  const env = { DB: db, TEST_MODE: "true" };
  const fixedNow = new Date("2026-10-21T10:00:00.000Z");

  // ----------------------------------------------------
  // 1. Untouched Files & Scheduler Isolation (Rule 4)
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
  // 2. Teach Mode Arming & Step Recording
  // ----------------------------------------------------
  console.log("\n--- 2. Teach Mode Arming & Credential Sanitization ---");
  const session = await TeachModeController.startSession(
    db,
    {
      title: "Export Midterm Student Grades",
      appContext: "browser:chrome",
    },
    env,
    fixedNow
  );

  assert(session.id.startsWith("teach_"), "Teach session ID has 'teach_' prefix");
  assert(session.status === "recording", "Teach session initialized in 'recording' status");

  // Record Step 1: Normal action
  const step1 = await TeachRecorder.recordStep(
    db,
    {
      sessionId: session.id,
      actionType: "browser_navigate",
      intentSummary: "Navigate to university grading portal",
      targetSelector: "https://portal.university.edu/grades",
    },
    env,
    fixedNow
  );
  assert(step1.id.startsWith("tstep_"), "Teach step receives 'tstep_' prefix");
  assert(step1.stepIndex === 0, "First step has zero-based index 0");

  // Record Step 2: Credential input (must be sanitized)
  const step2 = await TeachRecorder.recordStep(
    db,
    {
      sessionId: session.id,
      actionType: "keypress",
      intentSummary: "Input portal password",
      targetSelector: "#password-input",
      rawInput: "SecretPassword123!",
    },
    env,
    fixedNow
  );
  assert(step2.inputSanitized === "[REDACTED_SECRET]", "Password is strictly sanitized to '[REDACTED_SECRET]'");

  // Record Step 3: Export click
  const step3 = await TeachRecorder.recordStep(
    db,
    {
      sessionId: session.id,
      actionType: "click",
      intentSummary: "Click download CSV report button",
      targetSelector: "button#export-csv",
    },
    env,
    fixedNow
  );
  assert(step3.stepIndex === 2, "Third step has index 2");

  const steps = await TeachRecorder.getSteps(db, session.id);
  assert(steps.length === 3, "Retrieved all 3 recorded trace steps");

  // ----------------------------------------------------
  // 3. Trace Compilation into Structured Recipe
  // ----------------------------------------------------
  console.log("\n--- 3. Recipe Compilation & Confidence Scoring ---");
  const compiled = await TeachCompiler.compileSession(
    db,
    session.id,
    {
      title: "Grade Portal Export Recipe",
      intent: "Export midterm grade CSV from university portal",
    },
    env,
    fixedNow
  );

  assert(compiled.recipeId.startsWith("recipe_"), "Compiled recipe has 'recipe_' prefix");
  assert(compiled.status === "draft", "Compiled recipe starts in 'draft' status (approval required)");
  assert(compiled.confidence > 0.8, "Confidence score is positively evaluated (> 0.8)");
  assert(compiled.steps.length === 3, "Compiled recipe contains 3 sequential steps");
  assert(compiled.steps[0].adapter === "browser", "Step 1 correctly mapped to browser adapter");
  assert(compiled.steps[1].adapter === "desktop", "Step 2 correctly mapped to desktop adapter");

  // Verify session transitioned to completed
  const updatedSession = await TeachModeController.getSession(db, session.id);
  assert(updatedSession?.status === "completed", "Teach session transitioned to 'completed'");

  // ----------------------------------------------------
  // 4. Recipe Lifecycle & Memory OS Canonicalization
  // ----------------------------------------------------
  console.log("\n--- 4. Recipe Approval & Memory OS Ingestion ---");
  const approvedRecipe = await TeachRecipeService.approveRecipe(db, compiled.recipeId, env, fixedNow);

  assert(approvedRecipe.status === "approved", "Recipe transitioned to 'approved'");
  assert(typeof approvedRecipe.memoryObjectId === "string", "Approved recipe links to canonical MemoryObject");
  assert(approvedRecipe.memoryObjectId?.startsWith("mem_"), "MemoryObject ID has 'mem_' prefix");

  // Verify MemoryObject was durably created in memory_objects table
  const memoryRow = await db
    .prepare("SELECT * FROM memory_objects WHERE id = ?")
    .bind(approvedRecipe.memoryObjectId)
    .first<any>();
  assert(Boolean(memoryRow), "Canonical MemoryObject exists in D1 database");
  assert(memoryRow.type === "note", "MemoryObject type is 'note'");
  assert(memoryRow.source === "teach_mode", "MemoryObject source stamped as 'teach_mode'");

  // ----------------------------------------------------
  // 5. Obsidian Mirror & Markdown Generation
  // ----------------------------------------------------
  console.log("\n--- 5. Obsidian Mirror & Markdown Generation ---");
  const note = ObsidianMirror.formatRecipeNote(approvedRecipe);

  assert(note.filename.endsWith(".md"), "Obsidian note filename has .md extension");
  assert(note.markdown.includes("---"), "Note contains YAML frontmatter block");
  assert(note.markdown.includes(`recipe_id: "${approvedRecipe.id}"`), "Frontmatter contains recipe_id");
  assert(
    note.markdown.includes(
      "Approved teach recipes are exported to Obsidian as Markdown, but the Personal AI OS database remains the canonical source of truth for workflow state, versions, and approvals."
    ),
    "Note contains canonical OS source of truth disclaimer"
  );
  assert(note.markdown.includes("## Step-by-Step Procedure"), "Note contains step-by-step section");
  assert(!note.markdown.includes("SecretPassword123!"), "Note contains ZERO unredacted passwords");

  // Obsidian Vault Export Service
  const vaultExport = await ObsidianExportService.exportAllWorkflows(db);
  assert(vaultExport.count >= 1, "Vault export contains at least 1 approved recipe");
  assert(vaultExport.notes[0].recipeId === approvedRecipe.id, "Export payload includes approved recipe");

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

runTeachUnitTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
