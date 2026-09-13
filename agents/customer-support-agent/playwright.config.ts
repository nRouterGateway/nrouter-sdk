import { defineConfig, devices } from '@playwright/test';

// Fast fail if NROUTER_API_KEY is unset, except when listing tests or checking syntax
if (!process.env.NROUTER_API_KEY || !process.env.NROUTER_API_KEY.trim()) {
  const isListing = process.argv.some(arg => arg === '--list' || arg === '-l');
  if (!isListing) {
    throw new Error('NROUTER_API_KEY environment variable is required to run e2e tests. Fast failing.');
  }
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 90_000,
  retries: 0,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:4174',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node e2e/demo-server.mjs',
    url: 'http://127.0.0.1:4174/healthz',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PATH: process.env.PATH || '',
      NROUTER_API_KEY: process.env.NROUTER_API_KEY?.trim() || '',
      ...(process.env.NROUTER_BASE_URL && process.env.NROUTER_BASE_URL.trim()
        ? { NROUTER_BASE_URL: process.env.NROUTER_BASE_URL.trim() }
        : {}),
      ...(process.env.MODEL && process.env.MODEL.trim()
        ? { MODEL: process.env.MODEL.trim() }
        : {}),
    },
  },
});
