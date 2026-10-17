import { describe, expect, it } from "vitest";
import { MockImageFetcher } from "../images/mock-image-fetcher";
import { mockImageUrl } from "../mocks/fixtures/necklace";
import { defaultSettings } from "../settings/schema";
import { decideMatch, visionCouldMatter } from "./final-score";
import { type ImageFingerprint, pairSimilarity, scoreImages } from "./image-score";
import { computePHash, pHashSimilarity } from "./phash";
import { compareSpecs, optionMismatches } from "./spec-score";
import type { ProductSpecs } from "./specs";

const settings = defaultSettings({ MIN_PROFIT: 300, MAX_ACCEPTABLE_LOSS: 100, DEMAND_THRESHOLD: 60 }).matching;

const supplierSpecs: ProductSpecs = {
  material: "copper",
  shape: "heart",
  sizeCm: 45,
  color: "rose gold",
  personalization: true,
  giftBox: false,
  packQuantity: 1,
};

describe("pHash", () => {
  const fetcher = new MockImageFetcher();
  const hashOf = async (content: string) => computePHash((await fetcher.fetch(mockImageUrl("x", 1, content))).bytes);

  it("is stable, 16 hex characters, and identical for the same picture", async () => {
    const first = await hashOf("necklace-1");
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashOf("necklace-1")).toBe(first);
  });

  it("survives resizing and recompression", async () => {
    const sharp = (await import("sharp")).default;
    const original = (await fetcher.fetch(mockImageUrl("x", 1, "necklace-1"))).bytes;
    const resized = await sharp(original).resize(200, 200).jpeg({ quality: 70 }).toBuffer();
    expect(pHashSimilarity(await computePHash(original), await computePHash(resized))).toBeGreaterThanOrEqual(0.9);
  });

  it("separates different pictures", async () => {
    const base = await hashOf("necklace-1");
    for (const other of ["necklace-2", "round-1", "silver-heart-1", "gift-box-1"]) {
      expect(pHashSimilarity(base, await hashOf(other))).toBeLessThan(0.85);
    }
  });

  it("measures similarity as the share of equal bits", () => {
    expect(pHashSimilarity("ffffffffffffffff", "ffffffffffffffff")).toBe(1);
    expect(pHashSimilarity("ffffffffffffffff", "0000000000000000")).toBe(0);
    expect(pHashSimilarity("ffffffffffffffff", "fffffffffffffff0")).toBe(1 - 4 / 64);
    expect(() => pHashSimilarity("abc", "abc")).toThrow();
  });
});

describe("scoreImages", () => {
  // Hashes differing in 32 of 64 bits are unrelated; embeddings then decide.
  const print = (pHash: string, embedding: number[]): ImageFingerprint => ({ pHash, embedding });
  const a = print("ffffffff00000000", [1, 0, 0]);
  const b = print("0000ffff0000ffff", [0, 1, 0]);
  const c = print("00ff00ff00ff00ff", [0, 0, 1]);

  it("trusts a near-duplicate hash without looking at embeddings", () => {
    expect(pairSimilarity(a, print("ffffffff00000001", [0, 1, 0]))).toBeCloseTo(1 - 1 / 64);
  });

  it("falls back to embedding similarity for different files", () => {
    expect(pairSimilarity(a, print("0000ffff0000ffff", [0.9, Math.sqrt(1 - 0.81), 0]))).toBeCloseTo(0.9);
    expect(pairSimilarity(a, b)).toBe(0);
  });

  it("scores the share of supplier images with a strong match", () => {
    const result = scoreImages([a, b, c], [print("0f0f0f0f0f0f0f0f", [0, 0.1, 0.99]), a], 0.85);
    expect(result.matchedImageCount).toBe(2);
    expect(result.imageScore).toBeCloseTo(2 / 3);
    expect(result.bestMatches[0]).toMatchObject({ supplierIndex: 0, competitorIndex: 1, similarity: 1 });
    expect(result.bestMatches.map((match) => match.supplierIndex)).toEqual([0, 2, 1]);
  });

  it("requires similarity strictly above the threshold", () => {
    const borderline = print("0f0f0f0f0f0f0f0f", [0.85, Math.sqrt(1 - 0.85 ** 2), 0]);
    expect(scoreImages([a], [borderline], 0.85).matchedImageCount).toBe(0);
  });

  it("scores 0 when either side has no images", () => {
    expect(scoreImages([], [a], 0.85).imageScore).toBe(0);
    expect(scoreImages([a], [], 0.85).imageScore).toBe(0);
  });
});

describe("compareSpecs", () => {
  it("scores identical specs 1 with no failures", () => {
    expect(compareSpecs(supplierSpecs, { ...supplierSpecs }, 0.1)).toEqual({ specScore: 1, hardRuleFailures: [], unknownFields: [] });
  });

  it.each([
    ["material", { material: "925 silver" }],
    ["shape", { shape: "round" }],
    ["personalization", { personalization: false }],
    ["giftBox", { giftBox: true }],
    ["packQuantity", { packQuantity: 2 }],
    ["sizeCm", { sizeCm: 60 }],
  ] as const)("treats a different %s as a hard-rule failure", (field, change) => {
    const result = compareSpecs(supplierSpecs, { ...supplierSpecs, ...change }, 0.1);
    expect(result.hardRuleFailures).toEqual([field]);
  });

  it("accepts sizes within ±10% and rejects those outside", () => {
    expect(compareSpecs(supplierSpecs, { ...supplierSpecs, sizeCm: 49.5 }, 0.1).hardRuleFailures).toEqual([]);
    expect(compareSpecs(supplierSpecs, { ...supplierSpecs, sizeCm: 40.5 }, 0.1).hardRuleFailures).toEqual([]);
    expect(compareSpecs(supplierSpecs, { ...supplierSpecs, sizeCm: 50 }, 0.1).hardRuleFailures).toEqual(["sizeCm"]);
    expect(compareSpecs(supplierSpecs, { ...supplierSpecs, sizeCm: 40 }, 0.1).hardRuleFailures).toEqual(["sizeCm"]);
  });

  it("lowers the score for a different colour without failing a hard rule", () => {
    const result = compareSpecs(supplierSpecs, { ...supplierSpecs, color: "silver" }, 0.1);
    expect(result.hardRuleFailures).toEqual([]);
    expect(result.specScore).toBeCloseTo(6 / 7);
  });

  it("treats a spec the competitor does not state as unknown, not as a mismatch", () => {
    const result = compareSpecs(supplierSpecs, { ...supplierSpecs, shape: null }, 0.1);
    expect(result).toMatchObject({ hardRuleFailures: [], unknownFields: ["shape"] });
    expect(result.specScore).toBeCloseTo(6 / 7);
  });

  it("ignores fields the supplier itself does not state, and compares text case-insensitively", () => {
    const result = compareSpecs({ ...supplierSpecs, color: null }, { ...supplierSpecs, material: " Copper ", color: "blue" }, 0.1);
    expect(result).toEqual({ specScore: 1, hardRuleFailures: [], unknownFields: [] });
  });

  it("does not match two listings with the same title but different material", () => {
    // Title alone would say "same"; the stated material says otherwise.
    const copper = { ...supplierSpecs, material: "copper" };
    const silver = { ...supplierSpecs, material: "925 silver" };
    const comparison = compareSpecs(copper, silver, 0.1);
    expect(comparison.hardRuleFailures).toEqual(["material"]);
    expect(
      decideMatch({ imageScore: 1, matchedImageCount: 6, specs: comparison, vision: { same: true, confidence: 1, differences: [] } }, settings).status,
    ).toBe("REJECTED");
  });
});

describe("optionMismatches", () => {
  const lamp = { "light color": "White", power: "0.5 watts" };

  it("flags a competitor item that is another choice of the same options", () => {
    // Seen on eBay: the cable-only variation of a lamp listing, at a third of the lamp's price.
    expect(optionMismatches(lamp, { "Light color": "USB data cable", power: "1pc", Type: "Night Light" })).toEqual(["option: light color", "option: power"]);
    expect(optionMismatches(lamp, { "Light Color": "Grey", Power: "0.5 watts" })).toEqual(["option: light color"]);
  });

  it("accepts the same choice whatever the spelling, and ignores options the competitor does not state", () => {
    expect(optionMismatches(lamp, { "Light-Color": " white ", POWER: "0.5  Watts" })).toEqual([]);
    expect(optionMismatches(lamp, { Brand: "Unbranded", Type: "Night Light" })).toEqual([]);
    expect(optionMismatches({}, { "Light color": "Grey" })).toEqual([]);
  });
});

describe("decideMatch", () => {
  const perfectSpecs = compareSpecs(supplierSpecs, supplierSpecs, 0.1);
  const same = (confidence: number) => ({ same: true, confidence, differences: [] });

  it("weights image 40%, spec 30%, vision 30%", () => {
    const { finalScore } = decideMatch({ imageScore: 4 / 6, matchedImageCount: 4, specs: perfectSpecs, vision: same(0.95) }, settings);
    expect(finalScore).toBeCloseTo(0.4 * (4 / 6) + 0.3 + 0.3 * 0.95);
  });

  it("confirms at 0.85 and above", () => {
    expect(decideMatch({ imageScore: 4 / 6, matchedImageCount: 4, specs: perfectSpecs, vision: same(0.95) }, settings).status).toBe("CONFIRMED");
  });

  it("sends 0.60–0.85 to review", () => {
    const unclearShape = compareSpecs(supplierSpecs, { ...supplierSpecs, shape: null }, 0.1);
    const result = decideMatch({ imageScore: 3 / 6, matchedImageCount: 3, specs: unclearShape, vision: same(0.68) }, settings);
    expect(result.finalScore).toBeCloseTo(0.2 + 0.3 * (6 / 7) + 0.3 * 0.68);
    expect(result.status).toBe("REVIEW");
  });

  it("discards below 0.60", () => {
    expect(decideMatch({ imageScore: 0, matchedImageCount: 0, specs: perfectSpecs, vision: same(0.5) }, settings).status).toBe("REJECTED");
  });

  it("counts a confident 'different product' verdict against the match", () => {
    const result = decideMatch(
      { imageScore: 1, matchedImageCount: 6, specs: perfectSpecs, vision: { same: false, confidence: 0.95, differences: ["different clasp"] } },
      settings,
    );
    expect(result.finalScore).toBeCloseTo(0.4 + 0.3 + 0.3 * 0.05);
    expect(result.status).toBe("REVIEW");
  });

  it("rejects on a hard-rule failure even with a perfect score otherwise", () => {
    const withBox = compareSpecs(supplierSpecs, { ...supplierSpecs, giftBox: true }, 0.1);
    expect(decideMatch({ imageScore: 1, matchedImageCount: 6, specs: withBox, vision: same(1) }, settings).status).toBe("REJECTED");
  });

  it("holds a single-image match for review unless every spec is stated and matches", () => {
    const lenient = { ...settings, confirmThreshold: 0.6 };
    const unclearShape = compareSpecs(supplierSpecs, { ...supplierSpecs, shape: null }, 0.1);
    const oneImage = { imageScore: 1 / 6, matchedImageCount: 1, vision: same(1) };
    expect(decideMatch({ ...oneImage, specs: unclearShape }, lenient).status).toBe("REVIEW");
    expect(decideMatch({ ...oneImage, specs: perfectSpecs }, lenient).status).toBe("CONFIRMED");
    expect(decideMatch({ ...oneImage, matchedImageCount: 2, specs: unclearShape }, lenient).status).toBe("CONFIRMED");
  });

  it("skips vision when it cannot change the outcome", () => {
    const withBox = compareSpecs(supplierSpecs, { ...supplierSpecs, giftBox: true }, 0.1);
    const nothingKnown = compareSpecs(supplierSpecs, { material: null, shape: null, sizeCm: null, color: null, personalization: null, giftBox: null, packQuantity: null }, 0.1);
    expect(visionCouldMatter({ imageScore: 1, specs: withBox }, settings)).toBe(false);
    expect(visionCouldMatter({ imageScore: 0, specs: nothingKnown }, settings)).toBe(false);
    expect(visionCouldMatter({ imageScore: 0.5, specs: perfectSpecs }, settings)).toBe(true);
  });
});
