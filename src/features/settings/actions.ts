"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/server/auth/session";
import { saveSettings } from "@/server/settings/service";
import { type SettingsFormState, parseSettingsForm } from "./form";

export async function saveSettingsAction(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  await requireAdmin();

  const values: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string") values[name] = value;
  }

  const parsed = parseSettingsForm(values);
  if (!parsed.success) return { saved: false, errors: parsed.errors, submitted: values };

  await saveSettings(parsed.settings);
  revalidatePath("/settings");
  return { saved: true, errors: {} };
}
