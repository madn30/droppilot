"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { verifyPassword } from "@/server/auth/password";
import { endSession, startSession } from "@/server/auth/session";
import { loginThrottle } from "@/server/auth/throttle";
import { getEnv } from "@/server/env";
import { logger } from "@/server/logger";

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export interface LoginState {
  error: string | null;
  /** Echoed back after a failed attempt so the field keeps what was typed. */
  email?: string;
}

export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Enter your email and password." };

  if (loginThrottle.isBlocked(Date.now())) {
    return { error: "Too many failed attempts. Try again in a few minutes.", email: parsed.data.email };
  }

  const env = getEnv();
  // Always run the password check so response time does not reveal whether the email matched.
  const passwordOk = verifyPassword(parsed.data.password, env.ADMIN_PASSWORD_HASH);
  const emailOk = parsed.data.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
  if (!passwordOk || !emailOk) {
    loginThrottle.recordFailure(Date.now());
    logger.warn({ email: parsed.data.email }, "failed login attempt");
    return { error: "Wrong email or password.", email: parsed.data.email };
  }

  loginThrottle.reset();
  await startSession(env.ADMIN_EMAIL);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}
