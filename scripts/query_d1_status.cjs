const secret = "5d5eb296-6d63-455b-b9f2-fe9fbf49fa87";
const url = "https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/internal/test/d1-query";

async function query(sql, binds = []) {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret
    },
    body: JSON.stringify({ sql, binds })
  });
  const data = await resp.json();
  return data;
}

async function main() {
  console.log("=== chat_messages grouped by status ===");
  console.log(await query("SELECT status, COUNT(*) as cnt FROM chat_messages GROUP BY status;"));

  console.log("\n=== chat_messages with attempts > 1 ===");
  try {
    console.log(await query("SELECT id, status, text, attempts, last_attempt_at FROM chat_messages WHERE attempts > 1 LIMIT 20;"));
  } catch (e) {
    console.log("attempts column error:", e.message);
  }

  console.log("\n=== telegram_updates count per hour for the last 6h ===");
  try {
    console.log(await query("SELECT strftime('%Y-%m-%d %H:00', created_at) as hour, COUNT(*) as cnt FROM telegram_updates WHERE created_at >= datetime('now', '-6 hours') GROUP BY hour ORDER BY hour DESC;"));
  } catch (e) {
    console.log("telegram_updates error:", e.message);
  }

  console.log("\n=== replies sent by the sweeper in the last 2h ===");
  try {
    console.log(await query("SELECT id, text, outcome, status, created_at FROM chat_messages WHERE (outcome LIKE '%sweep%' OR outcome LIKE '%offline%' OR text LIKE '%AI offline%') AND created_at >= datetime('now', '-2 hours') ORDER BY created_at DESC LIMIT 20;"));
  } catch (e) {
    console.log("sweeper query error:", e.message);
  }
}

main().catch(console.error);
