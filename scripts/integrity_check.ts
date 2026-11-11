/**
 * scripts/integrity_check.ts - file-level integrity gate.
 *
 * Why this exists: two worker modules were silently damaged in an earlier pass.
 * One lost every backslash inside its regexes ("\s+" became "s+"), which turned a
 * working safety gate into one that matched literal text. Another was truncated to
 * a 125-byte fragment with no exports. Neither broke the build, because the damage
 * was still valid TypeScript, so tests caught it late.
 *
 * This gate checks two shapes of that damage before a deploy or a commit:
 *   1. A module too small to be complete, or ending mid-token.
 *   2. A regex literal where a backslash was stripped, leaving "s+" or "d{".
 *
 * Only the body of a regex literal is inspected, so ordinary code such as
 * `attempts++` or `circuit.consecutiveFailures++` is never flagged.
 *
 * Usage: npm run integrity
 *        npm run predeploy                                   (this, then model guard)
 *        npx tsx scripts/integrity_check.ts --compile        (plus worker typecheck)
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = process.cwd();

/** Any module smaller than this cannot be a real module. */
const MIN_BYTES = 150;

interface Finding {
  file: string;
  line: number;
  why: string;
  excerpt: string;
}

function listTs(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(dir, name).replace(/\\/g, "/"));
}

/**
 * Return the bodies of regex literals on one line. A regex is recognised only after
 * a character that can legally precede one, so division and URLs are skipped.
 */
function regexBodies(line: string): string[] {
  const bodies: string[] = [];
  const allowedBefore = "=(,!:[{&|?;<>+-*%^~";
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "/" || line[index + 1] === "/" || line[index - 1] === "/") continue;
    let before = index - 1;
    while (before >= 0 && line[before] === " ") before -= 1;
    const preceding = before >= 0 ? line[before] : "";
    if (preceding !== "" && !allowedBefore.includes(preceding) && !line.slice(0, index).trimEnd().endsWith("return")) {
      continue;
    }

    let cursor = index + 1;
    let body = "";
    let inClass = false;
    while (cursor < line.length) {
      const char = line[cursor];
      if (char === "\\") {
        body += char + (line[cursor + 1] ?? "");
        cursor += 2;
        continue;
      }
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) break;
      body += char;
      cursor += 1;
    }
    if (cursor < line.length && body.length > 0) bodies.push(body);
    index = cursor;
  }
  return bodies;
}

/** A stripped backslash leaves a bare quantifier that follows a letter, "|" or ")". */
function corruptReason(body: string): string | null {
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "s" && char !== "d") continue;
    const next = body[index + 1];
    if (next !== "+" && next !== "{") continue;
    if (index > 0 && body[index - 1] === "\\") continue; // correctly escaped
    const before = index > 0 ? body[index - 1] : "";
    if (/[a-z|)]/i.test(before)) {
      return char === "s"
        ? "regex lost a backslash (\\s+ became s+)"
        : "regex lost a backslash (\\d{ became d{)";
    }
  }
  return null;
}

function inspect(file: string, problems: Finding[]): number {
  const absolute = path.join(ROOT, file);
  const bytes = fs.statSync(absolute).size;
  const text = fs.readFileSync(absolute, "utf8");
  const lines = text.split(/\r?\n/);

  if (bytes < MIN_BYTES) {
    problems.push({
      file,
      line: 1,
      why: `file is only ${bytes} bytes (minimum ${MIN_BYTES}) - likely truncated`,
      excerpt: `${lines.length} lines`,
    });
  }

  const lastChar = text.trim().slice(-1);
  if (lastChar && !/[}\];'"`a-zA-Z0-9]/.test(lastChar)) {
    problems.push({ file, line: lines.length, why: "file ends mid-token", excerpt: lastChar });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    for (const body of regexBodies(line)) {
      const reason = corruptReason(body);
      if (reason) {
        problems.push({ file, line: index + 1, why: reason, excerpt: body.slice(0, 90) });
      }
    }
  }

  return bytes;
}

function main(): void {
  const files = [...listTs("worker"), ...listTs("scripts")].sort();
  const problems: Finding[] = [];

  if (files.length === 0) {
    console.log("integrity: no files found - wrong working directory?");
    process.exit(1);
  }

  let smallest = Number.MAX_SAFE_INTEGER;
  let smallestFile = "";
  for (const file of files) {
    const bytes = inspect(file, problems);
    if (bytes < smallest) {
      smallest = bytes;
      smallestFile = file;
    }
  }

  console.log(`integrity: scanned ${files.length} files (worker/ and scripts/)`);
  console.log(`integrity: smallest file ${smallestFile} at ${smallest} bytes`);

  if (problems.length > 0) {
    console.log(`integrity: FAIL - ${problems.length} problem(s)`);
    for (const problem of problems) {
      console.log(`  ${problem.file}:${problem.line} - ${problem.why}`);
      console.log(`    ${problem.excerpt}`);
    }
    process.exit(1);
  }

  if (process.argv.includes("--compile")) {
    const tsc = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsc", "-p", "tsconfig.worker.json", "--noEmit"],
      { cwd: ROOT, stdio: "inherit", shell: false }
    );
    if (tsc.status !== 0) {
      console.log("integrity: FAIL - worker typecheck failed");
      process.exit(1);
    }
    console.log("integrity: worker typecheck passed");
  }

  console.log("integrity: PASS");
}

main();
