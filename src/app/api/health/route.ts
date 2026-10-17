import { NextResponse } from "next/server";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  await db.$queryRaw`SELECT 1`;
  return NextResponse.json({ status: "ok" });
}
