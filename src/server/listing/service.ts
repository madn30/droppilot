import type { Holiday, Listing, Marketplace, ProductVariant } from "@prisma/client";
import type { ListingCopyGenerator } from "../ai/types";
import { formatMoney, linkLines, listingDetails, marketplaceName, supplierLines } from "../alerts/notices";
import type { Notifier } from "../alerts/notifiers";
import { sendNotice } from "../alerts/service";
import {
  ComplianceError,
  assertBlindShippingForAmazon,
  assertDeliveryWithinPromise,
  assertDropshipSupplier,
  assertListingLimit,
  assertNoTrademarks,
  assertAllowedWarehouse,
  deliversWithinPromise,
  findTrademarks,
  shipsFromAllowedWarehouse,
} from "../compliance/guards";
import { db } from "../db";
import { newListingsPaused } from "../health/monitor";
import type { MarketplaceAdapter } from "../marketplaces/types";
import { productSpecsSchema } from "../matching/specs";
import { priceVariant } from "../repricer/run";
import { cutoffDate, occurrenceOnOrAfter } from "../seasonal/calendar";
import { MAX_TITLE_LENGTH, addHolidayKeyword, holidayTitleKeyword } from "../seasonal/titles";
import type { Settings } from "../settings/schema";
import { variationSet } from "./variations";

/** Units offered per listing; never more than the supplier has. */
export const MAX_LISTING_QUANTITY = 5;
const TREND_KEYWORDS = 3;

export interface ListingDeps {
  copyGenerator: ListingCopyGenerator;
  getMarketplace: (marketplace: Marketplace) => MarketplaceAdapter;
  /** Told when a draft is waiting for approval and when a listing goes live. */
  notifiers: Notifier[];
  settings: Settings;
  now?: () => Date;
}

const EMPTY_SPECS = { material: null, shape: null, sizeCm: null, color: null, personalization: null, giftBox: null, packQuantity: null };
// How many options a message spells out before summarising the rest.
const OPTIONS_IN_NOTICE = 12;

const DRAFT_STATUSES = ["DRAFT", "PENDING_APPROVAL"] as const;

/** One line per option for a message: "White $11.89 ×5, Black $11.89 ×5, … and 30 more". */
function optionLines(rows: { options: Record<string, string>; priceCents: number; quantity: number }[]): string[] {
  const names = Object.keys(rows[0]?.options ?? {});
  const shown = rows.slice(0, OPTIONS_IN_NOTICE).map((row) => `${names.map((name) => row.options[name]).join(" / ")} ${formatMoney(row.priceCents)} ×${row.quantity}`);
  const prices = rows.map((row) => row.priceCents);
  return [
    `${rows.length} options by ${names.join(" and ")}, ${formatMoney(Math.min(...prices))} to ${formatMoney(Math.max(...prices))}:`,
    `${shown.join(", ")}${rows.length > shown.length ? `, and ${rows.length - shown.length} more` : ""}`,
  ];
}

/** Listings live on the marketplaces; the options of one listing count once. */
async function countLiveListings(): Promise<number> {
  const live = await db.listing.findMany({
    where: { externalId: { not: null }, status: { in: ["ACTIVE", "PAUSED"] } },
    distinct: ["marketplace", "externalId"],
    select: { id: true },
  });
  return live.length;
}

/**
 * The other variants of the product that can be sold as options of the same listing as `variant`:
 * in stock, in an allowed warehouse, deliverable in time and not listed yet. Empty when the marketplace has no listings with
 * options or there is nothing to choose between; the variant is then listed on its own.
 */
async function findVariations(variant: ProductVariant, marketplace: Marketplace, deps: ListingDeps) {
  if (!deps.getMarketplace(marketplace).publishVariations) return [];
  const others = await db.productVariant.findMany({
    where: {
      productId: variant.productId,
      id: { not: variant.id },
      stock: { gt: 0 },
      listings: { none: { marketplace, status: { not: "ENDED" } } },
    },
    orderBy: { sku: "asc" },
  });
  return variationSet(
    variant,
    others.filter(
      (other) => shipsFromAllowedWarehouse(marketplace, other, deps.settings.listing) && deliversWithinPromise(marketplace, other, deps.settings.listing),
    ),
  );
}

/**
 * Creates the listing for a variant on a marketplace: generated title and
 * description, price from the repricer, and (for seasonal listings) the
 * holiday keyword and cut-off date. Where the marketplace supports it, the
 * product's other sellable variants join the same listing as options the
 * buyer picks (colour, size, …), each with its own price and stock.
 * With manual approve on, it waits as a draft for approval; otherwise it is
 * published straight away.
 * Returns the existing listing when the variant already has one there.
 */
export async function createListing(
  variantId: string,
  marketplace: Marketplace,
  deps: ListingDeps,
  options: { holiday?: Holiday } = {},
): Promise<Listing> {
  const now = deps.now?.() ?? new Date();
  const variant = await db.productVariant.findUniqueOrThrow({
    where: { id: variantId },
    include: { product: { include: { supplier: true, trendSnapshots: { orderBy: { capturedAt: "desc" }, take: 1 } } } },
  });
  const { product } = variant;

  const existing = await db.listing.findFirst({ where: { variantId, marketplace, status: { not: "ENDED" } } });
  if (existing) return existing;
  // A product already listed with options is listed: a variant is not added to that listing after the fact.
  const withOptions = await db.listing.findFirst({
    where: { marketplace, groupKey: { not: null }, status: { not: "ENDED" }, variant: { productId: variant.productId } },
    orderBy: { sku: "asc" },
  });
  if (withOptions) return withOptions;

  assertDropshipSupplier(product.supplier);
  assertBlindShippingForAmazon(marketplace, product.supplier);
  assertAllowedWarehouse(marketplace, variant, deps.settings.listing);
  assertDeliveryWithinPromise(marketplace, variant, deps.settings.listing);
  if (variant.stock <= 0) throw new Error(`Variant ${variant.sku} is out of stock at the supplier`);

  const variations = await findVariations(variant, marketplace, deps);
  const grouped = variations.length > 0;
  const specs = productSpecsSchema.safeParse(variant.specs).data ?? EMPTY_SPECS;

  const { holiday } = options;
  const maxTitleLength = MAX_TITLE_LENGTH[marketplace];
  // Google's "related rising queries" often wander off-topic; only those that share a word with the product are used.
  const titleWords = new Set(product.title.toLowerCase().split(/[^a-z]+/).filter((word) => word.length > 3));
  const trendQueries = ((product.trendSnapshots[0]?.relatedQueries ?? []) as string[]).filter((query) =>
    query.toLowerCase().split(/[^a-z]+/).some((word) => titleWords.has(word)),
  );
  // The holiday phrase comes first so it wins the limited title space; trademarked search terms are never passed on.
  const keywords = [...(holiday ? [holidayTitleKeyword(holiday)] : []), ...trendQueries.slice(0, TREND_KEYWORDS)].filter(
    (keyword) => findTrademarks(keyword).length === 0,
  );
  const copy = await deps.copyGenerator.generateListingCopy({
    marketplace,
    sourceTitle: product.title,
    sourceDescription: product.description,
    // A listing with options must not name one colour in its title.
    specs: grouped ? { ...specs, color: null } : specs,
    keywords,
    maxTitleLength,
  });
  const title = holiday ? addHolidayKeyword(copy.title, holiday, maxTitleLength) : copy.title;
  if (title.length > maxTitleLength) throw new Error(`Generated title is ${title.length} characters; ${marketplace} allows ${maxTitleLength}`);
  assertNoTrademarks({ title, description: copy.description });

  const holidayDate = holiday ? occurrenceOnOrAfter(holiday.dateRule, now) : null;
  // Product ids are short enough for eBay's 50-character group key.
  const groupKey = grouped ? `DP-${product.externalId}`.slice(0, 50) : null;
  const members = grouped ? variations : [{ variant, options: {} }];

  const rows: { listing: Listing; options: Record<string, string> }[] = [];
  for (const member of members) {
    const { decision, floorCents } = await priceVariant(member.variant, marketplace, deps.settings);
    const sku = `DP-${member.variant.sku}`;
    const data = {
      variantId: member.variant.id,
      groupKey,
      title,
      description: copy.description,
      priceCents: decision.priceCents,
      floorCents,
      quantity: Math.min(member.variant.stock, MAX_LISTING_QUANTITY),
      status: deps.settings.listing.manualApprove ? ("PENDING_APPROVAL" as const) : ("DRAFT" as const),
      pauseReason: null,
      externalId: null,
      holidayId: holiday?.id ?? null,
      cutoffDate: holidayDate ? cutoffDate(holidayDate, member.variant.processingDays, member.variant.deliveryDaysMax) : null,
    };
    // A SKU has one row per marketplace: an earlier listing that ended is brought back as a fresh draft, keeping its history.
    const listing = await db.listing.upsert({
      where: { marketplace_sku: { marketplace, sku } },
      create: { marketplace, sku, ...data },
      update: data,
    });
    rows.push({ listing, options: member.options });
  }
  const [{ listing }] = rows;
  if (!deps.settings.listing.manualApprove) return publishListing(listing.id, deps);
  await sendNotice(
    {
      title: `${marketplaceName(marketplace)} listing awaiting your approval`,
      message: [
        ...(grouped
          ? [
              title,
              ...optionLines(rows.map((row) => ({ options: row.options, priceCents: row.listing.priceCents, quantity: row.listing.quantity }))),
              ...supplierLines(variant, product),
              ...linkLines(listing, product),
            ]
          : listingDetails(listing, variant, product, deps.settings)),
        ...(holiday ? [`Holiday: ${holiday.name}`] : []),
        "Nothing is on the marketplace yet. Approve or reject it here or on the Listings page.",
      ].join("\n"),
      actions: [
        { label: "Approve and publish", command: `approve ${listing.id}` },
        { label: "Reject", command: `reject ${listing.id}` },
      ],
    },
    deps.notifiers,
  );
  return listing;
}

/**
 * Puts a draft live on its marketplace, after re-checking every compliance rule and the price.
 * A draft that is one option of a listing goes live together with the listing's other options.
 */
export async function publishListing(listingId: string, deps: ListingDeps): Promise<Listing> {
  const now = deps.now?.() ?? new Date();
  const listing = await db.listing.findUniqueOrThrow({
    where: { id: listingId },
    include: { variant: { include: { product: { include: { supplier: true, images: { orderBy: { position: "asc" } } } } } } },
  });
  if (listing.status !== "DRAFT" && listing.status !== "PENDING_APPROVAL") {
    throw new Error(`Listing ${listing.sku} is ${listing.status} and cannot be published`);
  }
  const { variant } = listing;
  const { product } = variant;

  assertDropshipSupplier(product.supplier);
  assertBlindShippingForAmazon(listing.marketplace, product.supplier);
  assertAllowedWarehouse(listing.marketplace, variant, deps.settings.listing);
  assertDeliveryWithinPromise(listing.marketplace, variant, deps.settings.listing);
  assertNoTrademarks(listing);
  const [liveListings, firstListed] = await Promise.all([
    countLiveListings(),
    db.listing.findFirst({ where: { externalId: { not: null } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  assertListingLimit(liveListings, deps.settings.listing, firstListed?.createdAt ?? null, now);
  if (await newListingsPaused(listing.marketplace)) {
    throw new ComplianceError("ACCOUNT_HEALTH", `New ${listing.marketplace} listings are paused: an account health metric is close to its limit`);
  }

  const specs = productSpecsSchema.safeParse(variant.specs).data;
  const itemSpecifics: Record<string, string> = {};
  if (specs?.material) itemSpecifics.Material = specs.material;
  if (specs?.shape) itemSpecifics.Shape = specs.shape;
  if (specs?.color) itemSpecifics.Color = specs.color;
  if (specs?.sizeCm) itemSpecifics.Length = `${specs.sizeCm} cm`;
  if (specs?.personalization !== null && specs?.personalization !== undefined) itemSpecifics.Personalized = specs.personalization ? "Yes" : "No";
  // Every photo the supplier has; products imported before those were kept fall back to the cached ones.
  const imageUrls = product.galleryUrls.length > 0 ? product.galleryUrls : product.images.map((image) => image.url);
  const pictures = { imageUrls, detailImageUrls: product.detailImageUrls };

  if (listing.groupKey) {
    const published = await publishOptions({ ...listing, groupKey: listing.groupKey }, itemSpecifics, pictures, deps, now);
    if (published) return published;
    // Only one option can be sold right now: it goes live below as an ordinary listing.
    listing.groupKey = null;
  }

  if (variant.stock <= 0) throw new Error(`Variant ${variant.sku} is out of stock at the supplier`);

  // Competitors and supplier cost may have moved while the draft waited for approval.
  const { decision, floorCents } = await priceVariant(variant, listing.marketplace, deps.settings);
  if (decision.pause) {
    throw new Error(`Listing ${listing.sku} cannot be published: the cheapest confirmed competitor is below our floor`);
  }

  // When the exact product is already in the marketplace's catalog, the listing joins it instead of duplicating it.
  const catalogMatch = await db.productMatch.findFirst({
    where: { variantId: variant.id, status: "CONFIRMED", competitorListing: { marketplace: listing.marketplace } },
    orderBy: { finalScore: "desc" },
    include: { competitorListing: true },
  });

  const quantity = Math.min(variant.stock, MAX_LISTING_QUANTITY);
  const { externalId } = await deps.getMarketplace(listing.marketplace).publishListing({
    sku: listing.sku,
    title: listing.title,
    description: listing.description,
    priceCents: decision.priceCents,
    quantity,
    ...pictures,
    itemSpecifics,
    // Realistic handling time: what the supplier actually needs before the parcel ships.
    handlingDays: variant.processingDays,
    deliveryDaysMax: variant.deliveryDaysMax,
    existingProductId: listing.marketplace === "AMAZON" ? catalogMatch?.competitorListing.externalId : undefined,
  });

  await db.priceHistory.create({
    data: { listingId: listing.id, priceCents: decision.priceCents, floorCents, costCents: variant.costCents, reason: "INITIAL", createdAt: now },
  });
  const live = await db.listing.update({
    where: { id: listing.id },
    data: { externalId, groupKey: null, status: "ACTIVE", pauseReason: null, priceCents: decision.priceCents, floorCents, quantity, lastRepricedAt: now },
  });
  await sendNotice(
    { title: `Listed on ${marketplaceName(live.marketplace)}`, message: listingDetails(live, variant, product, deps.settings).join("\n") },
    deps.notifiers,
  );
  return live;
}

type DraftOption = Listing & { groupKey: string; variant: ProductVariant & { product: { externalId: string; supplier: { code: string; name: string } } } };

/**
 * Publishes the draft together with the other draft options of its listing. Options that cannot be sold
 * right now (out of stock, wrong warehouse, too slow, below the floor) are dropped. Returns null, having dropped them,
 * when fewer than two remain: the caller then publishes the requested draft as an ordinary listing.
 */
async function publishOptions(
  requested: DraftOption,
  sharedSpecifics: Record<string, string>,
  pictures: { imageUrls: string[]; detailImageUrls: string[] },
  deps: ListingDeps,
  now: Date,
): Promise<Listing | null> {
  const adapter = deps.getMarketplace(requested.marketplace);
  const drafts = await db.listing.findMany({
    where: { marketplace: requested.marketplace, groupKey: requested.groupKey, status: { in: [...DRAFT_STATUSES] } },
    include: { variant: true },
    orderBy: { sku: "asc" },
  });

  const priced = [];
  for (const draft of drafts) {
    const sellable =
      draft.variant.stock > 0 &&
      shipsFromAllowedWarehouse(draft.marketplace, draft.variant, deps.settings.listing) &&
      deliversWithinPromise(draft.marketplace, draft.variant, deps.settings.listing);
    // Competitors and supplier cost may have moved while the draft waited for approval.
    const price = sellable ? await priceVariant(draft.variant, draft.marketplace, deps.settings) : null;
    if (!price || price.decision.pause) continue;
    priced.push({
      draft,
      attributes: draft.variant.attributes,
      priceCents: price.decision.priceCents,
      floorCents: price.floorCents,
      quantity: Math.min(draft.variant.stock, MAX_LISTING_QUANTITY),
    });
  }
  // The same rule as when the drafts were made: only what differs between the options still on offer is a choice.
  const ready = priced.length > 0 ? variationSet(priced[0], priced.slice(1)).map((entry) => ({ ...entry.variant, options: entry.options })) : [];
  const dropped = drafts.map((draft) => draft.id).filter((id) => !ready.some((option) => option.draft.id === id));

  const publishVariations = adapter.publishVariations?.bind(adapter);
  const single = ready.length < 2 || !publishVariations;
  // A dropped option is not offered; when the listing falls back to a single one, the requested draft stays.
  await db.listing.updateMany({
    where: { id: { in: single ? drafts.map((draft) => draft.id).filter((id) => id !== requested.id) : dropped } },
    data: { status: "ENDED" },
  });
  if (single) {
    await db.listing.update({ where: { id: requested.id }, data: { groupKey: null } });
    return null;
  }

  const optionNames = new Set(Object.keys(ready[0].options).map((name) => name.toLowerCase()));
  const { externalId } = await publishVariations({
    groupKey: requested.groupKey,
    title: requested.title,
    description: requested.description,
    ...pictures,
    // What the buyer chooses is not a fixed fact of the listing, and neither is one option's colour.
    itemSpecifics: Object.fromEntries(
      Object.entries(sharedSpecifics).filter(([name]) => name !== "Color" && !optionNames.has(name.toLowerCase())),
    ),
    // Realistic handling time: what the slowest option needs before the parcel ships.
    handlingDays: Math.max(...ready.map((option) => option.draft.variant.processingDays)),
    deliveryDaysMax: Math.max(...ready.map((option) => option.draft.variant.deliveryDaysMax)),
    variations: ready.map((option) => ({ sku: option.draft.sku, options: option.options, priceCents: option.priceCents, quantity: option.quantity })),
  });

  for (const option of ready) {
    await db.priceHistory.create({
      data: {
        listingId: option.draft.id,
        priceCents: option.priceCents,
        floorCents: option.floorCents,
        costCents: option.draft.variant.costCents,
        reason: "INITIAL",
        createdAt: now,
      },
    });
    await db.listing.update({
      where: { id: option.draft.id },
      data: {
        externalId,
        status: "ACTIVE",
        pauseReason: null,
        priceCents: option.priceCents,
        floorCents: option.floorCents,
        quantity: option.quantity,
        lastRepricedAt: now,
      },
    });
  }
  const live = await db.listing.findUniqueOrThrow({ where: { id: (ready.find((option) => option.draft.id === requested.id) ?? ready[0]).draft.id } });
  await sendNotice(
    {
      title: `Listed on ${marketplaceName(live.marketplace)} with ${ready.length} options`,
      message: [
        live.title,
        `${marketplaceName(live.marketplace)} item ${externalId}`,
        ...optionLines(ready),
        ...(dropped.length > 0 ? [`${dropped.length} option(s) left out: out of stock, too slow to deliver, or below the price floor.`] : []),
        ...supplierLines(requested.variant, requested.variant.product),
        ...linkLines(live, requested.variant.product),
      ].join("\n"),
    },
    deps.notifiers,
  );
  return live;
}

/** Discards a draft that was never published; for a listing with options, all its draft options. */
export async function rejectListing(listingId: string): Promise<void> {
  const listing = await db.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.status !== "DRAFT" && listing.status !== "PENDING_APPROVAL") {
    throw new Error(`Listing ${listing.sku} is ${listing.status}; only drafts can be rejected`);
  }
  await db.listing.updateMany({
    where: listing.groupKey
      ? { marketplace: listing.marketplace, groupKey: listing.groupKey, status: { in: [...DRAFT_STATUSES] } }
      : { id: listingId },
    data: { status: "ENDED" },
  });
}
