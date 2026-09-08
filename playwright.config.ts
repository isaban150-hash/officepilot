import { defineConfig, devices } from '@playwright/test';

/**
 * OFFICEPILOT-LIVE-AGENT-TEST-HARNESS-01B — der erste sichtbare Browserlauf.
 *
 * Bewusst klein: ein Browser, ein Projekt, ein Pilot. Keine Browsermatrix,
 * keine Cloud, keine Zugangsdaten.
 *
 * **Microsoft Edge statt Playwright-Chromium** (`channel: 'msedge'`): Edge ist
 * auf diesem Rechner installiert, Chromium wäre ein zusätzlicher Download von
 * rund 150 MB für dieselbe Engine.
 *
 * **Sichtbar oder schnell** entscheidet `E2E_HEADED`. Der Alltagslauf bleibt
 * headless und zügig; der Vorführlauf öffnet ein echtes Fenster und wird über
 * `slowMo` so weit verlangsamt, dass ein Mensch folgen kann.
 */
/**
 * Eigener Port, nicht der Alltagsport 5184.
 *
 * Auf diesem Rechner läuft dort bereits ein normaler Dev-Server. Ihn zu
 * übernehmen wäre falsch (er kennt `.env.e2e` nicht), ihn zu beenden wäre
 * übergriffig. Ein eigener Port trennt Vorführlauf und Alltagsarbeit sauber —
 * beide dürfen gleichzeitig laufen.
 */
const PORT = Number(process.env.E2E_PORT ?? 5199);

export default defineConfig({
  testDir: './tests/e2e',
  /*
   * OFFICEPILOT-LIVE-AGENT-CLOUD-TEST-01B — der Beta-Pfad kennt keine Cloud.
   *
   * Diese Konfiguration startet Vite mit `--mode e2e` und damit ohne
   * Supabase-Schlüssel. Die Cloud-Spezifikationen laufen ausschliesslich über
   * `playwright.cloud.config.ts`; hier würden sie zwangsläufig scheitern und
   * einen grünen Beta-Lauf rot färben.
   */
  testIgnore: [
    /auth\.setup\.ts/,
    /cloudSession\.spec\.ts/,
    /cloudReadOnlyVorgang\.spec\.ts/,
    /cloudReadOnlyInvoice\.spec\.ts/,
    /* WRITE-GATE-01B: beide setzen eine echte Cloud-Sitzung voraus. */
    /authorizeCloudWriteWorkspace\.setup\.ts/,
    /cloudWriteGate\.spec\.ts/,
  ],
  /* Ein Pilot — Parallelität bringt hier nichts und macht den Lauf unruhig. */
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],

  /*
   * Zwei Projekte statt einer Umgebungsvariablen: `E2E_HEADED=true …` lässt
   * sich unter Windows nicht ohne Zusatzpaket in ein npm-Script schreiben.
   * `--project` funktioniert überall gleich und kostet keine Abhängigkeit.
   */
  projects: [
    {
      /* Alltag: schnell, unsichtbar, keine künstliche Verzögerung. */
      name: 'smoke',
      use: { headless: true },
    },
    {
      /* Vorführung: echtes Edge-Fenster, langsam genug zum Mitlesen. */
      name: 'live',
      use: { headless: false, launchOptions: { slowMo: 400 } },
    },
    {
      /*
       * INVOICE-MOBILE-PRINT-RENDERING-01C — Android-nahe Absicherung.
       *
       * `devices['Galaxy S24']` ist eine mitgelieferte Gerätedefinition
       * (Android 14, SM-S921U, 360×780, `isMobile`, `hasTouch`) — keine frei
       * erfundene Konfiguration. Gerendert wird trotzdem von der Chromium-
       * Engine des Desktops.
       *
       * ⚠️ Das ist **kein** Samsung-Realgerätetest. Es prüft, ob die
       * Print-Isolation unter mobilem Viewport, Touch-Kontext und mobilen
       * Media-Queries trägt — nicht, wie Chrome auf einem echten Telefon
       * druckt.
       */
      name: 'android',
      use: { ...devices['Galaxy S24'], headless: true, channel: 'msedge' },
    },
  ],

  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'msedge',
    /* Sparsam: Belege entstehen bei Fehlern, nicht bei jedem grünen Lauf. */
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    /*
     * Video ist bewusst aus: Playwright verlangt dafür ein eigenes
     * ffmpeg-Binary, das erst heruntergeladen werden müsste. Der Trace enthält
     * bereits Screenshots, DOM-Schnappschüsse und Netzwerkverkehr jedes
     * Schritts — für die Fehlersuche genügt er. Aufnahme lässt sich später mit
     * `npx playwright install ffmpeg` nachrüsten, wenn sie gebraucht wird.
     */
    video: 'off',
  },

  webServer: {
    /*
     * Der Testlauf startet seinen eigenen Server im E2E-Modus.
     *
     * `reuseExistingServer: false` ist Absicht: Ein bereits laufender
     * Alltagsserver kennt `.env.e2e` nicht. Ihn stillschweigend zu übernehmen
     * hiesse, gegen eine andere Konfiguration zu testen als angenommen — und
     * das Ergebnis wäre wertlos, ohne dass es jemand merkt.
     */
    command: `npm run dev -- --mode e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
