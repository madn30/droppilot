import { db } from "../db";
import { getEnv } from "../env";
import { type Settings, defaultSettings, settingsSchema } from "./schema";

const SETTINGS_ID = 1;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stored values win; anything the stored row lacks comes from the defaults. */
export function mergeWithDefaults(defaults: unknown, stored: unknown): unknown {
  if (!isPlainObject(defaults) || !isPlainObject(stored)) return stored === undefined ? defaults : stored;
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    merged[key] = mergeWithDefaults(defaults[key], value);
  }
  return merged;
}

export async function getSettings(): Promise<Settings> {
  const defaults = defaultSettings(getEnv());
  const row = await db.settings.findUnique({ where: { id: SETTINGS_ID } });
  if (!row) return defaults;
  // A row saved before a setting existed must keep working: missing settings take their default.
  return settingsSchema.parse(mergeWithDefaults(defaults, row.data));
}

export async function saveSettings(settings: Settings): Promise<void> {
  const data = settingsSchema.parse(settings);
  await db.settings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, data },
    update: { data },
  });
}

// Seeding must never overwrite settings the admin has already edited.
export async function ensureSettings(): Promise<void> {
  await db.settings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, data: defaultSettings(getEnv()) },
    update: {},
  });
}
