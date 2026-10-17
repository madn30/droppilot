import { describe, expect, it } from "vitest";
import { TelegramNotifier } from "../alerts/notifiers";
import { TelegramApi, inlineKeyboard, parseTelegramWebhook } from "./api";
import { handleUpdate } from "./listener";

describe("parseTelegramWebhook", () => {
  it("reads the bot token and chat id from a sendMessage URL", () => {
    expect(parseTelegramWebhook("https://api.telegram.org/bot123:ABC-def/sendMessage?chat_id=8345")).toEqual({ token: "123:ABC-def", chatId: "8345" });
  });

  it("is null for anything else", () => {
    expect(parseTelegramWebhook("https://hooks.example.com/alerts")).toBeNull();
    expect(parseTelegramWebhook("https://api.telegram.org/bot123:ABC/sendMessage")).toBeNull();
    expect(parseTelegramWebhook("not a url")).toBeNull();
  });
});

describe("inlineKeyboard", () => {
  it("makes one button per action and drops commands Telegram cannot carry", () => {
    expect(inlineKeyboard([{ label: "Approve", command: "approve abc" }, { label: "Too long", command: "x".repeat(65) }])).toEqual({
      inline_keyboard: [[{ text: "Approve", callback_data: "approve abc" }]],
    });
    expect(inlineKeyboard([])).toBeUndefined();
  });
});

function recordingFetch(reply: unknown = { ok: true, result: [] }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(reply));
  };
  return { calls, fetchImpl };
}

describe("TelegramNotifier", () => {
  it("sends the alert with its actions as buttons", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await new TelegramNotifier("https://api.telegram.org/botT/sendMessage?chat_id=1", fetchImpl).send({
      severity: "INFO",
      title: "eBay listing awaiting your approval",
      message: "Lamp",
      actions: [{ label: "Approve and publish", command: "approve l1" }],
    });
    expect(calls[0].body).toEqual({
      text: "[DropPilot INFO] eBay listing awaiting your approval\nLamp",
      reply_markup: { inline_keyboard: [[{ text: "Approve and publish", callback_data: "approve l1" }]] },
    });
  });
});

describe("TelegramApi", () => {
  it("never puts the bot token in an error message", async () => {
    const api = new TelegramApi("SECRET-TOKEN", "1", async () => new Response("nope", { status: 401 }));
    await expect(api.sendMessage("hi")).rejects.toThrow("Telegram sendMessage returned HTTP 401");
    await expect(api.sendMessage("hi")).rejects.not.toThrow(/SECRET-TOKEN/);
  });
});

describe("handleUpdate", () => {
  function chat() {
    const sent: { text: string; actions?: unknown }[] = [];
    const answered: string[] = [];
    return {
      sent,
      answered,
      api: {
        chatId: "8345",
        sendMessage: async (text: string, actions?: unknown) => void sent.push({ text, actions }),
        answerCallback: async (id: string) => void answered.push(id),
      },
    };
  }
  const run = async (command: string) => ({ text: `ran ${command}` });

  it("runs a message or a button press from the admin's chat and answers", async () => {
    const { sent, answered, api } = chat();
    await handleUpdate({ update_id: 1, message: { chat: { id: 8345 }, text: "status" } }, api, run);
    await handleUpdate({ update_id: 2, callback_query: { id: "cb-1", data: "approve l1", message: { chat: { id: 8345 } } } }, api, run);
    expect(sent.map((message) => message.text)).toEqual(["ran status", "ran approve l1"]);
    expect(answered).toEqual(["cb-1"]);
  });

  it("ignores every other chat: the bot can be messaged by anyone", async () => {
    const { sent, api } = chat();
    const ran: string[] = [];
    await handleUpdate({ update_id: 1, message: { chat: { id: 999 }, text: "approve l1" } }, api, async (command) => {
      ran.push(command);
      return { text: "" };
    });
    expect(ran).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("tells the admin why a command failed", async () => {
    const { sent, api } = chat();
    await handleUpdate({ update_id: 1, message: { chat: { id: 8345 }, text: "approve l1" } }, api, async () => {
      throw new Error("eBay refused the listing");
    });
    expect(sent[0].text).toBe("Could not do that: eBay refused the listing");
  });
});
