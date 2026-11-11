/**
 * scripts/backup_d1.ts - export remote D1 to a directory OUTSIDE the repository.
 *
 * The previous backups landed in backups/ inside the repo, which here also means
 * inside OneDrive. Dumps now default to %USERPROFILE%\backups and can be moved with
 * the BACKUP_DIR environment variable. The script refuses any path inside the repo.
 *
 * Every export is scanned for credential shapes (Telegram bot token, Google API key,
 * Groq key). A hit prints the line number only: values are never shown.
 *
 * Usage: npm run backup:d1
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = process.cwd();
const DATABASE = "personal-ai-os-db";

function resolveTargetDir(): string {
  const configured = process.env.BACKUP_DIR?.trim();
  const dir = configured || path.join(os.homedir(), "backups");
  const resolved = path.resolve(dir);
  if (resolved.startsWith(path.resolve(ROOT) + path.sep) || resolved === path.resolve(ROOT)) {
    console.log("REFUSED: BACKUP_DIR points inside the repository.");
    console.log(`  repo:   ${path.resolve(ROOT)}`);
    console.log(`  target: ${resolved}`);
    console.log("  Set BACKUP_DIR to a folder outside the repo, or unset it to use the default.");
    process.exit(2);
  }
  return resolved;
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
}

/** Credential shapes. A match is reported by line number only. */
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "telegram bot token"],
  [/AIza[0-9A-Za-z_-]{20,}/g, "google api key"],
  [/gsk_[A-Za-z0-9]{20,}/g, "groq api key"],
];

function scanForCredentials(file: string): number {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  let hits = 0;
  for (let index = 0; index < lines.length; index += 1) {
    for (const [pattern, label] of CREDENTIAL_PATTERNS) {
      if (pattern.test(lines[index])) {
        hits += 1;
        console.log(`  WARNING: possible ${label} at line ${index + 1} - value not printed`);
      }
      pattern.lastIndex = 0;
    }
  }
  return hits;
}

function main(): void {
  const dir = resolveTargetDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `d1-${stamp()}.sql`);

  console.log(`backup: exporting ${DATABASE} to ${file}`);
  // Run wrangler through node and its own entry file. Spawning "npx.cmd" without a
  // shell fails silently on Windows, which made this look like an unsatisfiable export.
  const wranglerBin = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(wranglerBin)) {
    console.log(`FAIL: wrangler not found at ${wranglerBin} - run npm install`);
    process.exit(1);
  }
  const result = spawnSync(
    process.execPath,
    [wranglerBin, "d1", "export", DATABASE, "--remote", `--output=${file}`],
    { cwd: ROOT, stdio: "inherit", shell: false }
  );
  if ((result.status ?? 1) !== 0 || !fs.existsSync(file)) {
    console.log("FAIL: export did not produce a file");
    process.exit(1);
  }

  const bytes = fs.statSync(file).size;
  console.log(`backup: wrote ${bytes} bytes`);
  if (bytes === 0) {
    console.log("FAIL: export is empty");
    process.exit(1);
  }

  const hits = scanForCredentials(file);
  if (hits > 0) {
    console.log(`backup: ${hits} possible credential hit(s) - inspect the file before sharing it`);
    console.log("  The dump itself is not modified. Move it, or re-run after cleaning the table.");
  } else {
    console.log("backup: credential scan clean");
  }
}

main();
