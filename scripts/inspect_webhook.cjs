const fs = require("fs");
const devVars = fs.readFileSync(".dev.vars", "utf8");
const match = devVars.match(/TELEGRAM_BOT_TOKEN="?([^"\r\n]+)"?/);
const token = match ? match[1].trim() : "";
fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
  .then(r => r.json())
  .then(d => console.log(JSON.stringify(d, null, 2)))
  .catch(e => console.error(e));
