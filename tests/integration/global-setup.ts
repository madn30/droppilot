import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";

// Creates the test database if needed and brings it up to the latest migration.
export default function setup(project: TestProject): void {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: project.config.env.DATABASE_URL },
    stdio: "pipe",
  });
}
