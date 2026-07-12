import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { processOfficePilotQuestion } from './services/brain/brainOrchestrator';
import {
  analyzeInboxWorkflow,
  analyzeVorgangWorkflow,
} from './services/brain/workflowIntelligenceService';
import {
  isWorkflowQuestion,
  tryResolveWorkflowQuestion,
} from './services/brain/workflowKnowledgeResolver';
import {
  recordInboxContext,
  recordVorgangContext,
  resetCompanySessionForTests,
} from './services/brain/companySessionService';
import { WORKFLOW_INTELLIGENCE_I18N_KEYS } from './types/workflowIntelligence';
import { de, t, tr } from './i18n';
import {
  createAbschlagInvoice,
  createAuftragInboxItem,
  createMaterialInboxItem,
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

describe('AI-WORKFLOW-01 intelligence service', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompanySessionForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    hydrateVorgangStore([]);
  });

  it('empfiehlt Auftrag aus Werkvertrag ohne Vorgang', () => {
    const contract = createAuftragInboxItem({
      id: 'inbox-wf-contract',
      title: 'Werkvertrag Müller',
      classifiedKind: 'werkvertrag',
    });
    hydrateInboxStore([contract]);

    const analysis = analyzeInboxWorkflow(contract.id);
    expect(analysis?.recommendations[0]?.messageKey).toBe(
      'workflowIntelligence.recommend.createVorgangFromContract',
    );
    expect(analysis?.steps.find((s) => s.id === 'auftrag')?.status).toBe('missing');
  });

  it('ordnet Material wahrscheinlich dem passenden Auftrag zu', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-wf-mat',
        title: 'Sanierung Müller',
        customer: 'Müller GmbH',
        baustelle: 'Hauptstraße 1',
      }),
    ]);
    const material = createMaterialInboxItem();
    material.id = 'inbox-wf-mat';
    material.recognizedData = { Kunde: 'Müller GmbH', Baustelle: 'Hauptstraße 1' };
    hydrateInboxStore([material]);

    const analysis = analyzeInboxWorkflow(material.id);
    expect(analysis?.recommendations[0]?.messageKey).toBe(
      'workflowIntelligence.recommend.linkMaterialToVorgang',
    );
    expect(analysis?.risks.some((r) => r.id === 'material_without_vorgang')).toBe(false);
  });

  it('erkennt fehlende Schlussrechnung bei vollständig abgerechneten Positionen', () => {
    const position = createOrderPosition({ id: 'op-wf-schluss', plannedQuantity: 8 });
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-wf-schluss',
        title: 'Heizung Schmidt',
        orderPositions: [position],
        invoices: [createAbschlagInvoice('op-wf-schluss', 8, { id: 'inv-wf-full' })],
      }),
    ]);

    const analysis = analyzeVorgangWorkflow('v-wf-schluss');
    expect(analysis?.recommendations.some((r) => r.id === 'create_schluss')).toBe(true);
    expect(analysis?.steps.find((s) => s.id === 'schlussrechnung')?.status).toBe('at_risk');
  });

  it('warnt bei Material ohne Lieferschein nur bei erwartetem Lieferprozess', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-wf-ls',
        title: 'Dach Müller',
        orderPositions: [createOrderPosition({ category: 'material' })],
      }),
    ]);
    const material = createMaterialInboxItem();
    material.id = 'inbox-wf-ls';
    material.vorgangId = 'v-wf-ls';
    hydrateInboxStore([material]);

    const analysis = analyzeVorgangWorkflow('v-wf-ls');
    expect(analysis?.risks.some((r) => r.id === 'material_without_lieferschein')).toBe(true);
    expect(analysis?.recommendations.some((r) => r.id === 'collect_lieferschein')).toBe(true);
  });

  it('meldet kein Lieferschein-Risiko bei einzelner Materialrechnung ohne Materialprozess', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-wf-no-ls', title: 'Kleinarbeit' })]);
    const material = createMaterialInboxItem();
    material.id = 'inbox-wf-no-ls';
    material.vorgangId = 'v-wf-no-ls';
    hydrateInboxStore([material]);

    const analysis = analyzeVorgangWorkflow('v-wf-no-ls');
    expect(analysis?.risks.some((r) => r.id === 'material_without_lieferschein')).toBe(false);
    expect(analysis?.steps.find((s) => s.id === 'lieferschein')?.status).toBe('not_applicable');
  });

  it('erlaubt Auftrag ohne formellen Werkvertrag bei belastbarer Auftragsgrundlage', () => {
    const position = createOrderPosition({ id: 'op-with-basis' });
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-with-basis',
        title: 'Sanierung Müller',
        customer: 'Müller GmbH',
        orderPositions: [position],
        invoices: [createAbschlagInvoice(position.id, 2, { id: 'inv-with-basis' })],
      }),
    ]);
    const auftrag = createAuftragInboxItem({
      id: 'inbox-auftrag-basis',
      classifiedKind: 'auftrag',
      vorgangId: 'v-with-basis',
    });
    hydrateInboxStore([auftrag]);

    const analysis = analyzeVorgangWorkflow('v-with-basis');
    expect(analysis?.risks.some((r) => r.id === 'invoice_without_contract')).toBe(false);
    expect(analysis?.steps.find((s) => s.id === 'werkvertrag')?.status).toBe('not_applicable');
  });

  it('warnt nur bei Rechnung ohne jede belastbare Auftragsgrundlage', () => {
    const position = createOrderPosition({ id: 'op-no-contract' });
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-no-contract',
        title: '',
        customer: 'unbekannt',
        orderPositions: [],
        invoices: [createAbschlagInvoice(position.id, 1, { id: 'inv-no-contract' })],
      }),
    ]);

    const analysis = analyzeVorgangWorkflow('v-no-contract');
    expect(analysis?.risks.some((r) => r.id === 'invoice_without_contract')).toBe(true);
  });

  it('markiert Abschlagsrechnung nicht automatisch als fehlend', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-no-abschlag',
        title: 'Neubau Weber',
        orderPositions: [createOrderPosition({ id: 'op-no-abschlag', plannedQuantity: 10 })],
      }),
    ]);

    const analysis = analyzeVorgangWorkflow('v-no-abschlag');
    const abschlag = analysis?.steps.find((s) => s.id === 'abschlagsrechnung');
    expect(abschlag?.status).toBe('not_due');
    expect(analysis?.steps.some((s) => s.id === 'abschlagsrechnung' && s.status === 'missing')).toBe(
      false,
    );
  });

  it('setzt Gewährleistung vor Abnahme auf not_due', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-gew-not-due',
        title: 'Fassade Klein',
        orderPositions: [createOrderPosition({ id: 'op-gew' })],
      }),
    ]);

    const analysis = analyzeVorgangWorkflow('v-gew-not-due');
    expect(analysis?.steps.find((s) => s.id === 'gewaehrleistung')?.status).toBe('not_due');
    expect(analysis?.steps.find((s) => s.id === 'abnahme')?.status).toBe('not_due');
  });

  it('verlangt Aufmaß nur bei echtem Bedarf', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-no-aufmass',
        title: 'Pauschalauftrag',
        orderPositions: [createOrderPosition({ id: 'op-pauschal', unit: 'Stück' })],
      }),
    ]);

    const analysis = analyzeVorgangWorkflow('v-no-aufmass');
    expect(analysis?.steps.find((s) => s.id === 'aufmasz')?.status).toBe('not_applicable');
    expect(analysis?.risks.some((r) => r.id === 'schluss_without_aufmasz')).toBe(false);
  });

  it('meldet keine Dublette bei gleicher Rechnungsnummer und verschiedenen Lieferanten', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-dup-diff', title: 'Bad Dup' })]);
    const first = createMaterialInboxItem();
    first.id = 'inbox-dup-diff-1';
    first.vorgangId = 'v-dup-diff';
    first.recognizedData = {
      Rechnungsnummer: 'MR-100',
      Lieferant: 'Sanitär Großhandel',
      Betrag: '120,00 €',
      Rechnungsdatum: '2026-01-10',
    };
    const second = createMaterialInboxItem();
    second.id = 'inbox-dup-diff-2';
    second.vorgangId = 'v-dup-diff';
    second.recognizedData = {
      Rechnungsnummer: 'MR-100',
      Lieferant: 'Elektro Fachmarkt',
      Betrag: '120,00 €',
      Rechnungsdatum: '2026-01-11',
    };
    hydrateInboxStore([first, second]);

    const analysis = analyzeVorgangWorkflow('v-dup-diff');
    expect(analysis?.risks.some((r) => r.id === 'duplicate_material')).toBe(false);
  });

  it('erkennt echte doppelte Materialrechnung mit Nummer, Lieferant, Betrag und Datum', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-dup', title: 'Bad Dup' })]);
    const first = createMaterialInboxItem();
    first.id = 'inbox-dup-1';
    first.vorgangId = 'v-dup';
    first.recognizedData = {
      Rechnungsnummer: 'MR-100',
      Lieferant: 'Sanitär Großhandel',
      Betrag: '120,00 €',
      Rechnungsdatum: '2026-01-10',
    };
    const second = createMaterialInboxItem();
    second.id = 'inbox-dup-2';
    second.vorgangId = 'v-dup';
    second.recognizedData = {
      Rechnungsnummer: 'MR-100',
      Lieferant: 'Sanitär Großhandel',
      Betrag: '120,00 €',
      Rechnungsdatum: '2026-01-12',
    };
    hydrateInboxStore([first, second]);

    const analysis = analyzeVorgangWorkflow('v-dup');
    expect(analysis?.risks.some((r) => r.id === 'duplicate_material')).toBe(true);
  });

  it('begrenzt Risiken und Empfehlungen auf maximal 5 priorisierte Hinweise', () => {
    const position = createOrderPosition({ id: 'op-cap', plannedQuantity: 10, category: 'material' });
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-cap',
        title: '',
        customer: 'unbekannt',
        orderPositions: [position],
        invoices: [createAbschlagInvoice(position.id, 3, { id: 'inv-cap' })],
      }),
    ]);
    const materials = Array.from({ length: 4 }, (_, index) => {
      const item = createMaterialInboxItem();
      item.id = `inbox-cap-${index}`;
      item.vorgangId = 'v-cap';
      item.recognizedData = {
        Rechnungsnummer: 'MR-CAP',
        Lieferant: 'Sanitär Großhandel',
        Betrag: '99,00 €',
        Rechnungsdatum: `2026-01-${10 + index}`,
      };
      return item;
    });
    hydrateInboxStore(materials);

    const analysis = analyzeVorgangWorkflow('v-cap');
    expect(analysis?.risks.length).toBeLessThanOrEqual(5);
    expect(analysis?.recommendations.length).toBeLessThanOrEqual(5);
    if (analysis && analysis.recommendations.length > 1) {
      expect(analysis.recommendations[0].priority).toBeLessThanOrEqual(
        analysis.recommendations[analysis.recommendations.length - 1].priority,
      );
    }
  });
});

describe('AI-WORKFLOW-01 i18n DE/TR', () => {
  it('hat vollständige workflowIntelligence-Keys in DE und TR ohne Fallback', () => {
    for (const key of WORKFLOW_INTELLIGENCE_I18N_KEYS) {
      const deValue = de[key as keyof typeof de];
      const trValue = tr[key as keyof typeof tr];
      const translated = t(key as keyof typeof de, 'tr');

      expect(deValue, `${key} fehlt in DE`).toBeTruthy();
      expect(trValue, `${key} fehlt in TR`).toBeTruthy();
      expect(trValue?.trim(), `${key} ist leer in TR`).not.toBe('');
      expect(trValue, `${key} nutzt deutschen Fallback`).not.toBe(deValue);
      expect(translated, `${key} fällt auf DE zurück`).toBe(trValue);
      expect(translated).not.toMatch(/^workflowIntelligence\./);
    }
  });
});

describe('AI-WORKFLOW-01 resolver and orchestrator', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompanySessionForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-wf-orch',
        title: 'Bad Müller',
        customer: 'Müller GmbH',
        orderPositions: [createOrderPosition({ id: 'op-orch', plannedQuantity: 10 })],
      }),
    ]);
  });

  it('erkennt Workflow-Fragen', () => {
    expect(isWorkflowQuestion('Was fehlt noch bei diesem Auftrag?')).toBe(true);
    expect(isWorkflowQuestion('Was ist VOB?')).toBe(false);
  });

  it('liefert Workflow-Stand mit erledigt/fehlend', () => {
    recordVorgangContext('v-wf-orch');
    const result = tryResolveWorkflowQuestion('Was fehlt noch?');
    expect(result?.assistantAnswer?.summary).toMatch(/erledigt|fehlen/);
    expect(result?.assistantAnswer?.bullets.some((b) => b.startsWith('✓'))).toBe(true);
    expect(result?.workflowSummary?.scopeTitle).toBe('Bad Müller');
    expect(result?.workflowSummary?.notDueSteps?.length).toBeGreaterThan(0);
  });

  it('integriert Workflow-Antworten im Orchestrator', async () => {
    recordVorgangContext('v-wf-orch');
    const result = await processOfficePilotQuestion('Was soll als Nächstes passieren?', {
      mode: 'rules',
    });
    expect(result.source).toBe('rules');
    expect(result.workflowUsed).toContain('workflow_intelligence');
    expect(result.assistantAnswer?.bullets.length).toBeGreaterThan(0);
  });
});
