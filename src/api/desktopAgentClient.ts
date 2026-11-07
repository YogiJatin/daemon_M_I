/**
 * src/api/desktopAgentClient.ts - Browser Client for Desktop Outbox Mirror
 *
 * Enqueues Markdown notes to the Cloudflare D1 mirror_outbox via
 * POST /api/v1/desktop/export-obsidian. The local desktop agent (mirror_agent.ts)
 * polls these jobs via /api/v1/desktop/mirror-jobs and writes them atomically
 * to the Obsidian vault with path validation and conflict detection.
 *
 * Zero inbound listening ports on desktop.
 */

import { getSessionToken } from './client';

export interface AgentHealth {
  ok: boolean;
  vault: string;
  defaultFolder: string;
}

export interface ObsidianWriteRequest {
  vault?: string;
  folder?: string;
  filename: string;
  content: string;
  overwrite?: boolean;
}

export interface ObsidianWriteResult {
  success: boolean;
  path?: string;
  relativePath?: string;
  error?: string;
}

/**
 * Checks whether the desktop agent is paired and active by querying /api/v1/health.
 */
export async function checkAgentHealth(): Promise<AgentHealth | null> {
  try {
    const token = getSessionToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch('/api/v1/health', {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const agent = data?.data?.desktop_agent || data?.desktop_agent;
    if (agent && agent.paired) {
      return {
        ok: true,
        vault: "Knowledge/Mirror",
        defaultFolder: "Recipes",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Enqueues a note into mirror_outbox via the Cloudflare Worker outbox.
 */
export async function writeToObsidian(
  req: ObsidianWriteRequest
): Promise<ObsidianWriteResult> {
  try {
    const token = getSessionToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const targetFolder = req.folder || 'Recipes';
    const res = await fetch('/api/v1/desktop/export-obsidian', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        targetFolder,
        filename: req.filename,
        content: req.content,
        isUntrusted: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return {
        success: false,
        error: errData?.error?.message || `Outbox export failed (HTTP ${res.status})`,
      };
    }

    await res.json().catch(() => ({}));
    return {
      success: true,
      relativePath: `${targetFolder}/${req.filename}`,
      path: `Knowledge/Mirror/${targetFolder}/${req.filename}`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to enqueue note to desktop outbox: ${err.message}`,
    };
  }
}
