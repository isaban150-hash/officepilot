/**
 * DOCUMENT-INVOICE-PRIMARY-ACTION-01B — der Fallabgleich ergänzt, er ersetzt nicht.
 *
 * Realbefund: Eine korrekt als Rechnung erkannte Lieferantenrechnung bot
 * prominent „Neuen Vorgang anlegen" statt „Als Ausgabe erfassen".
 *
 * Ursache war die Rangfolge in `attachDocumentCaseMatch`: Die von der
 * Dokumentfamilie bestimmte Hauptaktion `record_expense` wurde vom
 * Fallabgleich überschrieben — `none → create_vorgang`, `exact → link_vorgang`,
 * `likely/multiple → select_vorgang`. Geschützt war ausschliesslich
 * `accept_contract_order`.
 *
 * Fachlich falsch: Der Vorgangsbezug einer Ausgabe ist ein Feld der Ausgabe
 * (`Expense.allocations`) — er setzt ihre Erfassung voraus, statt sie zu
 * ersetzen. Deshalb bleibt `record_expense` Hauptaktion, unabhängig vom
 * Trefferzustand.
 *
 * Die eine Ausnahme: Mahnung und Zahlungserinnerung liegen wegen ihres
 * `documentType` in derselben Familie, sind aber **Bezugsdokumente**. Für sie
 * darf `record_expense` nie zurückkehren — sonst unterliefe eine
 * Darstellungsentscheidung die Sperren aus
 * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B.
 *
 * Geprüft wird über die produktiven Resolver, nicht über eine Nachbildung.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { buildDocumentSummary, buildInboxDocumentSummary } from './services/documentSummary';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateInboxStore } from './services/inboxService';
import { createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import { buildSyntheticWerkvertragText } from './test/werkvertragMultiSectionFixtures';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { t, type TranslationKey } from './i18n';
import type { ClassifiedDocumentKind, InboxItem, Vorgang } from './types/models';

const ITEM_ID = 'inbox-primary-action-01b';
const SUPPLIER = 'Westfalen SHK Grosshandel GmbH';
const SITE = 'Teststraße 24, 33602 Bielefeld';

const translate = (key: TranslationKey) => t(key, 'de');

/** Ein Finanzbeleg, wie er aus dem Eingang kommt. */
function financeDocument(
  kind: ClassifiedDocumentKind,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    ...createAuftragInboxItem({ id: ITEM_ID }),
    title: `${kind} ${SUPPLIER}`,
    sender: SUPPLIER,
    classifiedKind: kind,
    documentType: 'eingangsrechnung',
    recognizedData: {
      Rechnungsnummer: 'RE-4711',
      Betrag: '486,20 EUR',
      Lieferant: SUPPLIER,
    },
    ...overrides,
  } as InboxItem;
}

/** Ein Vorgang, den der Fallabgleich finden kann. */
function matchingVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return createTestVorgang({
    id: 'vg-primary-action-01b',
    title: 'Bauvorhaben Teststraße',
    customer: SUPPLIER,
    baustelle: SITE,
    ...overrides,
  });
}

/** Die Hauptaktion, wie sie die Detailseite sieht. */
function detailPrimary(item: InboxItem): string {
  const workflow = processUploadedDocument(item.id);
  return buildDocumentSummary(item, workflow, { translate }).primaryAction.id;
}

/** Die Hauptaktion, wie sie die Eingangskarte sieht. */
function inboxPrimary(item: InboxItem): string {
  return buildInboxDocumentSummary(item, { translate }).primaryAction.id;
}

function secondaryIds(item: InboxItem): string[] {
  const workflow = processUploadedDocument(item.id);
  return buildDocumentSummary(item, workflow, { translate }).secondaryActions.map((a) => a.id);
}

beforeEach(() => {
  hydrateVorgangStore([]);
  hydrateInboxStore([]);
});

describe('DOCUMENT-INVOICE-PRIMARY-ACTION-01B — Finanzbelege behalten ihre Hauptaktion', () => {
  /*
   * R1 — der belegte Realfall.
   *
   * Ohne Vorgangstreffer bot die Seite „Neuen Vorgang anlegen" an und die
   * Ausgabenerfassung verschwand ganz.
   */
  it('R1: eine Eingangsrechnung ohne Vorgang bleibt bei „Als Ausgabe erfassen"', () => {
    const item = financeDocument('eingangsrechnung');
    hydrateInboxStore([item]);

    expect(detailPrimary(item), 'Der Fallabgleich hat die Finanzaktion verdrängt')
      .toBe('record_expense');
    expect(detailPrimary(item)).not.toBe('create_vorgang');
  });

  /*
   * R2 — mit eindeutigem Vorgangstreffer.
   *
   * Auch dann bleibt die Rechnung zuerst ein Beleg: Ohne `Expense` gibt es
   * nichts, was einem Vorgang zugeordnet werden könnte.
   */
  it('R2: eine Eingangsrechnung mit eindeutigem Vorgang bleibt bei der Finanzaktion', () => {
    const vorgang = matchingVorgang();
    hydrateVorgangStore([vorgang]);
    const item = financeDocument('eingangsrechnung', {
      vorgangId: vorgang.id,
      vorgangLinkStatus: 'linked',
      recognizedData: {
        Rechnungsnummer: 'RE-4711',
        Betrag: '486,20 EUR',
        Lieferant: SUPPLIER,
        Baustelle: SITE,
      },
    });
    hydrateInboxStore([item]);

    expect(detailPrimary(item)).toBe('record_expense');
    // Der Vorgangsbezug verschwindet nicht — er bleibt als Nebenaktion.
    expect(secondaryIds(item)).toContain('link_vorgang');
  });

  /*
   * R3 — mehrdeutige Lage.
   *
   * Niemand soll zuerst einen Vorgang wählen müssen, um eine Rechnung
   * erfassen zu können.
   */
  it('R3: mehrere mögliche Vorgänge machen die Vorgangsauswahl nicht zur Pflicht', () => {
    hydrateVorgangStore([
      matchingVorgang({ id: 'vg-a', title: 'Bauvorhaben A' }),
      matchingVorgang({ id: 'vg-b', title: 'Bauvorhaben B' }),
    ]);
    const item = financeDocument('eingangsrechnung', {
      recognizedData: {
        Rechnungsnummer: 'RE-4711',
        Betrag: '486,20 EUR',
        Lieferant: SUPPLIER,
        Baustelle: SITE,
      },
    });
    hydrateInboxStore([item]);

    expect(detailPrimary(item)).toBe('record_expense');
    expect(detailPrimary(item)).not.toBe('select_vorgang');
  });

  /*
   * R8 — Belege ausserhalb der Rechnungsfamilie.
   *
   * Die Regel hängt an der tatsächlichen Hauptaktion, nicht an einer
   * pauschalen Familienliste — deshalb greift sie auch für Tankbelege.
   */
  it.each(['tankbeleg', 'kassenbeleg', 'quittung', 'ec_beleg', 'kreditkartenbeleg'] as const)(
    'R8: %s behält „Als Ausgabe erfassen" trotz Vorgangslage',
    (kind) => {
      hydrateVorgangStore([matchingVorgang()]);
      const item = financeDocument(kind, {
        recognizedData: { Betrag: '68,57 EUR', Lieferant: SUPPLIER, Baustelle: SITE },
      });
      hydrateInboxStore([item]);

      expect(detailPrimary(item)).toBe('record_expense');
    },
  );

  /*
   * Gutschrift — nur die Hauptaktion, keine neue Vorzeichensemantik.
   */
  it('Gutschrift behält die Finanzaktion (Vorzeichenfrage bleibt offen)', () => {
    hydrateVorgangStore([matchingVorgang()]);
    const item = financeDocument('gutschrift');
    hydrateInboxStore([item]);

    expect(detailPrimary(item)).toBe('record_expense');
  });

  /*
   * R10 — beide Oberflächen behandeln denselben Beleg konsistent.
   *
   * Bewusst **nicht** „identische Hauptaktion": Die Eingangskarte setzt in
   * `finalizeInboxPresentation` absichtlich eine eigene Hauptaktion
   * („Jetzt prüfen"), und ein bestehender Test verlangt für die Liste
   * ausdrücklich `create_vorgang` (`documentInboxSummary01`). Das ist eine
   * Produktentscheidung für die Liste, die dieser Block nicht umstösst.
   *
   * Prüfbar und im Scope ist die fachliche Konsistenz: Die Detailseite führt
   * die Finanzaktion, und **keine** der beiden Oberflächen bietet sie für ein
   * Bezugsdokument an.
   */
  it('R10: Detailseite führt die Finanzaktion, die Liste bietet keine abweichende Finanzaktion', () => {
    hydrateVorgangStore([matchingVorgang()]);
    const invoice = financeDocument('eingangsrechnung');
    hydrateInboxStore([invoice]);

    expect(detailPrimary(invoice)).toBe('record_expense');

    const dunning = financeDocument('mahnung');
    hydrateInboxStore([dunning]);
    expect(detailPrimary(dunning)).not.toBe('record_expense');
    expect(inboxPrimary(dunning)).not.toBe('record_expense');
  });
});

describe('DOCUMENT-INVOICE-PRIMARY-ACTION-01B — Bezugsdokumente bleiben ausgenommen', () => {
  /*
   * R4 / R5 — die Negativsicherung.
   *
   * Mahnung und Zahlungserinnerung liegen wegen ihres `documentType` in
   * derselben Familie wie echte Rechnungen. Bekämen sie durch diese Regel
   * `record_expense` zurück, unterliefe eine Darstellungsentscheidung die
   * Sperren aus 01B — und aus einer Mahnung entstünde wieder eine zweite
   * Verbindlichkeit.
   */
  it.each(['mahnung', 'zahlungserinnerung'] as const)(
    'R4/R5: %s erhält niemals „Als Ausgabe erfassen"',
    (kind) => {
      hydrateVorgangStore([matchingVorgang()]);
      const item = financeDocument(kind);
      hydrateInboxStore([item]);

      expect(detailPrimary(item), 'Bezugsdokument bekam die Erfassungsaktion').not.toBe(
        'record_expense',
      );
      expect(inboxPrimary(item)).not.toBe('record_expense');
      expect(secondaryIds(item)).not.toContain('record_expense');
    },
  );
});

describe('DOCUMENT-INVOICE-PRIMARY-ACTION-01B — Vertragslogik unverändert', () => {
  function contractItem(overrides: Partial<InboxItem> = {}): InboxItem {
    return {
      ...createAuftragInboxItem({ id: ITEM_ID }),
      title: 'Werkvertrag Musterbau OWL GmbH',
      sender: 'Musterbau OWL GmbH',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
      recognizedData: {
        Kunde: 'Musterbau OWL GmbH',
        Baustelle: SITE,
        _vertragstext: buildSyntheticWerkvertragText(),
      },
      ...overrides,
    } as InboxItem;
  }

  // R6 — ohne Verknüpfung bleibt die Auftragserfassung die Hauptaktion.
  it('R6: ein Vertrag ohne Verknüpfung behält „Als Auftrag erfassen"', () => {
    hydrateVorgangStore([]);
    const item = contractItem();
    hydrateInboxStore([item]);

    expect(detailPrimary(item)).toBe('accept_contract_order');
  });

  /*
   * R7 — die Zusicherung aus CONTRACT-ORDER-ALREADY-LINKED-UX-01D.
   *
   * Ein bereits erfasster Vertrag darf die Erfassung nicht erneut anbieten.
   * Diese Bedingung darf der neue Schutz nicht mit aufweichen.
   */
  it('R7: ein bereits verknüpfter Vertrag bietet die Erfassung nicht erneut an', () => {
    const vorgang = matchingVorgang({ id: 'vg-linked', customer: 'Musterbau OWL GmbH' });
    hydrateVorgangStore([vorgang]);
    const item = contractItem({ vorgangId: vorgang.id, vorgangLinkStatus: 'created' });
    hydrateInboxStore([item]);

    expect(detailPrimary(item), 'Doppelanlage wieder möglich').not.toBe('accept_contract_order');
  });
});
