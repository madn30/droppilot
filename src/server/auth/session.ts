import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "../env";
import { SESSION_TTL_SECONDS, createSessionToken, verifySessionToken } from "./token";

const SESSION_COOKIE = "dp_session";

export async function startSession(email: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, createSessionToken(email, getEnv().SESSION_SECRET), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<{ email: string } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const env = getEnv();
  const session = verifySessionToken(token, env.SESSION_SECRET);
  // A token minted for a previous ADMIN_EMAIL must not outlive the change.
  return session?.email === env.ADMIN_EMAIL ? session : null;
}

// Call at the top of every protected layout, page and server action.
export async function requireAdmin(): Promise<{ email: string }> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
