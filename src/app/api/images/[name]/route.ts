import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSession } from "@/server/auth/session";
import { getEnv } from "@/server/env";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

// Cache file names are a 32-character hash plus an extension; nothing else is served.
const FILE_NAME = /^[0-9a-f]{32}\.(jpg|png|webp|gif|avif)$/;

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  if (!(await getSession())) return new Response("Unauthorized", { status: 401 });

  const { name } = await params;
  const match = FILE_NAME.exec(name);
  if (!match) return new Response("Not found", { status: 404 });

  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(getEnv().IMAGE_CACHE_DIR, name));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": CONTENT_TYPES[match[1]], "Cache-Control": "private, max-age=86400" },
  });
}
