const { execSync } = require("child_process");

function run(sql) {
  try {
    const cmd = `npx wrangler d1 execute personal-ai-os-db --remote --json --command="${sql.replace(/"/g, '\\"')}"`;
    const out = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return JSON.parse(out);
  } catch (e) {
    return { error: e.message, stderr: e.stderr?.toString() };
  }
}

console.log("=== chat_messages grouped by status ===");
console.log(JSON.stringify(run("SELECT status, COUNT(*) as cnt FROM chat_messages GROUP BY status;"), null, 2));

console.log("\n=== chat_messages with attempts > 1 ===");
console.log(JSON.stringify(run("SELECT id, status, text, attempts, last_attempt_at FROM chat_messages WHERE attempts > 1 LIMIT 20;"), null, 2));

console.log("\n=== telegram_updates count per hour for the last 6h ===");
console.log(JSON.stringify(run("SELECT strftime('%Y-%m-%d %H:00', created_at) as hour, COUNT(*) as cnt FROM telegram_updates WHERE created_at >= datetime('now', '-6 hours') GROUP BY hour ORDER BY hour DESC;"), null, 2));

console.log("\n=== replies sent by the sweeper in the last 2h ===");
console.log(JSON.stringify(run("SELECT id, text, outcome, status, created_at FROM chat_messages WHERE (outcome LIKE '%sweep%' OR outcome LIKE '%offline%' OR text LIKE '%AI offline%') AND created_at >= datetime('now', '-2 hours') ORDER BY created_at DESC LIMIT 20;"), null, 2));
