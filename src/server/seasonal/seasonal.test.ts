import { describe, expect, it } from "vitest";
import { addDays, cutoffDate, daysBetween, holidayDate, holidayWindow, occurrenceOnOrAfter } from "./calendar";
import { addHolidayKeyword, holidayTitleKeyword, removeHolidayWords } from "./titles";

const day = (date: string) => new Date(`${date}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

describe("holidayDate", () => {
  it("resolves fixed dates", () => {
    expect(iso(holidayDate("02-14", 2027))).toBe("2027-02-14");
    expect(iso(holidayDate("12-25", 2026))).toBe("2026-12-25");
  });

  it.each([
    ["Mother's Day 2026", "nth:5:2:0", 2026, "2026-05-10"],
    ["Mother's Day 2027", "nth:5:2:0", 2027, "2027-05-09"],
    ["Father's Day 2027", "nth:6:3:0", 2027, "2027-06-20"],
    ["Black Friday 2026", "nth:11:4:4+1", 2026, "2026-11-27"],
    ["Cyber Monday 2026", "nth:11:4:4+4", 2026, "2026-11-30"],
    ["Black Friday 2027", "nth:11:4:4+1", 2027, "2027-11-26"],
    // November 2029 starts on a Thursday: the fourth Thursday is the 22nd.
    ["Black Friday 2029", "nth:11:4:4+1", 2029, "2029-11-23"],
  ])("resolves %s", (_, rule, year, expected) => {
    expect(iso(holidayDate(rule, year))).toBe(expected);
  });

  it("rejects rules it does not understand", () => {
    expect(() => holidayDate("easter", 2027)).toThrow(/Invalid holiday date rule/);
    expect(() => holidayDate("nth:5:6:0", 2027)).toThrow();
  });
});

describe("occurrenceOnOrAfter", () => {
  it("returns this year's date until it has passed, then next year's", () => {
    expect(iso(occurrenceOnOrAfter("02-14", day("2027-02-03")))).toBe("2027-02-14");
    expect(iso(occurrenceOnOrAfter("02-14", new Date("2027-02-14T18:00:00Z")))).toBe("2027-02-14");
    expect(iso(occurrenceOnOrAfter("02-14", day("2027-02-15")))).toBe("2028-02-14");
    expect(iso(occurrenceOnOrAfter("nth:5:2:0", day("2027-02-16")))).toBe("2027-05-09");
  });
});

describe("cutoffDate", () => {
  it("is processing + delivery + 2 buffer days before the holiday", () => {
    // Necklace: 2 processing days + 5 delivery days + 2 buffer = 9 days before Feb 14.
    expect(iso(cutoffDate(day("2027-02-14"), 2, 5))).toBe("2027-02-05");
    expect(iso(cutoffDate(day("2027-02-14"), 7, 14))).toBe("2027-01-22");
  });
});

describe("holidayWindow", () => {
  const valentines = { dateRule: "02-14", listStartDaysBefore: 60 };

  it("opens listStartDaysBefore days ahead and stays open through the holiday", () => {
    expect(iso(holidayWindow(valentines, day("2027-01-10")).listStart)).toBe("2026-12-16");
    expect(holidayWindow(valentines, day("2026-12-15")).inWindow).toBe(false);
    expect(holidayWindow(valentines, day("2026-12-16")).inWindow).toBe(true);
    expect(holidayWindow(valentines, day("2027-02-14")).inWindow).toBe(true);
  });

  it("moves on to next year's occurrence the day after", () => {
    const window = holidayWindow(valentines, day("2027-02-15"));
    expect(iso(window.date)).toBe("2028-02-14");
    expect(window.inWindow).toBe(false);
  });
});

describe("date helpers", () => {
  it("counts calendar days regardless of the time of day", () => {
    expect(daysBetween(new Date("2027-02-03T23:00:00Z"), new Date("2027-02-14T01:00:00Z"))).toBe(11);
    expect(iso(addDays(day("2027-02-14"), 2))).toBe("2027-02-16");
  });
});

describe("holiday words in titles", () => {
  const valentines = { name: "Valentine's Day", keywords: ["valentines day gift", "gift for her", "romantic gift"] };
  const mothersDay = { name: "Mother's Day", keywords: ["mothers day gift", "gift for mom"] };

  it("adds the holiday's first keyword in title case", () => {
    expect(holidayTitleKeyword(valentines)).toBe("Valentines Day Gift");
    expect(addHolidayKeyword("Custom Photo Projection Necklace", valentines, 80)).toBe("Custom Photo Projection Necklace Valentines Day Gift");
  });

  it("does not add it twice or beyond the title limit", () => {
    const withKeyword = "Custom Photo Projection Necklace Valentines Day Gift";
    expect(addHolidayKeyword(withKeyword, valentines, 80)).toBe(withKeyword);
    expect(addHolidayKeyword("Custom Photo Projection Necklace", valentines, 40)).toBe("Custom Photo Projection Necklace");
  });

  it("removes every phrase of the holiday, with or without apostrophes", () => {
    expect(removeHolidayWords("Custom Photo Projection Necklace Valentines Day Gift", valentines)).toBe("Custom Photo Projection Necklace");
    expect(removeHolidayWords("Valentine's Day Photo Necklace Gift for Her", valentines)).toBe("Photo Necklace");
    expect(removeHolidayWords("Romantic Gift Necklace for VALENTINES DAY", valentines)).toBe("Necklace for");
  });

  it("re-targets a title from one holiday to the next", () => {
    const stripped = removeHolidayWords("Custom Photo Projection Necklace Valentines Day Gift", valentines);
    expect(addHolidayKeyword(stripped, mothersDay, 80)).toBe("Custom Photo Projection Necklace Mothers Day Gift");
  });

  it("leaves other titles untouched", () => {
    expect(removeHolidayWords("Heart Pendant Necklace", valentines)).toBe("Heart Pendant Necklace");
  });
});
