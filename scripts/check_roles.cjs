const { execSync } = require("child_process");
const out = execSync(`npx wrangler d1 execute personal-ai-os-db --remote --json --command="SELECT role, status, COUNT(*) as cnt FROM chat_messages GROUP BY role, status;"`, { encoding: "utf8" });
console.log(out);
