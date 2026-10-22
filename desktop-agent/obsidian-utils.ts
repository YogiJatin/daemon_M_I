/**
 * desktop-agent/obsidian-utils.ts — Pure Utility Functions
 *
 * All path security, filename sanitization, and nonce management live here.
 * Exported individually so tests can cover each invariant without starting a server.
 *
 * Security invariants:
 * - sanitizeFilename strips all characters illegal on Windows + Unix filesystems
 * - validateFolder rejects any relative traversal, absolute paths, and null bytes
 * - resolveVaultPath confirms the final path is inside the vault root
 * - Nonces are single-use with a 30-second TTL; expired entries are purged on each issue
 */

import path from 'node:path';
import crypto from 'node:crypto';

// ─── Filename Sanitization ────────────────────────────────────────────────────

export interface SanitizeResult {
  safe: string;
  changed: boolean;
}

/**
 * Sanitizes a filename for safe use on Windows and Unix.
 * Strips / replaces: forward-slash, backslash, colon, asterisk, question mark,
 * double-quote, angle brackets, pipe, null bytes, and leading dots.
 * Collapses consecutive dashes and trims whitespace.
 */
export function sanitizeFilename(raw: string): SanitizeResult {
  if (!raw || typeof raw !== 'string') {
    return { safe: 'untitled.md', changed: true };
  }

  let safe = raw
    .replace(/\0/g, '')                   // null bytes
    .replace(/[/\\:*?"<>|]/g, '-')        // Windows + Unix illegal filesystem chars
    .replace(/\.{2,}/g, '.')              // collapse .. to single dot
    .replace(/-{2,}/g, '-')               // collapse multiple dashes
    .trim();

  // Ensure .md extension
  if (!safe.toLowerCase().endsWith('.md')) {
    safe = safe + '.md';
  }

  // Guard empty result
  if (safe === '.md' || safe === '') {
    safe = 'untitled.md';
  }

  return { safe, changed: safe !== raw };
}

// ─── Folder Validation ────────────────────────────────────────────────────────

/**
 * Validates a relative folder path for use inside a vault.
 * Throws if the path attempts traversal, is absolute, or contains null bytes.
 * Returns the normalized path with forward slashes on success.
 */
export function validateFolder(folder: string): string {
  if (!folder || typeof folder !== 'string') {
    throw new Error('Folder must be a non-empty string.');
  }

  const normalized = folder.replace(/\\/g, '/').trim();

  if (normalized.includes('\0')) {
    throw new Error('Folder path contains null bytes — rejected.');
  }
  if (normalized.startsWith('/')) {
    throw new Error(`Absolute folder path rejected: "${folder}"`);
  }
  // Block any segment that is ".." or starts with "../"
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`Path traversal rejected: "${folder}"`);
    }
  }
  // Catch Windows absolute paths like "C:/..." that slipped through
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Absolute path injection rejected: "${folder}"`);
  }

  return normalized;
}

// ─── Vault Path Resolution ────────────────────────────────────────────────────

/**
 * Resolves vault + folder + filename into an absolute destination path.
 * Verifies the result is still inside the vault root; throws if not.
 */
export function resolveVaultPath(vault: string, folder: string, filename: string): string {
  const vaultRoot = path.resolve(vault);
  const destPath  = path.resolve(vault, folder, filename);

  // Must start with vaultRoot + path separator (prevent adjacent directory matches)
  if (!destPath.startsWith(vaultRoot + path.sep) && destPath !== vaultRoot) {
    throw new Error(
      `Resolved path "${destPath}" is outside the configured vault "${vaultRoot}". Write rejected.`
    );
  }

  return destPath;
}

// ─── Original-Title Preservation ─────────────────────────────────────────────

/**
 * If sanitization changed the filename, injects an `original_title` field into
 * the YAML frontmatter so the intended note name is visible inside Obsidian.
 * If no frontmatter is found, the content is returned unchanged.
 */
export function injectOriginalTitle(content: string, originalTitle: string): string {
  if (!content.startsWith('---')) return content;

  // Find the closing ---
  const closingIdx = content.indexOf('\n---', 4);
  if (closingIdx === -1) return content;

  const before  = content.slice(0, closingIdx);
  const after   = content.slice(closingIdx);
  const escaped = originalTitle.replace(/"/g, '\\"');

  return `${before}\noriginal_title: "${escaped}"${after}`;
}

// ─── Nonce Management ─────────────────────────────────────────────────────────

interface NonceEntry {
  expiresAt: number;
}

const nonceStore = new Map<string, NonceEntry>();

export const NONCE_TTL_MS = 30_000; // 30 seconds

/**
 * Issues a cryptographically random UUID as a single-use write nonce.
 * Purges any already-expired entries on each call.
 */
export function issueNonce(): string {
  const now   = Date.now();
  const nonce = crypto.randomUUID();

  // Purge expired
  for (const [k, v] of nonceStore) {
    if (v.expiresAt < now) nonceStore.delete(k);
  }

  nonceStore.set(nonce, { expiresAt: now + NONCE_TTL_MS });
  return nonce;
}

/**
 * Validates and consumes a nonce in one atomic operation.
 * Returns true only if the nonce exists, has not expired, and is now deleted.
 */
export function consumeNonce(nonce: string | undefined): boolean {
  if (!nonce) return false;
  const entry = nonceStore.get(nonce);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    nonceStore.delete(nonce);
    return false;
  }
  nonceStore.delete(nonce); // single-use: consumed
  return true;
}

/** Exposed for testing only — returns the current size of the nonce store. */
export function _nonceStoreSize(): number {
  return nonceStore.size;
}

/** Exposed for testing only — clears the nonce store. */
export function _clearNonceStore(): void {
  nonceStore.clear();
}
