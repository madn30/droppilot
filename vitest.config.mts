import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Integration tests need Postgres: npm run test:integration
    exclude: ["tests/integration/**", "node_modules/**"],
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5433/test",
      REDIS_URL: "redis://localhost:6379",
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD_HASH: "scrypt:unused:unused",
      SESSION_SECRET: "test-session-secret-test-session-secret",
      ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      MOCK_APIS: "true",
    },
  },
});
