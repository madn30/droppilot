import type { AspectFillInput, AspectFiller } from "../types";

/** Stand-in for the LLM: picks the first allowed value the listing text mentions. */
export class MockAspectFiller implements AspectFiller {
  async fillAspects(input: AspectFillInput): Promise<Record<string, string>> {
    const text = `${input.title}\n${input.description}`.toLowerCase();
    const filled: Record<string, string> = {};
    for (const aspect of input.aspects) {
      const mentioned = aspect.allowedValues.find((value) => value.split(/\s+/).some((word) => word.length > 3 && text.includes(word.toLowerCase())));
      if (mentioned) filled[aspect.name] = mentioned;
    }
    return filled;
  }
}
