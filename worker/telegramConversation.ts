/**
 * worker/telegramConversation.ts — Telegram Conversation & Plain-Text Ingress Handler
 *
 * Captures plain-text messages verbatim into tasks without date inference (AGENTS.md Rule 1 & 11).
 * Extracted from commands.ts as part of Block 0 hygiene.
 */

import { CommandContext, CommandResult, persistTask } from "./commands";
import { ParsedDeadline } from "./dateParser";

/**
 * Plain-text (non-command) messages become tasks verbatim — no date inference (BLOCK_1.md)
 */
export async function handlePlainText(text: string, context: CommandContext): Promise<CommandResult> {
  const title = text.trim();
  if (!title) {
    return { command: "plain_text", args: text, success: false, response: "Empty message ignored." };
  }

  const deadline: ParsedDeadline = { kind: "none", localDate: null, localTime: null, utcInstant: null };
  const now = context.now || new Date();

  const taskId = await persistTask({ title, deadline, rawExcerpt: title, context, now });

  return {
    command: "plain_text",
    args: text,
    success: true,
    taskId,
    deadline,
    response: `Task captured: "${title}"`,
  };
}
