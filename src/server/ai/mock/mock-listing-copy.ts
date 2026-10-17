import type { ListingCopyGenerator, ListingCopyInput } from "../types";

/** Template-based stand-in for the LLM listing writer. */
export class MockListingCopyGenerator implements ListingCopyGenerator {
  async generateListingCopy(input: ListingCopyInput): Promise<{ title: string; description: string }> {
    let title = input.sourceTitle;
    for (const keyword of input.keywords) {
      // A keyword that mostly repeats the title adds nothing ("photo projection necklace" twice).
      const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
      const repeated = words.filter((word) => title.toLowerCase().includes(word)).length;
      if (repeated * 2 >= words.length) continue;
      const candidate = `${title} ${keyword.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())}`;
      if (candidate.length > input.maxTitleLength) break;
      title = candidate;
    }

    const facts = [
      input.specs.material && `Material: ${input.specs.material}`,
      input.specs.color && `Color: ${input.specs.color}`,
      input.specs.sizeCm && `Size: ${input.specs.sizeCm} cm`,
      input.specs.personalization && "Personalized to order",
    ].filter((fact): fact is string => Boolean(fact));

    return {
      title: title.slice(0, input.maxTitleLength).trim(),
      description: [input.sourceDescription, ...facts].join("\n"),
    };
  }
}
