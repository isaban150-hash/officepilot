import { defineConfig } from '@playwright/test';

/**
 * OFFICEPILOT-LIVE-AGENT-CLOUD-TEST-01B — echte Sitzung, streng getrennt vom
 * Beta-Harness.
 *
 * Bewusst eine **eigene Konfigurationsdatei** statt weiterer Projekte in
 * `playwright.config.ts`: Jene startet Vite mit `--mode e2e` und damit
 * `.env.e2e` (`VITE_BETA_TEST_MODE=true`, keine Supabase-Schlüssel). Für eine
 * echte Anmeldung ist genau das falsch — hier läuft Vite im **normalen** Modus,
 * damit die lokal vorhandene Supabase-Konfiguration greift.
 *
 * ⚠️ Keine Belege in diesem Pfad: `trace`, `screenshot` und `video` sind
 * durchgehend aus. Ein Trace enthält den Netzwerkverkehr — Supabase-Anfragen
 * tragen ein gültiges Bearer-Token, und ein Screenshot zeigt echte
 * Geschäftsdaten. Beides hat auf der Platte nichts zu suchen.
 */

/**
 * Eigener Port. Nicht 5184 (dort arbeitet der Alltags-Dev-Server) und nicht
 * 5199 (Beta-Harness). Der Lauf startet seinen eigenen Server und setzt keinen
 * bereits laufenden voraus.
 */
const PORT = Number(process.env.E2E_CLOUD_PORT ?? 5200);

export const CLOUD_AUTH_STATE = 'playwright/.auth/officepilot.json';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  /* Die Anmeldung wartet auf einen Menschen — knapp über drei Minuten. */
  timeout: 240_000,
  expect: { timeout: 20_000 },
  /* Nur Testnamen, keine Daten. */
  reporter: [['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'msedge',
    /* Verbindlich für alle Cloud-Projekte — siehe Kopfkommentar. */
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },

  projects: [
    {
      /*
       * Einmalige manuelle Anmeldung. Läuft ausschliesslich auf Zuruf und ist
       * **keine** Abhängigkeit der anderen Projekte: Ein Cloud-Test darf nie
       * versehentlich ein Anmeldefenster öffnen, sondern muss klar scheitern,
       * wenn die Sitzung fehlt.
       */
      name: 'auth-setup',
      testMatch: /auth\.setup\.ts/,
      use: { headless: false, launchOptions: { slowMo: 700 } },
    },
    {
      /* Alltag: nutzt die gespeicherte Sitzung, ohne Fenster. */
      name: 'cloud',
      testMatch: [
        /cloudSession\.spec\.ts/,
        /cloudReadOnlyVorgang\.spec\.ts/,
        /cloudReadOnlyInvoice\.spec\.ts/,
      ],
      use: { headless: true, storageState: CLOUD_AUTH_STATE },
    },
    {
      /* Vorführung desselben Lesetests, sichtbar und langsam. */
      name: 'cloud-live',
      testMatch: [
        /cloudSession\.spec\.ts/,
        /cloudReadOnlyVorgang\.spec\.ts/,
        /cloudReadOnlyInvoice\.spec\.ts/,
      ],
      use: {
        headless: false,
        launchOptions: { slowMo: 700 },
        storageState: CLOUD_AUTH_STATE,
      },
    },
  ],

  webServer: {
    /*
     * Normaler Vite-Modus — **ohne** `--mode e2e`. Nur so liest die Anwendung
     * die lokal hinterlegte Supabase-Konfiguration und kann sich überhaupt
     * anmelden.
     */
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
