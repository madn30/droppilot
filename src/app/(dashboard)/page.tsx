import type { Marketplace } from "@prisma/client";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveAlertAction } from "@/features/alerts/actions";
import { requireAdmin } from "@/server/auth/session";
import { db } from "@/server/db";
import { getSettings } from "@/server/settings/service";

export const dynamic = "force-dynamic";

const PERIOD_DAYS = 30;
const MARKETPLACES: { marketplace: Marketplace; label: string }[] = [
  { marketplace: "EBAY", label: "eBay" },
  { marketplace: "AMAZON", label: "Amazon" },
];

function dollars(cents: number): string {
  return `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function percent(rate: number | null): string {
  return rate === null ? "not reported" : `${(rate * 100).toFixed(2)}%`;
}

export default async function OverviewPage() {
  await requireAdmin();
  const since = new Date(Date.now() - PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const [settings, revenue, profit, orders, activeListings, products, matchesToReview, draftsToApprove, alerts, lastHeartbeat, health] =
    await Promise.all([
      getSettings(),
      db.order.aggregate({ where: { orderedAt: { gte: since }, status: { not: "CANCELLED" } }, _sum: { totalCents: true } }),
      db.supplierOrder.aggregate({
        where: { createdAt: { gte: since }, status: { in: ["PLACED", "SHIPPED", "DELIVERED"] } },
        _sum: { expectedProfitCents: true },
      }),
      db.order.count({ where: { orderedAt: { gte: since } } }),
      db.listing.count({ where: { status: "ACTIVE" } }),
      db.product.count(),
      db.productMatch.count({ where: { status: "REVIEW" } }),
      db.listing.count({ where: { status: "PENDING_APPROVAL" } }),
      db.alert.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: "desc" }, take: 20 }),
      db.jobLog.findFirst({ where: { jobName: "heartbeat", status: "SUCCEEDED" }, orderBy: { startedAt: "desc" } }),
      Promise.all(
        MARKETPLACES.map(async ({ marketplace, label }) => ({
          label,
          latest: await db.accountHealth.findFirst({ where: { marketplace }, orderBy: { capturedAt: "desc" } }),
        })),
      ),
    ]);

  const stats = [
    { label: `Revenue, ${PERIOD_DAYS} days`, value: dollars(revenue._sum.totalCents ?? 0) },
    { label: `Expected profit, ${PERIOD_DAYS} days`, value: dollars(profit._sum.expectedProfitCents ?? 0) },
    { label: `Orders, ${PERIOD_DAYS} days`, value: String(orders) },
    { label: "Active listings", value: `${activeListings} / ${settings.listing.maxActiveListings}` },
    { label: "Products", value: String(products) },
  ];
  const todo = [
    { href: "/products", label: "Listings awaiting approval", count: draftsToApprove },
    { href: "/products", label: "Matches to review", count: matchesToReview },
  ].filter((item) => item.count > 0);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Overview</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader>
              <CardDescription>{stat.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{stat.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Alerts</CardTitle>
          <CardDescription>
            Problems that need you. They are also sent by email and Telegram when those are configured.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {todo.map((item) => (
            <p key={item.href}>
              <Link href={item.href} className="underline underline-offset-4">
                {item.count} {item.label.toLowerCase()}
              </Link>
            </p>
          ))}
          {alerts.length === 0 ? (
            <p className="text-muted-foreground">No open alerts.</p>
          ) : (
            alerts.map((alert) => (
              <div key={alert.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <Badge variant={alert.severity === "CRITICAL" ? "destructive" : "secondary"}>{alert.severity.toLowerCase()}</Badge>
                  <p className="whitespace-pre-line">{alert.message}</p>
                  {alert.orderId && (
                    <Link href="/products" className="underline underline-offset-4">
                      Go to orders
                    </Link>
                  )}
                </div>
                <form action={resolveAlertAction}>
                  <input type="hidden" name="alertId" value={alert.id} />
                  <Button type="submit" size="sm" variant="outline">
                    Mark resolved
                  </Button>
                </form>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {health.map(({ label, latest }) => (
          <Card key={label}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {label} account health
                {latest?.newListingsPaused && <Badge variant="destructive">New listings paused</Badge>}
              </CardTitle>
              <CardDescription>
                {latest ? `Checked ${latest.capturedAt.toISOString().slice(0, 10)}. Checked daily.` : "Not checked yet. Checked daily by the worker."}
              </CardDescription>
            </CardHeader>
            {latest && (
              <CardContent className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm tabular-nums">
                <span>Defect rate</span>
                <span>{percent(latest.defectRate)}</span>
                <span>Late shipment rate</span>
                <span>{percent(latest.lateShipmentRate)}</span>
                <span>Cancellation rate</span>
                <span>{percent(latest.cancellationRate)}</span>
                <span>Valid tracking rate</span>
                <span>{percent(latest.validTrackingRate)}</span>
                <span>Return rate</span>
                <span>{percent(latest.returnRate)}</span>
              </CardContent>
            )}
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Background worker</CardTitle>
          <CardDescription>The worker runs as its own process and reports a heartbeat every hour.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3 text-sm">
          {lastHeartbeat ? (
            <>
              <Badge variant="secondary">Seen</Badge>
              <span>Last heartbeat {lastHeartbeat.startedAt.toISOString().replace("T", " ").slice(0, 16)} UTC</span>
            </>
          ) : (
            <>
              <Badge variant="destructive">Not seen</Badge>
              <span>
                No heartbeat yet. Start it with <code>npm run worker</code>.
              </span>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
