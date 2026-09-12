import { defineConfig, devices } from '@playwright/test';

/**
 * MANUAL-INVOICE-UI-01B1B — echter Browserlauf gegen die **lokale**
 * Supabase-Instanz (Docker), nicht gegen die synthetische Attrappe und nie
 * gegen eine verknüpfte/entfernte Datenbank.
 *
 * Die Zugangsdaten der lokalen Instanz kommen ausschliesslich aus der
 * Umgebung (`supabase status -o env`) und werden hier nicht abgelegt:
 *
 *   E2E_LOCALDB_SUPABASE_URL       z. B. http://127.0.0.1:54321
 *   E2E_LOCALDB_ANON_KEY           lokaler anon key
 *   E2E_LOCALDB_SERVICE_ROLE_KEY   lokaler service_role key (nur zum Anlegen
 *                                  des synthetischen Testnutzers)
 *
 * Ohne diese Variablen startet der Lauf nicht — lieber laut scheitern als
 * still gegen ein falsches Ziel.
 */
const PORT = Number(process.env.E2E_LOCALDB_PORT ?? 5202);
const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error('E2E_LOCALDB_SUPABASE_URL und E2E_LOCALDB_ANON_KEY müssen gesetzt sein (nur lokal).');
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL)) {
  throw new Error(`E2E_LOCALDB_SUPABASE_URL muss auf die lokale Instanz zeigen, nicht auf ${SUPABASE_URL}`);
}

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  preserveOutput: 'failures-only',
  outputDir: 'test-results/localdb',

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
    serviceWorkers: 'block',
  },

  projects: [
    {
      name: 'localdb-desktop',
      testMatch: /localdb[A-Za-z0-9]*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'msedge', headless: true },
    },
    {
      name: 'localdb-desktop-headed',
      testMatch: /localdb[A-Za-z0-9]*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'msedge', headless: false, launchOptions: { slowMo: 250 } },
    },
    {
      name: 'localdb-android',
      testMatch: /localdb[A-Za-z0-9]*\.spec\.ts/,
      use: { ...devices['Galaxy S24'], channel: 'msedge', headless: true },
    },
    {
      name: 'localdb-ios',
      testMatch: /localdb[A-Za-z0-9]*\.spec\.ts/,
      use: { ...devices['iPhone 14'], headless: true },
    },
  ],

  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      VITE_SUPABASE_URL: SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: ANON_KEY,
    },
  },
});
