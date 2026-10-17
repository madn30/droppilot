import { z } from "zod";

/** A button under a message; pressing it sends `command` back as if the admin had typed it. */
export interface MessageAction {
  label: string;
  command: string;
}

// Telegram refuses callback data over 64 bytes and messages over 4096 characters.
const MAX_CALLBACK_BYTES = 64;
const MAX_MESSAGE_CHARS = 4000;

const updateSchema = z.object({
  update_id: z.number(),
  message: z.object({ chat: z.object({ id: z.number() }), text: z.string().optional() }).optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      message: z.object({ chat: z.object({ id: z.number() }) }).optional(),
    })
    .optional(),
});
const updatesSchema = z.object({ ok: z.literal(true), result: z.array(updateSchema) });
export type TelegramUpdate = z.infer<typeof updateSchema>;

/**
 * The bot token and the admin's chat id, read from the sendMessage URL the alerts already use
 * (https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>). Null when the URL is another kind of webhook.
 */
export function parseTelegramWebhook(webhookUrl: string): { token: string; chatId: string } | null {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return null;
  }
  const match = /^\/bot([^/]+)\/sendMessage$/.exec(url.pathname);
  const chatId = url.searchParams.get("chat_id");
  if (url.host !== "api.telegram.org" || !match || !chatId) return null;
  return { token: match[1], chatId };
}

/** The inline keyboard for a message's actions, one button per row; actions Telegram could not carry are left out. */
export function inlineKeyboard(actions: MessageAction[]): { inline_keyboard: { text: string; callback_data: string }[][] } | undefined {
  const rows = actions
    .filter((action) => Buffer.byteLength(action.command) <= MAX_CALLBACK_BYTES)
    .map((action) => [{ text: action.label, callback_data: action.command }]);
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

/** The small part of the Telegram Bot API that DropPilot uses to talk with its admin. */
export class TelegramApi {
  constructor(
    private readonly token: string,
    readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The URL holds the token, so it never goes into an error message.
    if (!response.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}`);
    return response.json();
  }

  async sendMessage(text: string, actions: MessageAction[] = []): Promise<void> {
    await this.call("sendMessage", { chat_id: this.chatId, text: text.slice(0, MAX_MESSAGE_CHARS), reply_markup: inlineKeyboard(actions) }, 15_000);
  }

  /** Waits up to `waitSeconds` for new messages and button presses after `offset`. */
  async getUpdates(offset: number, waitSeconds: number): Promise<TelegramUpdate[]> {
    const body = { offset, timeout: waitSeconds, allowed_updates: ["message", "callback_query"] };
    return updatesSchema.parse(await this.call("getUpdates", body, (waitSeconds + 10) * 1000)).result;
  }

  /** Stops the "loading" state of a pressed button. */
  async answerCallback(callbackId: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId }, 15_000);
  }
}
