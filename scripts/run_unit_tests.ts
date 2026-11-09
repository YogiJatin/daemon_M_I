/**
 * scripts/run_unit_tests.ts - runs every tests/unit_*.ts suite and aggregates results.
 *
 * Usage: npm test            (all suites)
 *        npm test -- guard   (only files whose name contains "guard")
 *
 * Each suite is a standalone script that exits non-zero on failure, so this runner
 * just executes them in order and reports which ones failed.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// npm scripts run from the project root.
const PROJECT_ROOT = process.cwd();
const TESTS_DIR = path.join(PROJECT_ROOT, "tests");
const filter = process.argv[2] ?? "";

const files = fs
  .readdirSync(TESTS_DIR)
  .filter((name) => name.startsWith("unit_") && name.endsWith(".ts"))
  .filter((name) => (filter ? name.includes(filter) : true))
  .sort();

if (files.length === 0) {
  console.log("No unit test files matched.");
  process.exit(1);
}

// Run tsx through node itself: no shell, so no argument-escaping surprises on Windows.
const tsxCli = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const failures: string[] = [];

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const run = spawnSync(process.execPath, [tsxCli, path.join(TESTS_DIR, file)], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  if (run.status !== 0) {
    failures.push(file);
  }
}

console.log("");
console.log(`Suites run: ${files.length}`);
if (failures.length > 0) {
  console.log(`Failed (${failures.length}):`);
  for (const file of failures) console.log(`  ${file}`);
  process.exit(1);
}
console.log("All unit suites passed.");
