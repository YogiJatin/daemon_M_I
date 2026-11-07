const crypto = require('crypto');
const { execSync } = require('child_process');

const rawToken = 'golden_audit_token_' + crypto.randomBytes(16).toString('hex');
const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
const sessionId = 'audit-sess-' + crypto.randomBytes(8).toString('hex');
const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const nowIso = new Date().toISOString();

console.log('Seeding session...');
execSync(
  `npx wrangler d1 execute personal-ai-os-db --remote --command="INSERT OR REPLACE INTO auth_sessions (id, token_hash, owner_user_id, workspace_id, expires_at, created_at, last_seen_at) VALUES ('${sessionId}', '${tokenHash}', '8364430714', 'default', '${expiresAt}', '${nowIso}', '${nowIso}');"`,
  { stdio: 'pipe' }
);

async function run() {
  console.log('Querying provider-audit endpoint...');
  const resp = await fetch('https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/internal/test/provider-audit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${rawToken}`
    }
  });
  console.log('Response status:', resp.status);
  const data = await resp.json();
  console.log(JSON.stringify(data, null, 2));
}
run();
