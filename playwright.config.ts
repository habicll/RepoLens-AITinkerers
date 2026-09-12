import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: [
    { command: "npx tsx tests/fixture-server.ts", url: "http://127.0.0.1:3001/api/health", reuseExistingServer: false, env: { COPILOTKIT_TELEMETRY_DISABLED: "true", DO_NOT_TRACK: "1" } },
    { command: "npm run dev:client", url: "http://127.0.0.1:5173", reuseExistingServer: false },
  ],
});
