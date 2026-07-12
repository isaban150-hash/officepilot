import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { setBrainGenerateTextForTests } from './services/officePilotBrainService';
import { setAiProviderFetchForTests } from './services/aiProviderService';
import {
  assessBrainIntent,
  detectActiveCapabilities,
  detectPlannedCapability,
  processOfficePilotQuestion,
} from './services/brain/brainOrchestrator';
import { createTestVorgang } from './test/fixtures';

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

describe('AI-BRAIN-01 capability registry', () => {
  it('erkennt geplante Erweiterungen ohne sie zu aktivieren', () => {
    const weather = detectPlannedCapability('Wie ist das Bauwetter morgen in Berlin?');
    expect(weather?.id).toBe('weather');
    expect(weather?.status).toBe('planned');
  });

  it('erkennt aktive Fähigkeiten im Fragekontext', () => {
    const capabilities = detectActiveCapabilities('Welche Rechnungen sind offen?');
    expect(capabilities).toContain('invoices');
  });
});

describe('AI-BRAIN-01 intent registry', () => {
  it('priorisiert Gedächtnis- und Kommunikationsintents', () => {
    const memory = assessBrainIntent('Wo liegt meine Freistellungsbescheinigung?');
    expect(memory.category).toBe('memory');

    const comm = assessBrainIntent('Formuliere eine höfliche Absage an den Kunden');
    expect(comm.category).toBe('communication_draft');
    expect(comm.needsContext).toBe(true);
  });
});

describe('AI-BRAIN-01 orchestrator', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-brain-orch',
        title: 'Sanierung Brain',
        customer: 'Müller GmbH',
        status: 'in_bearbeitung',
      }),
    ]);
    setBrainGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Mock-KI: Basierend auf den Daten ist aktuell nichts Kritisches offen.',
      }),
    );
    setAiProviderFetchForTests(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setBrainGenerateTextForTests(null);
    setAiProviderFetchForTests(null);
  });

  it('nutzt Regeln für Betriebsfragen ohne KI', async () => {
    const result = await processOfficePilotQuestion('Zeige offene Vorgänge', { mode: 'rules' });
    expect(result.source).toBe('rules');
    expect(result.confidence).toBe('high');
    expect(result.assistantAnswer?.bullets.length).toBeGreaterThan(0);
    expect(result.brainAnswer).toBeUndefined();
  });

  it('markiert geplante Fähigkeiten klar und erfindet keine Antwort', async () => {
    const result = await processOfficePilotQuestion('Recherchiere online aktuelle Zementpreise', {
      mode: 'smart',
    });
    expect(result.source).toBe('planned_capability');
    expect(result.capabilityId).toBe('material_prices');
    expect(result.confidence).toBe('low');
    expect(result.clarificationQuestion).toBeTruthy();
  });

  it('fordert Kontext für Kommunikationsentwürfe', async () => {
    const result = await processOfficePilotQuestion('Schreibe dem Kunden eine höfliche Absage', {
      mode: 'rules',
    });
    expect(result.source).toBe('clarification');
    expect(result.suggestedNextSteps.some((step) => step.route === '/kommunikation')).toBe(true);
  });

  it('eskaliert bei Deep-Modus zur KI ohne erfundene Fakten', async () => {
    const result = await processOfficePilotQuestion('Was ist wichtig im Betrieb?', { mode: 'deep' });
    expect(result.source).toBe('ai');
    expect(result.brainAnswer?.text).toContain('Mock-KI');
    expect(result.uncertaintyNote).toBeTruthy();
  });

  it('schlägt nächste Schritte bei fehlenden lokalen Daten vor', async () => {
    const result = await processOfficePilotQuestion('Wie hoch ist der Umsatz 2099?', { mode: 'rules' });
    expect(result.source).toBe('clarification');
    expect(result.suggestedNextSteps.length).toBeGreaterThan(0);
  });
});
