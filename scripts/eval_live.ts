/**
 * scripts/eval_live.ts - Daemon behaviour evaluation against the live provider chain.
 *
 * Usage (PowerShell or bash):
 *   npm run eval:live                 # all 60 cases
 *   npm run eval:live -- --limit 20   # first 20 cases (smoke)
 *   npm run eval:live -- --only j,m   # id prefix filter
 *
 * What it does:
 * - Loads provider keys from the gitignored `.dev.vars` in the project root.
 *   Values are never printed.
 * - Runs the deterministic cases (greeting / acknowledgement / fragment) through
 *   `matchDeterministicReply`, exactly as the Telegram path does.
 * - Runs the conversational cases through the real `telegram_assistant` prompt and
 *   output schema with the production provider order, using the synthetic_test
 *   privacy class so no owner data is sent to a provider.
 * - Asserts intent and reply-text expectations from tests/evals/daemon_eval.jsonl.
 *
 * This is an evaluation harness: it never writes to D1 and never sends Telegram
 * messages. Exit code 0 = every case passed, 1 = at least one failure.
 */

import * as fs from "fs";
import * as path from "path";
import { AIAdapter } from "../worker/aiAdapter";
import { AICapabilityRegistry } from "../worker/aiCapabilityRegistry";
import {
  buildAssistantUserPrompt,
  registerTelegramAssistantCapability,
} from "../worker/telegramAssistant";
import { getCapabilityManifest } from "../worker/capabilityManifest";
import { matchDeterministicReply } from "../worker/greetingMatcher";

interface EvalCase {
  id: string;
  text: string;
  source?: string;
  mode: "deterministic" | "guard" | "model";
  expect: {
    kind?: string;
    reply_contains?: string[];
    reply_not_contains?: string[];
    deterministic_null?: boolean;
    intent_any?: string[];
  };
}

interface CaseResult {
  id: string;
  text: string;
  mode: string;
  ok: boolean;
  intent?: string;
  provider?: string;
  reply?: string;
  failures: string[];
}

// npm scripts run from the project root.
const PROJECT_ROOT = process.cwd();
const DATASET_PATH = path.join(PROJECT_ROOT, "tests", "evals", "daemon_eval.jsonl");

/** Reads KEY=VALUE pairs from .dev.vars without logging any value. */
function loadDevVars(): Record<string, string> {
  const env: Record<string, string> = {};
  const file = path.join(PROJECT_ROOT, ".dev.vars");
  if (!fs.existsSync(file)) return env;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadDataset(): EvalCase[] {
  const text = fs.readFileSync(DATASET_PATH, "utf8");
  const cases: EvalCase[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    cases.push(JSON.parse(trimmed) as EvalCase);
  }
  return cases;
}

function includesAny(haystack: string, needles: string[]): string | null {
  const lower = haystack.toLowerCase();
  for (const needle of needles) {
    if (lower.includes(needle.toLowerCase())) return needle;
  }
  return null;
}

function checkReply(
  reply: string,
  expect: EvalCase["expect"],
  failures: string[]
): void {
  const banned = includesAny(reply, ["No data"]);
  if (banned) failures.push(`reply contains banned phrase "${banned}"`);
  if (expect.reply_contains) {
    for (const needle of expect.reply_contains) {
      if (!reply.toLowerCase().includes(needle.toLowerCase())) {
        failures.push(`reply missing "${needle}"`);
      }
    }
  }
  if (expect.reply_not_contains) {
    const hit = includesAny(reply, expect.reply_not_contains);
    if (hit) failures.push(`reply contains forbidden "${hit}"`);
  }
}

function runDeterministicCase(item: EvalCase, now: Date): CaseResult {
  const failures: string[] = [];
  const match = matchDeterministicReply(item.text, now);

  if (item.mode === "guard") {
    if (match !== null) {
      failures.push(`expected no deterministic reply, got kind "${match.kind}"`);
    }
    return { id: item.id, text: item.text, mode: item.mode, ok: failures.length === 0, reply: match?.reply, failures };
  }

  if (!match) {
    failures.push("expected a deterministic reply, got none");
    return { id: item.id, text: item.text, mode: item.mode, ok: false, failures };
  }
  if (item.expect.kind && match.kind !== item.expect.kind) {
    failures.push(`expected kind "${item.expect.kind}", got "${match.kind}"`);
  }
  checkReply(match.reply, item.expect, failures);
  return {
    id: item.id,
    text: item.text,
    mode: item.mode,
    ok: failures.length === 0,
    intent: match.kind,
    reply: match.reply,
    failures,
  };
}

async function runModelCase(
  item: EvalCase,
  adapter: AIAdapter,
  systemPrompt: string,
  outputSchema: Record<string, any> | undefined,
  now: Date
): Promise<CaseResult> {
  const failures: string[] = [];
  const userPrompt = buildAssistantUserPrompt(item.text, now, {}, [], undefined, []);

  const response = await adapter.execute<any>({
    capability: "telegram_assistant",
    systemPrompt,
    userPrompt,
    inputContext: { text: item.text },
    privacyClass: "synthetic_test",
    outputSchema,
    responseFormat: "json",
    timeoutMs: 15000,
  });

  const result: CaseResult = {
    id: item.id,
    text: item.text,
    mode: item.mode,
    ok: false,
    provider: `${response.provider}/${response.model}`,
    failures,
  };

  if (!response.ok || !response.data) {
    failures.push(
      `provider call failed: ${response.error?.code ?? "unknown"}${
        response.error?.message ? ` - ${response.error.message}` : ""
      }`
    );
    return result;
  }

  const data = response.data as { intent?: string; reply_text?: string };
  const intent = String(data.intent ?? "");
  const reply = String(data.reply_text ?? "");
  result.intent = intent;
  result.reply = reply;

  if (item.expect.intent_any && item.expect.intent_any.length > 0) {
    const allowed = item.expect.intent_any.map((value) => value.toLowerCase());
    if (!allowed.includes(intent.toLowerCase())) {
      failures.push(`intent "${intent}" not in [${item.expect.intent_any.join(", ")}]`);
    }
  }
  checkReply(reply, item.expect, failures);
  result.ok = failures.length === 0;
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const onlyIndex = args.indexOf("--only");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) || 0 : 0;
  const only = onlyIndex >= 0 ? String(args[onlyIndex + 1] ?? "").split(",").filter(Boolean) : [];

  const now = new Date();
  const allCases = loadDataset();
  let cases = allCases;
  if (only.length > 0) {
    cases = cases.filter((item) => only.some((prefix) => item.id.startsWith(prefix)));
  }
  if (limit > 0) cases = cases.slice(0, limit);

  // Capability definitions are loaded by importing the module that registers them.
  registerTelegramAssistantCapability();
  const capability = AICapabilityRegistry.get("telegram_assistant");
  if (!capability) {
    console.log("FAIL: telegram_assistant capability is not registered");
    process.exit(1);
  }
  const systemPrompt = capability.systemRules;
  const outputSchema = capability.outputSchema;

  const env = loadDevVars();
  const adapter = new AIAdapter(env);

  // Preflight: model cases need at least one provider key. Fail loudly instead of
  // reporting 40 provider errors as behavioural failures.
  const needsModel = cases.some((item) => item.mode === "model");
  const hasProviderKey = Boolean(
    env.GROQ_API_KEY_1 ||
      env.GROQ_API_KEY ||
      env.GROQ_API_KEY_2 ||
      env.GROQ_API_KEY_SECONDARY ||
      env.GEMINI_API_KEY_1 ||
      env.GEMINI_API_KEY
  );
  if (needsModel && !hasProviderKey) {
    console.log("BLOCKED: no AI provider key found in .dev.vars.");
    console.log("  Set GROQ_API_KEY_1 (and optionally GROQ_API_KEY_2 / GEMINI_API_KEY_1) in the");
    console.log("  gitignored .dev.vars, then re-run: npm run eval:live");
    console.log("  Production keeps these as Worker secrets, which cannot be read back.");
    process.exit(2);
  }

  console.log("Daemon live evaluation");
  console.log(`  dataset:     ${path.relative(PROJECT_ROOT, DATASET_PATH)} (${allCases.length} cases)`);
  console.log(`  running:     ${cases.length} cases`);
  console.log(`  provider order: ${adapter.getProviderOrder().join(" > ")}`);
  console.log(`  manifest:    ${getCapabilityManifest().length} chars`);
  console.log("");

  const results: CaseResult[] = [];
  for (const item of cases) {
    let result: CaseResult;
    if (item.mode === "model") {
      result = await runModelCase(item, adapter, systemPrompt, outputSchema, now);
      // Small gap keeps us inside provider rate limits on the free tier.
      await new Promise((resolve) => setTimeout(resolve, 300));
    } else {
      result = runDeterministicCase(item, now);
    }
    results.push(result);
    const mark = result.ok ? "PASS" : "FAIL";
    const detail = result.failures.length > 0 ? `  <- ${result.failures.join("; ")}` : "";
    console.log(
      `[${mark}] ${result.id} (${result.mode}) "${result.text}"` +
        `${result.intent ? ` -> ${result.intent}` : ""}${detail}`
    );
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  const rate = results.length > 0 ? ((passed / results.length) * 100).toFixed(1) : "0.0";

  console.log("");
  console.log(`Result: ${passed}/${results.length} passed (${rate}%)`);
  if (failed > 0) {
    console.log("");
    console.log("Failures:");
    for (const result of results.filter((entry) => !entry.ok)) {
      console.log(`  ${result.id}: "${result.text}" -> ${result.failures.join("; ")}`);
      if (result.reply) {
        console.log(`     reply: ${result.reply.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.log(`FAIL: eval runner crashed - ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
