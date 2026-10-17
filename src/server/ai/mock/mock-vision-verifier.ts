import { necklaceVisionVerdicts } from "../../mocks/fixtures/necklace";
import type { ImagePair, VisionVerdict, VisionVerifier } from "../types";

// Mock image URLs look like https://mock.droppilot.local/images/<owner>/<n>.png?content=<photo>
function parseMockImageUrl(url: string): { owner: string | null; content: string | null } {
  const parsed = new URL(url);
  return {
    owner: parsed.pathname.match(/^\/images\/([^/]+)\//)?.[1] ?? null,
    content: parsed.searchParams.get("content"),
  };
}

/**
 * Stand-in for Claude vision. Fixture competitors get their scripted verdict;
 * anything else is judged by how many pairs are literally the same photo.
 */
export class MockVisionVerifier implements VisionVerifier {
  async verifySameProduct(pairs: ImagePair[]): Promise<VisionVerdict> {
    if (pairs.length === 0) {
      return { same: false, confidence: 0, differences: ["no image pairs to compare"] };
    }

    const { owner } = parseMockImageUrl(pairs[0].competitor.url);
    const scripted = owner ? necklaceVisionVerdicts[owner] : undefined;
    if (scripted) return scripted;

    const identical = pairs.filter(
      (pair) => parseMockImageUrl(pair.supplier.url).content === parseMockImageUrl(pair.competitor.url).content,
    ).length;
    const share = identical / pairs.length;
    return {
      same: share >= 0.5,
      confidence: share >= 0.5 ? share : 1 - share,
      differences: share === 1 ? [] : ["some photos show a different item"],
    };
  }
}
