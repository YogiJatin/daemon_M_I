/**
 * desktop-agent/obsidian-writer.ts — Local Obsidian Vault Write Server
 *
 * Listens on 127.0.0.1 ONLY (never 0.0.0.0).
 * The cloud backend never touches the filesystem.
 * Only this process writes files; it never exposes vault contents.
 *
 * Security model (layered):
 *   Layer 1 — 127.0.0.1 binding: unreachable from the network
 *   Layer 2 — Origin allowlist: only configured app origins are served
 *   Layer 3 — Per-request nonce: prevents cross-site requests from
 *              triggering writes even if layer 2 is somehow bypassed
 *   Layer 4 — Vault allowlist: only the configured vault path is writable
 *   Layer 5 — Path resolution check: resolveVaultPath confirms the final
 *              absolute path is inside the vault before any fs call
 *
 * Run:  npx tsx desktop-agent/obsidian-writer.ts
 * Or:   npm run agent   (once script is added to package.json)
 *
 * Endpoints:
 *   GET  /desktop/health           — liveness probe; no auth required
 *   GET  /desktop/nonce            — issue a single-use write nonce (origin-gated)
 *   POST /desktop/obsidian/write   — write note to vault (origin + nonce required)
 */

import http    from 'node:http';
import { promises as fs } from 'node:fs';
import path    from 'node:path';

import { config } from './obsidian-config.js';
import {
  sanitizeFilename,
  validateFolder,
  resolveVaultPath,
  injectOriginalTitle,
  issueNonce,
  consumeNonce,
} from './obsidian-utils.js';

// ─── CORS helpers ─────────────────────────────────────────────────────────────

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  return config.allowedOrigins.includes(origin);
}

function setCorsHeaders(res: http.ServerResponse, origin: string | undefined): void {
  if (origin && isOriginAllowed(origin)) {
    // Reflect the specific allowed origin (never "*")
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Nonce');
    res.setHeader('Vary', 'Origin');
  }
  // If origin is not allowed, no CORS headers are set.
  // The browser will block the response automatically.
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error('Request body too large (max 20 MB).'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

export const server = http.createServer(async (req, res) => {
  const rawUrl  = req.url ?? '/';
  const url     = new URL(rawUrl, `http://127.0.0.1:${config.port}`);
  const method  = req.method?.toUpperCase() ?? 'GET';
  const origin  = req.headers['origin'] as string | undefined;
  const ts      = new Date().toISOString();

  // ── CORS preflight ────────────────────────────────────────────────────────
  if (method === 'OPTIONS') {
    setCorsHeaders(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET /desktop/health ───────────────────────────────────────────────────
  // Liveness probe — no origin restriction, no nonce.
  if (method === 'GET' && url.pathname === '/desktop/health') {
    setCorsHeaders(res, origin);
    sendJson(res, 200, {
      ok:            true,
      vault:         config.obsidianVault,
      defaultFolder: config.defaultFolder,
    });
    console.log(`[${ts}] GET /desktop/health → 200`);
    return;
  }

  // ── GET /desktop/nonce ────────────────────────────────────────────────────
  // Issues a single-use 30-second write nonce.
  // Rejected if the request origin is not in the allowlist.
  if (method === 'GET' && url.pathname === '/desktop/nonce') {
    if (!isOriginAllowed(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden — origin not allowed');
      console.warn(`[${ts}] GET /desktop/nonce → 403 (origin: ${origin ?? 'none'})`);
      return;
    }
    setCorsHeaders(res, origin);
    const nonce = issueNonce();
    sendJson(res, 200, { nonce, ttlSeconds: 30 });
    console.log(`[${ts}] GET /desktop/nonce → issued (origin: ${origin})`);
    return;
  }

  // ── POST /desktop/obsidian/write ──────────────────────────────────────────
  if (method === 'POST' && url.pathname === '/desktop/obsidian/write') {
    const t0 = Date.now();

    // Layer 2: Origin
    if (!isOriginAllowed(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden — origin not allowed');
      console.warn(`[${ts}] POST /desktop/obsidian/write → 403 (origin: ${origin ?? 'none'})`);
      return;
    }
    setCorsHeaders(res, origin);

    // Layer 3: Nonce
    const nonce = req.headers['x-agent-nonce'] as string | undefined;
    if (!consumeNonce(nonce)) {
      sendJson(res, 401, {
        success: false,
        error:   'Invalid or expired nonce. Call GET /desktop/nonce first, then include the nonce in X-Agent-Nonce.',
      });
      console.warn(`[${ts}] POST /desktop/obsidian/write → 401 (bad nonce)`);
      return;
    }

    // Parse body
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: `Invalid JSON: ${err.message}` });
      return;
    }

    const { vault, folder, filename, content, overwrite: overwriteFlag } = body as {
      vault?:    string;
      folder?:   string;
      filename:  string;
      content:   string;
      overwrite?: boolean;
    };

    if (!filename || typeof filename !== 'string') {
      sendJson(res, 400, { success: false, error: '"filename" is required.' });
      return;
    }
    if (content === undefined || content === null || typeof content !== 'string') {
      sendJson(res, 400, { success: false, error: '"content" is required.' });
      return;
    }

    // Layer 4: Vault allowlist
    const requestedVault = (vault as string | undefined) ?? config.obsidianVault;
    if (path.resolve(requestedVault) !== path.resolve(config.obsidianVault)) {
      sendJson(res, 400, {
        success: false,
        error:   `Vault "${requestedVault}" is not the configured vault. Update settings.json to change the vault.`,
      });
      console.warn(`[${ts}] Vault mismatch attempted: "${requestedVault}"`);
      return;
    }

    // Sanitize filename
    const { safe: safeFilename, changed } = sanitizeFilename(filename);
    const originalTitle = changed ? filename.replace(/\.md$/i, '') : undefined;

    // Validate folder
    let safeFolder: string;
    try {
      safeFolder = validateFolder((folder as string | undefined) ?? config.defaultFolder);
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err.message });
      return;
    }

    // Layer 5: Resolve and confirm inside vault
    let destPath: string;
    try {
      destPath = resolveVaultPath(config.obsidianVault, safeFolder, safeFilename);
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err.message });
      return;
    }

    // Overwrite guard
    const shouldOverwrite = (overwriteFlag as boolean | undefined) ?? config.overwrite;
    try {
      await fs.access(destPath);
      if (!shouldOverwrite) {
        const rel = path.relative(config.obsidianVault, destPath);
        sendJson(res, 409, {
          success: false,
          error:   `File already exists: "${rel}". Pass "overwrite": true to replace it.`,
        });
        return;
      }
    } catch {
      // File does not exist — proceed
    }

    // Create directories and write
    try {
      await fs.mkdir(path.dirname(destPath), { recursive: true });

      // Inject original_title into YAML frontmatter if sanitization changed the filename
      const finalContent = originalTitle
        ? injectOriginalTitle(content, originalTitle)
        : content;

      await fs.writeFile(destPath, finalContent, 'utf8');
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: `Write failed: ${err.message}` });
      console.error(`[${ts}] Write error: ${err.message}`);
      return;
    }

    const elapsed     = Date.now() - t0;
    const relativePath = path.relative(config.obsidianVault, destPath);

    console.log(`[${ts}] ✓ Exported → ${relativePath}  (${elapsed}ms, origin: ${origin})`);
    sendJson(res, 200, { success: true, path: destPath, relativePath });
    return;
  }

  // 404 fallback
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

export function startServer(port: number = config.port): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n[Desktop Agent] STARTUP FAILURE — port ${port} already in use`);
        console.error('  Another instance may be running. Kill it or change "port" in settings.json.\n');
      } else {
        console.error(`[Desktop Agent] Server error: ${err.message}`);
      }
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      console.log('\nPersonal AI OS Desktop Agent — Obsidian Writer');
      console.log(`  Vault  : ${config.obsidianVault}`);
      console.log(`  Folder : ${config.defaultFolder}`);
      console.log(`  Listen : http://127.0.0.1:${port}  (127.0.0.1 only)`);
      console.log(`  Origins: ${config.allowedOrigins.join(', ')}`);
      console.log('\nReady. Waiting for export requests...\n');
      resolve(server);
    });
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// Auto-start when executed directly
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('obsidian-writer.ts') ||
  process.argv[1].endsWith('obsidian-writer.js')
);

if (isDirectRun) {
  startServer().catch(() => process.exit(1));
}
