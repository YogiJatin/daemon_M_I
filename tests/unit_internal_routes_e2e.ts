/**
 * tests/unit_internal_routes_e2e.ts - the real Worker handler must not expose
 * /api/v1/internal/test/* in production.
 *
 * unit_internal_auth.ts tests the gate function. This test calls the module's fetch
 * handler exactly as Cloudflare would, with and without ENABLE_TEST_ROUTES, so a future
 * refactor that reorders the middleware chain cannot silently reopen the routes.
 */

import worker from "../worker/index";
import { createMockD1 } from "./mockD1";

let pass = 0;
let fail = 0;

function assert(condition: boolean, name: string, detail?: unknown): void {
  if (condition) {
    pass += 1;
    console.log(`  PASS: ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL: ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const ctxStub: any = {
  waitUntil: () => {},
  passThroughOnException: () => {},
};

function internalRequest(token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // internalAuth reads the admin credential from the Telegram header name on purpose.
  if (token) headers["X-Telegram-Bot-Api-Secret-Token"] = token;
  return new Request("https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/internal/test/d1-query", {
    method: "POST",
    headers,
    body: JSON.stringify({ sql: "SELECT 1 AS one" }),
  });
}

async function run(): Promise<void> {
  console.log("\n=== INTERNAL ROUTES: PRODUCTION 404 ===\n");

  const adminToken = "a".repeat(40);

  console.log("--- 1. ENABLE_TEST_ROUTES unset (the production state) ---");
  const productionEnv: any = {
    DB: createMockD1(),
    TELEGRAM_OWNER_ID: "8364430714",
    TEST_ADMIN_TOKEN: adminToken,
  };

  const evenWithToken = await worker.fetch(internalRequest(adminToken), productionEnv, ctxStub);
  assert(evenWithToken.status === 404, "correct admin token still gets 404 in production", evenWithToken.status);
  const bodyText = await evenWithToken.text();
  assert(bodyText.length === 0, "404 body is empty (route does not advertise itself)", bodyText);
  assert(!evenWithToken.headers.get("content-type")?.includes("json"), "404 is not a JSON API error");

  const withoutToken = await worker.fetch(internalRequest(), productionEnv, ctxStub);
  assert(withoutToken.status === 404, "anonymous caller gets 404 in production", withoutToken.status);

  console.log("--- 2. A near-miss switch value stays closed ---");
  for (const value of ["true", "yes", "2", " 1"]) {
    const env: any = { ...productionEnv, ENABLE_TEST_ROUTES: value };
    const response = await worker.fetch(internalRequest(adminToken), env, ctxStub);
    assert(response.status === 404, `ENABLE_TEST_ROUTES='${value}' keeps the 404`, response.status);
  }

  console.log("--- 3. Enabled without the admin token ---");
  const enabledEnv: any = { ...productionEnv, ENABLE_TEST_ROUTES: "1" };
  const noToken = await worker.fetch(internalRequest(), enabledEnv, ctxStub);
  assert(noToken.status === 401, "enabled route without a token is 401, not 404", noToken.status);
  const wrongToken = await worker.fetch(internalRequest("b".repeat(40)), enabledEnv, ctxStub);
  assert(wrongToken.status === 401, "enabled route with a wrong token is 401", wrongToken.status);

  console.log("--- 4. Enabled with the admin token reaches the handler ---");
  const allowed = await worker.fetch(internalRequest(adminToken), enabledEnv, ctxStub);
  assert(allowed.status !== 404 && allowed.status !== 401, "handler is reachable only when explicitly enabled", allowed.status);

  console.log(`\nTOTAL: ${pass + fail} | PASSED: ${pass} | FAILED: ${fail}`);
  if (fail > 0) process.exit(1);
}

run().catch((error) => {
  console.log(`  FAIL: test crashed -> ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
