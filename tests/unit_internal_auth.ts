/**
 * tests/unit_internal_auth.ts - gate for /api/v1/internal/* and session hardening.
 *
 * The old behaviour let anyone who knew the Telegram webhook secret act as the owner
 * on every API route. These tests pin the replacement:
 *   1. Internal endpoints are absent unless ENABLE_TEST_ROUTES=1.
 *   2. When enabled they need TEST_ADMIN_TOKEN (>=32 chars, constant-time) or a real session.
 *   3. A webhook-secret header never authenticates a normal API call.
 *   4. constantTimeEqual compares by digest and never short-circuits on length.
 */

import { authenticateRequest, constantTimeEqual, hashToken } from "../worker/auth";
import { authorizeInternalRequest, testRoutesEnabled } from "../worker/internalAuth";
import { createMockD1 } from "./mockD1";

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, name: string, details?: unknown) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passCount++;
  } else {
    console.error(`  FAIL: ${name}`, details === undefined ? "" : JSON.stringify(details));
    failCount++;
  }
}

const ADMIN_TOKEN = "test_admin_token_" + "a".repeat(24); // 41 chars
const WEBHOOK_SECRET = "webhook_secret_value_for_tests";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

function adminRequest(token: string): Request {
  return new Request("http://localhost/api/v1/internal/test/d1-query", {
    method: "POST",
    headers: { [SECRET_HEADER]: token },
  });
}

async function seedSession(db: any, token: string) {
  const tokenHash = await hashToken(token);
  const now = new Date();
  await db
    .prepare(
      `INSERT INTO auth_sessions (id, token_hash, owner_user_id, workspace_id, expires_at, created_at, last_seen_at)
       VALUES (?, ?, '8364430714', 'default', ?, ?, ?)`
    )
    .bind(
      "sess_unit_" + tokenHash.slice(0, 8),
      tokenHash,
      new Date(now.getTime() + 3600_000).toISOString(),
      now.toISOString(),
      now.toISOString()
    )
    .run();
}

async function runInternalAuthTests() {
  console.log("\n=== INTERNAL AUTH GATE ===\n");

  // ----------------------------------------------------
  // 1. Switch
  // ----------------------------------------------------
  console.log("--- 1. ENABLE_TEST_ROUTES must be exactly '1' ---");
  assert(testRoutesEnabled({}) === false, "unset env disables internal routes");
  assert(testRoutesEnabled({ ENABLE_TEST_ROUTES: "true" }) === false, "'true' does not enable them");
  assert(testRoutesEnabled({ ENABLE_TEST_ROUTES: "1" }) === true, "'1' enables them");

  // ----------------------------------------------------
  // 2. Disabled means absent, even with the right token
  // ----------------------------------------------------
  console.log("--- 2. Disabled routes reject every caller ---");
  const db = createMockD1();
  const disabledEnv = { TEST_ADMIN_TOKEN: ADMIN_TOKEN, TELEGRAM_OWNER_ID: "8364430714" };
  const whenDisabled = await authorizeInternalRequest(adminRequest(ADMIN_TOKEN), disabledEnv, db);
  assert(whenDisabled.ok === false, "correct token is refused while routes are off");
  assert(whenDisabled.reason === "test_routes_disabled", "reason names the switch", whenDisabled.reason);

  // ----------------------------------------------------
  // 3. Enabled + correct token
  // ----------------------------------------------------
  console.log("--- 3. Enabled with TEST_ADMIN_TOKEN ---");
  const enabledEnv = { ...disabledEnv, ENABLE_TEST_ROUTES: "1" };
  const withToken = await authorizeInternalRequest(adminRequest(ADMIN_TOKEN), enabledEnv, db);
  assert(withToken.ok === true, "matching admin token is accepted", withToken);
  assert(withToken.reason === "test_admin_token", "reason names the credential", withToken.reason);

  const wrongToken = await authorizeInternalRequest(adminRequest(ADMIN_TOKEN.replace(/a$/, "b")), enabledEnv, db);
  assert(wrongToken.ok === false, "a near-miss token is rejected", wrongToken.reason);

  // The webhook secret must NOT work as an internal credential.
  const webhookAsAdmin = await authorizeInternalRequest(adminRequest(WEBHOOK_SECRET), enabledEnv, db);
  assert(webhookAsAdmin.ok === false, "webhook secret is not an admin credential", webhookAsAdmin.reason);

  // ----------------------------------------------------
  // 4. Short configured token is never accepted
  // ----------------------------------------------------
  console.log("--- 4. Weak configured token is ignored ---");
  const shortTokenEnv = { ENABLE_TEST_ROUTES: "1", TEST_ADMIN_TOKEN: "short", TELEGRAM_OWNER_ID: "8364430714" };
  const shortToken = await authorizeInternalRequest(adminRequest("short"), shortTokenEnv, db);
  assert(shortToken.ok === false, "tokens under 32 characters never authorise");

  // ----------------------------------------------------
  // 5. Owner session works with routes enabled
  // ----------------------------------------------------
  console.log("--- 5. Real owner session is accepted ---");
  const sessionToken = "owner_session_token_for_unit_tests";
  await seedSession(db, sessionToken);
  const sessionRequest = new Request("http://localhost/api/v1/internal/test/d1-query", {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  const withSession = await authorizeInternalRequest(
    sessionRequest,
    { ENABLE_TEST_ROUTES: "1", TELEGRAM_OWNER_ID: "8364430714" },
    db
  );
  assert(withSession.ok === true, "a live owner session authorises internal routes", withSession);
  assert(withSession.reason === "owner_session", "reason names the credential", withSession.reason);

  // ----------------------------------------------------
  // 6. Webhook secret no longer mints a session
  // ----------------------------------------------------
  console.log("--- 6. authenticateRequest has no webhook-secret shortcut ---");
  const webhookOnly = new Request("http://localhost/api/v1/today", {
    headers: { [SECRET_HEADER]: WEBHOOK_SECRET },
  });
  const webhookAuth = await authenticateRequest(webhookOnly, db, "8364430714");
  assert(webhookAuth.authenticated === false, "webhook secret header alone is not authenticated");
  assert(webhookAuth.error === "missing_credentials", "reported as missing credentials", webhookAuth.error);

  const bearerWebhook = new Request("http://localhost/api/v1/today", {
    headers: { Authorization: `Bearer ${WEBHOOK_SECRET}` },
  });
  const bearerAuth = await authenticateRequest(bearerWebhook, db, "8364430714");
  assert(bearerAuth.authenticated === false, "webhook secret as a bearer token is not a session");

  const realSession = await authenticateRequest(
    new Request("http://localhost/api/v1/today", { headers: { Authorization: `Bearer ${sessionToken}` } }),
    db,
    "8364430714"
  );
  assert(realSession.authenticated === true, "a real session token still authenticates");

  // ----------------------------------------------------
  // 7. constantTimeEqual
  // ----------------------------------------------------
  console.log("--- 7. constantTimeEqual ---");
  assert((await constantTimeEqual("abc", "abc")) === true, "equal strings match");
  assert((await constantTimeEqual("abc", "abd")) === false, "different strings do not match");
  assert((await constantTimeEqual("abc", "abcdef")) === false, "different lengths do not match");
  assert((await constantTimeEqual("", "")) === true, "empty strings are equal to each other");

  console.log(`\n=== RESULT: ${passCount} passed, ${failCount} failed ===`);
  if (failCount > 0) process.exit(1);
}

runInternalAuthTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
