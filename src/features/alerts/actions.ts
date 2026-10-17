"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveAlert } from "@/server/alerts/service";
import { requireAdmin } from "@/server/auth/session";

export async function resolveAlertAction(formData: FormData): Promise<void> {
  await requireAdmin();
  await resolveAlert(z.string().min(1).parse(formData.get("alertId")));
  revalidatePath("/");
  revalidatePath("/products");
}
