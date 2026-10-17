import type { Listing } from "@prisma/client";
import { formatMoney, marketplaceName } from "../alerts/notices";
import { resolveAlerts } from "../alerts/service";
import { db } from "../db";
import type { ListingDeps } from "../listing/service";
import { publishListing, rejectListing } from "../listing/service";
import type { OrderDeps } from "../orders/deps";
import { PAYMENT_NEEDED_ALERT, markCancelled, markHandledManually, processOrder } from "../orders/fulfil";
import type { MessageAction } from "./api";

export interface CommandDeps {
  listing: () => Promise<ListingDeps>;
  orders: () => Promise<OrderDeps>;
}

export interface CommandReply {
  text: string;
  actions?: MessageAction[];
}

const HELP = [
  "DropPilot commands:",
  "status — what needs you",
  "drafts — listings awaiting approval",
  "approve <id> · reject <id> — a draft listing",
  "orders — orders that need a decision",
  "retry <id> — try the supplier order again",
  "fulfil <id> — order it even at a loss",
  "handled <id> — you fulfilled it yourself",
  "cancelled <id> — you cancelled it on the marketplace",
  "paid <id> — you paid the supplier for it",
  "alerts — open alerts",
  "Ids are shown in the lists; buttons under messages do the same.",
].join("\n");

const DRAFT = { in: ["DRAFT", "PENDING_APPROVAL"] as ("DRAFT" | "PENDING_APPROVAL")[] };
const NEEDS_DECISION = { in: ["NEEDS_DECISION", "FAILED"] as ("NEEDS_DECISION" | "FAILED")[] };

/** Draft listings as the admin approves them: one per marketplace listing, its options counted. */
async function draftListings(): Promise<{ lead: Listing; options: number; minCents: number; maxCents: number }[]> {
  const rows = await db.listing.findMany({ where: { status: DRAFT }, orderBy: [{ createdAt: "asc" }, { sku: "asc" }] });
  const groups = new Map<string, Listing[]>();
  for (const row of rows) {
    const key = row.groupKey ? `${row.marketplace}|${row.groupKey}` : row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => ({
    lead: group[0],
    options: group.length,
    minCents: Math.min(...group.map((row) => row.priceCents)),
    maxCents: Math.max(...group.map((row) => row.priceCents)),
  }));
}

function priceRange(minCents: number, maxCents: number): string {
  return minCents === maxCents ? formatMoney(minCents) : `${formatMoney(minCents)}–${formatMoney(maxCents)}`;
}

async function status(): Promise<CommandReply> {
  const [drafts, active, paused, orders, unpaid, alerts] = await Promise.all([
    draftListings(),
    db.listing.findMany({ where: { status: "ACTIVE", externalId: { not: null } }, distinct: ["marketplace", "externalId"], select: { id: true } }),
    db.listing.count({ where: { status: "PAUSED" } }),
    db.order.count({ where: { status: NEEDS_DECISION } }),
    db.alert.count({ where: { type: PAYMENT_NEEDED_ALERT, resolvedAt: null } }),
    db.alert.count({ where: { resolvedAt: null } }),
  ]);
  return {
    text: [
      `Drafts awaiting approval: ${drafts.length}`,
      `Live listings: ${active.length} · paused options: ${paused}`,
      `Orders needing a decision: ${orders}`,
      `Supplier orders to pay: ${unpaid}`,
      `Open alerts: ${alerts}`,
    ].join("\n"),
    actions: [
      ...(drafts.length > 0 ? [{ label: "Show drafts", command: "drafts" }] : []),
      ...(orders + unpaid > 0 ? [{ label: "Show orders", command: "orders" }] : []),
    ],
  };
}

async function drafts(): Promise<CommandReply> {
  const groups = await draftListings();
  if (groups.length === 0) return { text: "No drafts are waiting for approval." };
  return {
    text: groups
      .map(({ lead, options, minCents, maxCents }) =>
        [
          `${marketplaceName(lead.marketplace)}: ${lead.title}`,
          `${priceRange(minCents, maxCents)}${options > 1 ? ` · ${options} options` : ""}`,
          `approve ${lead.id}`,
          `reject ${lead.id}`,
        ].join("\n"),
      )
      .join("\n\n"),
    actions: groups.slice(0, 5).flatMap(({ lead }) => [
      { label: `Approve: ${lead.title.slice(0, 30)}`, command: `approve ${lead.id}` },
      { label: `Reject: ${lead.title.slice(0, 30)}`, command: `reject ${lead.id}` },
    ]),
  };
}

async function orders(): Promise<CommandReply> {
  const waiting = await db.order.findMany({ where: { status: NEEDS_DECISION }, orderBy: { orderedAt: "asc" }, take: 10 });
  const unpaid = await db.alert.findMany({ where: { type: PAYMENT_NEEDED_ALERT, resolvedAt: null, orderId: { not: null } }, orderBy: { createdAt: "asc" }, take: 10 });
  if (waiting.length + unpaid.length === 0) return { text: "No orders need you right now." };
  return {
    text: [
      ...waiting.map((order) =>
        [
          `${marketplaceName(order.marketplace)} order ${order.externalId} · ${formatMoney(order.totalCents)} · ${order.status.toLowerCase().replaceAll("_", " ")}`,
          `retry ${order.id}`,
          `fulfil ${order.id}`,
          `handled ${order.id}`,
          `cancelled ${order.id}`,
        ].join("\n"),
      ),
      ...unpaid.map((alert) => [alert.message.split("\n")[0], `paid ${alert.orderId}`].join("\n")),
    ].join("\n\n"),
  };
}

async function alerts(): Promise<CommandReply> {
  const open = await db.alert.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: "desc" }, take: 10 });
  if (open.length === 0) return { text: "No open alerts." };
  return { text: open.map((alert) => `[${alert.severity}] ${alert.message.split("\n")[0]}`).join("\n") };
}

async function decideOrder(decision: "retry" | "fulfil", orderId: string, deps: CommandDeps): Promise<CommandReply> {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) return { text: `No order with id ${orderId}. Send "orders" for the list.` };
  const result = await processOrder(orderId, await deps.orders(), { force: decision === "fulfil" });
  if (result.outcome === "ORDERED") {
    return { text: `Supplier order placed for ${marketplaceName(order.marketplace)} order ${order.externalId}: ${result.supplierOrderId}.` };
  }
  return { text: `Not placed (${result.outcome.toLowerCase().replaceAll("_", " ")}) for order ${order.externalId}. See the alert for the reason.` };
}

/**
 * Runs one command sent by the admin in the chat and returns what to answer.
 * Words are case-insensitive, a leading "/" is allowed, and "_" may stand for the space ("/approve_<id>").
 */
export async function runCommand(input: string, deps: CommandDeps): Promise<CommandReply> {
  const [word = "", id] = input.trim().replace(/^\//, "").replace(/_/, " ").split(/\s+/);
  switch (word.toLowerCase()) {
    case "start":
    case "help":
      return { text: HELP };
    case "status":
      return status();
    case "drafts":
      return drafts();
    case "orders":
      return orders();
    case "alerts":
      return alerts();
  }
  if (!["approve", "reject", "retry", "fulfil", "handled", "cancelled", "paid"].includes(word.toLowerCase())) {
    return { text: `I don't know "${word}". Send "help" for the commands.` };
  }
  if (!id) return { text: `"${word}" needs an id. Send "drafts" or "orders" to see them.` };

  switch (word.toLowerCase()) {
    case "approve": {
      const draft = await db.listing.findUnique({ where: { id } });
      if (!draft) return { text: `No listing with id ${id}. Send "drafts" for the list.` };
      const live = await publishListing(id, await deps.listing());
      return { text: `Published on ${marketplaceName(live.marketplace)}: ${live.title} (item ${live.externalId}).` };
    }
    case "reject": {
      const draft = await db.listing.findUnique({ where: { id } });
      if (!draft) return { text: `No listing with id ${id}. Send "drafts" for the list.` };
      await rejectListing(id);
      return { text: `Rejected: ${draft.title}. Nothing was published.` };
    }
    case "retry":
    case "fulfil":
      return decideOrder(word.toLowerCase() === "fulfil" ? "fulfil" : "retry", id, deps);
    case "handled":
    case "cancelled":
    case "paid": {
      const order = await db.order.findUnique({ where: { id } });
      if (!order) return { text: `No order with id ${id}. Send "orders" for the list.` };
      if (word.toLowerCase() === "handled") await markHandledManually(id);
      else if (word.toLowerCase() === "cancelled") await markCancelled(id);
      else await resolveAlerts({ type: PAYMENT_NEEDED_ALERT, orderId: id });
      const done = { handled: "marked as fulfilled by you", cancelled: "recorded as cancelled (nothing was cancelled on the marketplace)", paid: "payment noted; the reminder is closed" }[
        word.toLowerCase() as "handled" | "cancelled" | "paid"
      ];
      return { text: `Order ${order.externalId}: ${done}.` };
    }
  }
  return { text: HELP };
}
