/**
 * scripts/lib/testGuard.ts - safety gate for the scripted test runners.
 *
 * Why this exists
 * ---------------
 * The runners in scripts/ used to hardcode the deployed Worker URL and then write
 * fixture rows (memories, auth sessions, timetable slots, desktop devices) straight
 * into the production D1 database. Two golden runs left 15 `mem_seed_*` memories,
 * a private test memory and 43 desktop devices in the live database for weeks.
 *
 * The rules now:
 *   1. Local is the default target: http://127.0.0.1:8787 (wrangler dev / Miniflare).
 *   2. A non-loopback target is only accepted when the caller opts in explicitly with
 *      `--allow-remote` or ALLOW_REMOTE_TESTS=1. A reflexive `npx tsx scripts/run_*.ts`
 *      therefore cannot reach live data by accident.
 *   3. Every run gets a `test_run_id`. Rows a run writes are tagged with it and removed
 *      by CleanupRegistry even when the run throws.
 *
 * Nothing here talks to the network; it only decides what a runner is allowed to do.
 */

import * as crypto from "crypto";

export const LOCAL_BASE_URL = "http://127.0.0.1:8787";
export const REMOTE_BASE_URL = "https://personal-ai-os.jatin-personal-ai.workers.dev";

export interface TestTarget {
  /** True when the resolved base URL is not a loopback address. */
  remote: boolean;
  /** True when the caller passed --allow-remote / ALLOW_REMOTE_TESTS=1. */
  optedIn: boolean;
  baseUrl: string;
  /** Flag to pass to `wrangler d1 execute` so seeds land in the same database. */
  d1Flag: "--local" | "--remote";
}

/** Loopback check that does not require a URL parser (works for localhost and 127.0.0.1). */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Resolve where this run should send requests.
 *
 * Accepted arguments:
 *   --allow-remote          opt in to a non-loopback target
 *   --base-url=<url>        explicit target (still refused unless opted in)
 */
export function parseTarget(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env
): TestTarget {
  const optedIn = argv.includes("--allow-remote") || env.ALLOW_REMOTE_TESTS === "1";
  const flag = argv.find((arg) => arg.startsWith("--base-url="));
  const explicitUrl = flag ? flag.slice("--base-url=".length) : "";
  const baseUrl = explicitUrl.length > 0 ? explicitUrl : optedIn ? REMOTE_BASE_URL : LOCAL_BASE_URL;
  const remote = !isLoopbackUrl(baseUrl);
  return { remote, optedIn, baseUrl, d1Flag: remote ? "--remote" : "--local" };
}

/**
 * Throw unless this target is safe to use. Loopback is always safe; anything else
 * needs the explicit opt-in that parseTarget recorded.
 */
export function assertSafeTarget(label: string, target: TestTarget): void {
  if (!target.remote) return;
  if (target.optedIn) return;
  throw new Error(
    `${label}: refusing to run against ${target.baseUrl}. ` +
      `Scripted runners default to ${LOCAL_BASE_URL} (wrangler dev). ` +
      `Pass --allow-remote (or ALLOW_REMOTE_TESTS=1) only when you intend to write fixture rows into live D1.`
  );
}

/** Short unique tag for one runner execution, e.g. test_run_3f9c1a2b4d5e. */
export function newTestRunId(prefix = "test_run"): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export type CleanupFn = () => Promise<void> | void;

/**
 * Ordered list of teardown steps. runAll() drains the list so a double call in a
 * `finally` and an error handler cannot delete the same fixtures twice.
 */
export class CleanupRegistry {
  private readonly steps: CleanupFn[] = [];

  register(step: CleanupFn): void {
    this.steps.push(step);
  }

  get size(): number {
    return this.steps.length;
  }

  /**
   * Run every registered step once. A failing step never prevents the remaining
   * steps from running; the return value is the number of failures.
   */
  async runAll(log: (message: string) => void = (message) => console.error(message)): Promise<number> {
    let failures = 0;
    for (const step of this.steps.splice(0)) {
      try {
        await step();
      } catch (error) {
        failures++;
        log(`testGuard: cleanup step failed: ${(error as Error).message}`);
      }
    }
    return failures;
  }
}

/**
 * SQL that stamps seeded rows with the run id. The column is added by migration 0026;
 * older databases ignore the statement through the caller's try/catch.
 */
export function tagSeededRowSql(table: string, idColumn: string, idValue: string, runId: string): string {
  return (
    `UPDATE ${table} SET test_run_id = '${runId}' WHERE ${idColumn} = '${idValue}';`
  );
}

/**
 * SQL that removes every row a run tagged. Kept narrow on purpose: a run may only
 * delete what it stamped, never rows that were already there.
 */
export function cleanupTaggedRowsSql(table: string, runId: string): string {
  return `DELETE FROM ${table} WHERE test_run_id = '${runId}';`;
}
