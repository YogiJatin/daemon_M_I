/**
 * tests/unit_daemon_prompt.ts — Daemon prompt + temperature (Stage 1)
 *
 * Verifies:
 * 1. DAEMON_SYSTEM_PROMPT carries the terse Daemon rules and keeps the
 *    classifier sections (anchors, rubric, invariants, few-shot, multi-intent,
 *    JSON contract) plus language matching.
 * 2. The registered telegram_assistant capability uses that constant, so every
 *    provider/fallback receives the same system prompt.
 * 3. Groq, Gemini and Workers AI all receive temperature <= 0.2, honor an
 *    explicit 0, and clamp a hot value down to the ceiling.
 * 4. A plain-text prompt is sent as plain text on the Gemini path (no JSON mode).
 */

import assert from "node:assert";
import {
  DAEMON_SYSTEM_PROMPT,
  DAEMON_ANSWER_PROMPT,
  DAEMON_PERSONA,
  renderDaemonSystemPrompt,
} from "../worker/prompts";
import { AIAdapter, resetCircuitBreakers, MAX_CHAT_TEMPERATURE } from "../worker/aiAdapter";
import { AICapabilityRegistry } from "../worker/aiCapabilityRegistry";
// Side-effect import: registers the telegram_assistant capability.
import "../worker/telegramAssistant";

let passed = 0;
let failed = 0;

async function it(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL: ${name}\n     ${err.message}`);
  }
}

const JSON_REPLY = JSON.stringify({ intent: "chat", confidence: 0.9, reply_text: "No data." });

type Captured = { url: string; body: any };

function installFetchCapture(): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(init.body) : null;
    } catch {
      body = init?.body;
    }
    captured.push({ url, body });
    if (url.includes("api.groq.com")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON_REPLY } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON_REPLY }] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 200 });
  }) as any;
  return { captured, restore: () => { globalThis.fetch = original; } };
}

async function runCapability(env: any, temperature: number): Promise<void> {
  resetCircuitBreakers();
  const adapter = new AIAdapter(env);
  const res = await adapter.executeCapability<any, any>(
    "telegram_assistant",
    { userText: `probe-${Math.random().toString(36).slice(2)}`, temperature },
    "personal",
    undefined,
    new Date()
  );
  assert.strictEqual(res.ok, true, `capability failed: ${JSON.stringify(res.error)}`);
}

async function main() {
  console.log("\n=== Daemon prompt contract ===");

  await it("uses the persona v3 identity and the OWNER_STYLE contract", () => {
    assert.match(DAEMON_SYSTEM_PROMPT, /You are Daemon/);
    assert.match(DAEMON_SYSTEM_PROMPT, /right hand of Jatin/);
    assert.match(DAEMON_SYSTEM_PROMPT, /OWNER_STYLE in CONTEXT sets address terms/);
    assert.match(DAEMON_SYSTEM_PROMPT, /<modes>/);
    // The old persona hard-coded the address term: that is exactly what broke.
    assert.doesNotMatch(DAEMON_SYSTEM_PROMPT, /Address him as "sir"/);
  });

  await it("carries the conversation modes that stop small talk dead-ending", () => {
    for (const mode of ["OPERATE:", "CHAT:", "LEARN:", "ADVISE:", "SUPPORT:", "META:"]) {
      assert.ok(DAEMON_SYSTEM_PROMPT.includes(mode), `missing mode ${mode}`);
    }
    assert.match(DAEMON_SYSTEM_PROMPT, /Never answer chat with "no record"/);
    assert.match(DAEMON_SYSTEM_PROMPT, /Venting is not a policy violation/);
    assert.match(DAEMON_SYSTEM_PROMPT, /figurative/);
  });

  await it("forbids invented facts and action claims without a fixed dead-end", () => {
    assert.match(DAEMON_SYSTEM_PROMPT, /CONTEXT, SYSTEM RESULTS or/);
    assert.match(DAEMON_SYSTEM_PROMPT, /Never claim removed, deleted, saved, set, scheduled/);
    assert.match(DAEMON_SYSTEM_PROMPT, /Emit the action\./);
    assert.match(DAEMON_SYSTEM_PROMPT, /Never "sir, sir"/);
    assert.doesNotMatch(DAEMON_SYSTEM_PROMPT, /reply "No data\."/);
  });

  await it("declares the risk field and the style_update action", () => {
    assert.match(DAEMON_SYSTEM_PROMPT, /"risk": "none\|figurative\|possible"/);
    assert.match(DAEMON_SYSTEM_PROMPT, /"type":"style_update"/);
    assert.match(DAEMON_SYSTEM_PROMPT, /STYLE UPDATES \(style_update\)/);
  });

  await it("keeps language matching for English, Hinglish and Telugu", () => {
    assert.match(DAEMON_SYSTEM_PROMPT, /Hinglish/);
    assert.match(DAEMON_SYSTEM_PROMPT, /Telugu-mixed/);
  });

  await it("keeps the classifier sections from the previous prompt", () => {
    assert.match(DAEMON_SYSTEM_PROMPT, /ANCHOR MAPPINGS/);
    assert.match(DAEMON_SYSTEM_PROMPT, /CAPTURE RUBRIC for implicit_commitment/);
    assert.match(DAEMON_SYSTEM_PROMPT, /CRITICAL INVARIANTS FOR BODILY STATE VS COMMITMENT/);
    assert.match(DAEMON_SYSTEM_PROMPT, /FEW-SHOT EXAMPLES/);
    assert.match(DAEMON_SYSTEM_PROMPT, /MULTI-INTENT/);
    assert.match(DAEMON_SYSTEM_PROMPT, /OUTPUT FORMAT \(JSON only\)/);
  });

  await it("injects the capability manifest into the single constant", () => {
    const rendered = renderDaemonSystemPrompt("- Task & Reminder Tracking: capture");
    assert.match(rendered, /Task & Reminder Tracking/);
    assert.doesNotMatch(rendered, /\{\{CAPABILITY_MANIFEST\}\}/);
  });

  await it("registers the constant as the capability system prompt", () => {
    const capability = AICapabilityRegistry.get("telegram_assistant");
    assert.ok(capability, "telegram_assistant capability missing");
    assert.match(capability!.systemRules, /You are Daemon/);
    assert.match(capability!.systemRules, /ANCHOR MAPPINGS/);
  });

  await it("answer prompt shares the persona and no longer dead-ends on a fixed string", () => {
    assert.match(DAEMON_ANSWER_PROMPT, /You are Daemon/);
    assert.ok(DAEMON_ANSWER_PROMPT.startsWith(DAEMON_PERSONA), "persona block must lead the answer prompt");
    assert.doesNotMatch(DAEMON_ANSWER_PROMPT, /reply exactly: No data/i);
    // The phrase that used to be quoted as the example answer must be gone: the model
    // parroted it back to small talk.
    assert.doesNotMatch(DAEMON_ANSWER_PROMPT, /No record of that/);
    assert.match(DAEMON_ANSWER_PROMPT, /Follow OWNER_STYLE/);
    // Format comes from responseFormat on the request; the prompt says plain text, and
    // the adapter must not sniff that wording (covered by the Gemini case below).
    assert.match(DAEMON_ANSWER_PROMPT, /Plain text only/);
  });

  await it("classifier prompt carries the persona instead of the old STYLE/TRUTH split", () => {
    assert.ok(DAEMON_SYSTEM_PROMPT.startsWith(DAEMON_PERSONA), "persona block must lead the classifier prompt");
    assert.doesNotMatch(DAEMON_SYSTEM_PROMPT, /^STYLE$/m);
    assert.doesNotMatch(DAEMON_SYSTEM_PROMPT, /^TRUTH$/m);
    assert.doesNotMatch(DAEMON_SYSTEM_PROMPT, /reply "No data\."/i);
    assert.match(DAEMON_SYSTEM_PROMPT, /ANCHOR MAPPINGS/);
  });

  console.log("\n=== Provider temperature ceiling ===");

  const { captured, restore } = installFetchCapture();
  try {
    await it("Groq receives the requested temperature 0", async () => {
      const env = { GROQ_API_KEY: "test-key", GROQ_MODEL: "test-model", AI_PROVIDER_ORDER: "groq_primary" };
      await runCapability(env, 0);
      const call = captured.filter((c) => c.url.includes("api.groq.com")).at(-1);
      assert.ok(call, "Groq was not called");
      assert.strictEqual(call!.body.temperature, 0);
    });

    await it("Groq defaults to 0.1 when no temperature is requested", async () => {
      const env = { GROQ_API_KEY: "test-key", GROQ_MODEL: "test-model", AI_PROVIDER_ORDER: "groq_primary" };
      resetCircuitBreakers();
      const adapter = new AIAdapter(env);
      const res = await adapter.executeCapability<any, any>(
        "telegram_assistant",
        { userText: `probe-${Math.random().toString(36).slice(2)}` },
        "personal",
        undefined,
        new Date()
      );
      assert.strictEqual(res.ok, true);
      const call = captured.filter((c) => c.url.includes("api.groq.com")).at(-1);
      assert.strictEqual(call!.body.temperature, 0.1);
    });

    await it("Gemini clamps a hot request to the 0.2 ceiling", async () => {
      const env = {
        GEMINI_API_KEY: "test-key",
        GEMINI_ENABLED: "1",
        GEMINI_MODEL: "gemini-test",
        AI_PROVIDER_ORDER: "gemini_primary",
      };
      await runCapability(env, 0.9);
      const call = captured.filter((c) => c.url.includes("generativelanguage.googleapis.com")).at(-1);
      assert.ok(call, "Gemini was not called");
      assert.strictEqual(call!.body.generationConfig.temperature, MAX_CHAT_TEMPERATURE);
      assert.strictEqual(call!.body.generationConfig.temperature <= 0.2, true);
    });

    await it("Gemini omits JSON mode for the plain-text answer path", async () => {
      resetCircuitBreakers();
      const env = {
        GEMINI_API_KEY: "test-key",
        GEMINI_ENABLED: "1",
        GEMINI_MODEL: "gemini-test",
        AI_PROVIDER_ORDER: "gemini_primary",
      };
      const adapter = new AIAdapter(env);
      const res = await adapter.execute<any>(
        {
          capability: "telegram_assistant",
          systemPrompt: DAEMON_ANSWER_PROMPT,
          responseFormat: "text",
          userPrompt: "<DATA type=\"memory\">- [mem_1] third-year ECE student</DATA>",
          inputContext: {},
          privacyClass: "personal",
          temperature: 0.1,
        },
        new Date()
      );
      assert.strictEqual(res.ok, true, JSON.stringify(res.error));
      const call = captured.filter((c) => c.url.includes("generativelanguage.googleapis.com")).at(-1);
      assert.strictEqual(call!.body.generationConfig.responseMimeType, undefined);
      assert.strictEqual(call!.body.generationConfig.temperature, 0.1);
    });

    await it("Workers AI receives a clamped temperature on every call", async () => {
      let waiOptions: any = null;
      const env = {
        WORKERS_AI_MODEL: "@cf/test-model",
        AI_PROVIDER_ORDER: "workers_ai",
        AI: {
          run: async (_model: string, options: any) => {
            waiOptions = options;
            return { response: JSON_REPLY };
          },
        },
      };
      await runCapability(env, 0.9);
      assert.ok(waiOptions, "Workers AI was not called");
      assert.strictEqual(waiOptions.temperature, MAX_CHAT_TEMPERATURE);
      assert.strictEqual(waiOptions.temperature <= 0.2, true);
    });
  } finally {
    restore();
  }

  console.log(`\nTOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
