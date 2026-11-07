/**
 * worker/desktopMirrorService.ts - Block 3 Desktop Outbox Mirror Service
 *
 * Implements:
 * - B3.1 Schema & Job Enqueuing
 * - B3.2 One-time 8-char code pairing, device token hashing, revocation
 * - B3.3 Mirror job claims (with 5-min lease) and idempotent ACK
 * - B3.4 Producer helpers for UI / recipe / memory exports
 * - B3.6 Untrusted content neutralization (Templater, DataviewJS, inline $=)
 */

import { checkAndRedactSecrets } from "./secretsGuard";

export interface MirrorJobRecord {
  id: string;
  dedupe_key: string | null;
  target_folder: string;
  filename: string;
  content: string;
  content_sha256: string;
  status: "pending" | "claimed" | "delivered" | "conflict" | "failed";
  attempts: number;
  claimed_by: string | null;
  claimed_until: string | null;
  written_path: string | null;
  last_error: string | null;
  conflict_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesktopDeviceRecord {
  id: string;
  name: string;
  token_sha256: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  agent_version: string | null;
}

function ulid(): string {
  const ts = Date.now().toString(36).padStart(8, "0");
  const rand = Math.random().toString(36).slice(2, 10).padStart(8, "0");
  return (ts + rand).toUpperCase();
}

export async function sha256Hex(data: string): Promise<string> {
  const enc = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// B3.6 Untrusted External Content Neutralization
// ---------------------------------------------------------------------------
export function neutralizeObsidianContent(content: string, isUntrusted: boolean = false): string {
  let cleaned = content;

  if (isUntrusted) {
    // Neutralize Templater tags: <% ... %>
    cleaned = cleaned.replace(/<%/g, "&lt;%");
    // Neutralize DataviewJS blocks: ```dataviewjs ... ```
    cleaned = cleaned.replace(/```\s*dataviewjs/gi, "```text-dataviewjs");
    // Neutralize inline DataviewJS expressions: $= ...
    cleaned = cleaned.replace(/\$=\s*/g, "\\$=");

    // Add untrusted frontmatter if not present
    if (!cleaned.startsWith("---")) {
      cleaned = `---\nsource: untrusted_external\ntrust: untrusted_external\n---\n\n${cleaned}`;
    }
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// B3.2 Device Pairing & Token Verification
// ---------------------------------------------------------------------------

export async function createPairingCode(db: D1Database): Promise<string> {
  // Generate 8-character random uppercase alphanumeric code (e.g. 7A9B3K2F)
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // exclude easily confused 0, 1, I, O
  let code = "";
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  for (let i = 0; i < 8; i++) {
    code += chars[randomBytes[i] % chars.length];
  }

  const codeHash = await sha256Hex(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // 10 min

  // Cleanup expired pairing codes
  await db.prepare("DELETE FROM desktop_pairing_codes WHERE expires_at < ?").bind(now.toISOString()).run().catch(() => {});

  await db
    .prepare(
      `INSERT INTO desktop_pairing_codes (code_sha256, expires_at, attempts)
       VALUES (?, ?, 0)`
    )
    .bind(codeHash, expiresAt)
    .run();

  return code;
}

export async function exchangePairingCode(
  db: D1Database,
  code: string,
  deviceName: string,
  agentVersion: string = "1.0.0"
): Promise<{ success: boolean; deviceToken?: string; deviceId?: string; error?: string }> {
  const cleanCode = code.trim().toUpperCase();
  const codeHash = await sha256Hex(cleanCode);
  const nowIso = new Date().toISOString();

  const record = await db
    .prepare(
      `SELECT code_sha256, expires_at, used_at, attempts
       FROM desktop_pairing_codes
       WHERE code_sha256 = ?`
    )
    .bind(codeHash)
    .first<{ code_sha256: string; expires_at: string; used_at: string | null; attempts: number }>();

  if (!record) {
    return { success: false, error: "Invalid or expired pairing code." };
  }

  if (record.used_at) {
    return { success: false, error: "Pairing code already used." };
  }

  if (record.expires_at < nowIso) {
    return { success: false, error: "Pairing code has expired." };
  }

  if (record.attempts >= 5) {
    return { success: false, error: "Too many failed attempts. Code locked." };
  }

  // Generate strong device token
  const rawTokenBytes = new Uint8Array(24);
  crypto.getRandomValues(rawTokenBytes);
  const rawTokenHex = Array.from(rawTokenBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const deviceToken = `dsk_${rawTokenHex}`;
  const tokenHash = await sha256Hex(deviceToken);

  const deviceId = "dev_" + ulid();

  // Atomically mark code used and insert device
  await db.batch([
    db
      .prepare("UPDATE desktop_pairing_codes SET used_at = ?, attempts = attempts + 1 WHERE code_sha256 = ?")
      .bind(nowIso, codeHash),
    db
      .prepare(
        `INSERT INTO desktop_devices (id, name, token_sha256, created_at, last_seen_at, agent_version)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(deviceId, deviceName.slice(0, 100), tokenHash, nowIso, nowIso, agentVersion),
  ]);

  return {
    success: true,
    deviceId,
    deviceToken,
  };
}

export async function authenticateDesktopDevice(
  request: Request,
  db: D1Database
): Promise<{ authenticated: boolean; device?: DesktopDeviceRecord; error?: string }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer dsk_")) {
    return { authenticated: false, error: "Missing or invalid desktop device token." };
  }

  const token = authHeader.slice(7).trim();
  const tokenHash = await sha256Hex(token);
  const nowIso = new Date().toISOString();

  const device = await db
    .prepare(
      `SELECT id, name, token_sha256, created_at, last_seen_at, revoked_at, agent_version
       FROM desktop_devices
       WHERE token_sha256 = ?`
    )
    .bind(tokenHash)
    .first<DesktopDeviceRecord>();

  if (!device) {
    return { authenticated: false, error: "Unknown device token." };
  }

  if (device.revoked_at) {
    return { authenticated: false, error: "Device token has been revoked." };
  }

  if (!timingSafeCompare(device.token_sha256, tokenHash)) {
    return { authenticated: false, error: "Token mismatch." };
  }

  // Update last seen
  await db
    .prepare("UPDATE desktop_devices SET last_seen_at = ? WHERE id = ?")
    .bind(nowIso, device.id)
    .run()
    .catch(() => {});

  return { authenticated: true, device };
}

// ---------------------------------------------------------------------------
// B3.3 / B3.4 Mirror Outbox Producers & Queue
// ---------------------------------------------------------------------------

export async function enqueueMirrorJob(
  db: D1Database,
  params: {
    dedupeKey?: string;
    targetFolder: string;
    filename: string;
    content: string;
    isUntrusted?: boolean;
  }
): Promise<string> {
  const jobId = "job_" + ulid();
  const nowIso = new Date().toISOString();

  // Neutralize if untrusted external content
  const cleanContent = neutralizeObsidianContent(params.content, params.isUntrusted);
  const contentSha = await sha256Hex(cleanContent);

  // If a pending/claimed job with the same dedupe_key exists, supersede it!
  if (params.dedupeKey) {
    await db
      .prepare(
        `UPDATE mirror_outbox
         SET status = 'failed', last_error = 'Superseded by newer job ${jobId}', updated_at = ?
         WHERE dedupe_key = ? AND status IN ('pending', 'claimed')`
      )
      .bind(nowIso, params.dedupeKey)
      .run()
      .catch(() => {});
  }

  await db
    .prepare(
      `INSERT INTO mirror_outbox
         (id, dedupe_key, target_folder, filename, content, content_sha256, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
    )
    .bind(
      jobId,
      params.dedupeKey || null,
      params.targetFolder,
      params.filename,
      cleanContent,
      contentSha,
      nowIso,
      nowIso
    )
    .run();

  return jobId;
}

export async function claimPendingMirrorJobs(
  db: D1Database,
  deviceId: string,
  limit: number = 10
): Promise<MirrorJobRecord[]> {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + 5 * 60 * 1000).toISOString(); // 5-min lease

  // Recover expired claims first: if claimed_until < now, reset to pending
  await db
    .prepare(
      `UPDATE mirror_outbox
       SET status = 'pending', claimed_by = NULL, claimed_until = NULL, updated_at = ?
       WHERE status = 'claimed' AND claimed_until < ? AND attempts < 5`
    )
    .bind(nowIso, nowIso)
    .run()
    .catch(() => {});

  // Mark jobs exceeding 5 attempts as failed
  await db
    .prepare(
      `UPDATE mirror_outbox
       SET status = 'failed', last_error = 'Max retry attempts (5) exceeded', updated_at = ?
       WHERE status IN ('pending', 'claimed') AND attempts >= 5`
    )
    .bind(nowIso)
    .run()
    .catch(() => {});

  // Claim up to `limit` pending jobs
  const pendingRows = await db
    .prepare(
      `SELECT id, dedupe_key, target_folder, filename, content, content_sha256, status,
              attempts, claimed_by, claimed_until, written_path, last_error, conflict_path,
              created_at, updated_at
       FROM mirror_outbox
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<MirrorJobRecord>();

  const jobs = pendingRows.results || [];
  if (jobs.length === 0) {
    return [];
  }

  for (const job of jobs) {
    await db
      .prepare(
        `UPDATE mirror_outbox
         SET status = 'claimed', claimed_by = ?, claimed_until = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .bind(deviceId, leaseUntil, nowIso, job.id)
      .run();
  }

  return jobs;
}

export async function acknowledgeMirrorJob(
  db: D1Database,
  jobId: string,
  ack: {
    status: "delivered" | "conflict" | "failed";
    writtenPath?: string;
    sha256?: string;
    error?: string;
    conflictPath?: string;
  }
): Promise<{ success: boolean; message: string }> {
  const nowIso = new Date().toISOString();

  const current = await db
    .prepare("SELECT id, status, content_sha256 FROM mirror_outbox WHERE id = ?")
    .bind(jobId)
    .first<{ id: string; status: string; content_sha256: string }>();

  if (!current) {
    return { success: false, message: `Mirror job '${jobId}' not found.` };
  }

  // Idempotent: if already delivered, ignore duplicate ack
  if (current.status === "delivered" && ack.status === "delivered") {
    return { success: true, message: "Job already delivered (idempotent)." };
  }

  await db
    .prepare(
      `UPDATE mirror_outbox
       SET status = ?, written_path = ?, conflict_path = ?, last_error = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      ack.status,
      ack.writtenPath || null,
      ack.conflictPath || null,
      ack.error || null,
      nowIso,
      jobId
    )
    .run();

  return { success: true, message: `Job '${jobId}' marked as ${ack.status}.` };
}

// ---------------------------------------------------------------------------
// Telegram Device Management Commands: /devices and /revoke
// ---------------------------------------------------------------------------

export async function handleListDevicesCommand(db: D1Database): Promise<string> {
  const rows = await db
    .prepare(
      `SELECT id, name, created_at, last_seen_at, revoked_at, agent_version
       FROM desktop_devices
       ORDER BY created_at DESC
       LIMIT 10`
    )
    .all<DesktopDeviceRecord>();

  const devices = rows.results || [];
  if (devices.length === 0) {
    return "No desktop devices paired. Run /pair desktop to pair your PC.";
  }

  const lines = ["🖥️ Paired Desktop Devices:"];
  for (const d of devices) {
    const status = d.revoked_at ? "🔴 Revoked" : "🟢 Active";
    const lastSeen = d.last_seen_at ? d.last_seen_at.slice(0, 16).replace("T", " ") : "Never";
    lines.push(`• [${d.id}] "${d.name}" (${status}) - Last seen: ${lastSeen}`);
  }
  lines.push("\nTo revoke a device: /revoke <id>");
  return lines.join("\n");
}

export async function handleRevokeDeviceCommand(db: D1Database, deviceId: string): Promise<string> {
  const cleanId = deviceId.trim();
  if (!cleanId) return "Usage: /revoke <device_id>";

  const nowIso = new Date().toISOString();
  const res = await db
    .prepare("UPDATE desktop_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(nowIso, cleanId)
    .run();

  if (!res.meta?.changes) {
    return `Device [${cleanId}] not found or already revoked.`;
  }

  return `Device [${cleanId}] successfully revoked. Next poll will return 401.`;
}
