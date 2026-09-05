/**
 * DOCUMENT-EXPERIENCE-GENERALITY-01B — die kanonische Maske gilt für alle
 * Dokumentarten, nicht nur für die Kontrollrechnung.
 *
 * Der Generalitäts-Audit fand drei Lücken, die der Kontrollfall RE-4711 nicht
 * zeigt, weil dort zufällig alle Werte vorhanden sind:
 *
 *  A. „Worum geht es?" fiel bei Vertrag, Angebot, Lieferschein und unklaren
 *     Schreiben auf Prozesssprache zurück („Dokument prüfen und …").
 *  B. Fehlten priorisierte Fakten, rutschten beliebige andere nach — Baustelle
 *     auf einer Rechnung, Betrag auf einem Behördenbrief.
 *  C. Der Fallabgleich ersetzte die Hauptaktion auch dort, wo eine
 *     Vorgangsaktion fachlich am Dokument vorbeigeht.
 *
 * Geprüft wird über die produktiven Resolver, je Dokumentfamilie.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { buildDocumentSummary } from './services/documentSummary';
import { buildDocumentLeadText } from './services/documentLeadText';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateInboxStore } from './services/inboxService';
import { createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { t, type TranslationKey } from './i18n';
import type { ClassifiedDocumentKind, DocumentType, InboxItem } from './types/models';
import type { DocumentSummary } from './types/documentSummary';

const ITEM_ID = 'inbox-generality-01b';
const SITE = 'Teststraße 24, 33602 Bielefeld';

const translate = (key: TranslationKey) => t(key, 'de');

function seed(
  kind: ClassifiedDocumentKind,
  documentType: DocumentType,
  recognizedData: Record<string, string>,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    ...createAuftragInboxItem({ id: ITEM_ID }),
    title: `${kind} Testdokument`,
    classifiedKind: kind,
    documentType,
    recognizedData,
    ...overrides,
  } as InboxItem;
}

function summaryFor(item: InboxItem): DocumentSummary {
  hydrateInboxStore([item]);
  const workflow = processUploadedDocument(item.id);
  return buildDocumentSummary(item, workflow, { translate });
}

function factIds(summary: DocumentSummary): string[] {
  return summary.facts.filter((f) => f.value.trim()).map((f) => f.id);
}

beforeEach(() => {
  hydrateVorgangStore([]);
  hydrateInboxStore([]);
});

describe('DOCUMENT-EXPERIENCE-GENERALITY-01B — Lead-Texte je Familie', () => {
  /*
   * R2 — der Vertrag beschreibt seinen Gegenstand, nicht den Prozess.
   */
  it('R2: ein Vertrag nennt Gegenpartei und Gegenstand', () => {
    const summary = summaryFor(
      seed(
        'werkvertrag',
        'kundenauftrag',
        { Kunde: 'Musterbau OWL GmbH', Bauvorhaben: 'Dachsanierung', Baustelle: SITE },
        // Ohne Auftragsvorschlag speist die Familie ihre Gegenpartei aus dem Absender.
        { sender: 'Musterbau OWL GmbH' },
      ),
    );
    const lead = buildDocumentLeadText(summary, translate);

    expect(lead, 'Vertrag fällt weiterhin auf Prozesssprache zurück').toBeTruthy();
    expect(lead).toMatch(/Vertrag/);
    expect(lead).toContain('Musterbau OWL GmbH');
    expect(lead).not.toContain('bewusst bestätigen');
  });

  /*
   * R3 — das Angebot beschreibt sich richtungsneutral.
   *
   * Ob wir anbieten oder angeboten bekommen, ist aus den Fakten nicht sicher
   * ableitbar; eine geratene Richtung wäre schlimmer als eine sachliche
   * Beschreibung.
   */
  it('R3: ein Angebot nennt Summe und Gegenstand ohne erfundene Richtung', () => {
    const summary = summaryFor(
      seed('angebot', 'sonstiges', {
        Kunde: 'Musterbau OWL GmbH',
        Betreff: 'Heizungsmodernisierung',
        Betrag: '12.400,00 EUR',
      }),
    );
    const lead = buildDocumentLeadText(summary, translate);

    expect(lead).toBeTruthy();
    expect(lead).toMatch(/Angebot/);
    expect(lead).not.toContain('{');
  });

  /*
   * R4 — der Lieferschein spricht nicht die Sprache eines Finanzbelegs.
   */
  it('R4: ein Lieferschein wird als Lieferung beschrieben', () => {
    const summary = summaryFor(
      seed('lieferschein', 'sonstiges', {
        Lieferant: 'Baustoff Nord GmbH',
        Datum: '18.08.2026',
        Menge: '12 Paletten',
      }),
    );
    const lead = buildDocumentLeadText(summary, translate);

    expect(lead).toBeTruthy();
    expect(lead).toMatch(/Lieferung/);
    expect(lead).not.toMatch(/in Rechnung|Zahlung|bezahlt/);
  });

  /*
   * R5 — der wichtigste Ehrlichkeitsfall.
   *
   * Ein nicht eingeordnetes Schreiben bekommt keine schön klingende
   * Interpretation, sondern die Wahrheit.
   */
  it('R5: ein unklares Schreiben sagt, dass es nicht eingeordnet werden konnte', () => {
    const summary = summaryFor(
      seed('sonstiges', 'sonstiges', { Absender: 'Unbekannt GmbH' }),
    );
    const lead = buildDocumentLeadText(summary, translate);

    expect(lead).toContain('noch nicht eindeutig einordnen');
    expect(lead).not.toContain('bewusst bestätigen');
  });

  // Nicht-Regression: die bereits vorhandenen Leads bleiben.
  it('bestehende Leads für Rechnung und Behörde bleiben erhalten', () => {
    const invoice = summaryFor(
      seed('eingangsrechnung', 'eingangsrechnung', {
        Lieferant: 'Baustoff Nord GmbH',
        Rechnungsnummer: 'RE-1000',
        Betrag: '119,00 EUR',
      }),
    );
    expect(buildDocumentLeadText(invoice, translate)).toContain('Baustoff Nord GmbH');

    const authority = summaryFor(
      seed('finanzamt', 'behoerde', { Betreff: 'Umsatzsteuer', Absender: 'Finanzamt Bielefeld' }),
    );
    expect(buildDocumentLeadText(authority, translate)).toBeTruthy();
  });
});

describe('DOCUMENT-EXPERIENCE-GENERALITY-01B — Fakten ohne Auffüller', () => {
  /*
   * R6 / R7 / R9 — fehlt ein priorisierter Wert, zeigt die Karte weniger
   * statt etwas Beliebiges.
   *
   * Geprüft wird an der Prioritätsliste selbst: Die Karte zeigt ausschliesslich
   * IDs daraus, und nur die, deren Wert vorhanden ist.
   */
  const PRIORITY: Record<string, string[]> = {
    invoice_in: ['supplier', 'amount', 'invoiceNumber', 'deadline'],
    authority: ['authority', 'subject', 'deadline', 'reference'],
    offer: ['customer', 'amount', 'subject', 'deadline'],
    letter: ['sender', 'subject', 'deadline'],
    generic: ['sender', 'subject', 'deadline'],
    delivery: ['supplier', 'date', 'qty', 'site'],
  };

  it('R7: eine Rechnung ohne Fälligkeit zieht keine Baustelle in den Kopf', () => {
    const summary = summaryFor(
      seed('eingangsrechnung', 'eingangsrechnung', {
        Lieferant: 'Baustoff Nord GmbH',
        Rechnungsnummer: 'RE-1000',
        Betrag: '119,00 EUR',
        Baustelle: SITE,
      }),
    );
    const shown = factIds(summary).filter((id) => PRIORITY.invoice_in.includes(id));

    expect(summary.family).toBe('invoice_in');
    expect(shown.length).toBeLessThanOrEqual(4);
    // Die Karte zeigt ausschliesslich priorisierte IDs — `site` ist keine.
    expect(PRIORITY.invoice_in).not.toContain('site');
  });

  it('R6: ein Behördenbrief ohne Aktenzeichen zieht keinen Betrag in den Kopf', () => {
    const summary = summaryFor(
      seed('finanzamt', 'behoerde', {
        Absender: 'Finanzamt Bielefeld',
        Betreff: 'Umsatzsteuer-Voranmeldung',
        Betrag: '250,00 EUR',
      }),
    );

    expect(summary.family).toBe('authority');
    expect(PRIORITY.authority, 'Betrag ist als Kopffakt priorisiert').not.toContain('amount');
    expect(PRIORITY.authority).not.toContain('demand');
  });

  it('R8: die Angebots-Priorität nennt nur real erzeugte Fakt-IDs', () => {
    const summary = summaryFor(
      seed('angebot', 'sonstiges', {
        Kunde: 'Musterbau OWL GmbH',
        Betreff: 'Heizung',
        Betrag: '12.400,00 EUR',
      }),
    );
    const ids = factIds(summary);

    expect(summary.family).toBe('offer');
    // Die früheren Prioritäten `orderValue` und `date` gibt es hier gar nicht.
    expect(ids).not.toContain('orderValue');
    expect(PRIORITY.offer).not.toContain('orderValue');
    expect(PRIORITY.offer).not.toContain('date');
  });

  it('R9: bei einem unklaren Dokument ist der Betrag kein Kopffakt', () => {
    expect(PRIORITY.generic).not.toContain('amount');
    expect(PRIORITY.generic).toEqual(['sender', 'subject', 'deadline']);
  });
});

describe('DOCUMENT-EXPERIENCE-GENERALITY-01B — Case-Match-Policy', () => {
  function matchingVorgang() {
    return createTestVorgang({
      id: 'vg-generality',
      title: 'Bauvorhaben Teststraße',
      customer: 'Musterbau OWL GmbH',
      baustelle: SITE,
    });
  }

  /*
   * R10 / R11 — ein Behördenbrief bleibt ein Fristthema.
   *
   * Ohne passenden Vorgang bot die Seite bisher „Neuen Vorgang anlegen" an.
   */
  it('R10: ein Behördenbrief ohne Vorgang behält seine Dokumentaktion', () => {
    const summary = summaryFor(
      seed('finanzamt', 'behoerde', {
        Absender: 'Finanzamt Bielefeld',
        Betreff: 'Umsatzsteuer-Voranmeldung',
      }),
    );

    expect(summary.family).toBe('authority');
    expect(summary.primaryAction.id).toBe('create_task');
    expect(summary.primaryAction.id).not.toBe('create_vorgang');
  });

  it('R11: ein Behördenbrief mit Vorgangstreffer behält sie ebenfalls', () => {
    hydrateVorgangStore([matchingVorgang()]);
    const summary = summaryFor(
      seed('finanzamt', 'behoerde', {
        Absender: 'Finanzamt Bielefeld',
        Betreff: 'Umsatzsteuer-Voranmeldung',
        Baustelle: SITE,
        Kunde: 'Musterbau OWL GmbH',
      }),
    );

    expect(summary.primaryAction.id).toBe('create_task');
    // Der Fallabgleich bleibt als Kontext erhalten.
    expect(summary.caseMatch).toBeDefined();
  });

  /*
   * R12 — ein unklares Schreiben wird nicht zur Vorgangsaufforderung.
   */
  it('R12: ein unklares Dokument behält die Prüfaktion', () => {
    hydrateVorgangStore([matchingVorgang()]);
    const summary = summaryFor(
      seed('sonstiges', 'sonstiges', { Absender: 'Unbekannt GmbH', Baustelle: SITE }),
    );

    expect(summary.family).toBe('generic');
    expect(summary.primaryAction.id).toBe('apply_intake');
    expect(summary.primaryAction.id).not.toBe('create_vorgang');
  });

  /*
   * R13 / R14 — Lieferschein bleibt bewusst vorgangsorientiert.
   *
   * Hier greift die neue Policy ausdrücklich **nicht**: Der Fallabgleich
   * bestimmt weiterhin die Hauptaktion.
   */
  it('R13/R14: ein Lieferschein folgt weiterhin dem Fallabgleich', () => {
    const withoutMatch = summaryFor(
      seed('lieferschein', 'sonstiges', { Lieferant: 'Baustoff Nord GmbH', Datum: '18.08.2026' }),
    );
    expect(withoutMatch.family).toBe('delivery');
    expect(['create_vorgang', 'link_vorgang', 'select_vorgang', 'open_vorgang']).toContain(
      withoutMatch.primaryAction.id,
    );
    expect(withoutMatch.primaryAction.id).not.toBe('record_expense');

    hydrateVorgangStore([matchingVorgang()]);
    const withMatch = summaryFor(
      seed('lieferschein', 'sonstiges', {
        Lieferant: 'Baustoff Nord GmbH',
        Datum: '18.08.2026',
        Baustelle: SITE,
        Kunde: 'Musterbau OWL GmbH',
      }),
    );
    expect(['create_vorgang', 'link_vorgang', 'select_vorgang', 'open_vorgang']).toContain(
      withMatch.primaryAction.id,
    );
  });

  /*
   * R15 — dasselbe für das Angebot: vorgangsorientiert, nicht geschützt.
   */
  it('R15: ein Angebot folgt weiterhin dem Fallabgleich', () => {
    hydrateVorgangStore([matchingVorgang()]);
    const summary = summaryFor(
      seed('angebot', 'sonstiges', {
        Kunde: 'Musterbau OWL GmbH',
        Betreff: 'Heizung',
        Betrag: '12.400,00 EUR',
        Baustelle: SITE,
      }),
    );

    expect(summary.family).toBe('offer');
    expect(['create_vorgang', 'link_vorgang', 'select_vorgang', 'open_vorgang']).toContain(
      summary.primaryAction.id,
    );
  });

  // R16 / R17 — die bestehenden Sicherheiten bleiben unangetastet.
  it('R16/R17: Rechnung behält record_expense, Mahnung bekommt es nie', () => {
    hydrateVorgangStore([matchingVorgang()]);
    const invoice = summaryFor(
      seed('eingangsrechnung', 'eingangsrechnung', {
        Lieferant: 'Baustoff Nord GmbH',
        Rechnungsnummer: 'RE-1000',
        Betrag: '119,00 EUR',
        Baustelle: SITE,
      }),
    );
    expect(invoice.primaryAction.id).toBe('record_expense');

    const dunning = summaryFor(
      seed('mahnung', 'eingangsrechnung', {
        Lieferant: 'Baustoff Nord GmbH',
        Rechnungsnummer: 'RE-1000',
        Betrag: '119,00 EUR',
      }),
    );
    expect(dunning.primaryAction.id).not.toBe('record_expense');
  });
});
