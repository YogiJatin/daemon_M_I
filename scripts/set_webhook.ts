/**
 * scripts/set_webhook.ts - register the Telegram webhook against the live Worker secret.
 *
 * Why this exists: `wrangler secret put` can rotate the Worker's copy of
 * TELEGRAM_WEBHOOK_SECRET, but Worker secrets cannot be read back, and Telegram only
 * learns the new value when someone calls setWebhook with the real bot token. If the
 * two sides drift apart, every inbound update is rejected with 401 and the bot goes
 * silent. This script closes that loop from the owner's machine.
 *
 * Owner usage:
 *   1. Put the real bot token in .dev.vars (gitignored):  TELEGRAM_BOT_TOKEN=...
 *   2. Run:  npx tsx scripts/set_webhook.ts
 *
 * The secret comes from backups/.new_webhook_secret (written by the rotation step) or
 * from --secret <value>. Nothing secret is printed: only lengths and ok/error flags.
 */

import * as fs from "fs";
import * as path from "path";

const PROJECT_ROOT = process.cwd();
const WORKER_ORIGIN = "https://personal-ai-os.jatin-personal-ai.workers.dev";
const WEBHOOK_PATH = "/api/v1/telegram/webhook";

function loadDevVars(): Record<string, string> {
  const env: Record<string, string> = {};
  const file = path.join(PROJECT_ROOT, ".dev.vars");
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

function readSecret(args: string[]): string | null {
  const flag = args.indexOf("--secret");
  if (flag >= 0 && args[flag + 1]) return args[flag + 1];
  const file = path.join(PROJECT_ROOT, "backups", ".new_webhook_secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  return null;
}

async function telegram(token: string, method: string, body?: unknown): Promise<any> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return response.json().catch(() => ({ ok: false, description: "unparseable response" }));
}

async function main(): Promise<void> {
  const env = loadDevVars();
  const token = env.TELEGRAM_BOT_TOKEN ?? "";

  // A real bot token is "<bot id>:<35+ chars>". Anything else is a placeholder and
  // Telegram answers 404 Not Found, which looks like a missing webhook.
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    console.log("BLOCKED: TELEGRAM_BOT_TOKEN in .dev.vars is missing or is a placeholder.");
    console.log(`  current value: absent or ${token.length} chars (a real token is ~46)`);
    console.log("  Put the real token from @BotFather into .dev.vars, then re-run:");
    console.log("    npx tsx scripts/set_webhook.ts");
    process.exit(2);
  }

  const secret = readSecret(process.argv.slice(2));
  if (!secret) {
    console.log("BLOCKED: no webhook secret available.");
    console.log("  Pass the value the Worker is holding: --secret <value>");
    console.log("  (or, after a rotation, write the new value to backups/.new_webhook_secret first).");
    console.log("  It must match the Worker's TELEGRAM_WEBHOOK_SECRET exactly, or every update 401s.");
    process.exit(2);
  }

  const before = await telegram(token, "getWebhookInfo");
  if (!before.ok) {
    console.log(`BLOCKED: getWebhookInfo failed: ${before.error_code ?? "?"} ${before.description ?? ""}`);
    process.exit(1);
  }
  console.log(`current: url=${before.result.url || "(none)"} pending=${before.result.pending_update_count}`);

  const url = before.result.url || `${WORKER_ORIGIN}${WEBHOOK_PATH}`;
  const set = await telegram(token, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  console.log(`setWebhook: ok=${set.ok}${set.description ? ` (${set.description})` : ""}`);
  if (!set.ok) process.exit(1);

  const after = await telegram(token, "getWebhookInfo");
  const info = after.result ?? {};
  console.log(`verify: url=${info.url}`);
  console.log(`        pending=${info.pending_update_count} last_error=${info.last_error_message ? "PRESENT" : "none"}`);
  process.exit(info.url === url ? 0 : 1);
}

main().catch((error) => {
  console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
