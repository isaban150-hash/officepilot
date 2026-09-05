/**
 * DUNNING-PRIMARY-ACTION-ROUTING-01B — eine Mahnung fragt nach der Zahlung,
 * nicht nach einem neuen Vorgang.
 *
 * Realbefund auf iPhone/Safari: Eine korrekt erkannte Mahnung zeigte Lieferant,
 * Betrag, Rechnungsnummer, den richtigen Lead und den Bezugsbeleg-Bereich
 * („Es wurde keine neue Ausgabe angelegt") — und darüber als Hauptaktion
 * **„Neuen Vorgang anlegen"**.
 *
 * Die Sicherheit war intakt, die Kohärenz nicht. Ursache war nicht der
 * Fallabgleich allein: Die Mahnung startete als `record_expense`, verlor diese
 * Aktion richtigerweise an die Bezugsdokument-Sperre aus
 * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B und fiel danach in den
 * Standardausgang des Fallabgleichs. Es fehlte also nicht der Schutz, sondern
 * die Aktion.
 *
 * Warum die bisherigen Tests grün waren: Sämtliche Mahnungs-Zusicherungen sind
 * Negativsicherungen („niemals `record_expense`"). `create_vorgang` erfüllt
 * jede davon. Diese Datei sichert erstmals **positiv**, was die Hauptaktion
 * sein muss.
 *
 * Geprüft wird über die produktiven Resolver, nicht über eine Nachbildung.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { buildDocumentSummary } from './services/documentSummary';
import { buildDocumentCaseMatch } from './services/documentCaseMatchService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateExpenseStore } from './services/expenseStore';
import { addExpense, getAllExpenses } from './services/expenseService';
import {
  executeDocumentAction,
  isDocumentActionAvailable,
} from './services/officeActionService';
import { isFinanceReferenceOnlyKind } from './services/documentFinanceReferenceService';
import { createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { t, type TranslationKey } from './i18n';
import type { ClassifiedDocumentKind, InboxItem, Vorgang } from './types/models';

const ITEM_ID = 'inbox-dunning-routing-01b';
const SUPPLIER = 'Westfalen Testlieferant fuer OfficePilot';
const SITE = 'Teststraße 24, 33602 Bielefeld';
const INVOICE_NUMBER = 'RE-4711';

const translate = (key: TranslationKey) => t(key, 'de');

/** Ein Bezugs- oder Finanzdokument, wie es aus dem Eingang kommt. */
function financeDocument(
  kind: ClassifiedDocumentKind,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  const { recognizedData, ...rest } = overrides;
  return {
    ...createAuftragInboxItem({ id: ITEM_ID }),
    title: `${kind} ${SUPPLIER}`,
    sender: SUPPLIER,
    classifiedKind: kind,
    documentType: 'eingangsrechnung',
    recognizedData: {
      Rechnungsnummer: INVOICE_NUMBER,
      Betrag: '486,20 EUR',
      Lieferant: SUPPLIER,
      ...recognizedData,
    },
    ...rest,
  } as InboxItem;
}

function matchingVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return createTestVorgang({
    id: 'vg-dunning-01b',
    title: 'Bauvorhaben Teststraße',
    customer: SUPPLIER,
    baustelle: SITE,
    ...overrides,
  });
}

/** Die Hauptaktion, wie sie die kanonische Detailseite sieht. */
function detailPrimary(item: InboxItem): string {
  const workflow = processUploadedDocument(item.id);
  return buildDocumentSummary(item, workflow, { translate }).primaryAction.id;
}

function detailPrimaryLabel(item: InboxItem): string {
  const workflow = processUploadedDocument(item.id);
  return translate(buildDocumentSummary(item, workflow, { translate }).primaryAction.labelKey);
}

/** Der tatsächliche Trefferzustand — damit kein Test behauptet, was er nicht prüft. */
function matchStatus(item: InboxItem): string {
  return buildDocumentCaseMatch(item).matchStatus;
}

beforeEach(() => {
  hydrateVorgangStore([]);
  hydrateInboxStore([]);
  hydrateExpenseStore([]);
});

describe('DUNNING-PRIMARY-ACTION-ROUTING-01B — die Zahlungsprüfung bleibt Hauptaktion', () => {
  /*
   * R1 — der belegte Realfall vom iPhone.
   */
  it('R1: eine Mahnung ohne Vorgangstreffer führt die Zahlungsprüfung', () => {
    const item = financeDocument('mahnung');
    hydrateInboxStore([item]);

    expect(matchStatus(item), 'Der Test prüft nicht den gemeinten Zustand').toBe('none');
    expect(detailPrimary(item), 'Die Mahnung bot wieder eine Vorgangsanlage an').toBe(
      'check_payment',
    );
    expect(detailPrimary(item)).not.toBe('create_vorgang');
    expect(detailPrimary(item)).not.toBe('record_expense');
  });

  it('R2: eine Zahlungserinnerung ohne Vorgangstreffer führt ebenfalls die Zahlungsprüfung', () => {
    const item = financeDocument('zahlungserinnerung');
    hydrateInboxStore([item]);

    expect(matchStatus(item)).toBe('none');
    expect(detailPrimary(item)).toBe('check_payment');
    expect(detailPrimary(item)).not.toBe('create_vorgang');
    expect(detailPrimary(item)).not.toBe('record_expense');
  });

  /*
   * R3–R5 — der Fallabgleich ergänzt, er ersetzt nicht. Geprüft wird über den
   * echten Trefferzustand: Was `buildDocumentCaseMatch` liefert, wird zuerst
   * festgestellt und dann mitgeprüft.
   */
  it('R3: ein eindeutiger Vorgangstreffer ersetzt die Zahlungsprüfung nicht', () => {
    const vorgang = matchingVorgang();
    hydrateVorgangStore([vorgang]);
    const item = financeDocument('mahnung', {
      recognizedData: { Baustelle: SITE },
    });
    hydrateInboxStore([item]);

    expect(matchStatus(item)).not.toBe('none');
    expect(detailPrimary(item)).toBe('check_payment');
    expect(detailPrimary(item)).not.toBe('link_vorgang');
  });

  it('R4/R5: mehrere mögliche Vorgänge machen die Vorgangsauswahl nicht zur Pflicht', () => {
    hydrateVorgangStore([
      matchingVorgang({ id: 'vg-a', title: 'Bauvorhaben A' }),
      matchingVorgang({ id: 'vg-b', title: 'Bauvorhaben B' }),
    ]);
    const item = financeDocument('mahnung', {
      recognizedData: { Baustelle: SITE },
    });
    hydrateInboxStore([item]);

    expect(detailPrimary(item)).toBe('check_payment');
    expect(detailPrimary(item)).not.toBe('select_vorgang');
  });

  /*
   * R6/R7 — der wichtigste Grenzfall.
   *
   * Ein vorhandener Vorgang beantwortet die Frage der Mahnung nicht: Ist die
   * zugrunde liegende Rechnung bezahlt? Die 01D-Regel „verknüpfter Vertrag
   * öffnet den Vorgang" bleibt vertragsspezifisch — dort verhindert sie eine
   * Doppelanlage, hier gäbe es nichts doppelt anzulegen.
   */
  it.each(['mahnung', 'zahlungserinnerung'] as const)(
    'R6/R7: %s mit bestätigter Verknüpfung bleibt bei der Zahlungsprüfung',
    (kind) => {
      const vorgang = matchingVorgang();
      hydrateVorgangStore([vorgang]);
      const item = financeDocument(kind, {
        vorgangId: vorgang.id,
        vorgangLinkStatus: 'linked',
      });
      hydrateInboxStore([item]);

      expect(detailPrimary(item)).toBe('check_payment');
      expect(detailPrimary(item)).not.toBe('open_vorgang');
    },
  );

  it('R8: eine ins Leere zeigende Verknüpfung führt weder zur Zuordnung noch zur Neuanlage', () => {
    hydrateVorgangStore([]);
    const item = financeDocument('mahnung', {
      vorgangId: 'vg-existiert-nicht',
      vorgangLinkStatus: 'linked',
    });
    hydrateInboxStore([item]);

    expect(detailPrimary(item)).toBe('check_payment');
    expect(detailPrimary(item)).not.toBe('link_vorgang');
    expect(detailPrimary(item)).not.toBe('create_vorgang');
  });
});

describe('DUNNING-PRIMARY-ACTION-ROUTING-01B — bestehende Regeln bleiben unberührt', () => {
  it('R9: eine normale Eingangsrechnung behält „Als Ausgabe erfassen"', () => {
    hydrateVorgangStore([matchingVorgang()]);
    const item = financeDocument('eingangsrechnung', {
      recognizedData: { Baustelle: SITE },
    });
    hydrateInboxStore([item]);

    expect(detailPrimary(item)).toBe('record_expense');
    expect(detailPrimary(item)).not.toBe('check_payment');
  });

  it.each(['tankbeleg', 'kassenbeleg', 'quittung'] as const)(
    'R10: %s behält „Als Ausgabe erfassen"',
    (kind) => {
      hydrateVorgangStore([matchingVorgang()]);
      const item = financeDocument(kind, {
        recognizedData: { Betrag: '68,57 EUR', Baustelle: SITE },
      });
      hydrateInboxStore([item]);

      expect(detailPrimary(item)).toBe('record_expense');
    },
  );

  /*
   * R11 — die 01D-Vertragsregel wird durch diesen Block nicht verallgemeinert.
   */
  it('R11: ein verknüpfter Vertrag öffnet weiterhin den Vorgang', () => {
    const vorgang = matchingVorgang({ id: 'vg-vertrag-01b' });
    hydrateVorgangStore([vorgang]);
    const item = {
      ...createAuftragInboxItem({ id: 'inbox-vertrag-dunning-01b' }),
      classifiedKind: 'werkvertrag' as ClassifiedDocumentKind,
      documentType: 'vertrag',
      vorgangId: vorgang.id,
      vorgangLinkStatus: 'linked',
    } as InboxItem;
    hydrateInboxStore([item]);

    const primary = detailPrimary(item);
    expect(primary).not.toBe('check_payment');
    expect(['open_vorgang', 'accept_contract_order']).toContain(primary);
  });
});

describe('DUNNING-PRIMARY-ACTION-ROUTING-01B — der Handler bleibt der bestehende', () => {
  /*
   * R12/R13 — kein Zweig legt eine Ausgabe an. Der Bezugsdokument-Schutz aus
   * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B bleibt die einzige Wahrheit.
   */
  it('R12/R13: „Zahlung prüfen" ohne gefundenen Beleg bucht nichts und bleibt beim Dokument', () => {
    const item = financeDocument('mahnung');
    hydrateInboxStore([item]);
    expect(isFinanceReferenceOnlyKind(item.classifiedKind)).toBe(true);
    expect(isDocumentActionAvailable('check_payment', item, item.classifiedKind)).toBe(true);

    const before = getAllExpenses().length;
    const result = executeDocumentAction('check_payment', item, {
      classifiedKind: item.classifiedKind,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.kind).toBe('delegate');
    /*
     * DUNNING-CHECK-PAYMENT-EXECUTION-01B — hier stand `expandDetails`.
     *
     * Das war die Ursache des zweiten Realgerät-FAIL: „Weitere Optionen"
     * klappten auf, unterhalb des Sichtfelds und ohne Bezug zur Zahlungsfrage.
     * Der Delegate zeigt jetzt auf den Bezugsbeleg-Bereich; die sichtbare
     * Wirkung sichert `dunningCheckPaymentExecution01b`.
     */
    expect(result.ok && result.kind === 'delegate' && result.delegate).toBe(
      'focusFinanceReference',
    );
    expect(getAllExpenses().length, 'Die Zahlungsprüfung hat gebucht').toBe(before);
  });

  /*
   * R14 — bei eindeutigem Bezug öffnet derselbe Handler den vorhandenen Beleg.
   * Es entsteht keine neue Relation; verknüpft wird weiterhin erst nach
   * ausdrücklicher Bestätigung.
   */
  it('R14: „Zahlung prüfen" mit eindeutigem Beleg öffnet den vorhandenen Beleg', () => {
    // Dieselbe Belegform wie in documentAccountingReferenceSafety01b — der
    // Bezug entsteht aus Rechnungsnummer plus Lieferant.
    const seeded = addExpense({
      title: `Rechnung ${INVOICE_NUMBER}`,
      category: 'material',
      supplierName: SUPPLIER,
      invoiceNumber: INVOICE_NUMBER,
      issueDate: '2026-08-01',
      paymentDueDate: '2026-08-31',
      grossAmount: 486.2,
      status: 'gebucht',
    });
    expect(seeded.success, JSON.stringify(seeded)).toBe(true);

    const item = financeDocument('mahnung');
    hydrateInboxStore([item]);

    const before = getAllExpenses().length;
    const result = executeDocumentAction('check_payment', item, {
      classifiedKind: item.classifiedKind,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.kind).toBe('navigate');
    expect(result.ok && result.kind === 'navigate' && result.route).toContain('/ausgaben/');
    expect(getAllExpenses().length).toBe(before);
  });
});

describe('DUNNING-PRIMARY-ACTION-ROUTING-01B — Beschriftung und Kohärenz', () => {
  it('R15: die Mahnung zeigt sichtbar die Zahlungsfrage, nicht die Vorgangsanlage', () => {
    const item = financeDocument('mahnung');
    hydrateInboxStore([item]);

    const label = detailPrimaryLabel(item);
    expect(label).toBe('Prüfen, ob schon bezahlt');
    expect(label).not.toContain('Vorgang');
  });

  /*
   * R16 — der Widerspruch, der auf dem Gerät sichtbar war: Der
   * Bezugsbeleg-Bereich sagte „keine neue Ausgabe angelegt", der Knopf darüber
   * „Neuen Vorgang anlegen". Beide Quellen sind unabhängig; diese Regression
   * bindet sie an dieselbe Bedingung.
   */
  it.each(['mahnung', 'zahlungserinnerung'] as const)(
    'R16: wo der Bezugsbeleg-Bereich erscheint, steht keine Vorgangsanlage als Hauptaktion (%s)',
    (kind) => {
      hydrateVorgangStore([matchingVorgang()]);
      const item = financeDocument(kind, { recognizedData: { Baustelle: SITE } });
      hydrateInboxStore([item]);

      // Dieselbe Bedingung, an der die Detailseite den Bereich einblendet.
      expect(isFinanceReferenceOnlyKind(item.classifiedKind)).toBe(true);
      expect(['create_vorgang', 'link_vorgang', 'select_vorgang', 'open_vorgang']).not.toContain(
        detailPrimary(item),
      );
    },
  );
});
