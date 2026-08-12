/**
 * GOLD-PDF-PARTY-DIRECTION-02 — Richtung der Parteifelder bei ausgehenden Dokumenten.
 *
 * Empfänger eines ausgehenden Dokuments: Auftraggeber → Kunde → Empfänger.
 * Aussteller / eigene Firma: Absender → Lieferant → item.sender.
 * Die beiden Richtungen dürfen einander nie vertreten. Fehlt der Empfänger, entfällt
 * der customer-Fakt — ein leeres Feld ist korrekt, die eigene Firma als Kunde ist falsch.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDocumentSummary, buildInboxDocumentSummary } from './documentSummary';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateInboxStore, getInboxItemById } from './inboxService';
import { hydrateVorgangStore, linkInboxToExistingVorgang } from './vorgangService';
import { processUploadedDocument } from './intakeWorkflowService';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { MOCK_VORGAENGE } from '../data/mockData';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { t, type TranslationKey } from '../i18n';
import type { InboxItem } from '../types/models';

const OWN_COMPANY = 'Cirmak Haustechnik GmbH';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function summarize(item: InboxItem) {
  hydrateInboxStore([item]);
  return buildInboxDocumentSummary(item, { translate });
}

function factValue(summary: ReturnType<typeof summarize>, id: string): string | undefined {
  return summary.facts.find((fact) => fact.id === id)?.value;
}

describe('DOCUMENT-SUMMARY-PARTY-DIRECTION-02', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore({ companyName: OWN_COMPANY } as never);
  });

  it('Ausgangsrechnung ohne erkannten Empfaenger zeigt keinen customer-Fakt', () => {
    const summary = summarize(
      createAuftragInboxItem({
        id: 'party-out-invoice-none',
        classifiedKind: 'ausgangsrechnung',
        documentType: 'ausgangsrechnung',
        sender: OWN_COMPANY,
        recognizedData: {
          Dokumentart: 'ausgangsrechnung',
          Absender: OWN_COMPANY,
          Lieferant: OWN_COMPANY,
          Rechnungsnummer: 'AR-2026-999',
          Datum: '01.04.2026',
        },
      } as never),
    );

    expect(summary.family).toBe('invoice_out');
    expect(factValue(summary, 'customer')).toBeUndefined();
    // Die eigene Firma darf nirgends als Kunde/Empfänger auftauchen.
    expect(summary.facts.some((fact) => fact.id === 'customer' && fact.value === OWN_COMPANY)).toBe(
      false,
    );
  });

  it('Angebot ohne erkannten Empfaenger zeigt keinen customer-Fakt', () => {
    const summary = summarize(
      createAuftragInboxItem({
        id: 'party-out-offer-none',
        classifiedKind: 'angebot',
        documentType: 'angebot',
        sender: OWN_COMPANY,
        recognizedData: {
          Dokumentart: 'angebot',
          Absender: OWN_COMPANY,
          Lieferant: OWN_COMPANY,
          Datum: '08.03.2026',
        },
      } as never),
    );

    expect(summary.family).toBe('offer');
    expect(factValue(summary, 'customer')).toBeUndefined();
    expect(summary.facts.some((fact) => fact.value === OWN_COMPANY)).toBe(false);
  });

  it('erkannter Empfaenger bleibt unveraendert erhalten', () => {
    const summary = summarize(
      createAuftragInboxItem({
        id: 'party-out-invoice-ok',
        classifiedKind: 'ausgangsrechnung',
        documentType: 'ausgangsrechnung',
        sender: OWN_COMPANY,
        recognizedData: {
          Dokumentart: 'ausgangsrechnung',
          Absender: OWN_COMPANY,
          Lieferant: OWN_COMPANY,
          Kunde: 'Sägewerk Ernst Flisch GmbH',
          Empfänger: 'Sägewerk Ernst Flisch GmbH',
          Rechnungsnummer: 'AR-2026-0031',
          Datum: '28.02.2026',
        },
      } as never),
    );

    expect(factValue(summary, 'customer')).toBe('Sägewerk Ernst Flisch GmbH');
  });

  it('Eingangsrechnung behaelt ihren supplier-Fakt', () => {
    const summary = summarize(
      createAuftragInboxItem({
        id: 'party-in-invoice',
        classifiedKind: 'eingangsrechnung',
        documentType: 'eingangsrechnung',
        sender: 'Hornbach Baumarkt AG',
        recognizedData: {
          Dokumentart: 'eingangsrechnung',
          Absender: 'Hornbach Baumarkt AG',
          Lieferant: 'Hornbach Baumarkt AG',
          Rechnungsnummer: 'HB-1',
          Datum: '02.04.2026',
        },
      } as never),
    );

    expect(summary.family).toBe('invoice_in');
    expect(factValue(summary, 'supplier')).toBe('Hornbach Baumarkt AG');
  });
});

/**
 * PARTY-DIRECTION-COUNTERPARTY-01 — der Vorgangskunde ist Empfänger, nie Aussteller.
 *
 * Bei einer verknüpften Eingangsrechnung trägt bi.facts.parties.counterparty den
 * Vorgangskunden. Er darf den Lieferanten nicht verdrängen, muss aber bei ausgehenden
 * Dokumenten weiterhin den Empfänger liefern. Alle Fälle laufen über die normale
 * Store-Hydrierung, processUploadedDocument und die echte Summary-Erzeugung; es wird
 * kein BusinessInterpretation-, Counterparty- oder Summary-Wert von Hand gesetzt.
 */
describe('PARTY-DIRECTION-COUNTERPARTY-01 – Vorgangskunde ist Empfaenger, nicht Aussteller', () => {
  const SUPPLIER = 'Hornbach Baumarkt AG';
  const VORGANG_CUSTOMER = 'Familie Müller';

  function realSummary(item: InboxItem) {
    hydrateInboxStore([item]);
    const workflow = processUploadedDocument(item.id)!;
    return {
      workflow,
      summary: buildDocumentSummary(item, workflow, { translate }),
    };
  }

  function incomingInvoice(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
    const source = MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-003')!;
    return { ...source, id, ...overrides } as InboxItem;
  }

  function seedVorgang(overrides: Record<string, unknown> = {}) {
    const base = MOCK_VORGAENGE.find((vorgang) => vorgang.id === 'v-001')!;
    hydrateVorgangStore([{ ...base, ...overrides } as never]);
    return base;
  }

  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore({ companyName: OWN_COMPANY } as never);
  });

  it('Eingangsrechnung mit bestaetigtem Vorgang zeigt den Aussteller als Lieferant, nicht den Vorgangskunden', () => {
    const seeded = seedVorgang();
    expect(seeded.customer).toBe(VORGANG_CUSTOMER);

    const item = incomingInvoice('party-dir-in-linked');
    expect(item.vorgangId).toBe('v-001');
    expect(item.vorgangLinkStatus).toBe('linked');
    expect(item.sender).toBe(SUPPLIER);

    const { workflow, summary } = realSummary(item);

    // Die Gegenpartei darf weiterhin der Vorgangskunde sein — sie ist der Empfänger.
    expect(workflow.businessInterpretation?.facts.parties.counterparty?.name).toBe(
      VORGANG_CUSTOMER,
    );

    expect(summary.family).toBe('invoice_in');
    expect(factValue(summary, 'supplier')).toBe(SUPPLIER);
    expect(factValue(summary, 'supplier')).not.toBe(VORGANG_CUSTOMER);
  });

  it('dieselbe Eingangsrechnung ohne Verknuepfung behaelt den Aussteller als Lieferant', () => {
    seedVorgang();

    const item = incomingInvoice('party-dir-in-unlinked', {
      vorgangId: undefined,
      vorgangTitle: undefined,
      vorgangLinkStatus: undefined,
    });

    const { summary } = realSummary(item);

    expect(summary.family).toBe('invoice_in');
    expect(factValue(summary, 'supplier')).toBe(SUPPLIER);
  });

  it('Ausgangsrechnung mit bestaetigtem Vorgang nimmt den Vorgangskunden als Empfaenger', () => {
    seedVorgang({ id: 'v-out', title: 'Sanierung Nord' });

    const raw = {
      ...createAuftragInboxItem(),
      id: 'party-dir-out-linked',
      title: 'Ausgangsrechnung Sanierung Nord',
      classifiedKind: 'ausgangsrechnung',
      documentType: 'ausgangsrechnung',
      sender: OWN_COMPANY,
      vorgangId: undefined,
      vorgangTitle: undefined,
      vorgangLinkStatus: undefined,
      recognizedData: {
        Dokumentart: 'ausgangsrechnung',
        Absender: OWN_COMPANY,
        Lieferant: OWN_COMPANY,
        Rechnungsnummer: 'AR-2026-500',
        Datum: '01.04.2026',
      },
    } as unknown as InboxItem;

    hydrateInboxStore([raw]);
    // Verknüpfung über den einzigen produktiven Schreiber, nicht von Hand.
    expect(linkInboxToExistingVorgang(raw, 'v-out')).toBeTruthy();
    const stored = getInboxItemById('party-dir-out-linked')!;
    expect(stored.vorgangLinkStatus).toBe('linked');

    const workflow = processUploadedDocument(stored.id)!;
    const summary = buildDocumentSummary(stored, workflow, { translate });

    expect(workflow.businessInterpretation?.facts.parties.counterparty?.name).toBe(
      VORGANG_CUSTOMER,
    );
    expect(summary.family).toBe('invoice_out');
    // Der Empfängerpfad über den Vorgangskunden bleibt erhalten.
    expect(factValue(summary, 'customer')).toBe(VORGANG_CUSTOMER);
  });

  it('Ausgangsrechnung ohne Vorgang und ohne sicheren Empfaenger zeigt keinen Empfaenger', () => {
    hydrateVorgangStore([]);

    const item = {
      ...createAuftragInboxItem(),
      id: 'party-dir-out-none',
      classifiedKind: 'ausgangsrechnung',
      documentType: 'ausgangsrechnung',
      sender: OWN_COMPANY,
      recognizedData: {
        Dokumentart: 'ausgangsrechnung',
        Absender: OWN_COMPANY,
        Lieferant: OWN_COMPANY,
        Rechnungsnummer: 'AR-2026-999',
        Datum: '01.04.2026',
      },
    } as unknown as InboxItem;

    const { summary } = realSummary(item);

    expect(summary.family).toBe('invoice_out');
    expect(factValue(summary, 'customer')).toBeUndefined();
    // Die eigene Firma darf nicht ersatzweise als Empfänger erscheinen.
    expect(summary.facts.some((fact) => fact.value === OWN_COMPANY)).toBe(false);
  });
});
