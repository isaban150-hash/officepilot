import { expect, test } from '@playwright/test';

/**
 * OFFICEPILOT-LIVE-AGENT-TEST-HARNESS-01B — der erste sichtbare Browserlauf.
 *
 * Dieser Pilot prüft **das Harness**, nicht die Fachlogik. Bewiesen werden soll
 * nur: Vite startet im E2E-Modus, Microsoft Edge lässt sich steuern,
 * OfficePilot lädt, das Routing arbeitet, die `data-testid` greifen, und ein
 * Beleg entsteht.
 *
 * ⚠️ Was er bewusst **nicht** tut, und warum:
 *
 * Die Anmeldung läuft ausschliesslich über Supabase
 * (`AuthContext` → `signInWithPassword`). Der Beta-Testmodus überspringt nur
 * den Einrichtungsassistenten — er meldet **niemanden** an. Ohne konfigurierte
 * Supabase-Instanz ist `isAuthenticated` falsch, und `App.tsx` zeigt
 * konsequent die öffentlichen Routen.
 *
 * Der Rechnungsbereich ist damit ohne echtes Konto nicht erreichbar. Diesen
 * Block auf Zugangsdaten oder eine Produktivänderung auszuweiten war
 * ausdrücklich nicht gewollt — deshalb endet der Pilot dort, wo die Anmeldung
 * beginnt. Alles Weitere gehört in den Cloud-Block.
 *
 * Ausschliesslich synthetischer Betrieb: keine Zugangsdaten, keine Cloud,
 * keine echten Kundendaten.
 */
test('Pilot: OfficePilot lädt, routet und zeigt die Anmeldung', async ({ page }, testInfo) => {
  await test.step('Anwendung öffnen', async () => {
    await page.goto('/');
    // Kein festes Warten: Playwright wartet auf den fachlichen Zustand.
    await expect(page.getByTestId('login-page')).toBeVisible();
  });

  await test.step('Die Anmeldemaske ist vollständig', async () => {
    await expect(page.getByTestId('login-email')).toBeVisible();
    await expect(page.getByTestId('login-password')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeVisible();
  });

  await test.step('Eine Eingabe kommt tatsächlich an', async () => {
    /*
     * Sichtbarer Beweis, dass der Agent wirklich tippt — mit einer offenkundig
     * synthetischen Adresse. Es wird **nicht** abgeschickt: Dieser Block führt
     * keine Anmeldung durch.
     */
    const email = page.getByTestId('login-email');
    await email.fill('pilot@example.invalid');
    await expect(email).toHaveValue('pilot@example.invalid');
  });

  await test.step('Client-Routing wechselt die Seite', async () => {
    await page.getByTestId('legal-link-impressum').click();
    await expect(page).toHaveURL(/\/impressum$/);
    await expect(page.getByTestId('legal-draft-notice')).toBeVisible();
  });

  await test.step('Die Zugriffsgrenze hält', async () => {
    /*
     * Ohne Anmeldung führt jede geschützte Route zurück zur Anmeldung. Das ist
     * hier kein Umweg, sondern die Zusicherung selbst.
     */
    await page.goto('/vorgaenge');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('login-page')).toBeVisible();
  });

  await test.step('Beleg sichern', async () => {
    const screenshot = await page.screenshot({ fullPage: true });
    await testInfo.attach('pilot-login', { body: screenshot, contentType: 'image/png' });
  });
});
