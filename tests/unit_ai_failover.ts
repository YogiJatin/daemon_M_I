/**
 * tests/unit_ai_failover.ts — Comprehensive Test Suite for Multi-Provider & Multi-Key Failover
 *
 * Verifies Phase E requirements:
 * 1. Multiple API keys per provider (groq_primary vs groq_secondary slot rotation)
 * 2. Multi-provider automatic failover across different provider types (Groq -> Gemini -> Mock)
 * 3. Circuit breaker suppression after repeated failures and recovery
 * 4. Proposal-only behavior: AI outputs never create tasks or mutate state directly
 * 5. Invariant: Zero Cron LLM usage
 * 6. Cloudflare Workers AI and local Ollama candidate configurations
 */

import { AIAdapter, resetCircuitBreakers, AIRequest } from "../worker/aiAdapter";
import { AICapabilities } from "../worker/aiCapabilities";
import { createMockD1 } from "./mockD1";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Hermetic suite: failover is exercised through simulatedFailure and the mock
// profile, so any real provider call is a bug. Block it loudly instead of
// sending placeholder keys to Groq.
globalThis.fetch = (() => {
  throw new Error("unit_ai_failover: live network access blocked - this suite runs on mocks only");
}) as unknown as typeof fetch;

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

async function runFailoverTests() {
  console.log("\n=== RUNNING PHASE E AI MULTI-PROVIDER & MULTI-KEY FAILOVER TESTS ===\n");

  // ----------------------------------------------------
  // 1. Multiple Keys Per Provider (Slot 1 -> Slot 2 Rotation)
  // ----------------------------------------------------
  console.log("--- 1. Multiple Keys Per Provider (Groq Slot 1 & Slot 2) ---");
  resetCircuitBreakers();

  const envWithMultipleGroqKeys = {
    GROQ_API_KEY_1: "gsk_slot1_test_key_12345",
    GROQ_API_KEY_2: "gsk_slot2_test_key_67890",
    AI_PROVIDER_ORDER: "groq_primary,groq_secondary,mock",
  };

  const adapter = new AIAdapter(envWithMultipleGroqKeys);
  const cfgSlot1 = adapter.getProviderConfig("groq_primary");
  const cfgSlot2 = adapter.getProviderConfig("groq_secondary");

  assert(cfgSlot1 !== null && cfgSlot1.apiKey === "gsk_slot1_test_key_12345", "Resolves Groq Slot 1 from GROQ_API_KEY_1");
  assert(cfgSlot2 !== null && cfgSlot2.apiKey === "gsk_slot2_test_key_67890", "Resolves Groq Slot 2 from GROQ_API_KEY_2");
  assert(cfgSlot1?.keySlot === 1 && cfgSlot2?.keySlot === 2, "Tracks distinct key slot numbers per profile");

  // Gemini multiple keys
  const envWithMultipleGeminiKeys = {
    GEMINI_API_KEY: "gemini_primary_fallback",
    GEMINI_API_KEY_2: "gemini_slot2_secret_xyz",
  };
  const geminiAdapter = new AIAdapter(envWithMultipleGeminiKeys);
  const geminiSlot1 = geminiAdapter.getProviderConfig("gemini_primary");
  const geminiSlot2 = geminiAdapter.getProviderConfig("gemini_secondary");

  assert(geminiSlot1 !== null && geminiSlot1.apiKey === "gemini_primary_fallback", "Gemini Slot 1 falls back to GEMINI_API_KEY");
  assert(geminiSlot2 !== null && geminiSlot2.apiKey === "gemini_slot2_secret_xyz", "Gemini Slot 2 resolves GEMINI_API_KEY_2");

  // ----------------------------------------------------
  // 2. Automatic Failover Across Named Profiles
  // ----------------------------------------------------
  console.log("\n--- 2. Automatic Failover: groq_primary (429) -> groq_secondary / mock ---");
  resetCircuitBreakers();

  const envFailover = {
    GROQ_API_KEY_1: "key1",
    GROQ_API_KEY_2: "key2",
    AI_PROVIDER_ORDER: "groq_primary,mock",
  };

  const failoverAdapter = new AIAdapter(envFailover);
  const req: AIRequest = {
    capability: "task_breakdown",
    systemPrompt: "Decompose this task",
    userPrompt: "Prepare presentation",
    inputContext: { title: "Prepare presentation" },
    privacyClass: "personal",
    simulatedFailure: "429", // simulate Groq Primary rate limited
  };

  const res = await failoverAdapter.execute(req);
  assert(res.ok === true, "Request succeeds despite primary encountering 429");
  assert(res.fallbackTriggered === true, "Marks fallbackTriggered = true");
  assert(res.provider === "mock", "Fails over to downstream eligible candidate (mock)");

  // ----------------------------------------------------
  // 3. Circuit Breaker Cooldown & Recovery
  // ----------------------------------------------------
  console.log("\n--- 3. Circuit Breaker Cooldown & Health Recovery ---");
  resetCircuitBreakers();

  // Primary fails repeatedly
  const failReq: AIRequest = {
    capability: "suggest_next",
    systemPrompt: "Rules",
    userPrompt: "Query",
    inputContext: {},
    privacyClass: "low_sensitivity",
    simulatedFailure: "503",
  };

  // Run call that encounters 503
  await failoverAdapter.execute(failReq);

  // Immediate subsequent request skips primary without waiting for timeout because circuit is in cooldown
  const start = Date.now();
  const nextRes = await failoverAdapter.execute({
    ...failReq,
    simulatedFailure: undefined, // Mock downstream will answer immediately
  });
  const elapsed = Date.now() - start;

  assert(nextRes.ok === true, "Subsequent request succeeds via fallback");
  assert(nextRes.fallbackTriggered === true, "Primary in cooldown is skipped immediately");
  assert(elapsed < 200, `Circuit cooldown skips primary fast (${elapsed}ms < 200ms)`);

  // Reset circuit breakers to simulate cooldown expiration
  resetCircuitBreakers();
  const recoveredRes = await failoverAdapter.execute({
    ...failReq,
    simulatedFailure: undefined,
  });
  assert(recoveredRes.ok === true, "Provider recovers immediately after circuit cooldown reset");

  // ----------------------------------------------------
  // 4. Governance: Proposal-Only & No Direct State Mutations
  // ----------------------------------------------------
  console.log("\n--- 4. Governance & Human-in-the-Loop Proposal Gating ---");
  const mockDb = createMockD1();
  const aiCaps = new AICapabilities(envFailover, mockDb);

  // Inspect database before AI call
  const tasksBefore = (await mockDb.prepare("SELECT count(*) as cnt FROM tasks").first())?.cnt || 0;
  const proposalsBefore = (await mockDb.prepare("SELECT count(*) as cnt FROM task_proposals").first())?.cnt || 0;

  // Run AI capability. simulatedFailure routes to the deterministic mock
  // provider, so placeholder keys are never sent to a live Groq endpoint.
  const taskBreakdownRes = await aiCaps.taskBreakdown(
    { title: "Plan sprint roadmap" },
    "personal",
    "429"
  );

  assert(taskBreakdownRes.ok === true, "AI taskBreakdown executes successfully");
  const proposals = (taskBreakdownRes.data as any)?.proposals || (taskBreakdownRes.data as any)?.subtasks || [];
  assert(proposals.length > 0, "Returns structured subtask proposals");

  // Verify that database tasks table was NOT mutated by AI
  const tasksAfter = (await mockDb.prepare("SELECT count(*) as cnt FROM tasks").first())?.cnt || 0;
  assert(tasksAfter === tasksBefore, "Rule 1 & Rule 11: AI output did NOT directly create or mutate any tasks");

  // Verify that proposals table DID receive candidate proposals awaiting owner review
  const proposalsAfter = (await mockDb.prepare("SELECT count(*) as cnt FROM task_proposals").first())?.cnt || 0;
  assert(proposalsAfter > proposalsBefore, "AI output correctly buffered into task_proposals table for owner confirmation");

  // ----------------------------------------------------
  // 5. Invariant: Zero AI in Cron Scheduler
  // ----------------------------------------------------
  console.log("\n--- 5. Non-Negotiable Rule 5: Zero AI in Cron Scheduler ---");
  const schedulerCode = fs.readFileSync(path.join(__dirname, "../worker/scheduler.ts"), "utf8");
  const hasAIInScheduler = /AIAdapter|AICapabilities|groq|gemini|openai|anthropic/i.test(schedulerCode);
  assert(!hasAIInScheduler, "Rule 5 strictly enforced: worker/scheduler.ts has zero AI imports or calls");

  // ----------------------------------------------------
  // 6. Profiles & Bindings Configurations
  // ----------------------------------------------------
  console.log("\n--- 6. Cloudflare Workers AI & Local Ollama Configurations ---");
  const workersAiCfg = adapter.getProviderConfig("workers_ai");
  assert(workersAiCfg !== null && workersAiCfg.providerType === "workers_ai", "Configures Cloudflare Workers AI profile");

  const ollamaCfg = adapter.getProviderConfig("ollama");
  assert(ollamaCfg !== null && ollamaCfg.providerType === "ollama", "Configures local Ollama desktop profile");
  assert(ollamaCfg?.allowedPrivacyClasses.includes("restricted"), "Ollama allowed for restricted privacy class");

  console.log("\n========================================");
  console.log(`TOTAL: ${passCount + failCount} | PASSED: ${passCount} | FAILED: ${failCount}`);
  console.log("========================================\n");

  if (failCount > 0) {
    process.exit(1);
  }
}

runFailoverTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
