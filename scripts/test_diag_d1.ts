import * as crypto from 'crypto';
import { execSync } from 'child_process';

const DEPLOYED_URL = 'https://personal-ai-os.jatin-personal-ai.workers.dev';
const rawToken = 'f8_test_token_diag';
const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
const sessionId = 'diag_sess_1';

execSync(
  `npx wrangler d1 execute personal-ai-os-db --remote --command="INSERT OR REPLACE INTO auth_sessions (id, token_hash, owner_user_id, workspace_id, expires_at, created_at, last_seen_at) VALUES ('diag_sess_1', '${tokenHash}', '8364430714', 'default', datetime('now', '+1 day'), datetime('now'), datetime('now'));"`,
  { stdio: 'inherit' }
);

const ins = await fetch(DEPLOYED_URL + '/api/v1/internal/test/d1-query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + rawToken },
  body: JSON.stringify({
    sql: "INSERT INTO chat_messages (id, update_id, chat_id, message_id, role, text, status, attempts, created_at, updated_at) VALUES ('diag_row_1', 999988, '-10022330099', 999988, 'user', 'Stuck message', 'failed_final', 3, datetime('now'), datetime('now'));"
  })
});
console.log('Insert status:', ins.status, await ins.text());

const sel = await fetch(DEPLOYED_URL + '/api/v1/internal/test/d1-query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + rawToken },
  body: JSON.stringify({ sql: "SELECT status, attempts FROM chat_messages WHERE id = 'diag_row_1';" })
});
console.log('Select status:', sel.status, await sel.text());
