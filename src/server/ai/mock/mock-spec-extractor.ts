import type { ProductSpecs } from "../../matching/specs";
import type { SpecExtractionInput, SpecExtractor } from "../types";

const MATERIALS: [RegExp, string][] = [
  [/925|sterling/, "925 silver"],
  [/stainless/, "stainless steel"],
  [/copper/, "copper"],
  [/brass/, "brass"],
  [/alloy/, "alloy"],
  [/leather/, "leather"],
  [/wood/, "wood"],
];
const SHAPES = ["heart", "round", "square", "oval", "star", "rectangle"];
// Longest first so "rose gold" wins over "gold".
const COLORS = ["rose gold", "gold", "silver", "black", "white", "red", "blue", "pink", "green"];

function findSpecific(itemSpecifics: Record<string, string>, pattern: RegExp): string | null {
  const entry = Object.entries(itemSpecifics).find(([name]) => pattern.test(name.toLowerCase()));
  return entry ? entry[1].toLowerCase() : null;
}

function parseSizeCm(text: string): number | null {
  // "40+5cm" is a chain plus extender: the usable length is the sum.
  const extended = text.match(/(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)\s*cm/);
  if (extended) return Number(extended[1]) + Number(extended[2]);
  const plain = text.match(/(\d+(?:\.\d+)?)\s*cm/);
  return plain ? Number(plain[1]) : null;
}

/**
 * Keyword-based stand-in for the LLM spec extractor. Item specifics win over
 * free text, exactly as the real prompt instructs, so two listings with the
 * same title but different stated materials extract differently.
 */
export class MockSpecExtractor implements SpecExtractor {
  async extractSpecs(input: SpecExtractionInput): Promise<ProductSpecs> {
    const text = `${input.title} ${input.description}`.toLowerCase();

    const materialSource = findSpecific(input.itemSpecifics, /material|metal/) ?? text;
    const shapeSource = findSpecific(input.itemSpecifics, /shape/) ?? text;
    const colorSource = findSpecific(input.itemSpecifics, /colou?r/) ?? text;
    const sizeSource = findSpecific(input.itemSpecifics, /length|size/) ?? text;
    const personalized = findSpecific(input.itemSpecifics, /personali[sz]ed/);
    const giftBox = findSpecific(input.itemSpecifics, /gift ?box|package|packaging/);
    const pack = text.match(/(\d+)\s*(?:pcs|pieces|pack)\b/);

    return {
      material: MATERIALS.find(([pattern]) => pattern.test(materialSource))?.[1] ?? null,
      shape: SHAPES.find((shape) => shapeSource.includes(shape)) ?? null,
      sizeCm: parseSizeCm(sizeSource),
      color: COLORS.find((color) => colorSource.includes(color)) ?? null,
      personalization:
        personalized !== null ? personalized === "yes" : /photo|picture|custom|personali[sz]ed|engrav/.test(text),
      giftBox: giftBox !== null ? /yes|box/.test(giftBox) && !/no\b/.test(giftBox) : /gift box|with box|box included/.test(text),
      packQuantity: pack ? Number(pack[1]) : 1,
    };
  }
}
