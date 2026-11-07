const { execSync } = require("child_process");
const out = execSync(`npx wrangler d1 execute personal-ai-os-db --remote --json --command="PRAGMA table_info(chat_messages);"`, { encoding: "utf8" });
console.log(out);
