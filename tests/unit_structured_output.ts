/**
 * tests/unit_structured_output.ts - provider-enforced JSON output.
 *
 * Verifies:
 * 1. Capability schemas are normalised into the shape each provider accepts
 *    (Groq strict: required + additionalProperties false; Gemini: upper-case types).
 * 2. Groq receives json_schema when the request declares an outputSchema.
 * 3. A model that rejects the schema is retried once with json_object instead of
 *    failing the whole turn.
 * 4. The chat temperature ceiling is 0.1 and hot requests are clamped to it.
 */

import assert from "node:assert";
import {
  AIAdapter,
  MAX_CHAT_TEMPERATURE,
  resetCircuitBreakers,
  toGeminiSchema,
  toStrictJsonSchema,
} from "../worker/aiAdapter";
import { AICapabilityRegistry } from "../worker/aiCapabilityRegistry";
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

const originalFetch = globalThis.fetch;

interface CapturedCall {
  url: string;
  body: any;
}

function installFetchCapture(status = 200): { captured: CapturedCall[]; restore: () => void } {
  const captured: CapturedCall[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url || input);
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(init.body) : null;
    } catch {
      body = init?.body;
    }
    captured.push({ url, body });
    const payload = {
      choices: [{ message: { content: JSON.stringify({ intent: "chat", confidence: 0.9, reply_text: "Ok." }) } }],
    };
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as any;
  return { captured, restore: () => { globalThis.fetch = originalFetch; } };
}

async function runStructuredOutputTests() {
  console.log("\n=== Structured output ===\n");

  await it("strict schema marks every property required and forbids extras", () => {
    const strict = toStrictJsonSchema({
      type: "object",
      properties: {
        intent: { type: "string" },
        hour: { type: "integer", nullable: true },
        tasks: { type: "array", items: { type: "object", properties: { title: { type: "string" } } } },
      },
    });
    assert.deepStrictEqual(strict.required, ["intent", "hour", "tasks"]);
    assert.strictEqual(strict.additionalProperties, false);
    assert.deepStrictEqual(strict.properties.hour.type, ["integer", "null"]);
    assert.strictEqual(strict.properties.hour.nullable, undefined);
    assert.strictEqual(strict.properties.tasks.items.additionalProperties, false);
    assert.deepStrictEqual(strict.properties.tasks.items.required, ["title"]);
  });

  await it("Gemini schema uppercases types and drops additionalProperties", () => {
    const gemini = toGeminiSchema({
      type: "object",
      properties: {
        intent: { type: "string" },
        tasks: { type: "array", items: { type: "object", properties: { title: { type: "string" } } } },
      },
      additionalProperties: false,
    });
    assert.strictEqual(gemini.type, "OBJECT");
    assert.strictEqual(gemini.properties.intent.type, "STRING");
    assert.strictEqual(gemini.properties.tasks.type, "ARRAY");
    assert.strictEqual(gemini.properties.tasks.items.type, "OBJECT");
    assert.strictEqual(gemini.additionalProperties, undefined);
  });

  await it("the classifier capability declares an output schema", () => {
    const capability = AICapabilityRegistry.get("telegram_assistant");
    assert.ok(capability, "telegram_assistant missing");
    assert.ok(capability!.outputSchema, "outputSchema not declared");
    assert.strictEqual(capability!.outputSchema!.type, "object");
  });

  await it("Groq receives json_schema when an output schema is declared", async () => {
    resetCircuitBreakers();
    const { captured, restore } = installFetchCapture();
    try {
      const adapter = new AIAdapter({
        GROQ_API_KEY: "test-key",
        GROQ_MODEL: "test-model",
        AI_PROVIDER_ORDER: "groq_primary",
      });
      const schema = AICapabilityRegistry.get("telegram_assistant")!.outputSchema;
      const res = await adapter.execute<any>(
        {
          capability: "telegram_assistant",
          systemPrompt: "sys",
          userPrompt: "ping",
          inputContext: {},
          privacyClass: "personal",
          outputSchema: schema,
        },
        new Date()
      );
      assert.strictEqual(res.ok, true, JSON.stringify(res.error));
      const call = captured.filter((c) => c.url.includes("api.groq.com")).at(-1)!;
      assert.strictEqual(call.body.response_format.type, "json_schema");
      assert.strictEqual(call.body.response_format.json_schema.strict, true);
      assert.strictEqual(call.body.response_format.json_schema.schema.additionalProperties, false);
    } finally {
      restore();
    }
  });

  await it("Groq keeps json_object when no schema is declared", async () => {
    resetCircuitBreakers();
    const { captured, restore } = installFetchCapture();
    try {
      const adapter = new AIAdapter({
        GROQ_API_KEY: "test-key",
        GROQ_MODEL: "test-model",
        AI_PROVIDER_ORDER: "groq_primary",
      });
      await adapter.execute<any>(
        {
          capability: "telegram_assistant",
          systemPrompt: "sys",
          userPrompt: "ping",
          inputContext: {},
          privacyClass: "personal",
        },
        new Date()
      );
      const call = captured.filter((c) => c.url.includes("api.groq.com")).at(-1)!;
      assert.strictEqual(call.body.response_format.type, "json_object");
    } finally {
      restore();
    }
  });

  await it("Groq downgrades to json_object when the schema is rejected", async () => {
    resetCircuitBreakers();
    const calls: any[] = [];
    globalThis.fetch = (async (_input: any, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push(body);
      if (body?.response_format?.type === "json_schema") {
        return new Response('{"error":{"message":"response_format json_schema is not supported"}}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ intent: "chat", confidence: 0.9 }) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;
    try {
      const adapter = new AIAdapter({
        GROQ_API_KEY: "test-key",
        GROQ_MODEL: "test-model",
        AI_PROVIDER_ORDER: "groq_primary",
      });
      const res = await adapter.execute<any>(
        {
          capability: "telegram_assistant",
          systemPrompt: "sys",
          userPrompt: "ping",
          inputContext: {},
          privacyClass: "personal",
          outputSchema: { type: "object", properties: { intent: { type: "string" } } },
        },
        new Date()
      );
      assert.strictEqual(res.ok, true, JSON.stringify(res.error));
      assert.strictEqual(calls.length, 2, "expected one schema call and one downgrade");
      assert.strictEqual(calls[0].response_format.type, "json_schema");
      assert.strictEqual(calls[1].response_format.type, "json_object");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await it("temperature ceiling is 0.1 and hot requests are clamped", async () => {
    assert.strictEqual(MAX_CHAT_TEMPERATURE, 0.1);
    resetCircuitBreakers();
    const { captured, restore } = installFetchCapture();
    try {
      const adapter = new AIAdapter({
        GROQ_API_KEY: "test-key",
        GROQ_MODEL: "test-model",
        AI_PROVIDER_ORDER: "groq_primary",
      });
      await adapter.execute<any>(
        {
          capability: "telegram_assistant",
          systemPrompt: "sys",
          userPrompt: "ping",
          inputContext: {},
          privacyClass: "personal",
          temperature: 0.9,
        },
        new Date()
      );
      const call = captured.filter((c) => c.url.includes("api.groq.com")).at(-1)!;
      assert.strictEqual(call.body.temperature, 0.1);
    } finally {
      restore();
    }
  });

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runStructuredOutputTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
