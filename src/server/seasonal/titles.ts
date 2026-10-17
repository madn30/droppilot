import type { Marketplace } from "@prisma/client";

export const MAX_TITLE_LENGTH: Record<Marketplace, number> = { EBAY: 80, AMAZON: 200 };

interface HolidayWords {
  name: string;
  keywords: string[];
}

function titleCase(phrase: string): string {
  return phrase.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The phrase a holiday adds to listing titles: its first keyword, e.g. "Valentines Day Gift". */
export function holidayTitleKeyword(holiday: HolidayWords): string {
  return titleCase(holiday.keywords[0] ?? holiday.name);
}

/** Appends the holiday phrase when it fits within the marketplace's title limit; otherwise leaves the title alone. */
export function addHolidayKeyword(title: string, holiday: HolidayWords, maxLength: number): string {
  const keyword = holidayTitleKeyword(holiday);
  if (title.toLowerCase().includes(keyword.toLowerCase())) return title;
  const candidate = `${title} ${keyword}`;
  return candidate.length <= maxLength ? candidate : title;
}

/** Removes every phrase of the holiday (its keywords and its name) from a title. */
export function removeHolidayWords(title: string, holiday: HolidayWords): string {
  // Longest first, so "valentines day gift" goes before a shorter phrase it contains.
  const phrases = [...holiday.keywords, holiday.name].sort((a, b) => b.length - a.length);
  let result = title;
  for (const phrase of phrases) {
    // Apostrophes are optional: "Valentine's Day" also matches "Valentines Day".
    const pattern = escapeRegExp(phrase).replace(/'/g, "'?").replace(/\s+/g, "\\s+");
    result = result.replace(new RegExp(`\\b${pattern}\\b`, "gi"), " ");
  }
  return result.replace(/\s+/g, " ").trim();
}
