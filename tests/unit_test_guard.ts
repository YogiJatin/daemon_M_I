/**
 * tests/unit_test_guard.ts - the safety gate that keeps scripted runners off production.
 *
 * Covers scripts/lib/testGuard.ts:
 *   1. Local is the default target and seeds use `--local`.
 *   2. A non-loopback target needs the explicit --allow-remote / ALLOW_REMOTE_TESTS opt-in.
 *   3. A stray --base-url pointing at production is refused without that opt-in.
 *   4. Run ids are unique and prefixed.
 *   5. Cleanup runs every step, survives a throwing step, and drains itself.
 */

import {
  assertSafeTarget,
  cleanupTaggedRowsSql,
  CleanupRegistry,
  isLoopbackUrl,
  LOCAL_BASE_URL,
  newTestRunId,
  parseTarget,
  REMOTE_BASE_URL,
  tagSeededRowSql,
} from "../scripts/lib/testGuard";

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

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

async function runGuardTests() {
  console.log("\n=== TEST GUARD (A2) ===\n");

  // ----------------------------------------------------
  // 1. Defaults are local
  // ----------------------------------------------------
  console.log("--- 1. Default target is local wrangler dev ---");
  const local = parseTarget([], {});
  assert(local.remote === false, "no flags resolves to a local target", local);
  assert(local.baseUrl === LOCAL_BASE_URL, "base URL is the loopback default", local.baseUrl);
  assert(local.d1Flag === "--local", "D1 seeds use --local", local.d1Flag);
  assert(local.optedIn === false, "opt-in is false by default", local.optedIn);

  // ----------------------------------------------------
  // 2. Explicit opt-in
  // ----------------------------------------------------
  console.log("--- 2. Remote requires an explicit opt-in ---");
  const byFlag = parseTarget(["--allow-remote"], {});
  assert(byFlag.remote === true, "--allow-remote selects the deployed Worker", byFlag);
  assert(byFlag.baseUrl === REMOTE_BASE_URL, "--allow-remote uses the production URL", byFlag.baseUrl);
  assert(byFlag.d1Flag === "--remote", "remote run seeds with --remote", byFlag.d1Flag);

  const byEnv = parseTarget([], { ALLOW_REMOTE_TESTS: "1" });
  assert(byEnv.remote === true, "ALLOW_REMOTE_TESTS=1 is accepted as opt-in", byEnv);
  assert(byEnv.optedIn === true, "env opt-in is recorded", byEnv.optedIn);

  const anythingElse = parseTarget([], { ALLOW_REMOTE_TESTS: "true" });
  assert(anythingElse.remote === false, "only '1' counts as opt-in, not 'true'", anythingElse);

  // ----------------------------------------------------
  // 3. A stray --base-url cannot bypass the gate
  // ----------------------------------------------------
  console.log("--- 3. Stray --base-url cannot bypass the gate ---");
  const sneaky = parseTarget(["--base-url=https://personal-ai-os.jatin-personal-ai.workers.dev"], {});
  assert(sneaky.remote === true, "explicit production base URL is recognised as remote", sneaky);
  assert(sneaky.optedIn === false, "it is not treated as opt-in", sneaky.optedIn);
  assert(throws(() => assertSafeTarget("suite", sneaky)), "assertSafeTarget refuses it without --allow-remote");

  const allowed = parseTarget(["--allow-remote", "--base-url=http://127.0.0.1:9999"], {});
  assert(allowed.remote === false, "opted-in loopback override stays local", allowed);

  // ----------------------------------------------------
  // 4. assertSafeTarget behaviour
  // ----------------------------------------------------
  console.log("--- 4. assertSafeTarget ---");
  assert(!throws(() => assertSafeTarget("suite", local)), "loopback target passes");
  assert(!throws(() => assertSafeTarget("suite", byFlag)), "opted-in remote target passes");
  let refusal = "";
  try {
    assertSafeTarget("suite", sneaky);
  } catch (error) {
    refusal = (error as Error).message;
  }
  assert(refusal.includes("--allow-remote"), "the refusal explains how to opt in", refusal);
  assert(!throws(() => assertSafeTarget("suite", byEnv)), "a passing target never throws");

  // ----------------------------------------------------
  // 5. Loopback detection
  // ----------------------------------------------------
  console.log("--- 5. isLoopbackUrl ---");
  assert(isLoopbackUrl("http://127.0.0.1:8787") === true, "127.0.0.1 is loopback");
  assert(isLoopbackUrl("http://localhost:8787") === true, "localhost is loopback");
  assert(isLoopbackUrl("https://personal-ai-os.jatin-personal-ai.workers.dev") === false, "workers.dev is not loopback");
  assert(isLoopbackUrl("not a url") === false, "unparseable input is not loopback");

  // ----------------------------------------------------
  // 6. Run id tagging
  // ----------------------------------------------------
  console.log("--- 6. Test run ids ---");
  const a = newTestRunId();
  const b = newTestRunId();
  assert(a !== b, "run ids are unique");
  assert(/^test_run_[0-9a-f]{12}$/.test(a), "run id has the expected shape", a);
  assert(newTestRunId("b2").startsWith("b2_"), "custom prefix is honoured", newTestRunId("b2"));

  const tag = tagSeededRowSql("memory_objects", "id", "mem_seed_1", a);
  assert(tag.includes(`test_run_id = '${a}'`) && tag.includes("'mem_seed_1'"), "tag statement targets one row", tag);
  const wipe = cleanupTaggedRowsSql("memory_objects", a);
  assert(wipe === `DELETE FROM memory_objects WHERE test_run_id = '${a}';`, "cleanup only deletes this run's rows", wipe);

  // ----------------------------------------------------
  // 7. Cleanup registry
  // ----------------------------------------------------
  console.log("--- 7. CleanupRegistry ---");
  const registry = new CleanupRegistry();
  const order: string[] = [];
  registry.register(() => { order.push("first"); });
  registry.register(() => { throw new Error("deliberate"); });
  registry.register(async () => { order.push("third"); });

  const failures = await registry.runAll(() => {});
  assert(failures === 1, "one failing step is counted, others still run", failures);
  assert(order.join(",") === "first,third", "a throwing step does not block later steps", order);
  assert(registry.size === 0, "steps are drained so a second call cannot delete twice");

  const secondRun = await registry.runAll(() => {});
  assert(secondRun === 0, "second runAll has nothing to do", secondRun);

  console.log(`\n=== RESULT: ${passCount} passed, ${failCount} failed ===`);
  if (failCount > 0) process.exit(1);
}

runGuardTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
