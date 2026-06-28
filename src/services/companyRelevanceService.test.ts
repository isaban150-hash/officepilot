import { describe, expect, it, beforeEach } from 'vitest';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from './companyProfileService';
import {
  buildCompanyRelevanceInputFromInbox,
  checkCompanyRelevance,
  checkCompanyRelevanceFromInbox,
  isDocumentAnalysisAllowed,
} from './companyRelevanceService';
import { hydrateVorgangStore } from './vorgangService';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import type { CompanyProfile, InboxItem } from '../types/models';

const testProfile: CompanyProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030 998877',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage netto',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

function createInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-relevance-test',
    title: 'Dokument',
    documentType: 'brief',
    sender: 'Unbekannt',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'abheften',
    digitalFolder: { id: 'dig-1', name: 'Test', path: '/test/' },
    paperFiling: { folderId: 'folder-5', register: 'A', label: 'Test' },
    status: 'neu',
    receivedAt: '2026-06-01',
    recognizedData: {},
    officePilotSuggestion: 'Vorschlag',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Hinweis',
    ...overrides,
  };
}

describe('companyRelevanceService', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-mueller',
        title: 'Badezimmer-Sanierung Müller',
        customer: 'Familie Müller',
        baustelle: 'Hauptstr. 12, Berlin',
      }),
    ]);
  });

  it('erlaubt Analyse bei Firmenname im Text', () => {
    const result = checkCompanyRelevance({
      text: 'Schreiben an Mustermann Sanitär GmbH',
    });
    expect(result.isRelevant).toBe(true);
    expect(result.reasons).toContain('company_name');
  });

  it('erlaubt Analyse bei Geschäftsführer/Inhaber im Text', () => {
    const result = checkCompanyRelevance({
      text: 'An Max Mustermann, Handwerkerweg 7',
    });
    expect(result.isRelevant).toBe(true);
    expect(result.reasons).toContain('contact_person');
  });

  it('erlaubt Analyse bei Firmenadresse im Text', () => {
    const result = checkCompanyRelevance({
      text: 'Lieferung an Handwerkerweg 7, 10115 Berlin',
    });
    expect(result.isRelevant).toBe(true);
    expect(result.reasons).toContain('company_address');
  });

  it('erlaubt Analyse bei Baustelle/Vorgang im Text', () => {
    const result = checkCompanyRelevanceFromInbox(
      createInboxItem({
        recognizedData: { Baustelle: 'Hauptstr. 12, Berlin', Vorgang: 'Badezimmer-Sanierung Müller' },
      }),
    );
    expect(result.isRelevant).toBe(true);
    expect(result.reasons).toContain('vorgang_reference');
  });

  it('erlaubt Analyse bei Steuer- oder USt-ID', () => {
    const byTax = checkCompanyRelevance({ text: 'Steuernummer 27/123/45678' });
    const byVat = checkCompanyRelevance({ text: 'USt-IdNr. DE123456789' });
    expect(byTax.isRelevant).toBe(true);
    expect(byVat.isRelevant).toBe(true);
  });

  it('blockiert privaten Brief ohne Firmenbezug', () => {
    const result = checkCompanyRelevance({
      text: 'Liebe Maria, ich hoffe es geht dir gut. Viele Grüße, Anna',
    });
    expect(result.isRelevant).toBe(false);
    expect(isDocumentAnalysisAllowed(createInboxItem({ recognizedData: { Betreff: 'Privat' } }))).toBe(
      false,
    );
  });

  it('blockiert private Rechnung ohne Firmenbezug', () => {
    const result = checkCompanyRelevance({
      text: 'Rechnung Nr. PRIV-001\nRechnungsnummer: PRIV-001\nBetrag 120,00 €',
    });
    expect(result.isRelevant).toBe(false);
  });

  it('erlaubt Analyse nach manueller Markierung als Firmendokument', () => {
    const item = createInboxItem({
      recognizedData: { Betreff: 'Privat' },
      markedAsCompanyDocument: true,
    });
    const result = checkCompanyRelevanceFromInbox(item);
    expect(result.isRelevant).toBe(true);
    expect(result.reasons).toContain('manual_override');
    expect(isDocumentAnalysisAllowed(item)).toBe(true);
  });

  it('erkennt Kundenbezug über Vorgang', () => {
    const item = createInboxItem({
      sender: 'Familie Müller',
      recognizedData: { Kunde: 'Familie Müller' },
    });
    const result = checkCompanyRelevanceFromInbox(item);
    expect(result.isRelevant).toBe(true);
    expect(result.reasons).toContain('customer_reference');
  });

  it('erkennt BG-Bezug mit Firmenanker', () => {
    const result = checkCompanyRelevance({
      text: 'BG BAU Schreiben für Mustermann Sanitär GmbH, Betriebsnummer 12345678',
    });
    expect(result.isRelevant).toBe(true);
    expect(result.reasons).toContain('authority_reference');
  });

  it('baut Inbox-Input inklusive Vertragstext', () => {
    const input = buildCompanyRelevanceInputFromInbox(
      createInboxItem({
        recognizedData: { _vertragstext: SAMPLE_WERKVERTRAG_TEXT },
      }),
    );
    expect(input.text).toContain('Subunternehmer');
    expect(checkCompanyRelevance(input).isRelevant).toBe(true);
  });
});
