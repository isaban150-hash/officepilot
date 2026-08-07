import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInboxDocumentAssistant } from './services/documentAssistantService';
import { buildDocumentGuidance } from './services/documentGuidanceService';
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
    classifiedKind: item.classifiedKind ?? 'eingangsrechnung',
    classificationConfidence: 'high',
    classification: null,
    documentExplanation: null,
    documentUnderstanding: {
      documentType: 'eingangsrechnung',
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
      classifiedKind: item.classifiedKind ?? 'eingangsrechnung',
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
        classifiedKind: item.classifiedKind ?? 'eingangsrechnung',
        classificationConfidence: 'high',
        recognitionUncertain: false,
      },
      meaning: {
        eventType: 'invoice_received',
        certainty: 'detected',
        summary: 'Eingangsrechnung — Ausgabe und möglicher Vorgangsbezug, keine Buchung ohne Freigabe.',
        alternativeEventTypes: [],
      },
      operational: {
        primaryCase: 'invoice_received',
        meanings: ['money', 'action_required'],
        nextStep: 'Rechnung und Leistung abgleichen.',
        confirmRequirement: 'Keine automatische Buchung.',
        certainty: 'detected',
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

describe('DOCUMENT-UNDERSTANDING-01E', () => {
  beforeEach(() => {
    installStorageMocks();
  });

  it('Rechnung: Handlung bleibt ohne künstliche Begründung, wenn keine direkte Zuordnung existiert', () => {
    const item = createAuftragInboxItem({
      id: 'du-01e-invoice',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'eingangsrechnung',
    });

    const guidance = buildDocumentGuidance(item, workflow, 'de');
    const assistant = buildInboxDocumentAssistant(item, workflow, 'de');

    expect(guidance.actions[0]?.labelKey).not.toContain('Grund:');
    expect(assistant.actionSteps[0]?.key).not.toContain('Grund:');
  });

  it('Vertrag: Handlung bleibt ohne globale Bestätigungs-Begründung, wenn keine direkte Action-Zuordnung existiert', () => {
    const item = createAuftragInboxItem({
      id: 'du-01e-contract',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'werkvertrag',
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'werkvertrag',
        },
        requiredConfirmations: [
          { id: 'confirm_positions', summary: 'Die Leistungspositionen sollten bestätigt werden.', required: true },
        ],
      } as WorkflowResult['businessInterpretation'],
    });

    const guidance = buildDocumentGuidance(item, workflow, 'de');
    expect(guidance.actions.some((action) => action.labelKey.includes('Grund:'))).toBe(false);
  });

  it('Mahnung: vorhandenes Risiko wird nicht pauschal als Action-Begründung verwendet', () => {
    const item = createAuftragInboxItem({
      id: 'du-01e-reminder',
      classifiedKind: 'mahnung',
      documentType: 'brief',
      recommendedAction: 'zahlung_pruefen',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'mahnung',
      workflowDecision: {
        ...workflowBase().workflowDecision!,
        inboxItemId: item.id,
        classifiedKind: 'mahnung',
        risks: [
          {
            id: 'deadline-risk',
            severity: 'high',
            messageKey: 'docAssistant.inaction.deadlineRisk',
          },
        ],
      },
    });

    const guidance = buildDocumentGuidance(item, workflow, 'de');
    expect(guidance.actions.some((action) => action.labelKey.includes('Grund:'))).toBe(false);
  });
});
