import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDocumentNarrative } from './services/documentNarrativeService';
import { hydrateVorgangStore } from './services/vorgangService';
import { createAbschlagInvoice, createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import type { WorkflowResult } from './types/models';

function installStorageMocks(): void {
  const createStorage = () => {
    const store = new Map<string, string>();
    return {
      get length() {
        return store.size;
      },
      clear() {
        store.clear();
      },
      getItem(key: string) {
        return store.has(key) ? store.get(key)! : null;
      },
      key(index: number) {
        return Array.from(store.keys())[index] ?? null;
      },
      removeItem(key: string) {
        store.delete(key);
      },
      setItem(key: string, value: string) {
        store.set(key, String(value));
      },
    };
  };

  vi.stubGlobal('localStorage', createStorage());
  vi.stubGlobal('sessionStorage', createStorage());
}

function workflowBase(overrides: Partial<WorkflowResult> = {}): WorkflowResult {
  const item = createAuftragInboxItem();
  return {
    inboxItemId: item.id,
    companyRelevant: true,
    companyRelevance: { isRelevant: true, reasons: [], matchedHints: [] },
    classifiedKind: item.classifiedKind ?? 'sonstiges',
    classificationConfidence: 'high',
    classification: null,
    documentExplanation: null,
    documentUnderstanding: {
      documentType: item.classifiedKind ?? 'sonstiges',
      sender: item.sender,
      nextStep: 'Dokument prüfen.',
      partialRecognition: false,
    },
    documentAiActions: [],
    contractAnalysis: null,
    contractIntelligence: null,
    contractOrderProposal: null,
    suggestedVorgang: null,
    similarVorgaenge: [],
    suggestedOrderPositions: [],
    suggestedTasks: [],
    suggestedArchiveFolder: item.digitalFolder,
    requiredDocuments: [],
    pendingSummary: null,
    warnings: [],
    nextActions: [],
    workflowDecision: {
      inboxItemId: item.id,
      source: 'live',
      companyRelevant: true,
      companyRelevance: { isRelevant: true, reasons: [], matchedHints: [] },
      classifiedKind: item.classifiedKind ?? 'sonstiges',
      classificationConfidence: 'high',
      classification: null,
      documentExplanation: null,
      documentUnderstanding: null,
      documentAiActions: [],
      warnings: [],
      suggestedVorgang: null,
      businessInterpretation: null,
      documentMeaning: null,
      eventType: null,
      primaryDecision: null,
      operationalNextStep: '',
      nextActionCandidates: [],
      nextActions: [],
      taskProposals: [],
      vorgangRef: {
        status: 'none',
        suggested: null,
        linkedVorgangId: null,
        linkedVorgangTitle: null,
        similarCount: 0,
      },
      deadlines: {},
      confirmations: [],
      archiveDecision: {
        isArchived: false,
        canArchive: true,
        recommended: false,
        enabled: false,
      },
      officeActionContext: { availableDocumentActions: [] },
      executionStatus: {
        importedToArchive: false,
        archiveDocumentId: null,
        linkedVorgangId: null,
        linkedVorgangTitle: null,
        hasVorgang: false,
        confirmedFiling: false,
      },
      risks: [],
      workflowAnalysis: null,
    },
    businessInterpretation: {
      readOnly: true,
      sourceDocument: {
        sourceDocumentId: item.id,
        classifiedKind: item.classifiedKind ?? 'sonstiges',
        classificationConfidence: 'high',
        recognitionUncertain: false,
      },
      meaning: {
        eventType: 'review_required',
        certainty: 'uncertain',
        summary: 'Prüfung erforderlich.',
        alternativeEventTypes: [],
      },
      operational: {
        primaryCase: 'review_required',
        meanings: ['review'],
        nextStep: 'Dokument prüfen.',
        confirmRequirement: 'Keine automatische Entscheidung.',
        certainty: 'uncertain',
      },
      vorgangRef: {
        status: 'none',
        suggested: null,
        linkedVorgangId: null,
        linkedVorgangTitle: null,
        similarCount: 0,
      },
      parties: [],
      effects: [],
      missingInformation: [],
      conflicts: [],
      requiredConfirmations: [],
      nextActionCandidates: [],
      facts: {
        parties: {},
        subject: {},
        timeline: {},
        money: [],
        positions: [],
        conditions: [],
        references: [],
      },
      contractFamily: undefined,
      derivedFrom: {
        hasContractIntelligence: false,
        hasContractOrderProposal: false,
        hasClassification: false,
        hasDocumentUnderstanding: true,
        companyRelevant: true,
      },
    },
    ...overrides,
  } as WorkflowResult;
}

describe('DOCUMENT-UNDERSTANDING-01F', () => {
  beforeEach(() => {
    installStorageMocks();
    hydrateVorgangStore([]);
  });

  it('Mahnung + vorhandene Rechnungsreferenz → Beziehung wird angezeigt', () => {
    const vorgang = createTestVorgang({
      id: 'v-01f-1',
      title: 'BV Rüthen',
      invoices: [
        createAbschlagInvoice('op-test-1', 2, {
          id: 'inv-01f-1',
          number: 'RE-2026-104',
          type: 'rechnung',
        }),
      ],
    });
    hydrateVorgangStore([vorgang]);

    const item = createAuftragInboxItem({
      id: 'du-01f-reminder',
      classifiedKind: 'mahnung',
      documentType: 'brief',
      recognizedData: { Rechnungsnummer: 'RE-2026-104' },
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'mahnung',
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'mahnung',
        },
        vorgangRef: {
          status: 'linked',
          linkedVorgangId: vorgang.id,
          linkedVorgangTitle: vorgang.title,
          suggested: null,
          similarCount: 0,
        },
      } as WorkflowResult['businessInterpretation'],
      documentUnderstanding: {
        documentType: 'mahnung',
        invoiceNumber: 'RE-2026-104',
        sender: item.sender,
        nextStep: 'Mahnung prüfen.',
        partialRecognition: false,
      },
    });

    const narrative = buildDocumentNarrative({ item, workflow });
    expect(narrative).toContain('RE-2026-104');
    expect(narrative).toContain('Mahnung');
  });

  it('Werkvertrag + vorhandener Nachtrag → Beziehung wird angezeigt', () => {
    const vorgang = createTestVorgang({
      id: 'v-01f-2',
      title: 'BV Rüthen',
      confirmedOrderAmendments: [
        {
          cloudId: 'coa-1',
          clientAmendmentId: 'draft-1',
          vorgangId: 'v-01f-2',
          sequenceNo: 1,
          status: 'bestaetigt',
          title: 'Nachtrag 1',
          positions: [
            {
              id: 'coa-pos-1',
              changeType: 'add',
              description: 'Zusatzleistung',
              plannedQuantity: 1,
              unit: 'Stück',
              unitPrice: 150,
            },
          ],
          contentFingerprint: 'abc',
          confirmedAt: '2026-08-01T00:00:00.000Z',
          confirmedBy: 'user',
          rowVersion: 1,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });
    hydrateVorgangStore([vorgang]);

    const item = createAuftragInboxItem({
      id: 'du-01f-contract',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'werkvertrag',
      documentUnderstanding: {
        documentType: 'werkvertrag',
        sender: item.sender,
        nextStep: 'Werkvertrag prüfen.',
        partialRecognition: false,
      },
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'werkvertrag',
        },
        vorgangRef: {
          status: 'linked',
          linkedVorgangId: vorgang.id,
          linkedVorgangTitle: vorgang.title,
          suggested: null,
          similarCount: 0,
        },
        contractFamily: 'werkvertrag',
      } as WorkflowResult['businessInterpretation'],
    });

    const narrative = buildDocumentNarrative({ item, workflow });
    expect(narrative).toContain('Nachtrag');
    expect(narrative).toContain('Werkvertrag');
  });

  it('Keine belegte Beziehung → keine Beziehung wird erfunden', () => {
    const item = createAuftragInboxItem({
      id: 'du-01f-none',
      classifiedKind: 'mahnung',
      documentType: 'brief',
      recognizedData: { Rechnungsnummer: 'RE-404' },
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'mahnung',
      documentUnderstanding: {
        documentType: 'mahnung',
        invoiceNumber: 'RE-404',
        sender: item.sender,
        nextStep: 'Mahnung prüfen.',
        partialRecognition: false,
      },
    });

    const narrative = buildDocumentNarrative({ item, workflow });
    expect(narrative).not.toContain('bezieht sich auf die Rechnung');
    expect(narrative).not.toContain('Nachtrag');
    expect(narrative).not.toContain('Abschlagsrechnung');
  });
});
