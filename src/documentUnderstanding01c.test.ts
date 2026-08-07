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
      documentType: 'eingangsrechnung',
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
        parties: {
          counterparty: {
            name: 'Firma X GmbH',
            role: 'unknown',
            relation: 'counterparty',
            certainty: 'detected',
            source: 'understanding',
          },
        },
        subject: {},
        timeline: {
          deadline: {
            value: '15. August',
            certainty: 'detected',
            source: 'understanding',
          },
        },
        money: [
          {
            kind: 'invoice_total',
            amountFormatted: '3.284,51 €',
            certainty: 'detected',
            source: 'understanding',
          },
        ],
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

describe('DOCUMENT-UNDERSTANDING-01C', () => {
  it('Eingangsrechnung: verbindet Dokumentart, Gegenpartei, Betrag und Frist aus vorhandener Wahrheit', () => {
    const item = createAuftragInboxItem({
      id: 'du-01c-invoice',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      sender: 'Firma X GmbH',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'eingangsrechnung',
    });

    const narrative = buildDocumentNarrative({ item, workflow });

    expect(narrative).toContain('eingangsrechnung');
    expect(narrative).toContain('Firma X GmbH');
    expect(narrative).toContain('3.284,51 €');
    expect(narrative).toContain('15. August');
  });

  it('Vertrag/Nachtrag: vorhandener nächster Schritt und Unsicherheit werden korrekt formuliert', () => {
    const item = createAuftragInboxItem({
      id: 'du-01c-amendment',
      classifiedKind: 'nachtrag',
      documentType: 'kundenauftrag',
      sender: 'Bau AG',
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'nachtrag',
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'nachtrag',
        },
        meaning: {
          eventType: 'service_change_proposed',
          certainty: 'proposed',
          summary: 'Nachtrag erkannt — mögliche Leistungs- oder Planänderung, Bestätigung erforderlich.',
          alternativeEventTypes: [],
        },
        operational: {
          primaryCase: 'service_change_proposed',
          meanings: ['action_required'],
          nextStep: 'Nachtrag inhaltlich prüfen.',
          confirmRequirement: 'Bestätigung erforderlich.',
          certainty: 'proposed',
        },
        vorgangRef: {
          status: 'suggested',
          suggested: {
            vorgangId: 'v-1',
            vorgangTitle: 'BV Rüthen',
            customer: 'Kunde',
            confidence: 'medium',
            reasonKey: 'match',
          },
          linkedVorgangId: null,
          linkedVorgangTitle: null,
          similarCount: 1,
        },
      } as WorkflowResult['businessInterpretation'],
    });

    const narrative = buildDocumentNarrative({ item, workflow });
    expect(narrative).toContain('wahrscheinlich');
    expect(narrative).toContain('Nächster Schritt: Nachtrag inhaltlich prüfen');
    expect(narrative).toContain('BV Rüthen');
  });

  it('Kein Halluzinieren: fehlende Frist, Risiko und Vorgangsbezug werden nicht erfunden', () => {
    const item = createAuftragInboxItem({
      id: 'du-01c-nohallucination',
      classifiedKind: 'brief',
      documentType: 'brief',
      sender: 'Absender Y',
      deadline: null,
    });
    const workflow = workflowBase({
      inboxItemId: item.id,
      classifiedKind: 'brief',
      documentUnderstanding: {
        documentType: 'brief',
        sender: 'Absender Y',
        nextStep: 'Dokument prüfen.',
        partialRecognition: false,
      },
      workflowDecision: {
        ...workflowBase().workflowDecision!,
        inboxItemId: item.id,
        risks: [],
      },
      businessInterpretation: {
        ...workflowBase().businessInterpretation,
        sourceDocument: {
          ...workflowBase().businessInterpretation!.sourceDocument,
          sourceDocumentId: item.id,
          classifiedKind: 'brief',
        },
        facts: {
          ...workflowBase().businessInterpretation!.facts,
          timeline: {},
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
    expect(narrative).not.toContain('Frist ist');
    expect(narrative).not.toContain('Eine Frist ist wahrscheinlich');
    expect(narrative).not.toContain('Risiko:');
    expect(narrative).not.toContain('Der Vorgangsbezug ist bestätigt:');
    expect(narrative).not.toContain('Der Vorgangsbezug ist wahrscheinlich:');
    expect(narrative).not.toMatch(/\bV-\d+\b/i);
    expect(narrative).not.toContain('Baustelle');
  });
});
