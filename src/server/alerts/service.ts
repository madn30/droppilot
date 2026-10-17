import type { Alert, AlertSeverity, Prisma } from "@prisma/client";
import { db } from "../db";
import { logger } from "../logger";
import type { MessageAction } from "../telegram/api";
import type { AlertMessage, Notifier } from "./notifiers";

/**
 * Sends news that needs no action (a sale, a new listing) by email and Telegram. Nothing is stored:
 * the dashboard already shows it. A failed channel is logged and does not stop the caller.
 */
export async function sendNotice(notice: Omit<AlertMessage, "severity">, notifiers: Notifier[]): Promise<void> {
  for (const notifier of notifiers) {
    try {
      await notifier.send({ severity: "INFO", ...notice });
    } catch (error) {
      logger.error({ channel: notifier.channel, title: notice.title, err: error }, "notification failed");
    }
  }
}

export interface AlertInput {
  severity: AlertSeverity;
  /** e.g. "order.price_jump", "health.EBAY.defectRate". */
  type: string;
  title: string;
  message: string;
  orderId?: string;
  context?: Prisma.InputJsonValue;
  /** Buttons for the chat channels; not stored. */
  actions?: MessageAction[];
}

/**
 * Records an alert for the dashboard and sends it by email and Telegram.
 * An open alert of the same type for the same order is not raised twice.
 */
export async function raiseAlert(input: AlertInput, notifiers: Notifier[]): Promise<Alert> {
  const existing = await db.alert.findFirst({
    where: { type: input.type, orderId: input.orderId ?? null, resolvedAt: null },
  });
  if (existing) return existing;

  const alert = await db.alert.create({
    data: {
      severity: input.severity,
      type: input.type,
      message: `${input.title}\n${input.message}`,
      orderId: input.orderId,
      context: input.context,
    },
  });
  for (const notifier of notifiers) {
    try {
      await notifier.send({ severity: input.severity, title: input.title, message: input.message, actions: input.actions });
    } catch (error) {
      // The alert is already on the dashboard; one unreachable channel must not hide it or stop the others.
      logger.error({ channel: notifier.channel, alertId: alert.id, err: error }, "alert notification failed");
    }
  }
  return alert;
}

export async function resolveAlert(alertId: string, now: Date = new Date()): Promise<void> {
  await db.alert.update({ where: { id: alertId }, data: { resolvedAt: now } });
}

/** Closes open alerts of a type (optionally for one order) once their cause is gone. */
export async function resolveAlerts(where: { type: string; orderId?: string }, now: Date = new Date()): Promise<void> {
  await db.alert.updateMany({ where: { ...where, resolvedAt: null }, data: { resolvedAt: now } });
}
