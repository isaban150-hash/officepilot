import { describe, expect, it } from 'vitest';
import { createAuftragInboxItem } from './test/fixtures';
import { buildDocumentNarrative } from './services/documentNarrativeService';
import type { WorkflowResult } from './types/models';

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
      documentType: item.classifiedKind ?? 'eingangsrechnung',
      sender: item.sender,
      amount: '3.284,51 €',
      deadline: '15. August',
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
        summary: 'Eingangsrechnung erkannt.',
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

describe('DOCUMENT-UNDERSTANDING-01D', () => {
  it('Rechnung + vorhandener Vorgang: Narrative enthält den vorhandenen Vorgangsnamen', () => {
    const item = createAuftragInboxItem({
      id: 'du-01d-invoice',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      sender: 'Firma X GmbH',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'eingangsrechnung',
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'eingangsrechnung',
        },
        vorgangRef: {
          status: 'linked',
          suggested: null,
          linkedVorgangId: 'vorgang-ruethen',
          linkedVorgangTitle: 'BV Rüthen',
          similarCount: 0,
        },
      } as WorkflowResult['businessInterpretation'],
    });

    const narrative = buildDocumentNarrative({ item, workflow });

    expect(narrative).toContain('Diese Rechnung gehört zum Vorgang „BV Rüthen“');
  });

  it('Werkvertrag + Nachtrag: Narrative stellt den vorhandenen Vertragszusammenhang her', () => {
    const item = createAuftragInboxItem({
      id: 'du-01d-amendment',
      classifiedKind: 'nachtrag',
      documentType: 'nachtrag',
      sender: 'Bau AG',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'nachtrag',
      documentUnderstanding: {
        documentType: 'nachtrag',
        sender: 'Bau AG',
        nextStep: 'Nachtrag prüfen.',
        partialRecognition: false,
      },
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'nachtrag',
        },
        meaning: {
          eventType: 'service_change_proposed',
          certainty: 'detected',
          summary: 'Nachtrag erkannt.',
          alternativeEventTypes: [],
        },
        operational: {
          primaryCase: 'service_change_proposed',
          meanings: ['action_required'],
          nextStep: 'Nachtrag inhaltlich prüfen.',
          confirmRequirement: 'Bestätigung erforderlich.',
          certainty: 'detected',
        },
        vorgangRef: {
          status: 'linked',
          suggested: null,
          linkedVorgangId: 'vorgang-sanierung',
          linkedVorgangTitle: 'BV Rüthen',
          similarCount: 0,
        },
        contractFamily: 'werkvertrag',
      } as WorkflowResult['businessInterpretation'],
    });

    const narrative = buildDocumentNarrative({ item, workflow });

    expect(narrative).toContain('Dieser Nachtrag gehört zum Vorgang „BV Rüthen“');
    expect(narrative).toContain('Er bezieht sich auf den bereits erkannten Werkvertrag');
  });

  it('Kein Vorgang vorhanden: Narrative erfindet keinen Bezug', () => {
    const item = createAuftragInboxItem({
      id: 'du-01d-no-vorgang',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      sender: 'Firma X GmbH',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'eingangsrechnung',
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'eingangsrechnung',
        },
        vorgangRef: {
          status: 'none',
          suggested: null,
          linkedVorgangId: null,
          linkedVorgangTitle: null,
          similarCount: 0,
        },
      } as WorkflowResult['businessInterpretation'],
    });

    const narrative = buildDocumentNarrative({ item, workflow });

    expect(narrative).not.toContain('gehört zum Vorgang');
    expect(narrative).not.toContain('gehört wahrscheinlich zum Vorgang');
    expect(narrative).not.toContain('Werkvertrag');
    expect(narrative).not.toContain('BV Rüthen');
  });
});