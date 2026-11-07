/**
 * worker/gmailService.ts - Gmail Read-Only Ingress Adapter (Phase 4 / Block 5)
 *
 * Implements Rule 26 Narrow Amendment:
 * "Read-only mailbox access solely to draft task_proposals; no send, delete,
 * label or modify; no raw bodies stored; email is untrusted DATA."
 *
 * Invariants:
 * - Scope: exactly 'https://www.googleapis.com/auth/gmail.readonly'
 * - PKCE OAuth with single-use state valid for 10 minutes
 * - AES-256-GCM token encryption at rest
 * - Sender domain check anchored (equal or .domain, never substring)
 * - Bulk email (List-Unsubscribe / Precedence: bulk) skipped with zero LLM calls
 * - Quoted replies stripped, text capped at 4000 chars
 * - Message wrapped as <DATA type="email" trust="untrusted_external">
 * - Max 3 task proposals per email
 * - Date validation: past or > 1 year asks confirmation
 * - Mock or Workers AI answering: hold message unseen for future run
 * - invalid_grant disables ingestion with 1 alert, no retry loop
 */

import { encryptToken, decryptToken } from './gmailCrypto';

export interface NormalizedEmailItem {
  source: 'gmail';
  external_id: string;
  received_at: string;
  from: string;
  from_address: string;
  from_domain: string;
  subject: string;
  text: string;
  is_bulk: boolean;
  dkim_pass: boolean;
  raw_body_hash: string;
}

/**
 * Anchored domain allowlist check (E02, E03)
 * Requires domain to equal allowed domain or end with '.' + domain.
 * Rejects subdomains of evil sites like x@university.edu.evil.com or prefix matches.
 */
export function isDomainAllowlisted(fromDomain: string, allowlist: string[]): boolean {
  if (!fromDomain || allowlist.length === 0) return false;
  const target = fromDomain.toLowerCase().trim();

  return allowlist.some((allowed) => {
    const a = allowed.toLowerCase().trim();
    if (!a) return false;
    return target === a || target.endsWith('.' + a);
  });
}

/**
 * Parse email address into display name, address, and domain
 */
export function parseFromHeader(fromHeader: string): { name: string; address: string; domain: string } {
  const match = fromHeader.match(/^(?:["']?([^"']*)["']?\s*)?<?([a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))>?$/);
  if (match) {
    return {
      name: (match[1] || '').trim(),
      address: match[2].toLowerCase().trim(),
      domain: match[3].toLowerCase().trim(),
    };
  }

  // Fallback for simple address
  const atIdx = fromHeader.lastIndexOf('@');
  if (atIdx > 0) {
    const address = fromHeader.trim().toLowerCase().replace(/[<>]/g, '');
    const domain = address.slice(address.lastIndexOf('@') + 1);
    return { name: '', address, domain };
  }

  return { name: '', address: fromHeader, domain: '' };
}

/**
 * Strip quoted email replies and signatures, cap to 4000 chars (E13)
 */
export function stripQuotedReplies(rawText: string): string {
  if (!rawText) return '';

  const lines = rawText.split(/\r?\n/);
  const cleanLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Stop/skip on quotation headers
    if (/^>/.test(trimmed)) continue;
    if (/^On\s+.*wrote:$/i.test(trimmed)) break;
    if (/^-+\s*(?:Original Message|Forwarded message)\s*-+/i.test(trimmed)) break;
    if (/^From:\s+/i.test(trimmed) && cleanLines.length > 2) break;

    cleanLines.push(line);
  }

  let text = cleanLines.join('\n').trim();
  if (text.length > 4000) {
    text = text.slice(0, 4000);
  }
  return text;
}

/**
 * Compute SHA-256 hash of a string
 */
export async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Parse headers from Gmail message payload
 */
export function extractHeaders(headers: Array<{ name: string; value: string }>): {
  from: string;
  subject: string;
  isBulk: boolean;
  dkimPass: boolean;
} {
  let from = '';
  let subject = '';
  let isBulk = false;
  let dkimPass = false;

  for (const h of headers) {
    const name = h.name.toLowerCase();
    const val = h.value;

    if (name === 'from') from = val;
    else if (name === 'subject') subject = val;
    else if (name === 'list-unsubscribe') isBulk = true;
    else if (name === 'precedence' && /bulk|list|junk/i.test(val)) isBulk = true;
    else if (name === 'authentication-results') {
      if (/dkim=pass/i.test(val)) {
        dkimPass = true;
      }
    }
  }

  return { from, subject, isBulk, dkimPass };
}

/**
 * OAuth Helper: Generate PKCE code_verifier and code_challenge
 */
export async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = btoa(String.fromCharCode(...randomBytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return { codeVerifier, codeChallenge };
}

/**
 * OAuth Helper: Build Google OAuth consent URL
 */
export function buildConsentUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string
): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return url.toString();
}

/**
 * OAuth Helper: Exchange authorization code for refresh & access tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ refresh_token?: string; access_token: string; expires_in: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });

  const data = await res.json() as any;
  if (!res.ok || data.error) {
    throw new Error(`Token exchange failed: ${data.error_description || data.error || res.status}`);
  }

  return data;
}

/**
 * Refresh an access token using the encrypted refresh token
 */
export async function getValidAccessToken(
  db: D1Database,
  clientId: string,
  clientSecret: string,
  encryptionKey?: string
): Promise<string> {
  const authRow = await db
    .prepare('SELECT encrypted_refresh_token, status, is_active FROM gmail_auth WHERE id = ?')
    .bind('primary')
    .first<{ encrypted_refresh_token: string | null; status: string; is_active: number }>();

  if (!authRow || !authRow.encrypted_refresh_token || authRow.status !== 'connected' || authRow.is_active !== 1) {
    throw new Error('Gmail integration is not connected or active');
  }

  const refreshToken = await decryptToken(authRow.encrypted_refresh_token, encryptionKey);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json() as any;
  if (!res.ok || data.error) {
    if (data.error === 'invalid_grant') {
      // Rule 4.6 / E11: invalid_grant -> disable ingestion, one alert, no retry loop
      await db
        .prepare("UPDATE gmail_auth SET status = 'disabled_invalid_grant', is_active = 0, updated_at = ? WHERE id = 'primary'")
        .bind(new Date().toISOString())
        .run();
      throw new Error('invalid_grant: Gmail authorization revoked or expired. Ingestion disabled.');
    }
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  }

  return data.access_token;
}

/**
 * Revoke Gmail OAuth token and delete ciphertext (E10)
 */
export async function revokeGmailAccess(
  db: D1Database,
  encryptionKey?: string
): Promise<boolean> {
  const authRow = await db
    .prepare('SELECT encrypted_refresh_token FROM gmail_auth WHERE id = ?')
    .bind('primary')
    .first<{ encrypted_refresh_token: string | null }>();

  if (authRow?.encrypted_refresh_token) {
    try {
      const refreshToken = await decryptToken(authRow.encrypted_refresh_token, encryptionKey);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }).catch(() => null);
    } catch {
      // Continue to delete from DB even if remote revoke network fails
    }
  }

  await db
    .prepare("UPDATE gmail_auth SET status = 'revoked', encrypted_refresh_token = NULL, is_active = 0, updated_at = ? WHERE id = 'primary'")
    .bind(new Date().toISOString())
    .run();

  return true;
}

/**
 * Validate an extracted ISO date string (E12)
 * Returns { valid: boolean; ask_user?: boolean; reason?: string }
 */
export function validateProposalDate(dateIso: string, now: Date): { valid: boolean; ask_user?: boolean; reason?: string } {
  const target = new Date(dateIso);
  if (isNaN(target.getTime())) {
    return { valid: false, reason: 'Invalid date format' };
  }

  // Past date check (>10 minutes in the past)
  if (target.getTime() < now.getTime() - 10 * 60 * 1000) {
    return { valid: true, ask_user: true, reason: 'Date is in the past' };
  }

  // Over 1 year in the future
  const oneYearFromNow = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000);
  if (target.getTime() > oneYearFromNow.getTime()) {
    return { valid: true, ask_user: true, reason: 'Date is more than 1 year in the future' };
  }

  return { valid: true, ask_user: false };
}
