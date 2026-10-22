/**
 * src/api/desktopAgentClient.ts — Browser Client for the Local Desktop Agent
 *
 * Handles all communication with the Obsidian writer agent running at
 * http://127.0.0.1:27124. Never touches the cloud for filesystem writes.
 *
 * Security flow for writes:
 *   1. GET /desktop/nonce  → receive single-use token (30s TTL)
 *   2. POST /desktop/obsidian/write + X-Agent-Nonce header → write file
 *
 * The agent only accepts requests from origins listed in its settings.json.
 * Random sites cannot obtain a nonce because the /nonce endpoint also
 * enforces the origin allowlist.
 *
 * This module never reads vault contents back to the cloud.
 * D1 remains the source of truth.
 */

const AGENT_BASE   = 'http://127.0.0.1:27124';
const HEALTH_TIMEOUT_MS = 1_500;
const WRITE_TIMEOUT_MS  = 10_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentHealth {
  ok:            boolean;
  vault:         string;
  defaultFolder: string;
}

export interface ObsidianWriteRequest {
  /** Optional override; defaults to the agent's configured vault. */
  vault?:     string;
  /** Relative subfolder inside the vault. Created if missing. */
  folder?:    string;
  /** Markdown filename, e.g. "My Recipe.md". Sanitized server-side. */
  filename:   string;
  /** Full Markdown content, including YAML frontmatter. Not modified. */
  content:    string;
  /** Overwrite an existing file. Defaults to the agent's setting. */
  overwrite?: boolean;
}

export interface ObsidianWriteResult {
  success:       boolean;
  /** Absolute path of the written file on the local machine. */
  path?:         string;
  /** Path relative to the vault root, e.g. "Workflows/My Recipe.md". */
  relativePath?: string;
  /** Human-readable error when success === false. */
  error?:        string;
}

// ─── Health Check ─────────────────────────────────────────────────────────────

/**
 * Checks whether the desktop agent is reachable.
 * Returns null if the agent is not running or the request times out.
 * Use this before showing the "Export to Obsidian" button state.
 */
export async function checkAgentHealth(): Promise<AgentHealth | null> {
  try {
    const res = await fetch(`${AGENT_BASE}/desktop/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as AgentHealth;
  } catch {
    return null;
  }
}

// ─── Nonce Fetch ──────────────────────────────────────────────────────────────

async function fetchNonce(): Promise<string> {
  const res = await fetch(`${AGENT_BASE}/desktop/nonce`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (res.status === 403) {
    throw new Error('Desktop agent rejected this origin. Check allowedOrigins in desktop-agent/settings.json.');
  }
  if (!res.ok) {
    throw new Error(`Nonce request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { nonce: string };
  return data.nonce;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Writes a Markdown note to the local Obsidian vault via the desktop agent.
 *
 * Flow:
 *   GET /desktop/nonce         → single-use token
 *   POST /desktop/obsidian/write + X-Agent-Nonce → file written to vault
 *
 * Returns a structured result. Never throws — errors are returned in result.error.
 */
export async function writeToObsidian(
  req: ObsidianWriteRequest
): Promise<ObsidianWriteResult> {
  // Step 1: Acquire nonce
  let nonce: string;
  try {
    nonce = await fetchNonce();
  } catch (err: any) {
    return {
      success: false,
      error:   `Desktop agent unreachable or rejected: ${err.message}`,
    };
  }

  // Step 2: Write with nonce
  try {
    const res = await fetch(`${AGENT_BASE}/desktop/obsidian/write`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Agent-Nonce': nonce,
      },
      body:   JSON.stringify(req),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });

    const data = (await res.json()) as ObsidianWriteResult;
    return data;
  } catch (err: any) {
    return {
      success: false,
      error:   `Write request failed: ${err.message}`,
    };
  }
}
