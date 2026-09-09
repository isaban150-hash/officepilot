import { expect, test as localFachflowTest } from './localFachflowFixture';
import { loadTestWorldOperatorCompany } from './localTestWorldCompany';

/**
 * OFFICEPILOT-LOCAL-E2E-TESTWORLD-COMPANY-ALIGNMENT-01B — der Einstieg für
 * Fachtests mit Dokumenten aus der Testwelt.
 *
 * Identisch zur allgemeinen Fixture in **allem**, was Sicherheit ausmacht:
 * derselbe frische Kontext, dieselbe synthetische Sitzung, derselbe
 * fail-closed Cloud-Guard, derselbe automatische Teardown, dieselbe Sperre für
 * Service Worker. Nichts davon wird hier kopiert — es wird geerbt.
 *
 * Der einzige Unterschied ist die Antwort auf eine einzige Frage: **Wer
 * betreibt diesen Workspace?** Für Gold-Dokumente ist das die Betreiberfirma
 * der Testwelt. Läuft der Workspace unter einer anderen Identität, hält
 * OfficePilot deren Dokumente zu Recht für nicht betriebsrelevant.
 *
 * ⚠️ Das ist Stammdatenpflege, kein vorgeseedetes Ergebnis. Relevanz,
 * Klassifikation, Extraktion, Kunde und Vorgang entstehen unverändert im
 * Produktivcode aus echtem Dokumenttext.
 *
 * Auth-Probe und Cloud-Guard benutzen weiterhin die neutrale Fixture — sie
 * prüfen Infrastruktur und sollen keine fachliche Identität tragen.
 */
export const test = localFachflowTest.extend({
  /* Überschreibt genau eine Fixture der Basis — sonst ändert sich nichts. */
  operatorCompany: async ({}, use) => {
    await use(loadTestWorldOperatorCompany());
  },
});

export { expect };
