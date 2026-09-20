import { getCachedSetup } from '../persistenceService';
import { runAiRequest } from '../ai/aiRequestRunner';
import {
  buildDocumentAiAllowedSourceText as buildAllowedFromContext,
  buildDocumentAiContextFromDocument,
  buildDocumentAiContextFromInbox,
} from './documentAiContextService';
import { buildDocumentAiPrompt } from './documentAiPromptBuilder';
import { buildOperationalLines } from './documentAiRetrievalService';
import {
  findDocumentKnowledge,
  verifyUsedKnowledge,
} from './documentKnowledgeService';
import { parseDocumentAiAnswer } from './documentAiAnswerParser';
import {
  applyDocumentAiAnswerPostCheck,
  ensureTestNatureNote,
} from './documentAiAnswerPostCheck';
import { detectDocumentNature } from './documentAiDocumentNature';
import { filterUncertaintyNotesForQuestion } from './documentAiQuestionIntent';
import {
  appendDocumentAiConversationTurn,
  buildDocumentAiPriorTurnsGuardText,
  DOCUMENT_AI_MAX_PRIOR_ROUNDS,
  DOCUMENT_AI_MAX_TURN_CHARS,
  formatDocumentAiPriorTurnsForPrompt,
  normalizeDocumentAiPriorTurns,
  shouldPersistDocumentAiConversationExchange,
} from './documentAiConversationTurns';
import { t } from '../../i18n';
import {
  AREA_AI_DISCLAIMER,
  type AreaAiAnswer,
  type DocumentAiContext,
  type DocumentAiPriorTurn,
} from '../../types/areaAi';
import type { DocumentFieldFillConfirmRow } from '../../types/documentFieldFillConfirm';
import type { AppLanguage, CompanyDocument, InboxItem, WorkflowResult } from '../../types/models';

export type DocumentAiSource =
  | { type: 'document'; document: CompanyDocument }
  | {
      type: 'inbox';
      item: InboxItem;
      liveWorkflow?: WorkflowResult | null;
      /** Session Fill-Confirm rows → same TruthView as Overview / Rule-Assist. */
      sessionFillConfirmRows?: readonly DocumentFieldFillConfirmRow[] | null;
    };

function unavailableAnswer(
  question: string,
  text: string,
  errorCode?: string,
  uncertaintyNotes: string[] = [],
  warnings?: string[],
): AreaAiAnswer {
  const notes = uncertaintyNotes.length > 0 ? uncertaintyNotes : undefined;
  const parsed = parseDocumentAiAnswer(text);
  return {
    question,
    text: parsed.text || text,
    directAnswer: parsed.directAnswer || text,
    explanation: parsed.explanation || undefined,
    source: 'unavailable',
    disclaimer: AREA_AI_DISCLAIMER,
    generatedAt: new Date().toISOString(),
    errorCode,
    warnings,
    uncertain: true,
    uncertaintyNotes: notes,
  };
}

function buildContext(source: DocumentAiSource): DocumentAiContext {
  if (source.type === 'document') {
    return buildDocumentAiContextFromDocument(source.document);
  }
  return buildDocumentAiContextFromInbox(source.item, {
    liveWorkflow: source.liveWorkflow ?? null,
    sessionFillConfirmRows: source.sessionFillConfirmRows ?? null,
  });
}

/**
 * DOKUMENT-ASSISTENT-01H2 — Prüfmeldungen sind keine Hinweise für den Leser.
 *
 * Bisher wanderten die Warnungen der Prüfkette ungefiltert unter „Unsicher /
 * unvollständig". Sichtbar wurde daraus im Betrieb: „Verbotene
 * Rechts-/Steuerformulierung: rechtsberatung". Das ist kein Hinweis, das ist
 * ein Blick in den Maschinenraum — und er sagt dem Benutzer über sein
 * Dokument nichts.
 *
 * Die Warnungen bleiben erhalten; sie stehen weiter im Feld `warnings` und
 * damit für Protokoll und Test zur Verfügung. Nur angezeigt werden sie nicht
 * mehr.
 */
function collectAnswerUncertainty(
  question: string,
  context: DocumentAiContext,
  _warnings: string[] | undefined,
  lang: AppLanguage,
): string[] {
  const notes = [...context.missingFieldNotes, ...context.uncertainFieldNotes];
  if (!context.recognizedText?.trim()) {
    notes.push(t('document.freeQuestion.note.cannotAnswerFromDocument', lang));
  }
  const withTest = ensureTestNatureNote(notes, context, lang);
  const deduped = Array.from(new Set(withTest.filter(Boolean)));
  return filterUncertaintyNotesForQuestion(question, deduped, lang);
}

export async function askDocumentAi(input: {
  source: DocumentAiSource;
  question: string;
  /** DOCUMENT-ASSIST-02B — ephemeral prior turns (dialog only). */
  priorTurns?: readonly DocumentAiPriorTurn[] | null;
}): Promise<AreaAiAnswer> {
  const lang = getCachedSetup().language;
  const trimmedQuestion = input.question.trim();
  if (!trimmedQuestion) {
    return unavailableAnswer(
      '',
      t('document.freeQuestion.error.empty', lang),
      'invalid_prompt',
    );
  }

  const priorTurns = normalizeDocumentAiPriorTurns(input.priorTurns);
  const rohkontext = buildContext(input.source);
  /*
   * DOKUMENT-ASSISTENT-01F — gezielter Abruf.
   *
   * Erst jetzt, weil erst die Frage sagt, welche Auskunft gebraucht wird.
   * Ohne passende Frage bleibt der Abschnitt leer; der Arbeitsbereich wird
   * niemals vollstaendig in den Prompt geladen.
   */
  const mitBestand =
    input.source.type === 'inbox'
      ? {
          ...rohkontext,
          operationalLines: buildOperationalLines({
            question: trimmedQuestion,
            item: input.source.item,
            core: rohkontext.semantic,
          }),
        }
      : rohkontext;

  /*
   * DOKUMENT-ASSISTENT-01H3 — belegtes Fachwissen, aber nur wenn gefragt.
   *
   * Erst jetzt, aus demselben Grund wie beim Bestand: Erst die Frage sagt, ob
   * eine allgemeine Regel überhaupt gebraucht wird. Der Normalfall ist eine
   * leere Liste — dann sieht der Prompt aus wie bisher.
   */
  const asOf = new Date().toISOString().slice(0, 10);
  const knowledge = findDocumentKnowledge({
    question: trimmedQuestion,
    classifiedKind: mitBestand.classifiedKind,
    subject: mitBestand.semantic?.subject?.value ?? null,
    purpose: mitBestand.semantic?.purpose?.value ?? null,
    documentDates: [mitBestand.validUntil, mitBestand.deadline, mitBestand.issueDate],
    /* 01I1 — die erkannte Bescheinigungsart darf ein fremdes Thema ausschliessen. */
    certificate: mitBestand.semantic?.certificate,
    asOf,
  });
  const context = knowledge.length > 0 ? { ...mitBestand, knowledge } : mitBestand;
  const prompt = buildDocumentAiPrompt(trimmedQuestion, context, lang, { priorTurns });
  const dialogGuardText = buildDocumentAiPriorTurnsGuardText(priorTurns);
  const allowedSourceText = [buildAllowedFromContext(context), dialogGuardText]
    .filter(Boolean)
    .join('\n');

  const result = await runAiRequest({
    operation: 'document_question',
    prompt,
    guardProfile: 'qa',
    guardContext: { allowedSourceText },
  });

  const uncertaintyNotes = collectAnswerUncertainty(
    trimmedQuestion,
    context,
    result.warnings,
    lang,
  );

  if (result.source === 'unavailable') {
    return unavailableAnswer(
      trimmedQuestion,
      result.message ?? t('document.freeQuestion.error.unavailable', lang),
      result.errorCode,
      uncertaintyNotes,
    );
  }

  if (result.source === 'rule_fallback' || !result.text) {
    /*
     * DOKUMENT-ASSISTENT-01H2 — der seltene Fall, dass nichts bleibt.
     *
     * Dann ist die ehrliche Absage besser als ein Trümmerstück: Sie sagt, was
     * gilt, und wohin die Frage gehört. Was sie nicht mehr sagt, ist, dass
     * intern etwas „verworfen" wurde.
     */
    const message =
      result.errorCode === 'guard_rejected'
        ? t('document.freeQuestion.error.notAnswerable', lang)
        : result.message ?? t('document.freeQuestion.error.failed', lang);
    return unavailableAnswer(
      trimmedQuestion,
      message,
      result.errorCode,
      uncertaintyNotes,
      result.warnings,
    );
  }

  const parsed = parseDocumentAiAnswer(result.text);
  const checked = applyDocumentAiAnswerPostCheck({
    question: trimmedQuestion,
    parsed,
    context,
    lang,
  });

  const mergedWarnings = Array.from(
    new Set([...(result.warnings ?? []), ...checked.warnings]),
  );

  /*
   * DOKUMENT-ASSISTENT-01H3 — die Belege entstehen hier, nicht im Modell.
   *
   * Das Modell darf sagen, welche Aussagen es verwendet hat. Titel, Herausgeber
   * und Adresse holt OfficeTakt aus dem eigenen Bestand. Damit kann eine
   * Quellenangabe nicht erfunden werden — schlimmstenfalls fehlt sie.
   */
  const knowledgeSources = verifyUsedKnowledge(parsed.usedKnowledgeStatementIds, knowledge);

  return {
    question: trimmedQuestion,
    ...(knowledgeSources.length > 0 ? { knowledgeSources } : {}),
    text: checked.text,
    directAnswer: checked.directAnswer,
    explanation: checked.explanation || undefined,
    source: 'ai',
    disclaimer: AREA_AI_DISCLAIMER,
    generatedAt: new Date().toISOString(),
    warnings: mergedWarnings.length > 0 ? mergedWarnings : undefined,
    uncertain: uncertaintyNotes.length > 0 || checked.softened,
    uncertaintyNotes: uncertaintyNotes.length > 0 ? uncertaintyNotes : undefined,
  };
}

export {
  buildDocumentAiContextFromDocument,
  buildDocumentAiContextFromInbox,
  buildDocumentAiPrompt,
  filterUncertaintyNotesForQuestion,
  parseDocumentAiAnswer,
  applyDocumentAiAnswerPostCheck,
  detectDocumentNature,
};

export {
  normalizeDocumentAiPriorTurns,
  buildDocumentAiPriorTurnsGuardText,
  formatDocumentAiPriorTurnsForPrompt,
  appendDocumentAiConversationTurn,
  shouldPersistDocumentAiConversationExchange,
  DOCUMENT_AI_MAX_PRIOR_ROUNDS,
  DOCUMENT_AI_MAX_TURN_CHARS,
};
