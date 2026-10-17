"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { buildListingDeps } from "@/server/listing/deps";
import { createListing, publishListing, rejectListing } from "@/server/listing/service";
import { logger } from "@/server/logger";

export interface ListingActionState {
  error: string | null;
  done: string | null;
}

const idSchema = z.string().min(1);

/** Runs a listing action and turns a refusal (compliance rule, marketplace error) into a message for the page. */
async function run(done: string, action: () => Promise<unknown>): Promise<ListingActionState> {
  await requireAdmin();
  try {
    await action();
  } catch (error) {
    logger.warn({ err: error }, "listing action failed");
    return { error: error instanceof Error ? error.message : String(error), done: null };
  }
  revalidatePath("/products");
  return { error: null, done };
}

export async function approveListingAction(_previous: ListingActionState, formData: FormData): Promise<ListingActionState> {
  const listingId = idSchema.parse(formData.get("listingId"));
  return run("Published.", async () => publishListing(listingId, await buildListingDeps()));
}

export async function rejectListingAction(_previous: ListingActionState, formData: FormData): Promise<ListingActionState> {
  const listingId = idSchema.parse(formData.get("listingId"));
  return run("Rejected.", () => rejectListing(listingId));
}

export async function createListingAction(_previous: ListingActionState, formData: FormData): Promise<ListingActionState> {
  const variantId = idSchema.parse(formData.get("variantId"));
  const marketplace = z.enum(["EBAY", "AMAZON"]).parse(formData.get("marketplace"));
  return run("Listing created.", async () => createListing(variantId, marketplace, await buildListingDeps()));
}
