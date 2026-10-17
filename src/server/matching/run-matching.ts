import { readFile } from "node:fs/promises";
import path from "node:path";
import { type MatchStatus, Prisma } from "@prisma/client";
import type { EmbeddingsProvider, ImageRef, SpecExtractor, VisionVerdict, VisionVerifier } from "../ai/types";
import { db } from "../db";
import { cacheImage } from "../images/cache";
import type { ImageFetcher } from "../images/fetcher";
import { logger } from "../logger";
import type { CompetitorCandidate, MarketplaceAdapter } from "../marketplaces/types";
import type { Settings } from "../settings/schema";
import { findCandidates } from "./candidates";
import { decideMatch, visionCouldMatter } from "./final-score";
import { type ImageFingerprint, scoreImages } from "./image-score";
import { computePHash } from "./phash";
import { compareSpecs, optionMismatches } from "./spec-score";
import { type ProductSpecs, productSpecsSchema } from "./specs";

const MAX_IMAGES = 10;
const VISION_PAIRS = 4;

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

export interface MatchingDeps {
  marketplaces: MarketplaceAdapter[];
  specExtractor: SpecExtractor;
  visionVerifier: VisionVerifier;
  embeddings: EmbeddingsProvider;
  imageFetcher: ImageFetcher;
  imageCacheDir: string;
  settings: Settings["matching"];
}

export interface MatchingSummary {
  variantId: string;
  candidates: number;
  confirmed: number;
  review: number;
  rejected: number;
  isUnique: boolean;
}

/** An image that is cached on disk and fingerprinted, ready to compare. */
interface PreparedImage extends ImageFingerprint {
  url: string;
  localPath: string;
}

interface StoredImage {
  id: string;
  url: string;
  localPath: string | null;
  pHash: string | null;
  embedding: number[];
}

async function loadImage(image: { url: string; localPath: string }, cacheDir: string): Promise<ImageRef> {
  const bytes = await readFile(path.join(cacheDir, image.localPath));
  const contentType = CONTENT_TYPES[path.extname(image.localPath)] ?? "application/octet-stream";
  return { url: image.url, bytes, contentType };
}

/**
 * Makes sure every cached image has a pHash and an embedding, computing and
 * storing whichever is missing. Images without a local copy are left out.
 */
async function prepareImages(
  images: StoredImage[],
  deps: MatchingDeps,
  save: (id: string, fingerprint: ImageFingerprint) => Promise<void>,
): Promise<PreparedImage[]> {
  const cached = images.flatMap((image) => (image.localPath ? [{ ...image, localPath: image.localPath }] : []));
  const missing = cached.filter((image) => !image.pHash || image.embedding.length === 0);

  const fresh = new Map<string, ImageFingerprint>();
  if (missing.length > 0) {
    const files = await Promise.all(missing.map((image) => loadImage(image, deps.imageCacheDir)));
    const embeddings = await deps.embeddings.embedImages(files);
    for (const [index, image] of missing.entries()) {
      const fingerprint = { pHash: await computePHash(files[index].bytes), embedding: embeddings[index] };
      await save(image.id, fingerprint);
      fresh.set(image.id, fingerprint);
    }
  }

  return cached.flatMap((image) => {
    const fingerprint = fresh.get(image.id) ?? (image.pHash ? { pHash: image.pHash, embedding: image.embedding } : null);
    return fingerprint ? [{ url: image.url, localPath: image.localPath, ...fingerprint }] : [];
  });
}

/** Stores the listing and its images (cached locally), and extracts its specs when they are missing or stale. */
async function saveCandidate(candidate: CompetitorCandidate, deps: MatchingDeps) {
  const where = { marketplace_externalId: { marketplace: candidate.marketplace, externalId: candidate.externalId } };
  const existing = await db.competitorListing.findUnique({ where });

  const listingChanged =
    !existing || existing.title !== candidate.title || existing.description !== candidate.description;
  const parsedSpecs = listingChanged ? null : productSpecsSchema.safeParse(existing.extractedSpecs);
  const specs: ProductSpecs = parsedSpecs?.success
    ? parsedSpecs.data
    : await deps.specExtractor.extractSpecs({
        title: candidate.title,
        description: candidate.description,
        itemSpecifics: candidate.itemSpecifics,
      });

  const data = {
    title: candidate.title,
    description: candidate.description,
    url: candidate.url,
    priceCents: candidate.priceCents,
    shippingCents: candidate.shippingCents,
    currency: candidate.currency,
    deliveryDays: candidate.deliveryDays,
    sellerRating: candidate.sellerRating,
    soldCount: candidate.soldCount,
    itemSpecifics: candidate.itemSpecifics,
    extractedSpecs: specs,
    lastSeenAt: new Date(),
  };
  const listing = await db.competitorListing.upsert({
    where,
    create: { marketplace: candidate.marketplace, externalId: candidate.externalId, ...data },
    update: data,
    include: { images: true },
  });

  const urls = candidate.imageUrls.slice(0, MAX_IMAGES);
  const storedByPosition = new Map(listing.images.map((image) => [image.position, image]));
  const images: StoredImage[] = [];
  for (const [position, url] of urls.entries()) {
    const stored = storedByPosition.get(position);
    if (stored && stored.url === url && stored.localPath) {
      images.push(stored);
      continue;
    }
    let localPath: string | null = null;
    try {
      localPath = await cacheImage(url, deps.imageFetcher, deps.imageCacheDir);
    } catch (error) {
      // A dead image link costs this listing one comparison, not the whole run.
      logger.warn({ url, err: error }, "competitor image could not be cached");
    }
    // A new picture at this position invalidates the old fingerprints.
    const row = { url, localPath, pHash: null, embedding: [] };
    images.push(
      await db.competitorImage.upsert({
        where: { listingId_position: { listingId: listing.id, position } },
        create: { listingId: listing.id, position, ...row },
        update: row,
      }),
    );
  }
  await db.competitorImage.deleteMany({ where: { listingId: listing.id, position: { gte: urls.length } } });

  const prepared = await prepareImages(images, deps, async (id, fingerprint) => {
    await db.competitorImage.update({ where: { id }, data: fingerprint });
  });
  return { listingId: listing.id, specs, images: prepared };
}

/**
 * Finds competitor listings for one supplier variant and decides, for each,
 * whether it is the exact same product: image similarity, extracted specs with
 * hard rules, and a vision check where it can still change the outcome.
 * Decisions made by the user are never overwritten.
 */
export async function runMatchingForVariant(variantId: string, deps: MatchingDeps): Promise<MatchingSummary> {
  const variant = await db.productVariant.findUniqueOrThrow({
    where: { id: variantId },
    include: { product: { include: { images: { orderBy: { position: "asc" } } } } },
  });
  const { product } = variant;

  const supplierImages = await prepareImages(product.images, deps, async (id, fingerprint) => {
    await db.productImage.update({ where: { id }, data: fingerprint });
  });

  // The variant's own attributes (colour, size, with or without box) are what make it a separate market.
  const variantOptions = Object.fromEntries(
    Object.entries(variant.attributes as Prisma.JsonObject).map(([name, value]) => [name, String(value)]),
  );
  const storedSpecs = productSpecsSchema.safeParse(variant.specs);
  let supplierSpecs: ProductSpecs;
  if (storedSpecs.success) {
    supplierSpecs = storedSpecs.data;
  } else {
    supplierSpecs = await deps.specExtractor.extractSpecs({
      title: product.title,
      description: product.description,
      itemSpecifics: variantOptions,
    });
    await db.productVariant.update({ where: { id: variant.id }, data: { specs: supplierSpecs } });
  }

  const mainImage = supplierImages[0] ? (await loadImage(supplierImages[0], deps.imageCacheDir)).bytes : null;
  const candidates = await findCandidates({ title: product.title, mainImage }, deps.marketplaces);

  const counts: Record<MatchStatus, number> = { CONFIRMED: 0, REVIEW: 0, REJECTED: 0 };
  for (const candidate of candidates) {
    const competitor = await saveCandidate(candidate, deps);

    const images = scoreImages(supplierImages, competitor.images, deps.settings.imageMatchThreshold);
    const specComparison = compareSpecs(supplierSpecs, competitor.specs, deps.settings.sizeToleranceRate);
    const specs = {
      ...specComparison,
      // Only a variation states its own choice; a listing without variations may cover several colours at once.
      hardRuleFailures: [
        ...specComparison.hardRuleFailures,
        ...(candidate.isVariation ? optionMismatches(variantOptions, candidate.itemSpecifics) : []),
      ],
    };

    let vision: VisionVerdict | null = null;
    if (images.bestMatches.length > 0 && visionCouldMatter({ imageScore: images.imageScore, specs }, deps.settings)) {
      const pairs = await Promise.all(
        images.bestMatches.slice(0, VISION_PAIRS).map(async (match) => ({
          supplier: await loadImage(supplierImages[match.supplierIndex], deps.imageCacheDir),
          competitor: await loadImage(competitor.images[match.competitorIndex], deps.imageCacheDir),
        })),
      );
      vision = await deps.visionVerifier.verifySameProduct(pairs);
    }

    const decision = decideMatch({ imageScore: images.imageScore, matchedImageCount: images.matchedImageCount, specs, vision }, deps.settings);

    const where = { variantId_competitorListingId: { variantId: variant.id, competitorListingId: competitor.listingId } };
    const existing = await db.productMatch.findUnique({ where });
    const evidence = {
      imageScore: images.imageScore,
      matchedImageCount: images.matchedImageCount,
      specScore: specs.specScore,
      hardRuleFailures: specs.hardRuleFailures,
      visionVerdict: vision ? { ...vision } : Prisma.JsonNull,
      finalScore: decision.finalScore,
      lastEvaluatedAt: new Date(),
    };
    // The user's decision stands; only the evidence behind it is refreshed.
    const status = existing?.decidedBy === "USER" ? existing.status : decision.status;
    await db.productMatch.upsert({
      where,
      create: { variantId: variant.id, competitorListingId: competitor.listingId, ...evidence, status, decidedBy: "AUTO" },
      update: existing?.decidedBy === "USER" ? evidence : { ...evidence, status },
    });
    counts[status]++;
  }

  const isUnique = await refreshUniqueFlag(variant.id);
  return {
    variantId: variant.id,
    candidates: candidates.length,
    confirmed: counts.CONFIRMED,
    review: counts.REVIEW,
    rejected: counts.REJECTED,
    isUnique,
  };
}

/** A variant with no confirmed competitor is "unique" and is priced by margin target. */
export async function refreshUniqueFlag(variantId: string): Promise<boolean> {
  const confirmed = await db.productMatch.count({ where: { variantId, status: "CONFIRMED" } });
  const isUnique = confirmed === 0;
  await db.productVariant.update({ where: { id: variantId }, data: { isUnique } });
  return isUnique;
}
