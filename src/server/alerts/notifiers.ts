import nodemailer, { type Transporter } from "nodemailer";
import { getEnv } from "../env";
import { type MessageAction, inlineKeyboard } from "../telegram/api";

export interface AlertMessage {
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  message: string;
  /** What the admin can do about it straight from the chat; channels without buttons leave them out. */
  actions?: MessageAction[];
}

/** One way of reaching the admin outside the dashboard. */
export interface Notifier {
  readonly channel: string;
  send(alert: AlertMessage): Promise<void>;
}

function asText(alert: AlertMessage): string {
  return `[DropPilot ${alert.severity}] ${alert.title}\n${alert.message}`;
}

/** Posts {"text": …} to a webhook, e.g. a Telegram bot's sendMessage URL with the chat id in the query. */
export class TelegramNotifier implements Notifier {
  readonly channel = "telegram";

  constructor(
    private readonly webhookUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(alert: AlertMessage): Promise<void> {
    const response = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: asText(alert), reply_markup: inlineKeyboard(alert.actions ?? []) }),
    });
    if (!response.ok) throw new Error(`Telegram webhook returned HTTP ${response.status}`);
  }
}

export class EmailNotifier implements Notifier {
  readonly channel = "email";
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly to: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(alert: AlertMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.to,
      to: this.to,
      subject: `[DropPilot ${alert.severity}] ${alert.title}`,
      text: alert.message,
    });
  }
}

/** Records what would have been sent; used under MOCK_APIS and in tests. */
export class MockNotifier implements Notifier {
  readonly sent: AlertMessage[] = [];

  constructor(readonly channel: string) {}

  async send(alert: AlertMessage): Promise<void> {
    this.sent.push(alert);
  }
}

let mockNotifiers: Notifier[] | undefined;

/** The configured channels. A channel without its settings is simply absent; the dashboard always has the alert. */
export function getNotifiers(): Notifier[] {
  const env = getEnv();
  if (env.MOCK_APIS) {
    mockNotifiers ??= [new MockNotifier("email"), new MockNotifier("telegram")];
    return mockNotifiers;
  }
  const notifiers: Notifier[] = [];
  if (env.SMTP_URL && env.ALERT_EMAIL_TO) notifiers.push(new EmailNotifier(env.SMTP_URL, env.ALERT_EMAIL_TO));
  if (env.TELEGRAM_WEBHOOK_URL) notifiers.push(new TelegramNotifier(env.TELEGRAM_WEBHOOK_URL));
  return notifiers;
}
