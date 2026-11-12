/**
 * tests/unit_reply_text_shape.ts - reply_text must always leave the adapter as a string.
 *
 * Production printed "[object Object]" to the owner when a provider answered
 * reply_text as an object ({"text": "..."}). The adapter now pulls the text out, and an
 * unreadable object becomes an empty string so the caller can fall back.
 */

import assert from "node:assert";
import { AIAdapter, resetCircuitBreakers } from "../worker/aiAdapter";
// Side-effect import: registers the telegram_assistant capability.
import "../worker/telegramAssistant";

let passed = 0;
let failed = 0;

async function it(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL: ${name}\n     ${err?.message || err}`);
  }
}

function waiEnv(payload: unknown) {
  return {
    WORKERS_AI_MODEL: "@cf/test-model",
    AI_PROVIDER_ORDER: "workers_ai",
    AI: {
      run: async () => ({ response: typeof payload === "string" ? payload : JSON.stringify(payload) }),
    },
  } as any;
}

async function run(env: any) {
  resetCircuitBreakers();
  const adapter = new AIAdapter(env);
  return adapter.executeCapability<any, any>(
    "telegram_assistant",
    { userText: "yoo" },
    "personal",
    undefined,
    new Date()
  );
}

async function main() {
  console.log("\n=== reply_text shape ===\n");

  await it("an object reply_text with .text becomes that string", async () => {
    const res = await run(waiEnv({ intent: "chat", confidence: 0.9, reply_text: { text: "Morning." } }));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.reply_text, "Morning.");
    assert.doesNotMatch(String(res.data.reply_text), /\[object Object\]/);
  });

  await it("an object reply_text with .reply becomes that string", async () => {
    const res = await run(waiEnv({ intent: "chat", confidence: 0.9, reply_text: { reply: "Still here." } }));
    assert.strictEqual(res.data.reply_text, "Still here.");
  });

  await it("an unreadable reply_text object becomes empty, never [object Object]", async () => {
    const res = await run(waiEnv({ intent: "chat", confidence: 0.9, reply_text: { nope: 1 } }));
    assert.strictEqual(res.data.reply_text, "");
    assert.doesNotMatch(String(res.data.reply_text), /\[object Object\]/);
  });

  await it("a plain string reply_text is untouched", async () => {
    const res = await run(waiEnv({ intent: "chat", confidence: 0.9, reply_text: "Sure thing." }));
    assert.strictEqual(res.data.reply_text, "Sure thing.");
  });

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
