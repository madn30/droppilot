import path from "node:path";
import { defineConfig } from "vitest/config";

// Integration tests run against a real Postgres database (docker compose up -d postgres).
// The database is separate from the dev one and is migrated by the global setup.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://droppilot:droppilot@localhost:5433/droppilot_test";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    // One database is shared, so test files must not run in parallel.
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: "redis://localhost:6379",
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD_HASH: "scrypt:unused:unused",
      SESSION_SECRET: "test-session-secret-test-session-secret",
      ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      MOCK_APIS: "true",
      LOG_LEVEL: "silent",
    },
  },
});
