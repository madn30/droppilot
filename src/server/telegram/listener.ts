import { logger } from "../logger";
import type { TelegramApi, TelegramUpdate } from "./api";
import type { CommandReply } from "./commands";

/**
 * Handles one message or button press. Only the admin's own chat is obeyed: the bot can be found
 * and messaged by anyone, and its commands publish listings and place orders.
 */
export async function handleUpdate(update: TelegramUpdate, api: Pick<TelegramApi, "chatId" | "sendMessage" | "answerCallback">, run: (command: string) => Promise<CommandReply>): Promise<void> {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  const command = update.message?.text ?? update.callback_query?.data;
  if (update.callback_query) await api.answerCallback(update.callback_query.id);
  if (chatId === undefined || !command) return;
  if (String(chatId) !== api.chatId) {
    logger.warn({ chatId }, "telegram message from another chat ignored");
    return;
  }

  let reply: CommandReply;
  try {
    reply = await run(command);
  } catch (error) {
    // The admin asked for something and must hear why it did not happen.
    logger.warn({ command: command.split(/\s+/)[0], err: error }, "telegram command failed");
    reply = { text: `Could not do that: ${error instanceof Error ? error.message : String(error)}` };
  }
  await api.sendMessage(reply.text, reply.actions);
}

const WAIT_SECONDS = 25;
const RETRY_DELAY_MS = 5000;

/**
 * Listens for the admin's messages until `stopped()` turns true. Telegram keeps undelivered updates,
 * so a restart continues where the last confirmed one ended.
 */
export async function listenForCommands(api: TelegramApi, run: (command: string) => Promise<CommandReply>, stopped: () => boolean): Promise<void> {
  let offset = 0;
  while (!stopped()) {
    let updates: TelegramUpdate[];
    try {
      updates = await api.getUpdates(offset, WAIT_SECONDS);
    } catch (error) {
      if (stopped()) return;
      logger.warn({ err: error }, "telegram polling failed; retrying");
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      continue;
    }
    for (const update of updates) {
      // Moving the offset first means a command that crashes is not run again on the next poll.
      offset = update.update_id + 1;
      try {
        await handleUpdate(update, api, run);
      } catch (error) {
        logger.error({ err: error }, "telegram update could not be answered");
      }
    }
  }
}
