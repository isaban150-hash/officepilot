import { expect, test } from '@playwright/test';
import {
  installSyntheticSupabase,
  seedSyntheticSession,
  SYNTHETIC_SUPABASE_HOST,
} from './support/localSyntheticSupabase';

/**
 * OFFICEPILOT-LOCAL-E2E-SYNTHETIC-AUTH-PROBE-01B — kommt die Anwendung lokal
 * hinter die Anmeldegrenze?
 *
 * Nur diese eine Frage. Kein Fachflow: kein Upload, kein Dokument, kein Kunde,
 * kein Vorgang, keine Rechnung, keine Zahlung. Der einzige fachliche
 * Seitenaufruf ist `/vorgaenge` — und der dient allein dem Beweis, dass eine
 * geschützte Route trägt und der Bestand leer ist.
 *
 * Ein grünes Ergebnis zählt nur, wenn **beides** gilt: echter AppShell ohne
 * echte Supabase-Sitzung, und ein eindeutig workspace-gebundener lokaler
 * Zustand. Ein AppShell im guest-Scope wäre kein Erfolg, sondern ein
 * irreführender.
 */

test('Probe: lokaler Boot bis zum echten AppShell ohne echte Cloud', async ({ browser }) => {
  /* Frischer Kontext: leeres localStorage, leeres IndexedDB, keine Cookies. */
  const context = await browser.newContext();

  try {
    const tracker = await installSyntheticSupabase(context);
    await seedSyntheticSession(context);

    const page = await context.newPage();

    await test.step('Geschützte Route direkt öffnen', async () => {
      await page.goto('/vorgaenge', { waitUntil: 'domcontentloaded' });

      /*
       * Zuerst der Gegenbeweis: Erscheint die Anmeldemaske, ist die
       * synthetische Sitzung nicht getragen worden — und jede weitere
       * Zusicherung wäre bedeutungslos.
       */
      await expect(
        page.getByTestId('login-page'),
        'Die synthetische Sitzung wurde nicht angenommen — die Anmeldemaske ist aktiv.',
      ).toHaveCount(0);

      await expect(page.getByTestId('app-shell')).toBeVisible();
    });

    await test.step('Keine Umleitung auf die Anmeldung', async () => {
      /* Nur ein Wahrheitswert — dieselbe Zurückhaltung wie im Cloud-Pfad. */
      const onVorgaenge = await page.evaluate(
        () => window.location.pathname === '/vorgaenge',
      );
      expect(onVorgaenge).toBe(true);
    });

    await test.step('Der Bestand ist leer', async () => {
      await expect(page.getByTestId('vorgaenge-empty-state')).toBeVisible();
    });

    await test.step('Der lokale Zustand ist eindeutig workspace-gebunden', async () => {
      const scope = await page.evaluate((prefix) => {
        const names: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const name = window.localStorage.key(index);
          if (name !== null) names.push(name);
        }
        return {
          workspaceKeys: names.filter((n) => n.startsWith(`${prefix}:workspace:`)).length,
          userKeys: names.filter((n) => n.startsWith(`${prefix}:user:`)).length,
          guestKeys: names.filter((n) => n === `${prefix}:guest`).length,
        };
      }, 'officepilot-state');

      /* Nur Zahlen. Keine Kennung, kein gespeicherter Wert. */
      console.log(`  workspace-Scope: ${scope.workspaceKeys}`);
      console.log(`  user-Scope: ${scope.userKeys}`);
      console.log(`  guest-Scope: ${scope.guestKeys}`);

      expect(scope.workspaceKeys).toBe(1);
      expect(scope.userKeys).toBe(0);
      expect(scope.guestKeys).toBe(0);
    });

    await test.step('Es wurde keine fremde Gegenstelle erreicht', async () => {
      /* Pfadnamen des erfundenen Hosts sind unbedenklich und aufschlussreich. */
      console.log(
        `  synthetisch beantwortet: ${[...new Set(tracker.answered)].sort().join(', ')}`,
      );
      console.log(`  synthetischer Host: ${SYNTHETIC_SUPABASE_HOST}`);

      expect(
        tracker.unexpected,
        'Ein Supabase-Aufruf ohne Antwortregel wurde blockiert — die Probe deckt ihn nicht ab.',
      ).toEqual([]);

      /*
       * 01B2 — zugleich der Beweis, dass der Bootstrap ohne Sync-Push auskommt.
       * Ein gesperrter Schreibversuch wird abgewiesen und darf nicht folgenlos
       * bleiben; sonst wäre die Sperre nur eine Behauptung.
       */
      expect(
        tracker.forbiddenWrites,
        'Es wurde ein gesperrter Cloud-Schreibaufruf versucht.',
      ).toEqual([]);
      /*
       * Fremde Hosts in dieser Liste sind kein Fehler, sondern der Beleg, dass
       * die Blockade greift: Die Anwendung lädt etwa Schriften von Google, und
       * genau dieser Verkehr wurde abgewiesen statt durchgelassen.
       *
       * Entscheidend ist die schärfere Aussage — unter den Versuchen war kein
       * einziger Supabase-Host. Wäre die synthetische Adresse nicht angekommen
       * und die echte stattdessen benutzt worden, stünde sie hier.
       */
      console.log(
        `  abgewiesene Fremd-Hosts: ${tracker.blockedHosts.length}`,
      );
      expect(
        tracker.blockedHosts.filter((host) => host.includes('supabase')),
        'Es wurde eine echte Supabase-Gegenstelle angesprochen.',
      ).toEqual([]);

      /* Ohne beantwortete Aufrufe wäre der Beweis leer — dann trüge etwas anderes. */
      expect(tracker.answered.length).toBeGreaterThan(0);
    });
  } finally {
    /* Wegwerfbar: Mit dem Kontext verschwindet der gesamte lokale Zustand. */
    await context.close();
  }
});
