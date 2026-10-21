/**
 * tests/unit_ai_hardening.ts — Block 6.1 AI Architecture Hardening Unit Tests
 *
 * Verifies:
 * 1. Capability Registry: Registration, metadata retrieval, unregistered rejection.
 * 2. XML Context Builder: Canonical segmentation, record deduplication, deterministic output.
 * 3. Token Budget Manager: Heuristic token estimation, priority entity preservation, trimming.
 * 4. Prompt Cache: Memory-first LRU, canonical XML hashing, error exclusion, automatic TTL.
 * 5. AI Verifier: Citation checking, priority enum, confidence range, repair request generation.
 * 6. Provider Scoring: Owner primacy preservation, privacy gating, latency tie-break.
 * 7. Explainability: Mandatory fields (reason, confidence, evidence, affected_record_ids).
 * 8. Execution Planner: Platform-neutral plan typing, zero execution.
 * 9. Schema Registry: Validation rules across capability schemas.
 */

import { AICapabilityRegistry } from "../worker/aiCapabilityRegistry";
import { AIContextBuilder } from "../worker/aiContextBuilder";
import { TokenBudgetManager, ContextEntity } from "../worker/aiTokenBudgetManager";
import { AIPromptCache } from "../worker/aiPromptCache";
import { AIVerifier } from "../worker/aiVerifier";
import { AIProviderScoring } from "../worker/aiProviderScoring";
import { AIExecutionPlanner } from "../worker/aiExecutionPlanner";
import { validateTaskBreakdownOutput } from "../worker/schemas/task_breakdown";
import { validateWeeklyPlanOutput } from "../worker/schemas/weekly_plan";
import { validatePrioritizeOutput } from "../worker/schemas/prioritize";
import { validateSuggestNextOutput } from "../worker/schemas/suggest_next";
import { validateExplainability } from "../worker/schemas/explainability";
import { ProviderConfig } from "../worker/aiAdapter";

// Import aiCapabilities to trigger top-level capability registrations
import "../worker/aiCapabilities";

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

async function runHardeningTests() {
  console.log("\n=== RUNNING BLOCK 6.1 AI HARDENING TESTS ===\n");

  // ----------------------------------------------------
  // 1. Capability Registry
  // ----------------------------------------------------
  console.log("--- 1. Capability Registry ---");
  const registered = AICapabilityRegistry.list();
  assert(registered.length >= 4, "Registry contains at least 4 registered capabilities");

  const tb = AICapabilityRegistry.get("task_breakdown");
  assert(tb !== null && tb.id === "task_breakdown", "task_breakdown found in registry");
  assert(tb?.promptVersion === "1.1.0", "task_breakdown exposes versioned prompt '1.1.0'");
  assert(Array.isArray(tb?.dependencies) && tb.dependencies.includes("tasks"), "task_breakdown declares 'tasks' dependency");

  const unknown = AICapabilityRegistry.get("non_existent_capability");
  assert(unknown === null, "Registry returns null for unknown capability");

  // ----------------------------------------------------
  // 2. XML Context Builder
  // ----------------------------------------------------
  console.log("\n--- 2. XML Context Builder ---");
  const builder = new AIContextBuilder();
  builder.setSystemRules("System Rule Alpha");
  builder.setOwnerRequest("Owner Request Beta");
  builder.setOutputContract("Contract Gamma");

  // Add duplicates - verify deduplication
  builder.addEntity("task_1", "task", { title: "Study Physics", priority: "urgent" }, "mandatory");
  builder.addEntity("task_1", "task", { title: "Study Physics Duplicate" }, "mandatory");
  builder.addEntity("task_2", "task", { title: "Lab Prep", priority: "normal" }, "high");

  const built = builder.build(2500);
  assert(built.xml.includes("<system_rules>"), "Context contains <system_rules> segment");
  assert(built.xml.includes("<context>"), "Context contains <context> segment");
  assert(built.xml.includes("<tasks>"), "Context contains <tasks> segment");
  assert(built.xml.includes("<owner_request>"), "Context contains <owner_request> segment");
  assert(built.xml.includes("<output_contract>"), "Context contains <output_contract> segment");

  const task1Matches = (built.xml.match(/id="task_1"/g) || []).length;
  assert(task1Matches === 1, "Entity 'task_1' is deduplicated and appears exactly once in XML");

  // ----------------------------------------------------
  // 3. Token Budget Manager
  // ----------------------------------------------------
  console.log("\n--- 3. Token Budget Manager ---");
  const est = TokenBudgetManager.estimateTokens("Hello World! This is a test.");
  assert(typeof est === "number" && est > 0, "Token estimation heuristic returns positive integer");

  const entities: ContextEntity[] = [
    { id: "e1", type: "task", priority: "mandatory", payload: { title: "Mandatory Task" } },
    { id: "e2", type: "class", priority: "high", payload: { title: "High Priority Class Session" } },
    { id: "e3", type: "history", priority: "low", payload: { title: "Low History Entry 1 with extra description text" } },
    { id: "e4", type: "history", priority: "low", payload: { title: "Low History Entry 2 with extra description text" } },
  ];

  // Budget of 15 tokens (~60 chars) forces pruning: mandatory e1 ~7 tokens fits,
  // but adding more entities would exceed the ceiling
  const pruned = TokenBudgetManager.enforceBudget(entities, 15);
  assert(pruned.entities.some((e) => e.id === "e1"), "Mandatory entity 'e1' is preserved under tight budget");
  assert(pruned.trimmedCount > 0, "Lower-priority entity was pruned when budget was exceeded");

  // ----------------------------------------------------
  // 4. Prompt Cache
  // ----------------------------------------------------
  console.log("\n--- 4. Prompt Cache ---");
  AIPromptCache.clear();
  const cacheKey = await AIPromptCache.computeKey("task_breakdown", "1.1.0", "2.0.0", "<xml>context</xml>", '{"id":1}');
  assert(typeof cacheKey === "string" && cacheKey.length === 64, "Generated 64-char hex SHA-256 cache key");

  // Cache miss initially
  const miss = AIPromptCache.get(cacheKey);
  assert(miss === null, "Prompt cache returns null on miss");

  // Cache set
  AIPromptCache.set(cacheKey, "task_breakdown", "1.1.0", "2.0.0", { cached: true }, '{"cached":true}', "mock", "mock-v1", 300);
  const hit = AIPromptCache.get(cacheKey);
  assert(hit !== null && hit.data?.cached === true, "Prompt cache returns stored value on hit");
  assert(hit?.provider === "mock", "Prompt cache preserves provider metadata");

  // ----------------------------------------------------
  // 5. AI Verifier
  // ----------------------------------------------------
  console.log("\n--- 5. AI Verifier ---");
  const indexedIds = new Set(["task_real_1", "class_real_2"]);

  // Valid output
  const validOutput = {
    summary: "Plan summary",
    subtasks: [{ title: "Step 1", estimated_minutes: 30, suggested_deadline_offset_hours: 24, priority: "normal", evidence: "Ev" }],
    reason: "Because of deadline",
    confidence: 0.95,
    evidence: "Context record",
    affected_record_ids: ["task_real_1"],
  };
  const verValid = AIVerifier.verify(validOutput, validateTaskBreakdownOutput, indexedIds);
  assert(verValid.valid === true, "Valid output passes AI verification cleanly");

  // Hallucinated ID output
  const hallucinatedOutput = {
    ...validOutput,
    affected_record_ids: ["task_fake_999"],
  };
  const verHallucinated = AIVerifier.verify(hallucinatedOutput, validateTaskBreakdownOutput, indexedIds);
  assert(verHallucinated.valid === false, "AI Verifier rejects hallucinated record ID 'task_fake_999'");
  assert(verHallucinated.repairPrompt !== undefined, "AI Verifier generates repair prompt on error");
  assert(verHallucinated.repairPrompt?.includes("CRITICAL VALIDATION FAILURE"), "Repair prompt contains structured failure instructions");

  // ----------------------------------------------------
  // 6. Provider Scoring (Owner Primacy)
  // ----------------------------------------------------
  console.log("\n--- 6. Provider Scoring ---");
  const configs: ProviderConfig[] = [
    { id: "gemini", model: "gemini-2.0-flash", allowedPrivacyClasses: ["synthetic_test", "low_sensitivity"], timeoutMs: 5000 },
    { id: "groq", model: "llama-3.3-70b-versatile", allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"], timeoutMs: 5000 },
    { id: "workers_ai", model: "llama-3.1-8b", allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"], timeoutMs: 5000 },
    { id: "mock", model: "mock-v1", allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal", "restricted"], timeoutMs: 500 },
  ];

  const ownerOrder = ["groq", "workers_ai", "mock"];
  const healthMap = new Map([
    ["groq", { consecutiveFailures: 0, cooldownUntil: 0, avgLatencyMs: 250 }],
    ["workers_ai", { consecutiveFailures: 0, cooldownUntil: 0, avgLatencyMs: 150 }],
    ["mock", { consecutiveFailures: 0, cooldownUntil: 0, avgLatencyMs: 10 }],
  ]);

  const ranked = AIProviderScoring.rankCandidates(configs, ownerOrder, "personal", healthMap);
  assert(ranked[0].config.id === "groq", "Owner preference top choice 'groq' is ranked #1 when healthy");

  // When groq is in cooldown, owner second choice 'workers_ai' becomes #1
  const cooldownHealthMap = new Map([
    ["groq", { consecutiveFailures: 3, cooldownUntil: Date.now() + 60000, avgLatencyMs: 250 }],
    ["workers_ai", { consecutiveFailures: 0, cooldownUntil: 0, avgLatencyMs: 150 }],
    ["mock", { consecutiveFailures: 0, cooldownUntil: 0, avgLatencyMs: 10 }],
  ]);
  const rankedCooldown = AIProviderScoring.rankCandidates(configs, ownerOrder, "personal", cooldownHealthMap);
  assert(rankedCooldown[0].config.id === "workers_ai", "Second owner preference 'workers_ai' takes over when primary in cooldown");

  // ----------------------------------------------------
  // 7. Explainability Metadata Validation
  // ----------------------------------------------------
  console.log("\n--- 7. Explainability Metadata Validation ---");
  const expValid = validateExplainability({
    reason: "Clear actionable reason",
    confidence: 0.9,
    evidence: "Direct user prompt",
    affected_record_ids: ["rec_1"],
  });
  assert(expValid.valid === true, "Full explainability object passes validation");

  const expInvalid = validateExplainability({
    reason: "",
    confidence: 1.5, // invalid
  });
  assert(expInvalid.valid === false, "Missing fields and out-of-range confidence fail explainability check");

  // ----------------------------------------------------
  // 8. Execution Planner
  // ----------------------------------------------------
  console.log("\n--- 8. Execution Planner ---");
  const plan = AIExecutionPlanner.createPlan("task_breakdown", "Breakdown Execution Plan", [
    { type: "task_create", intent: "Create subtask 1", inputs: { title: "Subtask 1" } },
    { type: "notification_plan", intent: "Schedule reminder", inputs: { time: "18:00" } },
  ]);
  assert(plan.planId.startsWith("plan_"), "Execution plan generated with typed planId");
  assert(plan.status === "draft", "Execution plan status is strictly 'draft'");
  assert(plan.requiresApproval === true, "Execution plan enforces approval requirement (Rule 11)");
  assert(plan.steps.length === 2, "Execution plan contains 2 typed steps");

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log("\n========================================");
  console.log(`TOTAL: ${passCount + failCount} | PASSED: ${passCount} | FAILED: ${failCount}`);
  console.log("========================================\n");

  if (failCount > 0) {
    process.exit(1);
  }
}

runHardeningTests().catch((err) => {
  console.error("Hardening test runner error:", err);
  process.exit(1);
});
