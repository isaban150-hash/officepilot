/**
 * GOLD-PDF-PARTY-DIRECTION-02 — Richtung der Parteifelder bei ausgehenden Dokumenten.
 *
 * Empfänger eines ausgehenden Dokuments: Auftraggeber → Kunde → Empfänger.
 * Aussteller / eigene Firma: Absender → Lieferant → item.sender.
 * Die beiden Richtungen dürfen einander nie vertreten. Fehlt der Empfänger, entfällt
 * der customer-Fakt — ein leeres Feld ist korrekt, die eigene Firma als Kunde ist falsch.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildInboxDocumentSummary } from './documentSummary';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateInboxStore } from './inboxService';
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
