import { test as base, expect, type Page } from '@playwright/test';
import {
  installSyntheticSupabase,
  seedSyntheticSession,
  type SyntheticSupabaseTracker,
} from './localSyntheticSupabase';
import type { WorkspaceCompanyIdentity } from './localTestWorldCompany';

/**
 * OFFICEPILOT-LOCAL-E2E-CLOUD-BLOCK-GUARD-01B — der verbindliche Einstieg für
 * alle lokalen Fachtests.
 *
 * Der Guard aus `localSyntheticSupabase` schützt nur, wo er installiert ist.
 * Ein Spec, der sich seinen Kontext selbst baut und den Aufruf vergisst, hätte
 * keinen Schutz — und man sähe es ihm nicht an. Deshalb liegt die Installation
 * nicht mehr beim Testautor, sondern in der Fixture: **`context` und `page`
 * sind beide überschrieben**, sodass selbst ein Test, der nur `{ page }`
 * anfordert, zwangsläufig im geschützten Kontext läuft.
 *
 * Lokale Fachtests importieren `test` und `expect` ausschliesslich von hier,
 * nie direkt aus `@playwright/test`.
 */

export interface LocalFachflowFixtures {
  /**
   * COMPANY-ALIGNMENT-01B — wer den Testworkspace betreibt.
   *
   * Standard ist `undefined`: Die generische Infrastruktur bleibt neutral, und
   * Auth-Probe wie Cloud-Guard laufen ohne jede fachliche Firmenidentität.
   * Nur Testwelt-Fachflows überschreiben diese Fixture — siehe
   * `localTestWorldFachflowFixture`.
   */
  operatorCompany: WorkspaceCompanyIdentity | undefined;
  /** Der Guard-Zustand des laufenden Tests — nur Pfade, Hostnamen, Anzahlen. */
  guard: SyntheticSupabaseTracker;
  /**
   * Läuft nach jedem Test von selbst (`auto`) und braucht nicht angefordert zu
   * werden. Genau darin liegt der Wert: Vergessen ist nicht möglich.
   */
  guardAssertion: void;
}

export const test = base.extend<LocalFachflowFixtures>({
  /*
   * Eigener Kontext statt des eingebauten: kein `storageState`, keine Cookies,
   * leeres localStorage, leeres IndexedDB. Service Worker sind blockiert, weil
   * sie Anfragen an der Abfangregel vorbeiführen könnten.
   */
  context: async ({ browser }, use) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await use(context);
    await context.close();
  },

  /* Neutral, solange niemand sie überschreibt. */
  operatorCompany: undefined,

  guard: async ({ context, operatorCompany }, use) => {
    const tracker = await installSyntheticSupabase(context, { operatorCompany });
    await seedSyntheticSession(context);
    await use(tracker);
  },

  /*
   * `page` hängt an `guard`, nicht umgekehrt: So sind Abfangregel und Sitzung
   * garantiert installiert, bevor die erste Seite überhaupt existiert.
   */
  page: async ({ context, guard }, use) => {
    void guard;
    const page: Page = await context.newPage();
    await use(page);
  },

  guardAssertion: [
    async ({ guard }, use, testInfo) => {
      await use();

      /*
       * Nach dem Test, nicht davor — und ausdrücklich auch dann, wenn der Test
       * bereits aus anderem Grund gescheitert ist. Sonst verdeckte der erste
       * Fehler den zweiten, und ein blockierter Cloud-Write bliebe unbemerkt.
       *
       * `route.abort()` allein macht nämlich nichts rot: Die Anwendung fängt
       * Netzwerkfehler ab, ein Sync-Push landet in einer Warteschlange. Ohne
       * diese Zusicherung wäre der Guard eine Attrappe.
       */
      const problems: string[] = [];
      if (guard.forbiddenWrites.length > 0) {
        problems.push(`gesperrte Cloud-Writes: ${guard.forbiddenWrites.join(', ')}`);
      }
      if (guard.unexpected.length > 0) {
        problems.push(`unbekannte Supabase-Aufrufe: ${guard.unexpected.join(', ')}`);
      }

      /*
       * `blockedExternal` steht bewusst nicht in dieser Liste: Die Anwendung
       * lädt Schriften von Google. Das ist reine Darstellung, wurde abgewiesen
       * und ist kein Fehlschlag — es gehört nicht in dieselbe Klasse wie ein
       * versuchter Geschäfts-Write.
       */
      if (problems.length === 0) return;

      const message = `Cloud-Block-Guard hat eingegriffen — ${problems.join(' | ')}`;

      if (testInfo.status === 'failed' || testInfo.status === 'timedOut') {
        /*
         * Den ursprünglichen Fehler nicht verschlucken: Der Guard-Befund tritt
         * daneben, nicht an seine Stelle.
         */
        testInfo.errors.push({ message });
        return;
      }

      throw new Error(message);
    },
    { auto: true },
  ],
});

export { expect };
