/**
 * scripts/lib/devVars.ts - read local development secrets without hardcoding them.
 *
 * Scripts that talk to the deployed Worker need the same values `wrangler dev` would get.
 * Those values live in the gitignored `.dev.vars`; a literal copy in a tracked script
 * leaks the secret into git history and cannot be rotated cheaply.
 */

import * as fs from "fs";
import * as path from "path";

/** Reads KEY=VALUE lines from .dev.vars (project root). Never logs values. */
export function loadDevVars(): Record<string, string> {
  const env: Record<string, string> = {};
  const file = path.join(process.cwd(), ".dev.vars");
  if (!fs.existsSync(file)) return env;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
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

/**
 * The webhook secret the deployed Worker expects. Prefers the process environment,
 * then .dev.vars. Throws a readable error instead of sending an unauthenticated request.
 */
export function requireWebhookSecret(): string {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || loadDevVars().TELEGRAM_WEBHOOK_SECRET || "";
  if (!secret) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET is not set. Put it in .dev.vars (gitignored) or export it for this command."
    );
  }
  return secret;
}
