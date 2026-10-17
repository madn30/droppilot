import { z } from "zod";

/** Most options one listing offers; eBay allows more, but a longer list is hard for a buyer to use. */
export const MAX_VARIATIONS = 60;
// eBay rejects longer option names and values.
const MAX_OPTION_LENGTH = 50;

const attributesSchema = z.record(z.string(), z.string());

function tidy(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, MAX_OPTION_LENGTH).trim();
}

/**
 * What a buyer picks to get a variant, from the supplier's attributes:
 * {"light color": "Grey"} becomes { "Light Color": "Grey" }.
 */
export function optionsOf(attributes: unknown): Record<string, string> {
  const parsed = attributesSchema.safeParse(attributes).data ?? {};
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([name, value]) => {
      const optionName = tidy(name).replace(/(^|\s)\p{Ll}/gu, (letter) => letter.toUpperCase());
      const optionValue = tidy(value);
      return optionName && optionValue ? [[optionName, optionValue] as const] : [];
    }),
  );
}

function choiceKey(options: Record<string, string>): string {
  return Object.keys(options)
    .sort()
    .map((name) => `${name}=${options[name].toLowerCase()}`)
    .join("|");
}

/**
 * The variants that can be sold as the options of one listing together with `first`:
 * they have the same option names and each is a different choice. `first` leads.
 * Empty when there are not at least two, since a listing with one option is an ordinary listing.
 */
export function variationSet<T extends { attributes: unknown }>(first: T, others: T[]): { variant: T; options: Record<string, string> }[] {
  const firstOptions = optionsOf(first.attributes);
  const names = Object.keys(firstOptions).sort().join("|");
  if (!names) return [];

  const set = [{ variant: first, options: firstOptions }];
  const taken = new Set([choiceKey(firstOptions)]);
  for (const variant of others) {
    if (set.length >= MAX_VARIATIONS) break;
    const options = optionsOf(variant.attributes);
    const key = choiceKey(options);
    if (Object.keys(options).sort().join("|") !== names || taken.has(key)) continue;
    taken.add(key);
    set.push({ variant, options });
  }
  if (set.length < 2) return [];

  // An attribute every variant shares is not a choice; only the ones that differ are offered.
  const choices = Object.keys(firstOptions).filter((name) => new Set(set.map((entry) => entry.options[name].toLowerCase())).size > 1);
  return set.map((entry) => ({ variant: entry.variant, options: Object.fromEntries(choices.map((name) => [name, entry.options[name]])) }));
}
