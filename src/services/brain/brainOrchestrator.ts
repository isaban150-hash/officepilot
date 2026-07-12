import type { AssistantAnswer } from '../../types/models';
import type { BrainAnswer } from '../../types/brain';
import type {
  BrainConfidence,
  BrainOrchestrationMode,
  BrainOrchestrationOptions,
  BrainOrchestrationResult,
  BrainOrchestrationSource,
  BrainSuggestedStep,
} from '../../types/brainOrchestration';
import { isAiProviderConfigured } from '../aiProviderService';
import {
  EXPLANATION_NO_DATA_MESSAGE,
  findDocumentForExplanationQuestion,
} from '../memory/documentExplanationService';
import {
  memoryQueryAnswerToAssistantAnswer,
  tryMemoryQueryAnswer,
} from '../memory/memoryQueryService';
import {
  answerQuestion,
  detectIntent,
  NO_DATA_MESSAGE,
} from '../officeAssistantService';
import { askOfficePilotBrain } from '../officePilotBrainService';
import { trySearchAssistantAnswer } from '../officeSearchService';
import { getTodayIso } from '../taskNormalize';
import { detectPlannedCapability } from './brainCapabilityRegistry';
import { assessBrainIntent } from './brainIntentRegistry';
import { tryResolveCompanyContextQuestion } from './companyContextResolver';
import { tryResolveHandwerkKnowledgeQuestion } from './handwerkKnowledgeResolver';
import { tryResolveWorkflowQuestion } from './workflowKnowledgeResolver';
import { buildProactiveHints } from './companyProactiveHintsService';
import {
  getCompanySession,
  getContextRefFromSession,
  recordAssistantQuestion,
} from './companySessionService';
import { buildKommunikationPath } from '../../components/communication/communicationNavigation';

function nowIso(): string {
  return new Date().toISOString();
}

function isNoDataAnswer(answer: AssistantAnswer): boolean {
  return (
    answer.summary === NO_DATA_MESSAGE ||
    answer.summary === EXPLANATION_NO_DATA_MESSAGE ||
    (answer.bullets.length === 0 &&
      answer.actions.length === 0 &&
      /keine informationen|keine daten|nicht gefunden/i.test(answer.summary))
  );
}

function confidenceForSource(
  source: BrainOrchestrationSource,
  answer?: AssistantAnswer,
): BrainConfidence {
  if (source === 'memory' || source === 'search') return 'high';
  if (source === 'ai') return 'medium';
  if (source === 'rules' && answer && !isNoDataAnswer(answer)) return 'high';
  if (source === 'clarification' || source === 'planned_capability') return 'low';
  return 'low';
}

function buildCommunicationNextSteps(): BrainSuggestedStep[] {
  return [
    {
      id: 'open_communication',
      labelKey: 'brain.nextStep.openCommunication',
      route: '/kommunikation',
      reasonKey: 'brain.nextStep.openCommunicationReason',
    },
  ];
}

function buildDocumentReviewNextSteps(): BrainSuggestedStep[] {
  return [
    {
      id: 'open_inbox',
      labelKey: 'brain.nextStep.openInbox',
      route: '/eingang',
      reasonKey: 'brain.nextStep.openInboxReason',
    },
  ];
}

function buildRulesNextSteps(intent: ReturnType<typeof detectIntent>, answer: AssistantAnswer): BrainSuggestedStep[] {
  const steps: BrainSuggestedStep[] = [];
  if (intent.startsWith('invoices_')) {
    steps.push({
      id: 'open_invoices',
      labelKey: 'brain.nextStep.openInvoices',
      route: '/offene-rechnungen',
    });
  }
  if (intent.startsWith('tasks_')) {
    steps.push({
      id: 'open_tasks',
      labelKey: 'brain.nextStep.openTasks',
      route: '/aufgaben',
    });
  }
  if (intent.startsWith('documents_') || intent.startsWith('contracts_')) {
    steps.push({
      id: 'open_documents',
      labelKey: 'brain.nextStep.openDocuments',
      route: '/dokumente',
    });
  }
  if (intent.startsWith('vorgaenge_')) {
    steps.push({
      id: 'open_vorgaenge',
      labelKey: 'brain.nextStep.openVorgaenge',
      route: '/vorgaenge',
    });
  }
  if (answer.linkedRoute) {
    steps.push({
      id: 'linked_route',
      labelKey: 'brain.nextStep.followLink',
      route: answer.linkedRoute,
    });
  }
  return steps;
}

function buildResult(params: {
  question: string;
  source: BrainOrchestrationSource;
  assistantAnswer?: AssistantAnswer;
  brainAnswer?: BrainAnswer;
  suggestedNextSteps?: BrainSuggestedStep[];
  uncertaintyNote?: string;
  clarificationQuestion?: string;
  capabilityId?: BrainOrchestrationResult['capabilityId'];
  proactiveHints?: BrainOrchestrationResult['proactiveHints'];
  companyContextUsed?: string[];
  handwerkKnowledgeUsed?: string[];
  workflowUsed?: string[];
  workflowSummary?: import('../../types/workflowIntelligence').WorkflowAnalysisSummary;
}): BrainOrchestrationResult {
  const confidence = confidenceForSource(params.source, params.assistantAnswer);
  const session = getCompanySession();
  return {
    question: params.question,
    source: params.source,
    confidence,
    capabilityId: params.capabilityId,
    assistantAnswer: params.assistantAnswer,
    brainAnswer: params.brainAnswer,
    suggestedNextSteps: params.suggestedNextSteps ?? [],
    uncertaintyNote: params.uncertaintyNote,
    clarificationQuestion: params.clarificationQuestion,
    proactiveHints: params.proactiveHints ?? buildProactiveHints(session),
    companyContextUsed: params.companyContextUsed,
    handwerkKnowledgeUsed: params.handwerkKnowledgeUsed,
    workflowUsed: params.workflowUsed,
    workflowSummary: params.workflowSummary,
    generatedAt: nowIso(),
  };
}

function tryRulesAnswer(
  question: string,
  todayIso: string,
): { answer: AssistantAnswer; source: BrainOrchestrationSource } | null {
  const memoryAnswer = tryMemoryQueryAnswer(question, todayIso);
  if (memoryAnswer) {
    return {
      answer: memoryQueryAnswerToAssistantAnswer(memoryAnswer),
      source: 'memory',
    };
  }

  const searchAnswer = trySearchAssistantAnswer(question, todayIso);
  if (searchAnswer) {
    return { answer: searchAnswer, source: 'search' };
  }

  if (/was bedeutet|was muss ich tun|was wollte|was ist mit.*freistellung|fehlen nachweise/i.test(question)) {
    const explanation = findDocumentForExplanationQuestion(question);
    if (explanation) {
      return {
        answer: memoryQueryAnswerToAssistantAnswer(
          {
            shortAnswer: explanation.shortAnswer,
            source: `Firmen-Gedächtnis: ${explanation.sourceTitle ?? 'Dokument'}`,
            digitalLocation: explanation.digitalLocation,
            paperLocation: explanation.paperLocation,
            register: explanation.register,
            status: explanation.actionRequired,
            nextStep: explanation.nextSteps[0] ?? explanation.recommendation,
            uncertainty: explanation.uncertaintyNote,
          },
          'Dokument-Erklärung',
        ),
        source: 'memory',
      };
    }
    return {
      answer: {
        title: 'Dokument-Erklärung',
        summary: EXPLANATION_NO_DATA_MESSAGE,
        bullets: [],
        actions: [],
      },
      source: 'rules',
    };
  }

  return {
    answer: answerQuestion(question, todayIso),
    source: 'rules',
  };
}

export async function processOfficePilotQuestion(
  question: string,
  options: BrainOrchestrationOptions = {},
): Promise<BrainOrchestrationResult> {
  const trimmed = question.trim();
  const mode: BrainOrchestrationMode = options.mode ?? 'smart';
  const todayIso = getTodayIso(options.today);
  const session = recordAssistantQuestion(trimmed);
  const contextRef = options.contextRef ?? getContextRefFromSession(session);

  if (!trimmed) {
    return buildResult({
      question: '',
      source: 'unavailable',
      clarificationQuestion: 'brain.clarification.emptyQuestion',
    });
  }

  const companyResolution = tryResolveCompanyContextQuestion(trimmed, session);
  if (companyResolution) {
    return buildResult({
      question: trimmed,
      source: companyResolution.source,
      assistantAnswer: companyResolution.assistantAnswer,
      suggestedNextSteps: companyResolution.suggestedNextSteps,
      uncertaintyNote: companyResolution.uncertaintyNote,
      clarificationQuestion: companyResolution.clarificationQuestion,
      companyContextUsed: companyResolution.contextUsed,
    });
  }

  const handwerkResolution = tryResolveHandwerkKnowledgeQuestion(trimmed, session);
  if (handwerkResolution) {
    return buildResult({
      question: trimmed,
      source: handwerkResolution.source,
      assistantAnswer: handwerkResolution.assistantAnswer,
      suggestedNextSteps: handwerkResolution.suggestedNextSteps,
      uncertaintyNote: handwerkResolution.uncertaintyNote,
      clarificationQuestion: handwerkResolution.clarificationQuestion,
      handwerkKnowledgeUsed: handwerkResolution.knowledgeUsed,
    });
  }

  const workflowResolution = tryResolveWorkflowQuestion(trimmed, session);
  if (workflowResolution) {
    return buildResult({
      question: trimmed,
      source: workflowResolution.source,
      assistantAnswer: workflowResolution.assistantAnswer,
      suggestedNextSteps: workflowResolution.suggestedNextSteps,
      uncertaintyNote: workflowResolution.uncertaintyNote,
      clarificationQuestion: workflowResolution.clarificationQuestion,
      workflowUsed: workflowResolution.workflowUsed,
      workflowSummary: workflowResolution.workflowSummary,
    });
  }

  const plannedCapability = detectPlannedCapability(trimmed);
  if (plannedCapability) {
    return buildResult({
      question: trimmed,
      source: 'planned_capability',
      capabilityId: plannedCapability.id,
      assistantAnswer: {
        title: 'OfficePilot',
        summary:
          'Diese Funktion ist für eine spätere Version vorgesehen. OfficePilot nutzt dafür noch keine externen Quellen.',
        bullets: [
          'Ich kann Ihnen bei Dokumenten, Aufträgen, Rechnungen und Kommunikation aus Ihren vorhandenen Daten helfen.',
        ],
        actions: [],
      },
      uncertaintyNote: 'Geplante Erweiterung – derzeit keine Live-Daten.',
      clarificationQuestion: 'brain.clarification.plannedCapability',
    });
  }

  const intentAssessment = assessBrainIntent(trimmed);
  const isInvoiceIntent = /schreib.*rechnung|rechnung.*(erstellen|schreiben|jetzt)|jetzt.*rechnung/i.test(
    trimmed,
  );

  if (
    (intentAssessment.category === 'communication_draft' || intentAssessment.needsContext) &&
    !isInvoiceIntent
  ) {
    if (contextRef.type === 'none') {
      return buildResult({
        question: trimmed,
        source: 'clarification',
        assistantAnswer: {
          title: 'Kommunikation',
          summary:
            'Für Antwortentwürfe brauche ich den Bezug zu einem Dokument, Auftrag oder einer Rechnung. Öffnen Sie die Kommunikation mit Kontext.',
          bullets: [],
          actions: [],
        },
        suggestedNextSteps: buildCommunicationNextSteps(),
        uncertaintyNote: 'Ohne Dokumentenkontext kann kein verlässlicher Entwurf erstellt werden.',
        clarificationQuestion: 'brain.clarification.communicationContext',
      });
    }

    const contextLabel =
      session.currentVorgangTitle ??
      session.currentDocumentTitle ??
      session.currentCustomer ??
      'Ihrem aktuellen Bezug';
    return buildResult({
      question: trimmed,
      source: 'rules',
      assistantAnswer: {
        title: 'Kommunikation',
        summary: `Ich kann einen Entwurf mit Bezug zu ${contextLabel} in der Kommunikation vorbereiten.`,
        bullets: [],
        actions: [],
        linkedRoute: buildKommunikationPath(contextRef),
      },
      suggestedNextSteps: [
        {
          id: 'open_communication',
          labelKey: 'brain.nextStep.openCommunication',
          route: buildKommunikationPath(contextRef),
          reasonKey: 'brain.nextStep.openCommunicationReason',
        },
      ],
      companyContextUsed: ['session'],
    });
  }

  if (mode !== 'deep') {
    const rulesResult = tryRulesAnswer(trimmed, todayIso);
    if (rulesResult && !isNoDataAnswer(rulesResult.answer)) {
      const intent = detectIntent(trimmed);
      return buildResult({
        question: trimmed,
        source: rulesResult.source,
        assistantAnswer: rulesResult.answer,
        suggestedNextSteps: buildRulesNextSteps(intent, rulesResult.answer),
        uncertaintyNote: rulesResult.answer.summary.includes('prüfen')
          ? 'brain.uncertainty.reviewRecommended'
          : undefined,
      });
    }

    if (mode === 'rules') {
      return buildResult({
        question: trimmed,
        source: 'clarification',
        assistantAnswer: rulesResult?.answer ?? {
          title: 'OfficePilot',
          summary: NO_DATA_MESSAGE,
          bullets: [],
          actions: [],
        },
        suggestedNextSteps: isAiProviderConfigured()
          ? [
              {
                id: 'try_deep',
                labelKey: 'brain.nextStep.tryDeepAnswer',
                reasonKey: 'brain.nextStep.tryDeepAnswerReason',
              },
            ]
          : buildDocumentReviewNextSteps(),
        uncertaintyNote: 'brain.uncertainty.noLocalData',
        clarificationQuestion: 'brain.clarification.specifyDocumentOrVorgang',
      });
    }
  }

  if (!isAiProviderConfigured()) {
    return buildResult({
      question: trimmed,
      source: 'unavailable',
      assistantAnswer: {
        title: 'OfficePilot',
        summary:
          'Eine ausführliche KI-Antwort ist derzeit nicht verfügbar. Bitte prüfen Sie Ihre Daten in Eingang, Aufträgen oder Dokumenten.',
        bullets: [],
        actions: [],
      },
      suggestedNextSteps: buildDocumentReviewNextSteps(),
      uncertaintyNote: 'brain.uncertainty.noAiProvider',
    });
  }

  const brainAnswer = await askOfficePilotBrain(trimmed, session);
  if (brainAnswer.source === 'unavailable') {
    return buildResult({
      question: trimmed,
      source: 'unavailable',
      brainAnswer,
      suggestedNextSteps: buildDocumentReviewNextSteps(),
      uncertaintyNote: 'brain.uncertainty.aiUnavailable',
    });
  }

  return buildResult({
    question: trimmed,
    source: 'ai',
    brainAnswer,
    suggestedNextSteps:
      intentAssessment.activeCapabilities.includes('communication')
        ? buildCommunicationNextSteps()
        : [],
    uncertaintyNote: 'brain.uncertainty.aiBasedOnLocalData',
  });
}

export { assessBrainIntent } from './brainIntentRegistry';
export { detectPlannedCapability, detectActiveCapabilities } from './brainCapabilityRegistry';
