import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { setBrainGenerateTextForTests } from './services/officePilotBrainService';
import { setAiProviderFetchForTests } from './services/aiProviderService';
import { processOfficePilotQuestion } from './services/brain/brainOrchestrator';
import {
  isFollowUpQuestion,
  tryResolveCompanyContextQuestion,
} from './services/brain/companyContextResolver';
import { buildProactiveHints } from './services/brain/companyProactiveHintsService';
import {
  getCompanySession,
  recordInboxContext,
  recordVorgangContext,
  resetCompanySessionForTests,
} from './services/brain/companySessionService';
import { createAuftragInboxItem, createMaterialInboxItem, createTestVorgang } from './test/fixtures';

const testProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

describe('AI-COMPANY-01 session service', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompanySessionForTests();
    hydrateCompanyProfileStore(testProfile);
  });

  it('speichert Auftragskontext beim Öffnen eines Vorgangs', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-company-1',
        title: 'Sanierung Müller',
        customer: 'Müller GmbH',
        baustelle: 'Hauptstraße 5',
      }),
    ]);

    recordVorgangContext('v-company-1');
    const session = getCompanySession();

    expect(session.currentVorgangId).toBe('v-company-1');
    expect(session.currentCustomer).toBe('Müller GmbH');
    expect(session.currentBaustelle).toBe('Hauptstraße 5');
    expect(session.lastAction).toBe('view_vorgang');
  });

  it('merkt sich Gesprächsverlauf', async () => {
    await processOfficePilotQuestion('Wer ist der Kunde?', { mode: 'rules' });
    const session = getCompanySession();
    expect(session.conversationTurns).toContain('Wer ist der Kunde?');
  });
});

describe('AI-COMPANY-01 context resolver', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompanySessionForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    hydrateVorgangStore([]);
  });

  it('erkennt Folgefragen', () => {
    expect(isFollowUpQuestion('Schreib jetzt die Rechnung')).toBe(true);
    expect(isFollowUpQuestion('Wer ist der Kunde?')).toBe(true);
    expect(isFollowUpQuestion('Zeige offene Vorgänge')).toBe(false);
  });

  it('beantwortet Kundenfrage aus aktuellem Vorgang', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-mueller',
        title: 'Bad Müller',
        customer: 'Müller GmbH',
        baustelle: 'Gartenweg 3',
      }),
    ]);
    recordVorgangContext('v-mueller');

    const result = tryResolveCompanyContextQuestion('Wer ist der Kunde?');
    expect(result?.assistantAnswer?.summary).toContain('Müller GmbH');
    expect(result?.contextUsed).toContain('customer');
  });

  it('schlägt Rechnungserstellung für gemerkten Auftrag vor', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-invoice',
        title: 'Heizung Schmidt',
        customer: 'Schmidt OHG',
      }),
    ]);
    recordVorgangContext('v-invoice');

    const result = tryResolveCompanyContextQuestion('Schreib jetzt die Rechnung');
    expect(result?.assistantAnswer?.summary).toContain('Heizung Schmidt');
    expect(result?.suggestedNextSteps?.[0]?.route).toBe('/vorgaenge/v-invoice/rechnung');
  });

  it('stellt Rückfrage bei mehreren passenden Aufträgen', () => {
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', title: 'Auftrag A', customer: 'Müller GmbH', baustelle: 'Straße 1' }),
      createTestVorgang({ id: 'v-b', title: 'Auftrag B', customer: 'Müller GmbH', baustelle: 'Straße 2' }),
    ]);

    const material = createMaterialInboxItem();
    material.id = 'inbox-material-company';
    material.recognizedData = { Kunde: 'Müller GmbH', Baustelle: 'Straße 1' };
    hydrateInboxStore([material]);
    recordInboxContext(material.id, 'upload_document');

    const result = tryResolveCompanyContextQuestion('Ordne diese Materialrechnung zu');
    expect(result?.source).toBe('clarification');
    expect(result?.assistantAnswer?.bullets.length).toBeGreaterThan(1);
    expect(result?.clarificationQuestion).toBe('companyContext.clarification.whichVorgang');
  });
});

describe('AI-COMPANY-01 orchestrator integration', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompanySessionForTests();
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-flow',
        title: 'Werkvertrag Müller',
        customer: 'Müller GmbH',
        baustelle: 'Ringstraße 9',
      }),
    ]);
    setBrainGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Mock-KI mit Session-Kontext.',
      }),
    );
    setAiProviderFetchForTests(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setBrainGenerateTextForTests(null);
    setAiProviderFetchForTests(null);
    resetCompanySessionForTests();
  });

  it('verknüpft Werkvertrag und Folgefrage zur Rechnung', async () => {
    const contract = createAuftragInboxItem({
      id: 'inbox-werkvertrag',
      title: 'Werkvertrag Müller',
      vorgangId: 'v-flow',
      recognizedData: {
        Kunde: 'Müller GmbH',
        Baustelle: 'Ringstraße 9',
        Angebotssumme: '12.500,00 €',
        Leistung: 'Sanitär',
      },
    });
    hydrateInboxStore([contract]);
    recordInboxContext(contract.id);

    const accept = await processOfficePilotQuestion('Nimm diesen Werkvertrag.', { mode: 'rules' });
    expect(accept.assistantAnswer?.summary).toContain('Werkvertrag');

    const invoice = await processOfficePilotQuestion('Schreib jetzt die Rechnung.', { mode: 'rules' });
    expect(invoice.source).toBe('rules');
    expect(invoice.assistantAnswer?.summary).toContain('Werkvertrag Müller');
    expect(invoice.suggestedNextSteps.some((s) => s.route === '/vorgaenge/v-flow/rechnung')).toBe(true);
    expect(invoice.companyContextUsed).toContain('vorgang');
  });

  it('liefert proaktive Hinweise ohne erfundene Daten', async () => {
    recordVorgangContext('v-flow');
    const hints = buildProactiveHints(getCompanySession());
    expect(hints.some((h) => h.messageKey === 'companyContext.hint.noInvoiceOnVorgang')).toBe(true);
  });

  it('nutzt Session-Kontext für Kommunikationsentwürfe', async () => {
    recordVorgangContext('v-flow');

    const result = await processOfficePilotQuestion('Schreibe dem Kunden eine höfliche Absage', {
      mode: 'rules',
    });
    expect(result.source).toBe('rules');
    expect(result.assistantAnswer?.summary).toContain('Werkvertrag Müller');
    expect(result.suggestedNextSteps.some((s) => s.route?.includes('/kommunikation'))).toBe(true);
  });
});
