import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInboxDocumentAssistant } from './services/documentAssistantService';
import { buildDocumentAiContextFromInbox } from './services/document/documentAiContextService';
import { createAuftragInboxItem } from './test/fixtures';
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
    classifiedKind: item.classifiedKind ?? 'werkvertrag',
    classificationConfidence: 'high',
    classification: null,
    documentExplanation: null,
    documentUnderstanding: {
      documentType: 'werkvertrag',
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
      classifiedKind: item.classifiedKind ?? 'werkvertrag',
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
        classifiedKind: item.classifiedKind ?? 'werkvertrag',
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

describe('DOCUMENT-UNDERSTANDING-01B', () => {
  beforeEach(() => {
    installStorageMocks();
  });

  it('Assistant zeigt vorhandene missing-Aussagen in missingItems und nicht als uncertainFields', () => {
    const item = createAuftragInboxItem({
      id: 'du-01b-assistant',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'werkvertrag',
      requiredDocuments: [
        { type: 'freistellung', priority: 'hoch', reason: 'Freistellungsbescheinigung fehlt.' },
      ],
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'werkvertrag',
        },
        missingInformation: [
          { id: 'site', summary: 'Die Baustelle ist aus dem Dokument nicht eindeutig erkennbar.', certainty: 'uncertain' },
        ],
        requiredConfirmations: [
          { id: 'confirm_positions', summary: 'Die Leistungspositionen sollten bestätigt werden.', required: true },
        ],
        conflicts: [
          { id: 'truth-conflict', summary: 'Der bestehende Leistungsplan sollte vor Änderungen geprüft werden.', certainty: 'conflicting' },
        ],
      } as WorkflowResult['businessInterpretation'],
    });

    const assistant = buildInboxDocumentAssistant(item, workflow, 'de');
    expect(assistant.missingItems).toEqual(
      expect.arrayContaining([
        'Die Baustelle ist aus dem Dokument nicht eindeutig erkennbar.',
        'Die Leistungspositionen sollten bestätigt werden.',
        'Freistellungsbescheinigung fehlt.',
      ]),
    );
    expect(assistant.uncertainFields.map((field) => field.labelKey)).not.toEqual(
      expect.arrayContaining([
        'Die Baustelle ist aus dem Dokument nicht eindeutig erkennbar.',
        'Die Leistungspositionen sollten bestätigt werden.',
        'Freistellungsbescheinigung fehlt.',
      ]),
    );
  });

  it('AI-Kontext übernimmt vorhandene missing-Aussagen zusätzlich in missingFieldNotes', () => {
    const item = createAuftragInboxItem({
      id: 'du-01b-context',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'werkvertrag',
      requiredDocuments: [
        { type: 'freistellung', priority: 'hoch', reason: 'Freistellungsbescheinigung fehlt.' },
      ],
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'werkvertrag',
        },
        missingInformation: [
          { id: 'site', summary: 'Die Baustelle ist aus dem Dokument nicht eindeutig erkennbar.', certainty: 'uncertain' },
        ],
        requiredConfirmations: [
          { id: 'confirm_positions', summary: 'Die Leistungspositionen sollten bestätigt werden.', required: true },
        ],
      } as WorkflowResult['businessInterpretation'],
    });

    const context = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    expect(context.missingFieldNotes).toEqual(
      expect.arrayContaining([
        'Die Baustelle ist aus dem Dokument nicht eindeutig erkennbar.',
        'Die Leistungspositionen sollten bestätigt werden.',
        'Freistellungsbescheinigung fehlt.',
      ]),
    );
  });
});