import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import { CLOUD_AUTH_STATE } from '../../playwright.cloud.config';

/**
 * OFFICEPILOT-LIVE-AGENT-CLOUD-TEST-01B — einmalige manuelle Anmeldung.
 *
 * Der Agent kennt weder E-Mail noch Passwort und soll sie nie kennen. Er
 * öffnet nur das Fenster, wartet auf den angemeldeten Zustand und sichert
 * danach **ausschliesslich** den Supabase-Sitzungseintrag.
 *
 * ⚠️ Warum gefiltert wird, und zwar streng:
 *
 * OfficePilot legt seinen gesamten Geschäftsbestand in denselben
 * `localStorage` — `persistenceService` speichert `AppPersistedState` unter
 * `officepilot-state:workspace:<id>` mit Kunden, Vorgängen, Rechnungen und
 * Firmenprofil. Ein ungefiltertes `storageState` wäre deshalb kein
 * Sitzungstoken, sondern ein vollständiger Datenexport im Klartext.
 *
 * Deshalb: Der rohe Zustand wird **nur im Speicher** gelesen, dort auf den
 * einen Auth-Eintrag reduziert, das Ergebnis geprüft — und erst dann
 * geschrieben. Der ungefilterte Zustand berührt die Festplatte nie.
 *
 * Werte werden an keiner Stelle ausgegeben. Geprüft und protokolliert werden
 * ausschliesslich Schlüsselnamen und Anzahlen.
 */

/** Der Präfix, unter dem OfficePilot seinen Geschäftsbestand ablegt. */
const BUSINESS_PREFIX = 'officepilot-state';

/** Supabase-Sitzung: `sb-<projectRef>-auth-token`. */
function isSupabaseAuthKey(name: string): boolean {
  return name.startsWith('sb-') && name.endsWith('-auth-token');
}

test('Auth-Setup: einmalige manuelle Anmeldung sichern', async ({ page, context }) => {
  await page.goto('/login');
  await expect(page.getByTestId('login-page')).toBeVisible();

  /* Vor dem Warten, nicht danach — sonst liest es niemand rechtzeitig. */
  console.log('');
  console.log('  ============================================================');
  console.log('  JETZT BITTE IM EDGE-FENSTER MIT DEM VORHANDENEN');
  console.log('  OFFICEPILOT-TESTACCOUNT ANMELDEN. DANACH NICHTS MEHR ANKLICKEN.');
  console.log('  ============================================================');
  console.log('');

  /*
   * Der Agent füllt nichts aus und liest keine Formularwerte. Er wartet
   * ausschliesslich auf den angemeldeten Zustand.
   */
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 180_000 });

  /* Nur im Speicher. Ohne IndexedDB — dort liegen Entwürfe und Dateiblobs. */
  const raw = await context.storageState();

  const origins = raw.origins ?? [];
  expect(origins.length, 'Unerwartet viele Ursprünge im Browser-Zustand').toBeLessThanOrEqual(1);
  const origin = origins[0];
  expect(origin, 'Kein Ursprung mit Sitzungsdaten gefunden').toBeTruthy();

  const names = (origin?.localStorage ?? []).map((entry) => entry.name);
  const authNames = names.filter(isSupabaseAuthKey);
  const businessNames = names.filter((name) => name.startsWith(BUSINESS_PREFIX));

  /* Nur Namen und Anzahlen — niemals Werte. */
  console.log(`  localStorage-Einträge gesamt: ${names.length}`);
  console.log(`  davon Geschäftsdaten (${BUSINESS_PREFIX}:*): ${businessNames.length}`);
  console.log(`  davon Supabase-Auth (sb-*-auth-token): ${authNames.length}`);

  /*
   * Sicherheits-Gate: Nur wenn genau ein Auth-Eintrag zweifelsfrei erkennbar
   * ist, wird überhaupt geschrieben. Keine Übernahme aller `sb-*`-Einträge und
   * kein Rückfall auf „dann eben alles".
   */
  expect(
    authNames.length,
    'Der Supabase-Sitzungseintrag ist nicht eindeutig identifizierbar — es wird nichts gespeichert.',
  ).toBe(1);

  const authEntry = (origin?.localStorage ?? []).find((entry) => isSupabaseAuthKey(entry.name));
  expect(authEntry, 'Sitzungseintrag fehlt').toBeTruthy();

  const filtered = {
    /*
     * Die Anmeldung läuft vollständig über `localStorage`
     * (`createClient` ohne Auth-Optionen → supabase-js-Vorgabe). Cookies
     * werden deshalb nicht mitgenommen; was nicht gebraucht wird, wird nicht
     * gespeichert.
     */
    cookies: [],
    origins: [
      {
        origin: origin!.origin,
        localStorage: [authEntry!],
      },
    ],
  };

  /* Gegenprüfung am tatsächlich zu schreibenden Objekt, nicht an der Absicht. */
  const written = filtered.origins[0].localStorage.map((entry) => entry.name);
  expect(written.filter((name) => name.startsWith(BUSINESS_PREFIX)).length).toBe(0);
  expect(written.filter(isSupabaseAuthKey).length).toBe(1);
  expect(written.length).toBe(1);
  expect(filtered.origins.length).toBe(1);
  expect(filtered.cookies.length).toBe(0);
  expect(JSON.stringify(filtered)).not.toContain('indexedDB');

  mkdirSync(dirname(CLOUD_AUTH_STATE), { recursive: true });
  writeFileSync(CLOUD_AUTH_STATE, JSON.stringify(filtered), 'utf8');

  console.log(`  Gefilterte Sitzung gespeichert: ${CLOUD_AUTH_STATE}`);
  console.log('  Inhalt wird bewusst nicht ausgegeben.');
});
