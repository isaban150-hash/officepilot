import type { CompanySessionContext } from '../../types/companySession';
import type { HandwerkKnowledgeResolution } from '../../types/handwerkKnowledge';
import type { BrainSuggestedStep } from '../../types/brainOrchestration';
import { getInboxItemById } from '../inboxService';
import { buildInvoiceCreatePath, type InvoiceCreateType } from '../invoiceNavigation';
import { processUploadedDocument } from '../intakeWorkflowService';
import {
  getOpenQuantity,
  getPositionBillingStatus,
  hasFinalSchlussrechnung,
} from '../orderBillingRules';
import { analyzeContractIntelligenceFromInbox } from '../contractIntelligenceService';
import { getVorgangById } from '../vorgangService';
import {
  buildTermAnswer,
  buildWorkflowChainText,
  findHandwerkTermsInQuestion,
  getHandwerkTermById,
  getHandwerkTermForDocumentKind,
  isHandwerkDefinitionQuestion,
  isHandwerkKnowledgeQuestion,
} from './handwerkKnowledgeRegistry';
import { getCompanySession, hasActiveCompanyContext } from './companySessionService';

function invoiceStep(vorgangId: string, type: InvoiceCreateType): BrainSuggestedStep {
  return {
    id: `open_${type}`,
    labelKey:
      type === 'schluss'
        ? 'handwerkKnowledge.nextStep.schlussrechnung'
        : type === 'abschlag'
          ? 'handwerkKnowledge.nextStep.abschlagsrechnung'
          : 'companyContext.nextStep.createInvoice',
    // Der Typ war hier schon bekannt, wurde aber nicht an die Route gereicht.
    route: buildInvoiceCreatePath(vorgangId, type),
    reasonKey: 'handwerkKnowledge.nextStep.invoiceReason',
  };
}

function resolveDefinitionQuestion(question: string): HandwerkKnowledgeResolution | null {
  const terms = findHandwerkTermsInQuestion(question);
  if (terms.length === 0) return null;

  if (terms.length > 1 && !isHandwerkDefinitionQuestion(question)) {
    return {
      source: 'clarification',
      knowledgeUsed: terms.map((t) => t.id),
      assistantAnswer: {
        title: 'Fachbegriff',
        summary: 'Mehrere Fachbegriffe erkannt. Welchen Begriff meinen Sie?',
        bullets: terms.map((t) => t.title),
        actions: [],
      },
      clarificationQuestion: 'handwerkKnowledge.clarification.whichTerm',
    };
  }

  const term = terms[0];
  const answer = buildTermAnswer(term);
  return {
    source: 'memory',
    knowledgeUsed: [term.id],
    assistantAnswer: {
      title: answer.title,
      summary: answer.summary,
      bullets: answer.bullets,
      actions: [],
    },
  };
}

function resolveWorkflowQuestion(): HandwerkKnowledgeResolution {
  return {
    source: 'memory',
    knowledgeUsed: ['workflow_chain'],
    assistantAnswer: {
      title: 'Typischer Handwerksablauf',
      summary: 'So hängen die wichtigsten Schritte im Handwerk typischerweise zusammen:',
      bullets: [buildWorkflowChainText()],
      actions: [],
    },
  };
}

function resolveSchlussrechnungQuestion(session: CompanySessionContext): HandwerkKnowledgeResolution | null {
  const vorgangId = session.currentVorgangId;
  if (!vorgangId) {
    if (!hasActiveCompanyContext(session)) return null;
    return {
      source: 'clarification',
      knowledgeUsed: ['schlussrechnung'],
      assistantAnswer: {
        title: 'Schlussrechnung',
        summary: 'Für eine konkrete Einschätzung brauche ich den aktuellen Auftrag.',
        bullets: [
          'Eine Schlussrechnung kommt nach Leistungsende und Abnahme infrage.',
          'Bereits gestellte Abschläge werden verrechnet.',
        ],
        actions: [],
      },
      clarificationQuestion: 'companyContext.clarification.whichVorgang',
      uncertaintyNote: 'brain.uncertainty.reviewRecommended',
    };
  }

  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return null;

  if (hasFinalSchlussrechnung(vorgang)) {
    return {
      source: 'rules',
      knowledgeUsed: ['schlussrechnung', 'vorgang'],
      assistantAnswer: {
        title: 'Schlussrechnung',
        summary: `Für Auftrag „${vorgang.title}“ liegt bereits eine Schlussrechnung vor.`,
        bullets: [],
        actions: [],
        linkedRoute: `/vorgaenge/${vorgang.id}`,
      },
    };
  }

  const openPositions = vorgang.orderPositions.filter(
    (position) => getOpenQuantity(vorgang, position.id) > 0,
  );
  const fullyBilled = vorgang.orderPositions.filter((position) => {
    const status = getPositionBillingStatus(vorgang, position.id);
    return status?.isFullyBilled;
  });

  if (openPositions.length === 0 && fullyBilled.length > 0) {
    return {
      source: 'rules',
      knowledgeUsed: ['schlussrechnung', 'vorgang'],
      assistantAnswer: {
        title: 'Schlussrechnung',
        summary: `Ja – für Auftrag „${vorgang.title}“ sind alle Positionen abgerechnet. Eine Schlussrechnung wäre jetzt sinnvoll.`,
        bullets: fullyBilled.slice(0, 3).map((p) => `Position vollständig: ${p.description}`),
        actions: [],
        linkedRoute: buildInvoiceCreatePath(vorgang.id, 'schluss'),
      },
      suggestedNextSteps: [invoiceStep(vorgang.id, 'schluss')],
    };
  }

  if (openPositions.length > 0) {
    return {
      source: 'rules',
      knowledgeUsed: ['schlussrechnung', 'vorgang'],
      assistantAnswer: {
        title: 'Schlussrechnung',
        summary: `Noch nicht – bei Auftrag „${vorgang.title}“ sind noch ${openPositions.length} Position(en) offen.`,
        bullets: openPositions.slice(0, 3).map((p) => `Offen: ${p.description}`),
        actions: [],
        linkedRoute: `/vorgaenge/${vorgang.id}`,
      },
      uncertaintyNote: 'brain.uncertainty.reviewRecommended',
      suggestedNextSteps: [invoiceStep(vorgang.id, 'abschlag')],
    };
  }

  return {
    source: 'rules',
    knowledgeUsed: ['schlussrechnung'],
    assistantAnswer: {
      title: 'Schlussrechnung',
      summary:
        'Eine Schlussrechnung kommt nach vollständiger Leistungserbringung und Abnahme infrage – vorher eher Abschlags- oder Teilrechnungen.',
      bullets: ['Bitte prüfen Sie Aufmaß und offene Positionen im Auftrag.'],
      actions: [],
    },
    uncertaintyNote: 'brain.uncertainty.reviewRecommended',
  };
}

function resolveAbschlagQuestion(session: CompanySessionContext): HandwerkKnowledgeResolution | null {
  const vorgangId = session.currentVorgangId;
  if (!vorgangId) return null;

  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return null;

  const inboxId = session.currentInboxId ?? session.lastUploadInboxId;
  let contractAllows = false;
  if (inboxId) {
    const item = getInboxItemById(inboxId);
    if (item) {
      const intelligence = analyzeContractIntelligenceFromInbox(item);
      contractAllows = Boolean(intelligence?.progressBillingAllowed);
    }
  }

  const openPositions = vorgang.orderPositions.filter(
    (position) => getOpenQuantity(vorgang, position.id) > 0,
  );

  if (openPositions.length === 0) {
    return {
      source: 'rules',
      knowledgeUsed: ['abschlagsrechnung', 'vorgang'],
      assistantAnswer: {
        title: 'Abschlagsrechnung',
        summary: `Für Auftrag „${vorgang.title}“ sind aktuell keine offenen Positionen mehr – eher Schlussrechnung prüfen.`,
        bullets: [],
        actions: [],
      },
      uncertaintyNote: 'brain.uncertainty.reviewRecommended',
    };
  }

  const bullets = openPositions.slice(0, 3).map((p) => `Offene Leistung: ${p.description}`);
  if (contractAllows) {
    bullets.unshift('Im Werkvertrag sind Abschlagsrechnungen vorgesehen.');
  }

  return {
    source: 'rules',
    knowledgeUsed: ['abschlagsrechnung', 'vorgang'],
    assistantAnswer: {
      title: 'Abschlagsrechnung',
      summary: `Für Auftrag „${vorgang.title}“ wäre jetzt eine Abschlagsrechnung möglich.`,
      bullets,
      actions: [],
      linkedRoute: buildInvoiceCreatePath(vorgang.id, 'abschlag'),
    },
    suggestedNextSteps: [invoiceStep(vorgang.id, 'abschlag')],
    uncertaintyNote: contractAllows ? undefined : 'brain.uncertainty.reviewRecommended',
  };
}

function resolveDocumentTypeQuestion(session: CompanySessionContext): HandwerkKnowledgeResolution | null {
  const inboxId = session.currentInboxId ?? session.lastUploadInboxId;
  if (!inboxId) return null;

  const item = getInboxItemById(inboxId);
  if (!item) return null;

  const term = getHandwerkTermForDocumentKind(item.classifiedKind);
  if (item.classifiedKind === 'nachtrag') {
    return {
      source: 'rules',
      knowledgeUsed: ['nachtrag', 'document'],
      assistantAnswer: {
        title: 'Dokumentenart',
        summary: 'Das sieht nach einem Nachtrag aus.',
        bullets: [
          term?.practicalNote ?? 'Nachträge sollten als Position im Auftrag nachgeführt werden.',
        ],
        actions: [],
        linkedRoute: `/ablage/${inboxId}`,
      },
    };
  }

  if (term) {
    const workflow = processUploadedDocument(inboxId);
    const bullets = [term.practicalNote];
    if (workflow?.similarVorgaenge.length === 1) {
      bullets.push(`Passt wahrscheinlich zu Auftrag „${workflow.similarVorgaenge[0].title}“.`);
    }
    return {
      source: 'rules',
      knowledgeUsed: [term.id, 'document'],
      assistantAnswer: {
        title: 'Dokumentenart',
        summary: `Das Dokument „${item.title}“ ist als ${term.title} erkannt.`,
        bullets,
        actions: [],
        linkedRoute: `/ablage/${inboxId}`,
      },
      uncertaintyNote:
        workflow && workflow.similarVorgaenge.length > 1
          ? 'brain.uncertainty.reviewRecommended'
          : undefined,
    };
  }

  return null;
}

function resolveWerkvertragGaps(session: CompanySessionContext): HandwerkKnowledgeResolution | null {
  const inboxId = session.currentInboxId ?? session.lastUploadInboxId;
  if (!inboxId) return null;

  const item = getInboxItemById(inboxId);
  if (!item) return null;

  if (item.classifiedKind !== 'werkvertrag' && item.classifiedKind !== 'leistungsverzeichnis') {
    return null;
  }

  const intelligence = analyzeContractIntelligenceFromInbox(item);
  if (!intelligence) return null;

  const missingQuantities = intelligence.positions.some(
    (position) => !position.quantity || position.quantity <= 0,
  );

  if (!missingQuantities) return null;

  return {
    source: 'rules',
    knowledgeUsed: ['werkvertrag', 'aufmasz'],
    assistantAnswer: {
      title: 'Werkvertrag',
      summary: 'Zu diesem Werkvertrag fehlen noch die endgültigen Mengen.',
      bullets: [
        `${intelligence.positions.length} Positionen erkannt – bitte Aufmaß oder LV prüfen.`,
        'Ohne Mengen sind Abschlags- und Schlussrechnungen unsicher.',
      ],
      actions: [],
      linkedRoute: `/ablage/${inboxId}`,
    },
    uncertaintyNote: 'brain.uncertainty.reviewRecommended',
  };
}

export function tryResolveHandwerkKnowledgeQuestion(
  question: string,
  session: CompanySessionContext = getCompanySession(),
): HandwerkKnowledgeResolution | null {
  const q = question.trim();
  if (!q || !isHandwerkKnowledgeQuestion(q)) return null;

  if (/zusammenhang|zusammenhäng|ablauf|workflow|typisch.*ablauf|wie hängen/i.test(q)) {
    return resolveWorkflowQuestion();
  }

  if (/brauche ich.*schluss|benötige ich.*schluss|schlussrechnung.*(nötig|nötig|jetzt|hier)/i.test(q)) {
    return resolveSchlussrechnungQuestion(session);
  }

  if (/abschlagsrechnung.*(möglich|jetzt|nötig)|brauche ich.*abschlag/i.test(q)) {
    return resolveAbschlagQuestion(session);
  }

  if (/sieht.*nach|gehört.*wahrscheinlich|dokumentenart|was ist das für ein dokument/i.test(q)) {
    const docType = resolveDocumentTypeQuestion(session);
    if (docType) return docType;
  }

  if (/fehlen.*mengen|endgültige mengen|mengen.*fehlen/i.test(q)) {
    const gaps = resolveWerkvertragGaps(session);
    if (gaps) return gaps;
  }

  if (isHandwerkDefinitionQuestion(q) || findHandwerkTermsInQuestion(q).length > 0) {
    const definition = resolveDefinitionQuestion(q);
    if (definition) return definition;
  }

  if (hasActiveCompanyContext(session)) {
    const gaps = resolveWerkvertragGaps(session);
    if (gaps && /werkvertrag|vertrag/i.test(q)) return gaps;
  }

  return null;
}

export function explainHandwerkTerm(termId: string): HandwerkKnowledgeResolution | null {
  const term = getHandwerkTermById(termId as import('../../types/handwerkKnowledge').HandwerkKnowledgeId);
  if (!term) return null;
  const answer = buildTermAnswer(term);
  return {
    source: 'memory',
    knowledgeUsed: [term.id],
    assistantAnswer: {
      title: answer.title,
      summary: answer.summary,
      bullets: answer.bullets,
      actions: [],
    },
  };
}
