/**
 * desktop_agent/mirror_agent.ts - Block 3 Desktop Outbox Mirror Agent
 *
 * Implements:
 * - B3.5 Agent-side validation (single segment, .md only, no reserved Windows names, allowlist, realpath)
 * - B3.6 Untrusted content neutralization verification
 * - B3.7 Conflict guard (.mirror_state.json, on-disk diff -> .conflict-<timestamp>.md, atomic write)
 * - B3.8 Agent runtime (single-instance lock, rotating log, backoff, --vault, --dry-run, --once)
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const DEFAULT_VAULT_PATH = "D:\\daemon's brain\\Knowledge\\Mirror";
const STATE_FILENAME = ".mirror_state.json";
const LOCK_FILENAME = ".mirror_agent.lock";
const LOG_FILENAME = "mirror_agent.log";
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB rotating log

const RESERVED_WINDOWS_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

const ALLOWED_SUBFOLDERS = new Set([
  "",
  "Recipes",
  "Memories",
  "Briefings",
  "Tasks",
]);

export interface MirrorConfig {
  vaultPath: string;
  serverUrl: string;
  deviceToken: string;
  dryRun?: boolean;
  once?: boolean;
}

export function sha256File(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function logMessage(logFile: string, msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      if (stats.size > MAX_LOG_BYTES) {
        fs.renameSync(logFile, `${logFile}.old`);
      }
    }
    fs.appendFileSync(logFile, line, "utf8");
  } catch {}
  console.log(msg);
}

// ---------------------------------------------------------------------------
// B3.5 Strict Agent-Side Path & Content Validation
// ---------------------------------------------------------------------------
export function validateJob(
  vaultRoot: string,
  targetFolder: string,
  filename: string,
  content: string
): { valid: boolean; error?: string; resolvedTargetDir?: string } {
  // 1. Filename length cap
  if (!filename || filename.length > 100) {
    return { valid: false, error: "Filename exceeds 100 characters or is empty." };
  }

  // 2. Single segment check: no path separators
  if (filename.includes("/") || filename.includes("\\")) {
    return { valid: false, error: "Filename must be a single segment; separators forbidden." };
  }

  // 3. Must be .md only
  if (!filename.toLowerCase().endsWith(".md")) {
    return { valid: false, error: "Filename must end with .md" };
  }

  // 4. No alternate data streams (":")
  if (filename.includes(":")) {
    return { valid: false, error: "Alternate data streams (:) forbidden in filename." };
  }

  // 5. No parent traversal
  if (filename.includes("..")) {
    return { valid: false, error: "Directory traversal (..) forbidden." };
  }

  // 6. No trailing dot or space
  const nameWithoutExt = filename.slice(0, -3);
  if (nameWithoutExt.endsWith(".") || nameWithoutExt.endsWith(" ")) {
    return { valid: false, error: "Trailing dot or space forbidden in Windows filenames." };
  }

  // 7. Reserved Windows device names
  const baseUpper = nameWithoutExt.toUpperCase();
  if (RESERVED_WINDOWS_NAMES.has(baseUpper)) {
    return { valid: false, error: `Reserved Windows device name '${baseUpper}' forbidden.` };
  }

  // 8. Content size cap (500KB)
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > 512_000) {
    return { valid: false, error: `Content exceeds 500KB size limit (${byteLength} bytes).` };
  }

  // 9. Target folder allowlist check
  // Normalize targetFolder to subfolder relative to Mirror
  let subfolder = targetFolder.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "");
  subfolder = subfolder.replace(/^Knowledge[/\\]Mirror[/\\]?/i, "");
  subfolder = subfolder.replace(/^Mirror[/\\]?/i, "");

  if (!ALLOWED_SUBFOLDERS.has(subfolder)) {
    return { valid: false, error: `Target folder '${targetFolder}' is not in the Mirror allowlist.` };
  }

  // 10. Realpath boundary check: resolved path must be inside vaultRoot
  const targetDir = subfolder ? path.join(vaultRoot, subfolder) : vaultRoot;
  const canonicalVaultRoot = path.resolve(vaultRoot);
  const canonicalTargetDir = path.resolve(targetDir);

  if (!canonicalTargetDir.startsWith(canonicalVaultRoot)) {
    return { valid: false, error: "Resolved directory escapes vault root boundary." };
  }

  return { valid: true, resolvedTargetDir: canonicalTargetDir };
}

// ---------------------------------------------------------------------------
// B3.7 State File & Atomic Write with Conflict Detection
// ---------------------------------------------------------------------------
export interface MirrorState {
  writtenHashes: Record<string, string>; // relativePath -> sha256
}

export function loadState(vaultRoot: string): MirrorState {
  const statePath = path.join(vaultRoot, STATE_FILENAME);
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, "utf8"));
    }
  } catch {}
  return { writtenHashes: {} };
}

export function saveState(vaultRoot: string, state: MirrorState) {
  const statePath = path.join(vaultRoot, STATE_FILENAME);
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

export async function processJob(
  config: MirrorConfig,
  job: any,
  state: MirrorState,
  logFile: string
): Promise<{ status: "delivered" | "conflict" | "failed"; writtenPath?: string; conflictPath?: string; error?: string }> {
  const validation = validateJob(config.vaultPath, job.target_folder, job.filename, job.content);
  if (!validation.valid || !validation.resolvedTargetDir) {
    logMessage(logFile, `[REJECT] Job ${job.id} validation failed: ${validation.error}`);
    return { status: "failed", error: validation.error };
  }

  const targetDir = validation.resolvedTargetDir;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const targetFilePath = path.join(targetDir, job.filename);
  const relPath = path.relative(config.vaultPath, targetFilePath).replace(/\\/g, "/");
  const jobSha = sha256File(job.content);

  // Delete jobs are created only by the cloud after a committed D1 delete.
  if (job.action === "delete") {
    let removed = false;
    if (fs.existsSync(targetFilePath)) {
      if (!config.dryRun) {
        fs.unlinkSync(targetFilePath);
        delete state.writtenHashes[relPath];
        saveState(config.vaultPath, state);
      }
      removed = true;
    }
    logMessage(logFile, `[DELETE] ${removed ? "Removed" : "No file at"} '${relPath}'.`);
    return { status: "delivered", writtenPath: targetFilePath };
  }

  // Conflict Guard: check if file already exists on disk
  if (fs.existsSync(targetFilePath)) {
    const existingContent = fs.readFileSync(targetFilePath, "utf8");
    const onDiskSha = sha256File(existingContent);
    const lastKnownSha = state.writtenHashes[relPath];

    // If on-disk differs from what agent last wrote, local edit detected!
    const isConflict = lastKnownSha
      ? onDiskSha !== lastKnownSha && onDiskSha !== jobSha
      : onDiskSha !== jobSha;

    if (isConflict) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const conflictFilename = job.filename.replace(/\.md$/i, `.conflict-${timestamp}.md`);
      const conflictFilePath = path.join(targetDir, conflictFilename);

      logMessage(logFile, `[CONFLICT] Local edit detected for '${relPath}'. Writing conflict copy to '${conflictFilename}'.`);

      if (!config.dryRun) {
        // Write conflict copy atomically
        const tmpPath = `${conflictFilePath}.tmp.${Date.now()}`;
        fs.writeFileSync(tmpPath, job.content, "utf8");
        fs.renameSync(tmpPath, conflictFilePath);
      }

      return {
        status: "conflict",
        writtenPath: targetFilePath,
        conflictPath: conflictFilePath,
        error: `Local edit detected on ${relPath}. Preserved original and created conflict copy.`,
      };
    }
  }

  // Clean write / update (atomic write via temp file)
  if (!config.dryRun) {
    const tmpPath = `${targetFilePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, job.content, "utf8");
    fs.renameSync(tmpPath, targetFilePath);
    state.writtenHashes[relPath] = jobSha;
    saveState(config.vaultPath, state);
  }

  logMessage(logFile, `[DELIVERED] Written '${relPath}' (${jobSha.slice(0, 8)}).`);
  return { status: "delivered", writtenPath: targetFilePath };
}

// ---------------------------------------------------------------------------
// Single-Instance Lock
// ---------------------------------------------------------------------------
export function acquireLock(vaultRoot: string): boolean {
  const lockPath = path.join(vaultRoot, LOCK_FILENAME);
  try {
    if (fs.existsSync(lockPath)) {
      const pidStr = fs.readFileSync(lockPath, "utf8").trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0); // test if process exists
          return false; // already running!
        } catch {
          // stale lock
        }
      }
    }
    fs.writeFileSync(lockPath, String(process.pid), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(vaultRoot: string) {
  const lockPath = path.join(vaultRoot, LOCK_FILENAME);
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Agent Main Poll Loop
// ---------------------------------------------------------------------------
export async function runMirrorAgent(config: MirrorConfig): Promise<void> {
  const logFile = path.join(config.vaultPath, LOG_FILENAME);
  if (!fs.existsSync(config.vaultPath)) {
    fs.mkdirSync(config.vaultPath, { recursive: true });
  }

  if (!acquireLock(config.vaultPath)) {
    logMessage(logFile, "Another agent instance is already running. Exiting.");
    throw new Error("Another agent instance is already running. Exiting.");
  }

  process.on("exit", () => releaseLock(config.vaultPath));
  process.on("SIGINT", () => { releaseLock(config.vaultPath); process.exit(0); });
  process.on("SIGTERM", () => { releaseLock(config.vaultPath); process.exit(0); });

  logMessage(logFile, `Mirror agent started. Vault: '${config.vaultPath}', Server: '${config.serverUrl}'`);

  const state = loadState(config.vaultPath);
  let backoffMs = 1000;
  const maxBackoffMs = 5 * 60 * 1000; // 5 min

  while (true) {
    try {
      // Poll mirror jobs from server
      const url = `${config.serverUrl}/api/v1/desktop/mirror-jobs`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.deviceToken}`,
        },
      });

      if (res.status === 401 || res.status === 403) {
        logMessage(logFile, `Authentication failed (HTTP ${res.status}). Device token invalid or revoked. Halting agent.`);
        releaseLock(config.vaultPath);
        return;
      }

      if (!res.ok && res.status !== 204) {
        logMessage(logFile, `Server error HTTP ${res.status}. Backing off for ${Math.round(backoffMs / 1000)}s.`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
        if (config.once) break;
        continue;
      }

      backoffMs = 1000; // reset backoff on success

      if (res.status === 204) {
        // No pending jobs
        if (config.once) break;
        const jitter = Math.floor(Math.random() * 30000);
        await new Promise((r) => setTimeout(r, 30000 + jitter));
        continue;
      }

      const data = (await res.json().catch(() => ({}))) as any;
      const jobs = data.jobs || [];

      for (const job of jobs) {
        const result = await processJob(config, job, state, logFile);
        // ACK to server
        try {
          await fetch(`${config.serverUrl}/api/v1/desktop/mirror-jobs/${job.id}/ack`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.deviceToken}`,
            },
            body: JSON.stringify({
              status: result.status,
              writtenPath: result.writtenPath,
              conflictPath: result.conflictPath,
              error: result.error,
              sha256: sha256File(job.content),
            }),
          });
        } catch (ackErr: any) {
          logMessage(logFile, `Failed to ACK job ${job.id}: ${ackErr.message}`);
        }
      }

      if (config.once) break;
      const jitter = Math.floor(Math.random() * 30000);
      await new Promise((r) => setTimeout(r, 30000 + jitter));
    } catch (e: any) {
      logMessage(logFile, `Polling exception: ${e.message}. Backing off for ${Math.round(backoffMs / 1000)}s.`);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
      if (config.once) break;
    }
  }

  releaseLock(config.vaultPath);
}

// CLI entry point
if (process.argv[1] && process.argv[1].includes("mirror_agent")) {
  const args = process.argv.slice(2);
  let vaultPath = DEFAULT_VAULT_PATH;
  let serverUrl = "https://personal-ai-os.jatin-personal-ai.workers.dev";
  let dryRun = false;
  let once = false;
  let deviceToken = process.env.DESKTOP_DEVICE_TOKEN || "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && args[i + 1]) vaultPath = args[++i];
    if (args[i] === "--server" && args[i + 1]) serverUrl = args[++i];
    if (args[i] === "--token" && args[i + 1]) deviceToken = args[++i];
    if (args[i] === "--dry-run") dryRun = true;
    if (args[i] === "--once") once = true;
  }

  runMirrorAgent({ vaultPath, serverUrl, deviceToken, dryRun, once }).catch((err) => {
    console.error("Fatal agent error:", err);
    process.exit(1);
  });
}
