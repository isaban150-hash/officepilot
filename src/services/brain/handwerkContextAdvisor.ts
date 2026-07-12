import type { CompanySessionContext } from '../../types/companySession';
import type { HandwerkAdvice } from '../../types/handwerkKnowledge';
import type { InboxItem, Vorgang } from '../../types/models';
import { analyzeContractIntelligenceFromInbox } from '../contractIntelligenceService';
import { getInboxItemById } from '../inboxService';
import { processUploadedDocument } from '../intakeWorkflowService';
import {
  getBilledQuantity,
  getOpenQuantity,
  getPositionBillingStatus,
  hasFinalSchlussrechnung,
  hasSchlussrechnung,
} from '../orderBillingRules';
import { getHandwerkTermForDocumentKind } from './handwerkKnowledgeRegistry';
import { getVorgangById } from '../vorgangService';

function hasAnyBilledInvoice(vorgang: Vorgang): boolean {
  return vorgang.invoices.some(
    (inv) =>
      (inv.status === 'vorbereitet' || inv.status === 'versendet') &&
      (inv.positions?.length ?? 0) > 0,
  );
}

function fullyBilledPositions(vorgang: Vorgang): string[] {
  return vorgang.orderPositions
    .filter((position) => {
      const status = getPositionBillingStatus(vorgang, position.id);
      return status?.isFullyBilled;
    })
    .map((position) => position.description);
}

function openPositions(vorgang: Vorgang): string[] {
  return vorgang.orderPositions
    .filter((position) => getOpenQuantity(vorgang, position.id) > 0)
    .map((position) => position.description);
}

export function buildHandwerkAdviceForVorgang(vorgang: Vorgang): HandwerkAdvice[] {
  const advice: HandwerkAdvice[] = [];

  if (vorgang.orderPositions.length > 0 && !hasAnyBilledInvoice(vorgang)) {
    const totalBilled = vorgang.orderPositions.reduce(
      (sum, position) => sum + getBilledQuantity(vorgang, position.id),
      0,
    );
    if (totalBilled === 0) {
      advice.push({
        messageKey: 'handwerkKnowledge.hint.quantitiesNotFinalized',
        certainty: 'medium',
        knowledgeId: 'aufmasz',
      });
    }
  }

  const open = openPositions(vorgang);
  if (open.length > 0 && !hasFinalSchlussrechnung(vorgang) && vorgang.orderPositions.length > 0) {
    advice.push({
      messageKey: 'handwerkKnowledge.hint.abschlagPossible',
      params: { vorgang: vorgang.title },
      certainty: 'medium',
      knowledgeId: 'abschlagsrechnung',
    });
  }

  const fullyBilled = fullyBilledPositions(vorgang);
  if (fullyBilled.length > 0) {
    advice.push({
      messageKey: 'handwerkKnowledge.hint.positionFullyBilled',
      params: { position: fullyBilled[0], count: fullyBilled.length },
      certainty: 'high',
      knowledgeId: 'leistungsverzeichnis',
    });
  }

  if (
    fullyBilled.length === vorgang.orderPositions.length &&
    vorgang.orderPositions.length > 0 &&
    !hasSchlussrechnung(vorgang)
  ) {
    advice.push({
      messageKey: 'handwerkKnowledge.hint.schlussrechnungDue',
      params: { vorgang: vorgang.title },
      certainty: 'high',
      knowledgeId: 'schlussrechnung',
    });
  }

  return advice;
}

export function buildHandwerkAdviceForInbox(item: InboxItem): HandwerkAdvice[] {
  const advice: HandwerkAdvice[] = [];
  const term = getHandwerkTermForDocumentKind(item.classifiedKind);

  if (item.classifiedKind === 'nachtrag') {
    advice.push({
      messageKey: 'handwerkKnowledge.hint.looksLikeNachtrag',
      certainty: 'high',
      knowledgeId: 'nachtrag',
    });
  } else if (term) {
    advice.push({
      messageKey: 'handwerkKnowledge.hint.documentTypeRecognized',
      params: { type: term.title },
      certainty: 'high',
      knowledgeId: term.id,
    });
  }

  const workflow = processUploadedDocument(item.id);
  if (workflow?.similarVorgaenge.length === 1) {
    advice.push({
      messageKey: 'handwerkKnowledge.hint.documentBelongsToVorgang',
      params: { vorgang: workflow.similarVorgaenge[0].title },
      certainty: 'medium',
      knowledgeId: 'werkvertrag',
    });
  }

  if (item.classifiedKind === 'werkvertrag' || item.classifiedKind === 'leistungsverzeichnis') {
    const intelligence = analyzeContractIntelligenceFromInbox(item);
    if (intelligence && intelligence.positions.length > 0) {
      const hasOpenQuantity = intelligence.positions.some(
        (position) => !position.quantity || position.quantity <= 0,
      );
      if (hasOpenQuantity) {
        advice.push({
          messageKey: 'handwerkKnowledge.hint.contractQuantitiesMissing',
          certainty: 'medium',
          knowledgeId: 'aufmasz',
        });
      }
    }
    if (intelligence?.progressBillingAllowed) {
      advice.push({
        messageKey: 'handwerkKnowledge.hint.contractAllowsAbschlag',
        certainty: 'high',
        knowledgeId: 'abschlagsrechnung',
      });
    }
  }

  return advice;
}

export function buildHandwerkAdviceForSession(session: CompanySessionContext): HandwerkAdvice[] {
  const advice: HandwerkAdvice[] = [];

  if (session.currentVorgangId) {
    const vorgang = getVorgangById(session.currentVorgangId);
    if (vorgang) {
      advice.push(...buildHandwerkAdviceForVorgang(vorgang));
    }
  }

  const inboxId = session.currentInboxId ?? session.lastUploadInboxId;
  if (inboxId) {
    const item = getInboxItemById(inboxId);
    if (item) {
      advice.push(...buildHandwerkAdviceForInbox(item));
    }
  }

  const seen = new Set<string>();
  return advice.filter((item) => {
    const key = `${item.messageKey}:${item.knowledgeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
