import { defineConfig } from '@playwright/test';
import {
  SYNTHETIC_ANON_KEY,
  SYNTHETIC_SUPABASE_URL,
} from './tests/e2e/support/localSyntheticSupabase';

/**
 * OFFICEPILOT-LOCAL-E2E-SYNTHETIC-AUTH-PROBE-01B — der lokale, wegwerfbare Pfad.
 *
 * Dritte Konfiguration neben Beta (`playwright.config.ts`) und Cloud
 * (`playwright.cloud.config.ts`), und bewusst getrennt von beiden: Der
 * Beta-Pfad startet Vite ohne Supabase-Schlüssel und kommt deshalb nie hinter
 * die Anmeldemaske; der Cloud-Pfad benutzt eine echte Sitzung und darf niemals
 * mit erfundenen Werten vermischt werden.
 *
 * ⚠️ Die Supabase-Adresse wird hier **explizit gesetzt** und zeigt auf einen
 * `.invalid`-Host. Vite bevorzugt tatsächlich vorhandene Prozessvariablen
 * gegenüber `.env`-Dateien, sodass eine lokal hinterlegte echte Konfiguration
 * in diesem Lauf nicht greift. Zusätzlich weist der Test jeden Verkehr ab, der
 * weder an die eigene Anwendung noch an den erfundenen Host geht — die Adresse
 * allein ist die Zusicherung nicht wert, die Blockade schon.
 */

/** Eigener Port: 5184 Alltag, 5199 Beta, 5200 Cloud, 5201 lokal. */
const PORT = Number(process.env.E2E_LOCAL_PORT ?? 5201);

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],

  /* Wie im Cloud-Pfad: kein Fehlerkontext bleibt liegen. */
  preserveOutput: 'never',
  outputDir: 'test-results/local',

  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'msedge',
    /*
     * Hier gäbe es zwar keine echten Geschäftsdaten zu verlieren — aber ein
     * Ausgabepfad, der je nach Konfiguration mal Belege schreibt und mal nicht,
     * ist schwerer zu beurteilen als einer, der es nie tut.
     */
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    /* Ein Service Worker würde Anfragen an der Abfangregel vorbeiführen. */
    serviceWorkers: 'block',
  },

  projects: [
    {
      name: 'local',
      testMatch: /localSyntheticAuthProbe\.spec\.ts/,
      use: { headless: true },
    },
  ],

  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      /*
       * Ohne diese beiden erzeugt `getSupabaseClient()` keinen Client, und die
       * Anwendung bleibt ohne jede Sitzung auf der Anmeldemaske stehen. Beide
       * Werte sind frei erfunden und kein Geheimnis.
       */
      VITE_SUPABASE_URL: SYNTHETIC_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: SYNTHETIC_ANON_KEY,
    },
  },
});
