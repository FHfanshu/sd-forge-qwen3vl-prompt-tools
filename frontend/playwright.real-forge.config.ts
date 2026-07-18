import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/real-forge.spec.ts",
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.FORGE_BASE_URL ?? "http://127.0.0.1:7860",
    httpCredentials: process.env.FORGE_HTTP_USERNAME ? {
      username: process.env.FORGE_HTTP_USERNAME,
      password: process.env.FORGE_HTTP_PASSWORD ?? "",
    } : undefined,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
