import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pino's pretty transport runs in a worker thread that must be loaded from node_modules, not bundled.
  serverExternalPackages: ["pino", "pino-pretty", "thread-stream"],
};

export default nextConfig;
