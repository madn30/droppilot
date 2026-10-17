"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { type ListingActionState, approveListingAction, createListingAction, rejectListingAction } from "./actions";

const INITIAL_STATE: ListingActionState = { error: null, done: null };

function Outcome({ states }: { states: ListingActionState[] }) {
  const error = states.find((state) => state.error)?.error;
  const done = states.find((state) => state.done)?.done;
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  return done ? <p className="text-sm text-muted-foreground">{done}</p> : null;
}

export function DraftActions({ listingId }: { listingId: string }) {
  const [approveState, approve, approving] = useActionState(approveListingAction, INITIAL_STATE);
  const [rejectState, reject, rejecting] = useActionState(rejectListingAction, INITIAL_STATE);
  const busy = approving || rejecting;

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <form action={approve}>
          <input type="hidden" name="listingId" value={listingId} />
          <Button type="submit" size="sm" disabled={busy}>
            {approving ? "Publishing…" : "Approve and publish"}
          </Button>
        </form>
        <form action={reject}>
          <input type="hidden" name="listingId" value={listingId} />
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            Reject
          </Button>
        </form>
      </div>
      <Outcome states={[approveState, rejectState]} />
    </div>
  );
}

export function CreateListingButton({ variantId, marketplace }: { variantId: string; marketplace: "EBAY" | "AMAZON" }) {
  const [state, create, creating] = useActionState(createListingAction, INITIAL_STATE);
  return (
    <div className="space-y-1">
      <form action={create}>
        <input type="hidden" name="variantId" value={variantId} />
        <input type="hidden" name="marketplace" value={marketplace} />
        <Button type="submit" size="xs" variant="outline" disabled={creating}>
          {creating ? "Creating…" : `Create ${marketplace === "EBAY" ? "eBay" : "Amazon"} listing`}
        </Button>
      </form>
      <Outcome states={[state]} />
    </div>
  );
}
