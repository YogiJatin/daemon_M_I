/**
 * desktop-agent/obsidian-config.ts — Typed Config Loader
 *
 * Loads desktop-agent/settings.json and validates the vault path on startup.
 * Fails fast with a clear, actionable message if:
 *   - settings.json does not exist
 *   - obsidianVault is missing or empty
 *   - the vault directory does not exist on disk
 *   - the vault directory is not writable
 *
 * Production origins are included in the default allowedOrigins list.
 * Override them in settings.json to match your deployment.
 */

import { readFileSync, accessSync, constants } from 'node:fs';
import { resolve }                             from 'node:path';
import { fileURLToPath }                       from 'node:url';

export interface AgentConfig {
  /** Absolute path to the Obsidian vault root. Must exist and be writable. */
  obsidianVault: string;
  /** Default relative subfolder for exports (created if missing). */
  defaultFolder: string;
  /** Whether to overwrite existing files by default. */
  overwrite: boolean;
  /** Local HTTP port. Default: 27124. */
  port: number;
  /**
   * Origins permitted to request nonces and write notes.
   * Only exact string matches are accepted — no wildcards.
   * This is the primary CSRF/origin defence for the local writer.
   */
  allowedOrigins: string[];
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export function loadConfig(settingsPath?: string): AgentConfig {
  const filePath = settingsPath ?? resolve(__dirname, 'settings.json');

  // ── 1. Read file ─────────────────────────────────────────────────────────
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      console.error('\n[Desktop Agent] STARTUP FAILURE — settings.json not found');
      console.error(`  Expected: ${filePath}`);
      console.error('  Fix: copy desktop-agent/settings.example.json to desktop-agent/settings.json');
      console.error('       then set obsidianVault to the absolute path of your Obsidian vault.\n');
    } else {
      console.error('\n[Desktop Agent] STARTUP FAILURE — cannot parse settings.json');
      console.error(`  ${err.message}\n`);
    }
    process.exit(1);
  }

  // ── 2. Validate vault path ────────────────────────────────────────────────
  const rawVault = raw['obsidianVault'];
  if (!rawVault || typeof rawVault !== 'string' || !rawVault.trim()) {
    console.error('\n[Desktop Agent] STARTUP FAILURE — obsidianVault is missing or empty');
    console.error(`  File: ${filePath}`);
    console.error('  Fix: set "obsidianVault" to the absolute path of your Obsidian vault, e.g.');
    console.error('       "obsidianVault": "D:\\\\daemon\'s brain"\n');
    process.exit(1);
  }

  const vaultPath = rawVault.trim();

  // ── 3. Check vault exists ─────────────────────────────────────────────────
  try {
    accessSync(vaultPath, constants.F_OK);
  } catch {
    console.error('\n[Desktop Agent] STARTUP FAILURE — vault directory does not exist');
    console.error(`  Vault: ${vaultPath}`);
    console.error('  Fix: create the directory in Explorer, or update obsidianVault in settings.json.\n');
    process.exit(1);
  }

  // ── 4. Check vault is writable ────────────────────────────────────────────
  try {
    accessSync(vaultPath, constants.W_OK);
  } catch {
    console.error('\n[Desktop Agent] STARTUP FAILURE — vault directory is not writable');
    console.error(`  Vault: ${vaultPath}`);
    console.error('  Fix: check folder permissions (right-click → Properties → Security).\n');
    process.exit(1);
  }

  const DEFAULT_ORIGINS = [
    'http://localhost:5173',       // Vite dev server
    'http://localhost:8787',       // Wrangler local dev
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8787',
    'https://personal-ai-os.jatin-personal-ai.workers.dev', // production PWA
  ];

  return {
    obsidianVault:  vaultPath,
    defaultFolder:  (raw['defaultFolder']  as string)   ?? 'Workflows',
    overwrite:      (raw['overwrite']      as boolean)  ?? false,
    port:           (raw['port']           as number)   ?? 27124,
    allowedOrigins: (raw['allowedOrigins'] as string[]) ?? DEFAULT_ORIGINS,
  };
}

// Singleton used by the server — tests may call loadConfig() with a custom path.
export const config: AgentConfig = loadConfig();
