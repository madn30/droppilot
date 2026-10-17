import type { Prisma } from "@prisma/client";
import { db } from "../src/server/db";
import { logger } from "../src/server/logger";
import { ensureSettings } from "../src/server/settings/service";

// dateRule: "MM-DD" for fixed dates, "nth:<month>:<n>:<weekday 0=Sun>[+days]" for floating ones.
const holidays: Prisma.HolidayCreateInput[] = [
  {
    code: "valentines",
    name: "Valentine's Day",
    dateRule: "02-14",
    keywords: ["valentines day gift", "gift for her", "gift for girlfriend", "romantic gift"],
    categories: ["Jewelry", "Home Decor", "Gifts"],
    retargetToCode: "mothers-day",
  },
  {
    code: "mothers-day",
    name: "Mother's Day",
    dateRule: "nth:5:2:0",
    keywords: ["mothers day gift", "gift for mom", "gift for grandma"],
    categories: ["Jewelry", "Home Decor", "Gifts"],
    retargetToCode: "fathers-day",
  },
  {
    code: "fathers-day",
    name: "Father's Day",
    dateRule: "nth:6:3:0",
    keywords: ["fathers day gift", "gift for dad", "gift for grandpa"],
    categories: ["Tools", "Accessories", "Gifts"],
  },
  {
    code: "back-to-school",
    name: "Back to School",
    dateRule: "08-15",
    keywords: ["back to school", "school supplies", "student gift"],
    categories: ["Stationery", "Bags", "Dorm"],
  },
  {
    code: "halloween",
    name: "Halloween",
    dateRule: "10-31",
    keywords: ["halloween decoration", "halloween costume accessory", "spooky decor"],
    categories: ["Party Supplies", "Home Decor", "Costume Accessories"],
    retargetToCode: "christmas",
  },
  {
    code: "black-friday",
    name: "Black Friday",
    dateRule: "nth:11:4:4+1",
    keywords: ["black friday deal", "gift idea"],
    categories: ["Gifts", "Gadgets", "Home"],
    retargetToCode: "cyber-monday",
  },
  {
    code: "cyber-monday",
    name: "Cyber Monday",
    dateRule: "nth:11:4:4+4",
    keywords: ["cyber monday deal", "gift idea"],
    categories: ["Gifts", "Gadgets", "Home"],
    retargetToCode: "christmas",
  },
  {
    code: "christmas",
    name: "Christmas",
    dateRule: "12-25",
    keywords: ["christmas gift", "stocking stuffer", "christmas decoration", "xmas ornament"],
    categories: ["Gifts", "Home Decor", "Toys"],
    retargetToCode: "valentines",
  },
];

// Every step creates only what is missing, so re-running never overwrites edits made in the dashboard.
async function main(): Promise<void> {
  await ensureSettings();

  await db.supplier.upsert({
    where: { code: "cj" },
    create: { code: "cj", name: "CJ Dropshipping", isDropshipSupplier: true, supportsBlindShipping: true },
    update: {},
  });

  for (const holiday of holidays) {
    await db.holiday.upsert({ where: { code: holiday.code }, create: holiday, update: {} });
  }

  logger.info({ holidays: holidays.length }, "seed complete");
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, "seed failed");
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
