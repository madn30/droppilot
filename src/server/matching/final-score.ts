import type { MatchStatus } from "@prisma/client";
import type { VisionVerdict } from "../ai/types";
import type { Settings } from "../settings/schema";
import type { SpecComparison } from "./spec-score";

type MatchingSettings = Settings["matching"];

export interface MatchEvidence {
  imageScore: number;
  matchedImageCount: number;
  specs: SpecComparison;
  /** null when vision was not consulted. */
  vision: VisionVerdict | null;
}

/** How strongly the vision verdict says "same product", 0–1. */
function visionScore(vision: VisionVerdict | null): number {
  if (!vision) return 0;
  return vision.same ? vision.confidence : 1 - vision.confidence;
}

function computeFinalScore(evidence: Omit<MatchEvidence, "matchedImageCount">, settings: MatchingSettings): number {
  const { image, spec, vision } = settings.weights;
  const total = image + spec + vision;
  if (total === 0) return 0;
  return (image * evidence.imageScore + spec * evidence.specs.specScore + vision * visionScore(evidence.vision)) / total;
}

/**
 * The verdict for one competitor listing:
 *  - any hard-rule mismatch → rejected, whatever the score
 *  - score ≥ confirm threshold → confirmed
 *  - score ≥ review threshold → needs review
 *  - otherwise → rejected (discarded)
 * A match resting on at most one shared image may be a reused stock photo, so
 * it is only confirmed when every spec is stated and matches; else it goes to review.
 */
export function decideMatch(evidence: MatchEvidence, settings: MatchingSettings): { finalScore: number; status: MatchStatus } {
  const finalScore = computeFinalScore(evidence, settings);
  if (evidence.specs.hardRuleFailures.length > 0) return { finalScore, status: "REJECTED" };
  if (finalScore < settings.reviewThreshold) return { finalScore, status: "REJECTED" };

  const thinImageEvidence = evidence.matchedImageCount <= 1 && evidence.specs.specScore < 1;
  if (finalScore >= settings.confirmThreshold && !thinImageEvidence) return { finalScore, status: "CONFIRMED" };
  return { finalScore, status: "REVIEW" };
}

/** Whether a vision check could still lift this listing to at least "needs review". */
export function visionCouldMatter(evidence: Omit<MatchEvidence, "vision" | "matchedImageCount">, settings: MatchingSettings): boolean {
  if (evidence.specs.hardRuleFailures.length > 0) return false;
  const best = computeFinalScore({ ...evidence, vision: { same: true, confidence: 1, differences: [] } }, settings);
  return best >= settings.reviewThreshold;
}
