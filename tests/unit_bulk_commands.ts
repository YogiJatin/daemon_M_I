/**
 * tests/unit_bulk_commands.ts - owner phrasing for bulk actions must map to an
 * explicit kind, and ordinary chat must never match.
 */

import assert from "node:assert";
import { matchBulkCommand } from "../worker/bulkOps";

let passed = 0;
let failed = 0;

function it(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL: ${name}\n     ${err?.message || err}`);
  }
}

console.log("\n=== bulk commands ===\n");

it("delete all tasks", () => {
  assert.equal(matchBulkCommand("Delete all tasks")?.kind, "delete_tasks");
});

it("remove all the tasks and dues", () => {
  assert.equal(matchBulkCommand("remove all the tasks and dues")?.kind, "delete_tasks");
});

it("remove all tasks and classes", () => {
  assert.equal(matchBulkCommand("remove all tasks and classes")?.kind, "delete_all");
});

it("delete all classes", () => {
  assert.equal(matchBulkCommand("delete all classes")?.kind, "delete_classes");
});

it("mark all tasks complete", () => {
  assert.equal(matchBulkCommand("mark all tasks as complete")?.kind, "complete_tasks");
});

it("plain chat does not match", () => {
  assert.equal(matchBulkCommand("how are my tasks looking"), null);
  assert.equal(matchBulkCommand("delete the milk task"), null);
  assert.equal(matchBulkCommand("hello sir"), null);
});

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
