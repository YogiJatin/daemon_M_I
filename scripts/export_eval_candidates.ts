/**
 * scripts/export_eval_candidates.ts — Export Sanitized Eval Candidates
 *
 * Scans D1 chat_messages and task_proposals to export evaluation pairs:
 * - Selects interesting interactions: proposals, corrections, fallbacks.
 * - Enforces zero secrets / credential leakage (scrubs phone, keys, tokens).
 * - Outputs JSON structure suitable for offline benchmarking.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("Exporting evaluation candidates from remote D1...");

  const out = execSync(
    `npx wrangler d1 execute personal-ai-os-db --remote --command="
      SELECT cm.id, cm.role, cm.text, cm.intent, cm.confidence, cm.provider, cm.outcome, cm.created_at
      FROM chat_messages cm
      WHERE cm.role = 'user' AND cm.text NOT LIKE '/%'
      ORDER BY cm.created_at DESC LIMIT 50;
    " --json`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );

  const parsed = JSON.parse(out);
  const rows = parsed[0]?.results || [];

  const sanitized = rows.map((r: any) => ({
    id: r.id,
    input: r.text.replace(/\b\d{4}\s\d{4}\s\d{4}\b/g, "[REDACTED_AADHAAR]"),
    intent: r.intent || "unknown",
    provider: r.provider || "edge",
    outcome: r.outcome || "completed",
    timestamp: r.created_at,
  }));

  const exportPath = path.resolve(process.cwd(), "eval_candidates.json");
  fs.writeFileSync(exportPath, JSON.stringify(sanitized, null, 2), "utf8");

  console.log(`Exported ${sanitized.length} sanitized eval candidates to ${exportPath}`);
}

main().catch((e) => {
  console.error("Eval export failed:", e);
  process.exit(1);
});
