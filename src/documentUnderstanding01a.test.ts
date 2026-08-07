import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './i18n';
import { buildInboxDocumentAssistant } from './services/documentAssistantService';
import {
  buildDocumentGuidance,
  buildPrioritizedDocumentGuidance,
} from './services/documentGuidanceService';
import {
  buildDocumentReviewChecks,
  buildDocumentReviewRecommendations,
} from './services/documentReviewViewService';
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

describe('DOCUMENT-UNDERSTANDING-01A', () => {
  beforeEach(() => {
    installStorageMocks();
  });

  it('Mahnung/Frist: Wenn nichts passiert zeigt eine vorhandene Folge korrekt an', () => {
    const item = createAuftragInboxItem({
      id: 'du-01a-reminder',
      classifiedKind: 'mahnung',
      documentType: 'brief',
      deadline: '2026-08-15',
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
      documentUnderstanding: {
        documentType: 'mahnung',
        deadline: '2026-08-15',
        nextStep: 'Zahlung und Frist prüfen.',
        partialRecognition: false,
      },
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'mahnung',
        },
        meaning: {
          eventType: 'payment_reminder_received',
          certainty: 'detected',
          summary: 'Mahnung erkannt.',
          alternativeEventTypes: [],
        },
        operational: {
          primaryCase: 'payment_reminder_received',
          meanings: ['money', 'deadline', 'action_required'],
          deadlineType: 'payment_due',
          nextStep: 'Zahlung und Frist prüfen.',
          confirmRequirement: 'Keine automatische Zahlung.',
          certainty: 'detected',
        },
        facts: {
          ...workflowBase().businessInterpretation!.facts,
          timeline: {
            deadline: {
              value: '2026-08-15',
              certainty: 'detected',
              source: 'understanding',
            },
          },
        },
      } as WorkflowResult['businessInterpretation'],
    });

    const prioritized = buildPrioritizedDocumentGuidance(item, workflow, 'de');
    const assistant = buildInboxDocumentAssistant(item, workflow, 'de');
    const checks = buildDocumentReviewChecks(item, workflow);

    expect(prioritized.inaction[0]?.text).toBe(t('docAssistant.inaction.deadlineRisk', 'de'));
    expect(assistant.inactionConsequence?.key).toBe(t('docAssistant.inaction.deadlineRisk', 'de'));
    expect(checks.some((check) => check.labelKey === t('docAssistant.inaction.deadlineRisk', 'de'))).toBe(false);
  });

  it('Vertrag/Nachtrag: Es fehlt noch zeigt vorhandene missingInformation, confirmations und requiredDocuments', () => {
    const item = createAuftragInboxItem({
      id: 'du-01a-contract',
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
        conflicts: [
          { id: 'plan', summary: 'Der bestehende Leistungsplan sollte vor Änderungen geprüft werden.', certainty: 'conflicting' },
        ],
        requiredConfirmations: [
          { id: 'confirm_positions', summary: 'Die Leistungspositionen sollten bestätigt werden.', required: true },
        ],
      } as WorkflowResult['businessInterpretation'],
    });

    const prioritized = buildPrioritizedDocumentGuidance(item, workflow, 'de');
    const checks = buildDocumentReviewChecks(item, workflow);
    const assistant = buildInboxDocumentAssistant(item, workflow, 'de');

    expect(prioritized.missing.map((line) => line.text)).toEqual(
      expect.arrayContaining([
        'Die Baustelle ist aus dem Dokument nicht eindeutig erkennbar.',
        'Die Leistungspositionen sollten bestätigt werden.',
        'Freistellungsbescheinigung fehlt.',
      ]),
    );
    expect(checks.map((check) => check.labelKey)).toEqual(
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

  it('Konsistenz: Assistant und Review verwenden dieselbe priorisierte Nutzerführung', () => {
    const item = createAuftragInboxItem({
      id: 'du-01a-consistency',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'werkvertrag',
      nextActions: [
        { id: 'create_vorgang', labelKey: 'intake.action.createVorgang', enabled: true },
      ],
      workflowDecision: {
        ...workflowBase().workflowDecision!,
        inboxItemId: item.id,
        classifiedKind: 'werkvertrag',
        nextActions: [
          { id: 'create_vorgang', labelKey: 'intake.action.createVorgang', enabled: true },
        ],
      },
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'werkvertrag',
        },
        operational: {
          primaryCase: 'possible_new_order',
          meanings: ['action_required'],
          nextStep: 'Zuerst den Vorgang prüfen und danach anlegen.',
          confirmRequirement: 'Keine automatische Übernahme.',
          certainty: 'proposed',
        },
      } as WorkflowResult['businessInterpretation'],
    });

    const prioritized = buildPrioritizedDocumentGuidance(item, workflow, 'de');
    const guidance = buildDocumentGuidance(item, workflow, 'de');
    const recommendations = buildDocumentReviewRecommendations(item, workflow);
    const assistant = buildInboxDocumentAssistant(item, workflow, 'de');

    expect(prioritized.now[0]?.text).toBe('Zuerst den Vorgang prüfen und danach anlegen.');
    expect(guidance.mustAct.key).toBe('Zuerst den Vorgang prüfen und danach anlegen.');
    expect(recommendations[0]?.labelKey).toBe('Zuerst den Vorgang prüfen und danach anlegen.');
    expect(assistant.actionSteps[0]?.key).toBe('Zuerst den Vorgang prüfen und danach anlegen.');
  });
});