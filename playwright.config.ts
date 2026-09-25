import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    channel:
      process.env.PLAYWRIGHT_BROWSER_CHANNEL ??
      (process.platform === 'win32' ? 'msedge' : undefined),
    baseURL: 'http://127.0.0.1:15321',
    viewport: { width: 1360, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 15321',
    url: 'http://127.0.0.1:15321',
    reuseExistingServer: false,
    env:
      process.platform === 'darwin' ? { CHOKIDAR_USEPOLLING: '1' } : undefined,
  },
})
