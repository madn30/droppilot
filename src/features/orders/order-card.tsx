import type { OrderStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OrderActions } from "@/features/orders/order-actions";
import type { OrderWithPipeline } from "@/features/orders/queries";

const PIPELINE: { status: OrderStatus; label: string }[] = [
  { status: "NEW", label: "Received" },
  { status: "ORDERED", label: "Ordered at supplier" },
  { status: "SHIPPED", label: "Shipped, tracking uploaded" },
  { status: "DELIVERED", label: "Delivered" },
];

const OFF_PIPELINE: Partial<Record<OrderStatus, string>> = {
  NEEDS_DECISION: "Needs your decision",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

function dollars(cents: number): string {
  return `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function formatDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function OrderCard({ order }: { order: OrderWithPipeline }) {
  const supplierOrder = order.supplierOrders[0];
  const reached = PIPELINE.findIndex((step) => step.status === order.status);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{order.marketplace === "EBAY" ? "eBay" : "Amazon"}</Badge>
          Order {order.externalId}
          {OFF_PIPELINE[order.status] && (
            <Badge variant={order.status === "CANCELLED" ? "secondary" : "destructive"}>{OFF_PIPELINE[order.status]}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {formatDateTime(order.orderedAt)} · {order.buyerName} · {dollars(order.totalCents)}
          {order.shipByDate && ` · ship by ${order.shipByDate.toISOString().slice(0, 10)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ul>
          {order.items.map((item) => (
            <li key={item.id}>
              {item.quantity} × {item.listing.title} ({item.listing.sku}) at {dollars(item.priceCents)}
            </li>
          ))}
        </ul>

        {reached >= 0 && (
          <ol className="flex flex-wrap gap-2">
            {PIPELINE.map((step, index) => (
              <li key={step.status}>
                <Badge variant={index <= reached ? "default" : "outline"}>{step.label}</Badge>
              </li>
            ))}
          </ol>
        )}

        {order.supplierOrders.map((parcel) => (
          <p key={parcel.id} className="text-muted-foreground">
            Supplier order {parcel.externalId ?? "not placed"} · cost {dollars(parcel.costCents)} + {dollars(parcel.shippingCents)}{" "}
            shipping · expected profit {dollars(parcel.expectedProfitCents)}
            {parcel.trackingNumber && ` · tracking ${parcel.carrier ?? ""} ${parcel.trackingNumber}`}
            {parcel.failureReason && ` · ${parcel.failureReason}`}
          </p>
        ))}

        {!supplierOrder && order.status === "ORDERED" && (
          <p className="text-muted-foreground">
            Fulfilled outside DropPilot. Upload the tracking number on the marketplace yourself.
          </p>
        )}

        {order.openAlerts.map((message) => (
          <p key={message} role="alert" className="whitespace-pre-line rounded-lg border border-destructive/40 p-3 text-destructive">
            {message}
          </p>
        ))}

        <OrderActions orderId={order.id} status={order.status} />
      </CardContent>
    </Card>
  );
}
