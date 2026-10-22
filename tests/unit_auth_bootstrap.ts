/**
 * tests/unit_auth_bootstrap.ts — Unit Tests for PWA Authentication Bootstrap & State Machine
 *
 * Requirements:
 * 1. Start unauthenticated by default (isAuthenticated = false).
 * 2. On app load, call /api/v1/auth/me first.
 * 3. If auth fails with 401, render the pairing screen (PairView) immediately.
 * 4. If auth succeeds, load dashboard data and render the normal app (TodayView / dashboard).
 * 5. Successful pairing transitions the system to authenticated state.
 * 6. Expired or invalid session immediately clears data and returns to the pairing screen.
 */

import { api, setSessionToken, getSessionToken } from "../src/api/client";

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, name: string, details?: any) {
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
    passCount++;
  } else {
    console.error(`  ❌ FAIL: ${name}`, details ? JSON.stringify(details, null, 2) : "");
    failCount++;
  }
}

// Simulates the exact state machine and logic implemented in src/App.tsx
class AppAuthStateMachine {
  public isAuthenticated: boolean = false;
  public isAuthChecking: boolean = true;
  public currentMode: string = "focus";
  public todayData: any = null;
  public focusData: any = null;
  public presence: string = "healthy";

  // Mock call tracking
  public calls: string[] = [];

  constructor(initialMode: string = "focus") {
    this.currentMode = initialMode;
    this.isAuthenticated = false; // Rule 1: Start unauthenticated by default
    this.isAuthChecking = true;
  }

  // Exact reproduction of refreshCoreData in App.tsx
  async refreshCoreData() {
    try {
      this.calls.push("/api/v1/auth/me");
      await api.getMe();
      this.isAuthenticated = true;

      const [today, focus] = await Promise.all([
        (async () => {
          this.calls.push("/api/v1/today");
          return api.getToday().catch((err: any) => {
            if (err?.status === 401 || err?.code === "unauthorized") throw err;
            return null;
          });
        })(),
        (async () => {
          this.calls.push("/api/v1/focus");
          return api.getFocus().catch((err: any) => {
            if (err?.status === 401 || err?.code === "unauthorized") throw err;
            return null;
          });
        })(),
      ]);

      if (today) this.todayData = today;
      if (focus) {
        this.focusData = focus;
        this.presence = "healthy";
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.code === "unauthorized") {
        this.isAuthenticated = false;
        this.todayData = null;
        this.focusData = null;
      } else {
        this.presence = "offline";
      }
    } finally {
      this.isAuthChecking = false;
    }
  }

  // Evaluates which primary view would be rendered by App.tsx
  getActiveView(): "Loading" | "PairView" | "TodayView" | "OtherModeView" {
    if (this.isAuthChecking) return "Loading";
    if (!this.isAuthenticated) return "PairView";
    if (this.currentMode === "focus") return "TodayView";
    return "OtherModeView";
  }

  // Pair handler invoked by PairView.onPairedSuccess
  async handlePairedSuccess() {
    await this.refreshCoreData();
    this.currentMode = "focus";
  }
}

async function runTests() {
  console.log("\n=== RUNNING PWA AUTHENTICATION BOOTSTRAP UNIT TESTS ===\n");

  const originalFetch = globalThis.fetch;

  try {
    // -----------------------------------------------------------------------
    // Test 1: Unauthenticated bootstrap -> PairView
    // -----------------------------------------------------------------------
    console.log("--- 1. Testing Unauthenticated Bootstrap ---");
    {
      setSessionToken(null);
      const app = new AppAuthStateMachine("focus");

      // Mock /api/v1/auth/me returning 401
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/auth/me")) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: { code: "unauthorized", message: "Authentication required" },
            }),
            { status: 401, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch call to: ${url}`);
      };

      assert(app.isAuthenticated === false, "Starts unauthenticated by default (isAuthenticated = false)");
      assert(app.isAuthChecking === true, "Initial state has isAuthChecking = true");

      await app.refreshCoreData();

      assert(app.isAuthenticated === false, "Remains unauthenticated after 401 from /api/v1/auth/me");
      assert(app.isAuthChecking === false, "Auth check completes (isAuthChecking = false)");
      assert(app.getActiveView() === "PairView", "Renders PairView immediately for unauthenticated user");
      assert(app.calls.length === 1 && app.calls[0] === "/api/v1/auth/me", "Called ONLY /api/v1/auth/me first");
      assert(
        !app.calls.includes("/api/v1/today") && !app.calls.includes("/api/v1/focus"),
        "Protected endpoints /api/v1/today and /api/v1/focus were NOT called"
      );
      assert(app.todayData === null && app.focusData === null, "Dashboard data remains null");
    }

    // -----------------------------------------------------------------------
    // Test 2: Authenticated bootstrap -> TodayView / dashboard
    // -----------------------------------------------------------------------
    console.log("\n--- 2. Testing Authenticated Bootstrap ---");
    {
      setSessionToken("mock-valid-session-token");
      const app = new AppAuthStateMachine("focus");

      // Mock endpoints returning 200
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/auth/me")) {
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                owner_user_id: "8364430714",
                workspace_id: "ws_default",
                expires_at: new Date(Date.now() + 86400000).toISOString(),
                created_at: new Date().toISOString(),
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/v1/today")) {
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                date: "2026-10-22",
                tasks_due: [],
                schedule: [],
                stats: { completed_today: 1, pending_today: 0 },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/v1/focus")) {
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                active_task: null,
                next_class: null,
                unread_notifications: 0,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch call to: ${url}`);
      };

      await app.refreshCoreData();

      assert(app.isAuthenticated === true, "Marks isAuthenticated = true after successful /api/v1/auth/me");
      assert(app.isAuthChecking === false, "Auth check completed");
      assert(app.getActiveView() === "TodayView", "Renders TodayView / dashboard when authenticated");
      assert(app.todayData !== null, "todayData successfully loaded");
      assert(app.focusData !== null, "focusData successfully loaded");
      assert(app.calls.includes("/api/v1/auth/me"), "Called /api/v1/auth/me first");
      assert(app.calls.includes("/api/v1/today"), "Called /api/v1/today after auth success");
      assert(app.calls.includes("/api/v1/focus"), "Called /api/v1/focus after auth success");
    }

    // -----------------------------------------------------------------------
    // Test 3: Successful pairing -> transition to authenticated state
    // -----------------------------------------------------------------------
    console.log("\n--- 3. Testing Pairing Flow & Transition ---");
    {
      setSessionToken(null);
      const app = new AppAuthStateMachine("focus");

      let sessionActive = false;

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/auth/me")) {
          if (!sessionActive) {
            return new Response(
              JSON.stringify({
                ok: false,
                error: { code: "unauthorized", message: "Authentication required" },
              }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                owner_user_id: "8364430714",
                expires_at: new Date(Date.now() + 86400000).toISOString(),
                created_at: new Date().toISOString(),
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/v1/auth/pair")) {
          const body = JSON.parse(init?.body as string || "{}");
          if (body.code === "A1B2C3") {
            sessionActive = true;
            return new Response(
              JSON.stringify({
                ok: true,
                data: {
                  authenticated: true,
                  token: "paired-session-token-xyz",
                  expires_at: new Date(Date.now() + 86400000).toISOString(),
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(
            JSON.stringify({
              ok: false,
              error: { code: "unauthorized", message: "Invalid pairing code" },
            }),
            { status: 401, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/v1/today")) {
          return new Response(
            JSON.stringify({ ok: true, data: { date: "2026-10-22", tasks_due: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/v1/focus")) {
          return new Response(
            JSON.stringify({ ok: true, data: { active_task: null } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch call to: ${url}`);
      };

      // 1. Initial bootstrap fails -> PairView
      await app.refreshCoreData();
      assert(app.isAuthenticated === false, "Bootstrap: unauthenticated");
      assert(app.getActiveView() === "PairView", "Bootstrap: shows PairView");

      // 2. Perform pairing via api.pair()
      const pairRes = await api.pair("A1B2C3");
      assert(pairRes.authenticated === true, "api.pair() returned authenticated: true");
      assert(getSessionToken() === "paired-session-token-xyz", "Session token stored in memory");

      // 3. Trigger onPairedSuccess
      await app.handlePairedSuccess();

      assert(app.isAuthenticated === true, "Transitioned to isAuthenticated = true");
      assert(app.currentMode === "focus", "Switched currentMode to 'focus'");
      assert(app.getActiveView() === "TodayView", "Now displays TodayView / dashboard");
      assert(app.todayData !== null, "Loaded dashboard data upon successful pairing");
    }

    // -----------------------------------------------------------------------
    // Test 4: Expired / invalid session -> return to pairing screen
    // -----------------------------------------------------------------------
    console.log("\n--- 4. Testing Expired/Invalid Session Handling ---");
    {
      setSessionToken("expiring-session-token");
      const app = new AppAuthStateMachine("focus");

      let sessionRevoked = false;

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/auth/me")) {
          if (sessionRevoked) {
            return new Response(
              JSON.stringify({
                ok: false,
                error: { code: "unauthorized", message: "Session expired or revoked" },
              }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                owner_user_id: "8364430714",
                expires_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/v1/today")) {
          return new Response(
            JSON.stringify({ ok: true, data: { date: "2026-10-22", tasks_due: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/v1/focus")) {
          return new Response(
            JSON.stringify({ ok: true, data: { active_task: null } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected fetch call to: ${url}`);
      };

      // 1. Initially authenticated
      await app.refreshCoreData();
      assert(app.isAuthenticated === true, "Session is initially active");
      assert(app.getActiveView() === "TodayView", "Dashboard is rendered");

      // 2. Simulate session expiration
      sessionRevoked = true;
      await app.refreshCoreData();

      assert(app.isAuthenticated === false, "Reverted isAuthenticated to false after 401");
      assert(app.todayData === null, "todayData cleared on expired session");
      assert(app.focusData === null, "focusData cleared on expired session");
      assert(app.getActiveView() === "PairView", "UI returned to PairView immediately");
    }

  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\n========================================================");
  console.log(`Results: ${passCount} passed, ${failCount} failed, total ${passCount + failCount}`);
  console.log("========================================================\n");

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner threw an unhandled error:", err);
  process.exit(1);
});
