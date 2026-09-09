import { expect, test } from './support/localFachflowFixture';
import { SYNTHETIC_SUPABASE_URL } from './support/localSyntheticSupabase';

/**
 * OFFICEPILOT-LOCAL-E2E-CLOUD-BLOCK-GUARD-01B — der Guard beweist sich selbst.
 *
 * Kein Fachflow: kein Upload, kein Dokument, kein Kunde, kein Vorgang, keine
 * Rechnung, keine Zahlung. Geprüft wird ausschliesslich das Verhalten der
 * Abfangregel — mit erfundenen Aufrufen gegen einen erfundenen Host.
 *
 * Die Schreibversuche hier lösen **kein** Produktverhalten aus: Sie werden im
 * Browser direkt als `fetch` abgesetzt. Ein echter Cloud-Write kann daraus
 * schon deshalb nicht werden, weil der Zielhost unter `.invalid` liegt und die
 * Anfrage die Abfangregel nie verlässt.
 */

/** Setzt einen Aufruf ab und meldet nur, **ob** er scheiterte — nie was kam. */
async function attemptSupabaseCall(
  page: import('@playwright/test').Page,
  path: string,
  method: 'POST' | 'GET' = 'POST',
): Promise<{ rejected: boolean; status: number | null }> {
  return page.evaluate(
    async ([url, httpMethod]) => {
      try {
        const response = await fetch(url as string, {
          method: httpMethod as string,
          headers: { 'content-type': 'application/json' },
          body: httpMethod === 'GET' ? undefined : '{}',
        });
        return { rejected: false, status: response.status };
      } catch {
        /* Abgewiesen — genau das ist der erwünschte Ausgang. */
        return { rejected: true, status: null };
      }
    },
    [`${SYNTHETIC_SUPABASE_URL}${path}`, method] as const,
  );
}

test('Guard: der Bootstrap läuft ohne einen einzigen Schreibversuch', async ({ page, guard }) => {
  await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible();

  expect(guard.forbiddenWrites).toEqual([]);
  expect(guard.unexpected).toEqual([]);

  /*
   * Der eigentliche Befund dieses Falls: Der gesamte Auth- und
   * Workspace-Bootstrap kommt mit **einer** schreibfähigen Ausnahme aus.
   */
  expect(guard.bootstrapExceptionCount).toBe(1);

  /* Die automatische Zusicherung im Teardown prüft dasselbe noch einmal. */
});

test('Guard: ein bekannter Cloud-Write wird blockiert, nicht bestätigt', async ({
  page,
  guard,
}) => {
  await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible();

  const forbidden = '/rest/v1/rpc/upsert_workspace_sync_entity';
  const result = await attemptSupabaseCall(page, forbidden);

  /* Kein erfundenes „gespeichert": Der Aufruf scheitert, statt zu gelingen. */
  expect(result.rejected, 'Der gesperrte Write hat eine Antwort erhalten').toBe(true);
  expect(result.status).toBeNull();

  expect(guard.forbiddenWrites).toEqual([forbidden]);
  expect(guard.answered).not.toContain(forbidden);

  /*
   * Ohne die folgende Quittung würde die automatische Zusicherung diesen Test
   * rot machen — das ist der Nachweis, dass sie wirkt. Quittiert wird genau
   * ein namentlich genannter, tatsächlich erfasster Eintrag; „alles leeren"
   * gibt es nicht, und ein Guard-Schalter erst recht nicht.
   */
  guard.acknowledgeExpectedGuardEvent(forbidden);
  expect(guard.forbiddenWrites).toEqual([]);
});

test('Guard: ein unbekannter RPC bekommt keine Erfolgsantwort', async ({ page, guard }) => {
  await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible();

  const unknown = '/rest/v1/rpc/officepilot_unknown_e2e_probe';
  const result = await attemptSupabaseCall(page, unknown);

  expect(result.rejected).toBe(true);
  expect(guard.unexpected).toEqual([unknown]);
  expect(guard.answered).not.toContain(unknown);

  guard.acknowledgeExpectedGuardEvent(unknown);
});

test('Guard: die Bootstrap-Ausnahme gilt genau einmal je Kontext', async ({ page, guard }) => {
  await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible();

  /* Erster Aufruf: durch den Bootstrap bereits verbraucht. */
  const bootstrapPath = '/rest/v1/rpc/ensure_personal_workspace';
  expect(guard.bootstrapExceptionCount).toBe(1);
  expect(guard.answered).toContain(bootstrapPath);

  /* Zweiter Aufruf im selben Kontext: kein Bootstrap mehr, also ein Write. */
  const result = await attemptSupabaseCall(page, bootstrapPath);

  expect(result.rejected).toBe(true);
  expect(guard.bootstrapExceptionCount).toBe(1);
  expect(guard.forbiddenWrites).toEqual([bootstrapPath]);

  guard.acknowledgeExpectedGuardEvent(bootstrapPath);
});

test('Guard: ein Storage-Upload wird als Schreibversuch erkannt', async ({ page, guard }) => {
  await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible();

  /* Der Branding-Upload — der einzige Nicht-RPC-Schreibweg im Produktivcode. */
  const storagePath = '/storage/v1/object/branding-assets/synthetic-probe';
  const result = await attemptSupabaseCall(page, storagePath);

  expect(result.rejected).toBe(true);
  expect(guard.forbiddenWrites).toEqual([storagePath]);

  guard.acknowledgeExpectedGuardEvent(storagePath);
});

test('Guard: eine Quittung ohne erfassten Eintrag schlägt fehl', async ({ page, guard }) => {
  await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-shell')).toBeVisible();

  /*
   * Die Quittung ist die einzige Stelle, an der ein Test einen Guard-Eintrag
   * entfernen kann. Sie darf deshalb nichts entfernen, was nicht wirklich
   * passiert ist — sonst wäre sie doch ein Schalter.
   */
  expect(() =>
    guard.acknowledgeExpectedGuardEvent('/rest/v1/rpc/niemals_passiert'),
  ).toThrow();
});
