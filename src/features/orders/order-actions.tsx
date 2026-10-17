"use client";

import type { OrderStatus } from "@prisma/client";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { type OrderActionState, decideOrderAction } from "./actions";

const INITIAL_STATE: OrderActionState = { error: null, done: null };

export function OrderActions({ orderId, status }: { orderId: string; status: OrderStatus }) {
  const [state, decide, pending] = useActionState(decideOrderAction, INITIAL_STATE);
  if (status !== "NEEDS_DECISION" && status !== "FAILED") return null;

  return (
    <div className="space-y-2">
      <form action={decide} className="flex flex-wrap gap-2">
        <input type="hidden" name="orderId" value={orderId} />
        {status === "NEEDS_DECISION" ? (
          <Button type="submit" name="decision" value="FULFIL_ANYWAY" size="sm" disabled={pending}>
            Fulfil anyway
          </Button>
        ) : (
          <Button type="submit" name="decision" value="RETRY" size="sm" disabled={pending}>
            Retry
          </Button>
        )}
        <Button type="submit" name="decision" value="HANDLED_ELSEWHERE" size="sm" variant="outline" disabled={pending}>
          I fulfilled it with another supplier
        </Button>
        <Button type="submit" name="decision" value="CANCELLED" size="sm" variant="outline" disabled={pending}>
          I cancelled it on the marketplace
        </Button>
      </form>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}
