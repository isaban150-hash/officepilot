import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CLOUD_AUTH_STATE } from '../../playwright.cloud.config';
import {
  assertCloudWriteAllowed,
  CLOUD_WRITE_AUTHORIZATION_FILE,
  enforceCloudWriteVerdict,
  evaluateCloudWriteGate,
  GATE_MESSAGES,
  readCloudScopeSnapshot,
  readCloudWriteAuthorization,
  validateAuthorizationShape,
  type CloudScopeSnapshot,
} from './support/cloudWriteGate';

/**
 * OFFICEPILOT-E2E-CLOUD-WRITE-GATE-01B — Nachweis des Gates.
 *
 * Dieser Test schreibt **keine** fachlichen Cloud-Daten: kein Vorgang, kein
 * Kunde, keine Rechnung, kein Dokument, keine Zahlung, keine Statusänderung.
 * Er belegt ausschliesslich, dass das Gate in der echten Sitzung öffnet — und
 * dass es in erfundenen Fehllagen schliesst.
 *
 * Ein grünes Ergebnis bedeutet allein: „Diese Sitzung steht im ausdrücklich
 * lokal autorisierten E2E-Testworkspace." Es bedeutet nicht, dass ein Write
 * erlaubt ist; jeder fachliche Cloud-Write braucht weiterhin einen eigenen
 * Auftrag.
 */

const SETUP_HINT =
  'Die lokale OfficePilot-Testsitzung fehlt. Bitte zuerst `npm run test:e2e:auth` ausführen und sich einmal manuell anmelden.';

const AUTHORIZATION_HINT =
  'Keine lokale Schreib-Autorisierung vorhanden. Bitte einmalig `npm run test:e2e:authorize-write-workspace` ausführen.';

test.beforeAll(() => {
  expect(existsSync(CLOUD_AUTH_STATE), SETUP_HINT).toBe(true);
  expect(existsSync(CLOUD_WRITE_AUTHORIZATION_FILE), AUTHORIZATION_HINT).toBe(true);
});

test('Gate: die aktuelle Sitzung steht im autorisierten E2E-Schreibworkspace', async ({ page }) => {
  await test.step('Angemeldete Anwendung öffnen', async () => {
    await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-shell')).toBeVisible();
  });

  await test.step('Scope ist eindeutig', async () => {
    const scope = await readCloudScopeSnapshot(page);

    /* Nur Zahlen — kein Fingerprint, keine Kennung. */
    console.log(`  Anzahl workspace-Scope: ${scope.workspaceKeys}`);
    console.log(`  user-Scope: ${scope.userKeys}`);
    console.log(`  guest-Scope: ${scope.guestKeys}`);
    console.log(`  Auth-Key-Anzahl: ${scope.authKeys}`);

    expect(scope.workspaceKeys).toBe(1);
    expect(scope.userKeys).toBe(0);
    expect(scope.guestKeys).toBe(0);
    expect(scope.authKeys).toBe(1);
  });

  await test.step('Autorisierungsdatei ist strukturell gültig', async () => {
    /* Geprüft wird die Struktur; der Inhalt wird nirgends ausgegeben. */
    const shape = validateAuthorizationShape(readCloudWriteAuthorization());
    expect(shape.ok, AUTHORIZATION_HINT).toBe(true);
  });

  await test.step('Gate öffnet', async () => {
    await assertCloudWriteAllowed(page);
  });

  /* Hier endet der Block bewusst. Keine fachliche Aktion folgt. */
});

/*
 * Fail-closed, synthetisch geprüft.
 *
 * Die Fehllagen werden mit erfundenen Werten gegen die reine
 * Entscheidungslogik gefahren. Die echte Autorisierungsdatei wird dabei weder
 * gelesen noch verändert — ein Negativtest, der sie manipulieren müsste, wäre
 * selbst die Gefahr, gegen die er schützen soll.
 */
test.describe('Gate: fail-closed', () => {
  const AUTHORIZED = `sha256:${'a'.repeat(64)}`;
  const OTHER = `sha256:${'b'.repeat(64)}`;

  const okScope: CloudScopeSnapshot = {
    workspaceKeys: 1,
    userKeys: 0,
    guestKeys: 0,
    authKeys: 1,
    workspaceFingerprint: AUTHORIZED,
    cryptoAvailable: true,
  };

  const authorization = { schemaVersion: 1, workspaceFingerprint: AUTHORIZED };

  function expectBlocked(verdict: ReturnType<typeof evaluateCloudWriteGate>, reason: string) {
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false ? verdict.reason : '').toBe(reason);
  }

  test('Referenzlage öffnet — sonst bewiese kein Negativfall etwas', () => {
    expect(evaluateCloudWriteGate({ scope: okScope, authorization }).allowed).toBe(true);
  });

  test('Fingerprint-Mismatch blockiert', () => {
    expectBlocked(
      evaluateCloudWriteGate({
        scope: { ...okScope, workspaceFingerprint: OTHER },
        authorization,
      }),
      GATE_MESSAGES.mismatch,
    );
  });

  test('fehlende Autorisierung blockiert', () => {
    expectBlocked(
      evaluateCloudWriteGate({ scope: okScope, authorization: null }),
      GATE_MESSAGES.missingAuthorization,
    );
  });

  test('falsche schemaVersion blockiert', () => {
    expectBlocked(
      evaluateCloudWriteGate({
        scope: okScope,
        authorization: { schemaVersion: 2, workspaceFingerprint: AUTHORIZED },
      }),
      GATE_MESSAGES.schemaVersion,
    );
  });

  test('ungültiges Fingerprint-Format in der Datei blockiert', () => {
    expectBlocked(
      evaluateCloudWriteGate({
        scope: okScope,
        authorization: { schemaVersion: 1, workspaceFingerprint: 'sha256:kurz' },
      }),
      GATE_MESSAGES.fingerprintFormat,
    );
  });

  test('unbekannter Schlüssel in der Datei blockiert', () => {
    /* Die Datei darf nicht zum stillen Ablageort für Kennungen werden. */
    expectBlocked(
      evaluateCloudWriteGate({
        scope: okScope,
        authorization: { ...authorization, workspaceId: 'egal' },
      }),
      GATE_MESSAGES.malformedAuthorization,
    );
  });

  test('user-Scope blockiert', () => {
    expectBlocked(
      evaluateCloudWriteGate({ scope: { ...okScope, userKeys: 1 }, authorization }),
      GATE_MESSAGES.scope,
    );
  });

  test('guest-Scope blockiert', () => {
    expectBlocked(
      evaluateCloudWriteGate({ scope: { ...okScope, guestKeys: 1 }, authorization }),
      GATE_MESSAGES.scope,
    );
  });

  test('mehrere Workspace-Keys blockieren', () => {
    expectBlocked(
      evaluateCloudWriteGate({ scope: { ...okScope, workspaceKeys: 2 }, authorization }),
      GATE_MESSAGES.scope,
    );
  });

  test('kein Workspace-Key blockiert', () => {
    expectBlocked(
      evaluateCloudWriteGate({
        scope: { ...okScope, workspaceKeys: 0, workspaceFingerprint: null },
        authorization,
      }),
      GATE_MESSAGES.scope,
    );
  });

  test('fehlender oder mehrfacher Auth-Key blockiert', () => {
    expectBlocked(
      evaluateCloudWriteGate({ scope: { ...okScope, authKeys: 0 }, authorization }),
      GATE_MESSAGES.scope,
    );
    expectBlocked(
      evaluateCloudWriteGate({ scope: { ...okScope, authKeys: 2 }, authorization }),
      GATE_MESSAGES.scope,
    );
  });

  test('fehlendes Web Crypto blockiert', () => {
    expectBlocked(
      evaluateCloudWriteGate({
        scope: { ...okScope, cryptoAvailable: false },
        authorization,
      }),
      GATE_MESSAGES.crypto,
    );
  });

  /*
   * WRITE-GATE-01B2 — der Fehlerpfad muss die Seite abräumen.
   *
   * Playwright hängt an jeden roten Test einen `error-context.md` mit einem
   * Abbild der Seite, unabhängig von `trace/screenshot/video: 'off'`. Blockiert
   * das Gate auf der geladenen Anwendung, stünde dort der Geschäftsbestand.
   *
   * Geprüft wird mit **erfundenem** Seiteninhalt und erfundenen Fingerprints —
   * die echte Anwendung wird nicht geladen, die echte Autorisierungsdatei nicht
   * angefasst.
   */
  test('Fingerprint-Mismatch räumt die Seite ab, bevor der Fehler nach aussen geht', async ({
    page,
  }) => {
    const DUMMY_MARKER = 'SYNTHETISCHER-PLATZHALTER-KEIN-ECHTER-INHALT';
    await page.setContent(`<main data-testid="dummy-business-dom">${DUMMY_MARKER}</main>`);
    expect(await page.locator('[data-testid="dummy-business-dom"]').count()).toBe(1);

    const verdict = evaluateCloudWriteGate({
      scope: { ...okScope, workspaceFingerprint: OTHER },
      authorization,
    });
    expect(verdict.allowed).toBe(false);

    /* Der Fehler muss kommen — abgeräumt, aber nicht verschluckt. */
    await expect(enforceCloudWriteVerdict(page, verdict)).rejects.toThrow(GATE_MESSAGES.mismatch);

    expect(
      await page.locator('[data-testid="dummy-business-dom"]').count(),
      'Der synthetische Seiteninhalt steht nach dem Gate-Fehler noch im DOM',
    ).toBe(0);
    expect(await page.content()).not.toContain(DUMMY_MARKER);
  });

  test('erfolgreiches Gate räumt die Seite NICHT ab', async ({ page }) => {
    /* Ein späterer Write-Test arbeitet nach der Freigabe auf genau dieser Seite weiter. */
    const DUMMY_MARKER = 'SYNTHETISCHER-PLATZHALTER-BLEIBT';
    await page.setContent(`<main data-testid="dummy-keep">${DUMMY_MARKER}</main>`);

    await enforceCloudWriteVerdict(page, evaluateCloudWriteGate({ scope: okScope, authorization }));

    expect(await page.locator('[data-testid="dummy-keep"]').count()).toBe(1);
  });
});
