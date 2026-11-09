/**
 * worker/internalAuth.ts - the only gate for /api/v1/internal/* endpoints.
 *
 * Those endpoints run raw SQL, force scheduler ticks and rewrite tasks, so they must
 * not exist in production. Two conditions are required:
 *
 *   1. ENABLE_TEST_ROUTES=1 in the Worker environment.
 *   2. A caller secret that matches TEST_ADMIN_TOKEN (at least 32 characters,
 *      compared in constant time), OR a real owner session token.
 *
 * The Telegram webhook secret is NOT accepted here. It has a single job - proving a
 * webhook came from Telegram - and it must never double as an admin credential.
 */

import { authenticateRequest, constantTimeEqual, SessionRecord } from "./auth";

const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const MIN_SECRET_LENGTH = 32;

export interface InternalAuthResult {
  ok: boolean;
  /** Machine-readable reason, safe to log. Never includes the supplied secret. */
  reason: "test_routes_disabled" | "test_admin_token" | "owner_session" | "missing_credentials";
  session?: SessionRecord;
}

type EnvLike = Record<string, unknown>;

function readEnv(env: unknown, key: string): string {
  const value = (env as EnvLike)?.[key];
  return typeof value === "string" ? value : "";
}

/** Test/ops endpoints are absent unless this is explicitly switched on. */
export function testRoutesEnabled(env: unknown): boolean {
  return readEnv(env, "ENABLE_TEST_ROUTES") === "1";
}

export async function authorizeInternalRequest(
  request: Request,
  env: unknown,
  db: D1Database,
  now: Date = new Date()
): Promise<InternalAuthResult> {
  if (!testRoutesEnabled(env)) {
    return { ok: false, reason: "test_routes_disabled" };
  }

  const configuredToken = readEnv(env, "TEST_ADMIN_TOKEN");
  const suppliedToken = request.headers.get(SECRET_HEADER) || "";

  if (
    configuredToken.length >= MIN_SECRET_LENGTH &&
    suppliedToken.length >= MIN_SECRET_LENGTH &&
    (await constantTimeEqual(suppliedToken, configuredToken))
  ) {
    return { ok: true, reason: "test_admin_token" };
  }

  const ownerId = readEnv(env, "TELEGRAM_OWNER_ID") || undefined;
  const auth = await authenticateRequest(request, db, ownerId, now);
  if (auth.authenticated) {
    return { ok: true, reason: "owner_session", session: auth.session };
  }

  return { ok: false, reason: "missing_credentials" };
}
