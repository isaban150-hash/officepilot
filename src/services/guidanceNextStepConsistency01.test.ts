/**
 * FULLSUITE-BASELINE-11-REPAIR-01 — konkrete operative Empfehlung schlaegt den
 * generischen Fallback.
 *
 * Ursache der Regression: addBusinessInterpretationActions schob bei vorhandenem
 * operational.nextStep den generischen Schluessel reviewWorkflow.recommend.reviewDocument
 * ein, statt den konkreten Schritt selbst. buildPrioritizedDocumentGuidance stellte den
 * konkreten Schritt dagegen an erste Stelle — Assistant und Review sagten Verschiedenes.
 */
import { describe, expect, it } from 'vitest';
import { t, type TranslationKey } from '../i18n';
import { buildInboxDocumentAssistant } from './documentAssistantService';
import { buildDocumentGuidance, buildPrioritizedDocumentGuidance } from './documentGuidanceService';
import { createInboxWorkflowStub } from './documentSummary';
import { createAuftragInboxItem } from '../test/fixtures';
import type { WorkflowResult } from '../types/models';

const NEXT_STEP = 'Zuerst den Vorgang prüfen und danach anlegen.';

function workflowWithNextStep(
  item: ReturnType<typeof createAuftragInboxItem>,
  nextStep: string,
): WorkflowResult {
  const stub = createInboxWorkflowStub(item);
  return {
    ...stub,
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
        primaryCase: 'possible_new_order',
        meanings: ['action_required'],
        nextStep,
        confirmRequirement: 'Keine automatische Übernahme.',
        certainty: 'proposed',
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
      derivedFrom: {
        hasContractIntelligence: false,
        hasContractOrderProposal: false,
        hasClassification: false,
        hasDocumentUnderstanding: true,
        companyRelevant: true,
      },
    },
  } as WorkflowResult;
}

describe('GUIDANCE-NEXT-STEP-01', () => {
  it('konkrete priorisierte Empfehlung erscheint vor generischem Fallback', () => {
    const item = createAuftragInboxItem({
      id: 'guidance-next-step',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    const workflow = workflowWithNextStep(item, NEXT_STEP);

    const prioritized = buildPrioritizedDocumentGuidance(item, workflow, 'de');
    const guidance = buildDocumentGuidance(item, workflow, 'de');
    const assistant = buildInboxDocumentAssistant(item, workflow, 'de');

    expect(prioritized.now[0]?.text).toBe(NEXT_STEP);
    expect(guidance.mustAct.key).toBe(NEXT_STEP);
    // Beide Oberflächen fuehren dieselbe Formulierung.
    expect(assistant.actionSteps[0]?.key).toBe(NEXT_STEP);
    expect(guidance.actions[0]?.labelKey).toBe(NEXT_STEP);

    // Der generische Fallback darf hier nicht mehr an erster Stelle stehen.
    expect(assistant.actionSteps[0]?.key).not.toBe('reviewWorkflow.recommend.reviewDocument');

    // Tatsaechlich uebersetzte Ausgabe: lesbarer Satz, kein roher Schluessel.
    const rendered = t(assistant.actionSteps[0]!.key as TranslationKey, 'de');
    expect(rendered).toBe(NEXT_STEP);
    expect(rendered).not.toMatch(/^[a-z][A-Za-z]*\./);
  });

  it('ohne operativen naechsten Schritt bleibt der generische Fallback moeglich', () => {
    const item = createAuftragInboxItem({
      id: 'guidance-no-next-step',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    const workflow = workflowWithNextStep(item, '');

    const assistant = buildInboxDocumentAssistant(item, workflow, 'de');
    expect(assistant.actionSteps[0]?.key).not.toBe(NEXT_STEP);
  });
});
