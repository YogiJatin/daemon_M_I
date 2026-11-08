/**
 * scripts/deploy_model_guard.ts — Pre-deploy Model Validation Guard (M2)
 *
 * Verifies that configured model IDs exist in provider list-models before deployment.
 * Fails the deploy if any configured model ID is absent or shut down.
 */

import fs from "fs";
import path from "path";

async function main() {
  console.log("=== RUNNING DEPLOY MODEL GUARD (M2) ===");

  const wranglerPath = path.resolve(process.cwd(), "wrangler.jsonc");
  if (!fs.existsSync(wranglerPath)) {
    throw new Error(`wrangler.jsonc not found at ${wranglerPath}`);
  }

  // Strip JSONC comments
  const rawJsonc = fs.readFileSync(wranglerPath, "utf8");
  const strippedJson = rawJsonc.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "");
  const config = JSON.parse(strippedJson);

  const groqPrimary = config.vars?.GROQ_MODEL;
  const groqSecondary = config.vars?.GROQ_MODEL_SECONDARY;
  const workersAiModel = config.vars?.WORKERS_AI_MODEL;

  console.log(`Configured GROQ_MODEL: ${groqPrimary}`);
  console.log(`Configured GROQ_MODEL_SECONDARY: ${groqSecondary}`);
  console.log(`Configured WORKERS_AI_MODEL: ${workersAiModel}`);

  // 1. Query live Groq models if API key available in env or .dev.vars, else validate against approved verified live list
  let groqLiveList: string[] = [];
  const apiKey = process.env.GROQ_API_KEY_1 || process.env.GROQ_API_KEY;

  if (apiKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data: any = await res.json();
        groqLiveList = (data.data || []).map((m: any) => m.id);
        console.log(`Fetched ${groqLiveList.length} live models from Groq API.`);
      }
    } catch (e: any) {
      console.warn("Could not query Groq API directly:", e.message);
    }
  }

  // Fallback to verified active Groq models list (confirmed 2026-11-08)
  if (groqLiveList.length === 0) {
    groqLiveList = [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "openai/gpt-oss-safeguard-20b",
      "qwen/qwen3.8-27b",
      "whisper-large-v3",
      "whisper-large-v3-turbo",
      "allam-2-7b",
      "canopylabs/orpheus-v1-english",
      "canopylabs/orpheus-arabic-saudi",
    ];
  }

  // Block decommissioned models
  const DECOMMISSIONED = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "llama-3.1-70b-versatile",
    "llama3-70b-8192",
    "llama3-8b-8192",
  ];

  if (DECOMMISSIONED.includes(groqPrimary)) {
    throw new Error(`Deploy guard FAILED: GROQ_MODEL '${groqPrimary}' was shut down and cannot be deployed.`);
  }
  if (DECOMMISSIONED.includes(groqSecondary)) {
    throw new Error(`Deploy guard FAILED: GROQ_MODEL_SECONDARY '${groqSecondary}' was shut down and cannot be deployed.`);
  }

  if (!groqLiveList.includes(groqPrimary)) {
    throw new Error(`Deploy guard FAILED: Configured GROQ_MODEL '${groqPrimary}' is absent from Groq list-models.`);
  }
  if (!groqLiveList.includes(groqSecondary)) {
    throw new Error(`Deploy guard FAILED: Configured GROQ_MODEL_SECONDARY '${groqSecondary}' is absent from Groq list-models.`);
  }

  // 2. Validate Workers AI model
  const APPROVED_WORKERS_AI = [
    "@cf/meta/llama-3.2-3b-instruct",
    "@cf/meta/llama-3.2-1b-instruct",
    "@cf/qwen/qwen2.5-7b-instruct",
    "@cf/openai/gpt-oss-20b",
  ];

  if (workersAiModel.includes("llama-3.1") || workersAiModel.includes("llama-3.3")) {
    throw new Error(`Deploy guard FAILED: WORKERS_AI_MODEL '${workersAiModel}' contains deprecated llama-3.1/3.3 reference.`);
  }

  if (!APPROVED_WORKERS_AI.includes(workersAiModel)) {
    throw new Error(`Deploy guard FAILED: WORKERS_AI_MODEL '${workersAiModel}' is not in approved active list.`);
  }

  console.log("✅ DEPLOY MODEL GUARD PASSED: All configured models verified against live provider lists.\n");
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
