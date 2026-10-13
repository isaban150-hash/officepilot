import { buildCommunicationContext } from './communicationContextService';
import { buildCommunicationDraft } from './communicationDraftService';
import {
  answerDocumentQuestion,
  detectDocumentQuestionType,
} from './communicationDocumentQaService';
import {
  detectCommunicationIntent,
  detectRewriteStyle,
  isDocumentQuestionIntent,
} from './communicationIntentService';
import { getMissingCommunicationInfo } from './communicationQuestionService';
import { renderAllChannels } from './communicationChannelService';
import type { CommunicationRequest, CommunicationResult } from '../types/communication';

function blockedResult(
  reasonKey: string,
  intent: CommunicationResult['intent'] = 'unknown',
): CommunicationResult {
  return {
    mode: 'draft',
    intent,
    status: 'blocked',
    title: 'communication.blocked.title',
    summary: reasonKey,
    disclaimer:
      'OfficeTakt erteilt keine Rechts- oder Steuerberatung und trifft keine endgültigen Aussagen.',
  };
}

/**
 * FINANZ-CORE-01A (ZAH-12) — kein Erinnerungs- oder Mahnentwurf zu einer
 * stornierten, nicht versendeten oder beglichenen Rechnung und keine Mahnung
 * vor dem Zahlungsziel. Ohne Rechnungskontext bleibt alles wie bisher.
 */
function resolveInvoiceReminderBlock(
  intent: CommunicationResult['intent'],
  context: ReturnType<typeof buildCommunicationContext>,
): string | null {
  if (intent !== 'payment_reminder' && intent !== 'dunning_notice' && intent !== 'invoice_followup') return null;
  const state = context.invoiceSummary?.paymentState;
  if (state === 'cancelled') return 'communication.block.invoiceCancelled';
  if (state === 'not_sent') return 'communication.block.invoiceNotSent';
  if (state === 'settled') return 'communication.block.invoiceSettled';
  if (state === 'not_due' && intent === 'dunning_notice') return 'communication.block.invoiceNotDue';
  return null;
}

function needsInfoResult(
  intent: CommunicationResult['intent'],
  missingInfo: CommunicationResult['missingInfo'],
  context: ReturnType<typeof buildCommunicationContext>,
): CommunicationResult {
  return {
    mode: 'draft',
    intent,
    status: 'needs_info',
    title: 'communication.needsInfo.title',
    summary: 'communication.needsInfo.summary',
    missingInfo,
    disclaimer: context.disclaimer,
  };
}

export function processCommunicationRequest(request: CommunicationRequest): CommunicationResult {
  const ref = request.contextRef ?? { type: 'none' };
  const context = buildCommunicationContext(ref);
  const rewriteStyle = request.rewriteStyle ?? detectRewriteStyle(request.userText);
  const enrichedRequest: CommunicationRequest = { ...request, rewriteStyle };

  const intent = detectCommunicationIntent(request.userText, context);

  if ((ref.type === 'inbox' || ref.type === 'document') && !context.relevanceAllowed) {
    return blockedResult(context.relevanceBlockReason ?? 'communication.block.notRelevant', intent);
  }

  const reminderBlock = resolveInvoiceReminderBlock(intent, context);
  if (reminderBlock) return blockedResult(reminderBlock, intent);

  if (isDocumentQuestionIntent(intent)) {
    const questionType = detectDocumentQuestionType(request.userText);
    if (questionType === 'draft_reply') {
      const missing = getMissingCommunicationInfo('document_reply', enrichedRequest, context);
      if (missing.length > 0) {
        return needsInfoResult('document_reply', missing, context);
      }
      const coreDraft = buildCommunicationDraft(enrichedRequest, context, 'document_reply');
      if (coreDraft) {
        return {
          mode: 'draft',
          intent: 'document_reply',
          status: 'complete',
          title: 'communication.intent.document_reply',
          summary: 'communication.draftReady.summary',
          drafts: renderAllChannels(coreDraft, context),
          disclaimer: context.disclaimer,
        };
      }
    }

    const documentQa = answerDocumentQuestion(enrichedRequest, context);
    return {
      mode: 'question',
      intent: 'document_question',
      status: 'complete',
      title: 'communication.qa.title',
      summary: documentQa.answer,
      documentQa,
      disclaimer: context.disclaimer,
    };
  }

  if (intent === 'unknown') {
    return {
      mode: enrichedRequest.mode ?? 'draft',
      intent,
      status: 'no_data',
      title: 'communication.unknown.title',
      summary: 'communication.unknown.summary',
      disclaimer: context.disclaimer,
    };
  }

  const missingInfo = getMissingCommunicationInfo(intent, enrichedRequest, context);
  if (missingInfo.length > 0) {
    return needsInfoResult(intent, missingInfo, context);
  }

  const coreDraft = buildCommunicationDraft(enrichedRequest, context, intent);
  if (!coreDraft) {
    return {
      mode: 'draft',
      intent,
      status: 'no_data',
      title: 'communication.draftFailed.title',
      summary: 'communication.draftFailed.summary',
      disclaimer: context.disclaimer,
    };
  }

  return {
    mode: intent === 'rewrite_message' || intent === 'improve_text' ? 'rewrite' : 'draft',
    intent,
    status: 'complete',
    title: `communication.intent.${intent}`,
    summary: 'communication.draftReady.summary',
    drafts: renderAllChannels(coreDraft, context),
    disclaimer: context.disclaimer,
  };
}
