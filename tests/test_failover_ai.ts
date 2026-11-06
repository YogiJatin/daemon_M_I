import crypto from "node:crypto";

async function main() {
  const webhookSecret = "5d5eb296-6d63-455b-b9f2-fe9fbf49fa87";
  const updateId = Math.floor(Math.random() * 1000000) + 100000;

  console.log(`Sending /ai command via webhook with update_id ${updateId}...`);
  const res = await fetch("https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: 8364430714, is_bot: false, first_name: "Owner" },
        chat: { id: 8364430714, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: "/ai What should I focus on next?",
      },
    }),
  });

  console.log("Status:", res.status);
  const json = await res.json();
  console.log("Webhook Response:\n", JSON.stringify(json, null, 2));
}

main().catch(console.error);
