/**
 * scripts/webhook_register.ts - register the Telegram webhook in one step.
 *
 * Owner usage:  npm run webhook:register
 *
 * It asks for the bot token with hidden input (never read from an env var or a
 * file), generates a fresh 32-byte webhook secret, pushes that secret to the
 * Worker with `wrangler secret put` over stdin, then calls setWebhook with the
 * deployed route and allowed_updates [message, callback_query].
 *
 * Nothing secret is printed: only the URL, pending_update_count and whether a
 * last_error_message exists. The generated secret is not written to disk at all,
 * so the Worker, Telegram and this process are the only holders.
 *
 * After a token rotation this is the step to run (see docs/RUNBOOK.md).
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = process.cwd();
const SECRET_NAME = "TELEGRAM_WEBHOOK_SECRET"; // the name the Worker already reads
const FALLBACK_WEBHOOK = "https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/telegram/webhook";

/** Read a line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("A real terminal is required so the token can be hidden."));
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const finish = (result: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(result);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function webhookUrlFromConfig(): string {
  const file = path.join(ROOT, "wrangler.jsonc");
  if (!fs.existsSync(file)) return FALLBACK_WEBHOOK;
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/"WEBHOOK_URL"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? FALLBACK_WEBHOOK;
}

function runWrangler(args: string[], input?: string): number {
  // Spawning "npx.cmd" without a shell fails silently on Windows, so run wrangler
  // through node and its own entry file instead.
  const bin = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(bin)) {
    console.log(`FAIL: wrangler not found at ${bin} - run npm install`);
    return 1;
  }
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: ROOT,
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    shell: false,
  });
  return result.status ?? 1;
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
  const token = await readHidden("Bot token (hidden): ");

  // A real token is "<numeric bot id>:<35+ chars>". Anything else is a placeholder.
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    console.log(`BLOCKED: that does not look like a bot token (${token.length} chars).`);
    process.exit(2);
  }

  const secret = crypto.randomBytes(32).toString("hex");
  console.log(`secret: generated ${secret.length} hex chars (not printed, not written to disk)`);

  console.log(`wrangler: setting ${SECRET_NAME} from stdin`);
  if (runWrangler(["secret", "put", SECRET_NAME], `${secret}\n`) !== 0) {
    console.log("FAIL: wrangler secret put failed");
    process.exit(1);
  }
  console.log(`wrangler: ${SECRET_NAME} updated`);

  const url = webhookUrlFromConfig();
  const set = await telegram(token, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  if (!set.ok) {
    console.log(`FAIL: setWebhook rejected: ${set.error_code ?? "?"} ${set.description ?? ""}`);
    process.exit(1);
  }

  const info = await telegram(token, "getWebhookInfo");
  const result = info.result ?? {};
  console.log(`url: ${result.url ?? "(none)"}`);
  console.log(`pending_update_count: ${result.pending_update_count ?? 0}`);
  console.log(`last_error_message: ${result.last_error_message ? "PRESENT" : "none"}`);
  process.exit(result.url === url ? 0 : 1);
}

main().catch((error) => {
  console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
