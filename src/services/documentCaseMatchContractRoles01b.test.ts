/**
 * INBOX-CONTRACT-SECOND-UPLOAD-01B — Vertragsrollen im Fallabgleich.
 *
 * Realbefund (iPhone): Beim zweiten Werkvertrag lautete der Match-Grund
 * „gleicher Lieferant", obwohl die Gegenpartei der Auftraggeber/Kunde ist.
 * Ursache: `item.sender` floss pauschal als `supplier`-Signal ein und wurde
 * gegen `vorgang.customer` verglichen; die eigene Betreiberfirma wurde nirgends
 * herausgefiltert.
 *
 * Erwartung für die Familie Vertrag:
 *  - Absender/Gegenpartei = externer Auftraggeber → `customer`-Signal, Grund
 *    `same_customer`; nie `same_supplier` allein aus dem Absender.
 *  - eigene Firma als Auftragnehmer/Absender → kein Gegenpartei-Signal.
 *  - Lieferantensemantik für Eingangsrechnung/Lieferschein/Tank bleibt.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDocumentCaseMatch, extractDocumentCaseSignals } from './documentCaseMatchService';
import { hydrateCompanyProfileStore, resetCompanyProfile } from './companyProfileService';
import { hydrateVorgangStore } from './vorgangService';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { DEFAULT_COMPANY_PROFILE } from '../data/mockData';

const OWN = 'Cirmak Haustechnik GmbH';
const CUSTOMER = 'NordWest Dachbau GmbH';

beforeEach(() => {
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: OWN });
  hydrateVorgangStore([
    createTestVorgang({
      id: 'vg-roles',
      customer: CUSTOMER,
      baustelle: 'Werkstraße 12, 32657 Lemgo',
      title: 'Heizzentrale Lemgo',
    }),
  ]);
});

describe('Vertrag: Gegenpartei ist Kunde, nicht Lieferant', () => {
  it('R1: Absender = externer Auftraggeber (ohne explizites Kundenfeld) → customer-Signal und same_customer', () => {
    const item = createAuftragInboxItem({
      classifiedKind: 'werkvertrag',
      sender: CUSTOMER,
      recognizedData: { Baustelle: 'Werkstraße 12, 32657 Lemgo', Bauvorhaben: 'Heizzentrale Lemgo' },
    });
    const signals = extractDocumentCaseSignals(item);
    expect(signals.customer).toBe(CUSTOMER);
    expect(signals.supplier).toBeUndefined();

    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('exact');
    expect(match.reasons).toContain('same_customer');
    expect(match.reasons).not.toContain('same_supplier');
  });

  it('R2: eigene Firma als Absender/Auftragnehmer → kein Gegenpartei-Signal, Auftraggeber bleibt Kunde', () => {
    const item = createAuftragInboxItem({
      classifiedKind: 'werkvertrag',
      sender: OWN,
      recognizedData: {
        Auftragnehmer: OWN,
        Auftraggeber: CUSTOMER,
        Baustelle: 'Werkstraße 12, 32657 Lemgo',
      },
    });
    const signals = extractDocumentCaseSignals(item);
    expect(signals.customer).toBe(CUSTOMER);
    expect(signals.supplier).toBeUndefined();
    const match = buildDocumentCaseMatch(item);
    expect(match.reasons).toContain('same_customer');
    expect(match.reasons).not.toContain('same_supplier');
  });

  it('R3: eigene Firma als einziger Kandidat → kein customer-Signal (nie die eigene Firma als Gegenpartei)', () => {
    const item = createAuftragInboxItem({
      classifiedKind: 'werkvertrag',
      sender: OWN,
      recognizedData: { Kunde: OWN, Baustelle: 'Werkstraße 12, 32657 Lemgo' },
    });
    const signals = extractDocumentCaseSignals(item);
    expect(signals.customer).toBeUndefined();
    expect(signals.supplier).toBeUndefined();
  });
});

describe('Lieferantensemantik bleibt für Lieferantendokumente', () => {
  it('R4: Eingangsrechnung mit Absender = Lieferant → supplier-Signal unverändert', () => {
    resetCompanyProfile(OWN);
    const item = createAuftragInboxItem({
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      sender: 'Baustoffe Meier KG',
      recognizedData: { Rechnungsnummer: 'R-77' },
    });
    const signals = extractDocumentCaseSignals(item);
    expect(signals.supplier).toBe('Baustoffe Meier KG');
    expect(signals.customer).toBeUndefined();
  });

  it('R5: Lieferschein/Tankbeleg — Absender bleibt Lieferant', () => {
    for (const kind of ['lieferschein', 'tankbeleg'] as const) {
      const item = createAuftragInboxItem({
        classifiedKind: kind,
        documentType: 'eingangsrechnung',
        sender: 'Lieferant XY',
        recognizedData: {},
      });
      expect(extractDocumentCaseSignals(item).supplier).toBe('Lieferant XY');
    }
  });

  it('R6: explizites Lieferantenfeld gewinnt auch beim Vertrag (keine Extraktoren entfernt)', () => {
    const item = createAuftragInboxItem({
      classifiedKind: 'werkvertrag',
      sender: CUSTOMER,
      recognizedData: { Lieferant: 'Liefer D', Auftraggeber: CUSTOMER },
    });
    const signals = extractDocumentCaseSignals(item);
    expect(signals.supplier).toBe('Liefer D');
    expect(signals.customer).toBe(CUSTOMER);
  });
});
