const { execSync } = require("child_process");
const out = execSync(`npx wrangler d1 execute personal-ai-os-db --remote --json --command="SELECT strftime('%Y-%m-%d %H:00', received_at) as hour, COUNT(*) as cnt FROM telegram_updates WHERE received_at >= datetime('now', '-6 hours') GROUP BY hour ORDER BY hour DESC;"`, { encoding: "utf8" });
console.log(out);
