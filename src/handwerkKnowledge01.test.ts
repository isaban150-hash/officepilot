import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { setBrainGenerateTextForTests } from './services/officePilotBrainService';
import { setAiProviderFetchForTests } from './services/aiProviderService';
import {
  detectActiveCapabilities,
  processOfficePilotQuestion,
} from './services/brain/brainOrchestrator';
import {
  buildWorkflowChainText,
  findHandwerkTermsInQuestion,
  getHandwerkTermById,
  isHandwerkKnowledgeQuestion,
} from './services/brain/handwerkKnowledgeRegistry';
import { tryResolveHandwerkKnowledgeQuestion } from './services/brain/handwerkKnowledgeResolver';
import { buildHandwerkAdviceForVorgang } from './services/brain/handwerkContextAdvisor';
import {
  recordInboxContext,
  recordVorgangContext,
  resetCompanySessionForTests,
} from './services/brain/companySessionService';
import {
  createAbschlagInvoice,
  createAuftragInboxItem,
  createOrderPosition,
  createTestVorgang,
} from './test/fixtures';

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

describe('AI-KNOWLEDGE-01 registry', () => {
  it('enthält zentrale Handwerksbegriffe', () => {
    expect(getHandwerkTermById('werkvertrag')?.title).toBe('Werkvertrag');
    expect(getHandwerkTermById('leistungsverzeichnis')?.title).toBe('Leistungsverzeichnis (LV)');
    expect(getHandwerkTermById('vob')?.definition).toMatch(/Vergabe- und Vertragsordnung/);
    expect(getHandwerkTermById('traufe')?.title).toBe('Traufe');
  });

  it('erkennt Fachbegriffe in Fragen', () => {
    const terms = findHandwerkTermsInQuestion('Was ist ein Leistungsverzeichnis und was bedeutet EP?');
    expect(terms.map((t) => t.id)).toEqual(expect.arrayContaining(['leistungsverzeichnis', 'ep']));
    expect(isHandwerkKnowledgeQuestion('Was bedeutet Abschlagsrechnung?')).toBe(true);
  });

  it('beschreibt den typischen Handwerksablauf', () => {
    expect(buildWorkflowChainText()).toContain('Werkvertrag');
    expect(buildWorkflowChainText()).toContain('Schlussrechnung');
    expect(buildWorkflowChainText()).toContain('Gewährleistung');
  });
});

describe('AI-KNOWLEDGE-01 resolver', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompanySessionForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    hydrateVorgangStore([]);
  });

  it('erklärt Fachbegriffe wie LV und VOB', () => {
    const lv = tryResolveHandwerkKnowledgeQuestion('Was ist ein LV?');
    expect(lv?.assistantAnswer?.summary).toMatch(/Leistungspositionen/);

    const vob = tryResolveHandwerkKnowledgeQuestion('Was ist VOB?');
    expect(vob?.source).toBe('memory');
    expect(vob?.assistantAnswer?.summary).toMatch(/Vergabe- und Vertragsordnung/);
    expect(vob?.knowledgeUsed).toContain('vob');
  });

  it('beantwortet Schlussrechnung anhand des aktuellen Auftrags', () => {
    const position = createOrderPosition({ id: 'op-schluss', plannedQuantity: 10 });
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-schluss',
        title: 'Dach Müller',
        orderPositions: [position],
        invoices: [
          createAbschlagInvoice('op-schluss', 10, {
            id: 'inv-full',
            number: 'AR-2026-99',
          }),
        ],
      }),
    ]);
    recordVorgangContext('v-schluss');

    const result = tryResolveHandwerkKnowledgeQuestion('Brauche ich hier eine Schlussrechnung?');
    expect(result?.assistantAnswer?.summary).toMatch(/Schlussrechnung wäre jetzt sinnvoll/);
    expect(result?.suggestedNextSteps?.[0]?.route).toBe('/vorgaenge/v-schluss/rechnung');
  });

  it('erkennt Nachtrag im Dokumentkontext', () => {
    const nachtrag = createAuftragInboxItem({
      id: 'inbox-nachtrag',
      title: 'Nachtrag Dachabdichtung',
      classifiedKind: 'nachtrag',
    });
    hydrateInboxStore([nachtrag]);
    recordInboxContext(nachtrag.id);

    const result = tryResolveHandwerkKnowledgeQuestion('Das sieht nach einem Nachtrag aus');
    expect(result?.assistantAnswer?.summary).toMatch(/Nachtrag/);
    expect(result?.knowledgeUsed).toContain('nachtrag');
  });

  it('erklärt Materialrechnung und Lieferschein', () => {
    const material = tryResolveHandwerkKnowledgeQuestion('Was ist eine Materialrechnung?');
    expect(material?.assistantAnswer?.summary).toMatch(/Lieferanten/);

    const lieferschein = tryResolveHandwerkKnowledgeQuestion('Was ist ein Lieferschein?');
    expect(lieferschein?.knowledgeUsed).toContain('lieferschein');
  });
});

describe('AI-KNOWLEDGE-01 context advisor', () => {
  it('meldet vollständig abgerechnete Positionen', () => {
    const position = createOrderPosition({ id: 'op-done', description: 'Dachfläche eindecken' });
    const vorgang = createTestVorgang({
      orderPositions: [position],
      invoices: [createAbschlagInvoice('op-done', 10)],
    });

    const advice = buildHandwerkAdviceForVorgang(vorgang);
    expect(advice.some((a) => a.messageKey === 'handwerkKnowledge.hint.positionFullyBilled')).toBe(true);
    expect(advice.some((a) => a.messageKey === 'handwerkKnowledge.hint.schlussrechnungDue')).toBe(true);
  });
});

describe('AI-KNOWLEDGE-01 orchestrator', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompanySessionForTests();
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-orch-hk',
        title: 'Bad Müller',
        customer: 'Müller GmbH',
      }),
    ]);
    setBrainGenerateTextForTests(
      vi.fn().mockResolvedValue({ success: true, text: 'Mock-KI mit Handwerkswissen.' }),
    );
    setAiProviderFetchForTests(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setBrainGenerateTextForTests(null);
    setAiProviderFetchForTests(null);
  });

  it('aktiviert Handwerkswissen statt geplanter VOB-Erweiterung bei Grundlagenfragen', async () => {
    const result = await processOfficePilotQuestion('Was ist VOB?', { mode: 'rules' });
    expect(result.source).toBe('memory');
    expect(result.handwerkKnowledgeUsed).toContain('vob');
    expect(result.capabilityId).toBeUndefined();
  });

  it('erkennt construction_knowledge als aktive Fähigkeit', () => {
    const capabilities = detectActiveCapabilities('Was bedeutet Abschlagsrechnung im Werkvertrag?');
    expect(capabilities).toContain('construction_knowledge');
  });

  it('liefert Workflow-Antwort ohne KI', async () => {
    const result = await processOfficePilotQuestion('Wie hängen Werkvertrag und Schlussrechnung zusammen?', {
      mode: 'rules',
    });
    expect(result.source).toBe('memory');
    expect(result.handwerkKnowledgeUsed).toContain('workflow_chain');
    expect(result.assistantAnswer?.bullets[0]).toContain('Werkvertrag');
  });
});
