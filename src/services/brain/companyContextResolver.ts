import type { CompanyContextResolution, CompanySessionContext } from '../../types/companySession';
import type { BrainSuggestedStep } from '../../types/brainOrchestration';
import { buildKommunikationPath } from '../../components/communication/communicationNavigation';
import { getInboxItemById } from '../inboxService';
import { getContractPreviewForInbox, processUploadedDocument } from '../intakeWorkflowService';
import { getVorgangById } from '../vorgangService';
import {
  getCompanySession,
  getContextRefFromSession,
  hasActiveCompanyContext,
  recordContractAccepted,
} from './companySessionService';

function formatEuro(amount: number): string {
  return `${amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function isFollowUpQuestion(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  return (
    /dies(er|e|es|en)|diesen|aktuelle[rn]?|letzte[rn]?|jetzt|dazu|dabei|dort|hier/i.test(q) ||
    /wer ist.*(kunde|auftraggeber)|welcher kunde|kunde\??$/i.test(q) ||
    /welche.*baustelle|baustelle\??$/i.test(q) ||
    /vertragssumme|summe.*vertrag|wie hoch.*(summe|betrag|vertrag)/i.test(q) ||
    /schreib.*rechnung|rechnung.*(erstellen|schreiben|jetzt)|jetzt.*rechnung/i.test(q) ||
    /ordne.*(zu|material)|materialrechnung.*zuordn|zuordn/i.test(q) ||
    /nimm.*(werkvertrag|vertrag)|übernimm.*vertrag/i.test(q)
  );
}

function invoiceNextStep(vorgangId: string): BrainSuggestedStep {
  return {
    id: 'open_invoice',
    labelKey: 'companyContext.nextStep.createInvoice',
    route: `/vorgaenge/${vorgangId}/rechnung`,
    reasonKey: 'companyContext.nextStep.createInvoiceReason',
  };
}

function inboxNextStep(inboxId: string): BrainSuggestedStep {
  return {
    id: 'open_inbox_item',
    labelKey: 'brain.nextStep.openInbox',
    route: `/ablage/${inboxId}`,
    reasonKey: 'brain.nextStep.openInboxReason',
  };
}

function communicationNextStep(session: CompanySessionContext): BrainSuggestedStep | null {
  const ref = getContextRefFromSession(session);
  if (ref.type === 'none') return null;
  return {
    id: 'open_communication',
    labelKey: 'brain.nextStep.openCommunication',
    route: buildKommunikationPath(ref),
    reasonKey: 'brain.nextStep.openCommunicationReason',
  };
}

function resolveCustomerQuestion(session: CompanySessionContext): CompanyContextResolution | null {
  const customer =
    session.currentCustomer ??
    (session.currentVorgangId ? getVorgangById(session.currentVorgangId)?.customer : undefined);
  if (!customer) return null;

  const vorgang = session.currentVorgangId ? getVorgangById(session.currentVorgangId) : undefined;
  return {
    source: 'memory',
    contextUsed: ['customer', 'vorgang'],
    assistantAnswer: {
      title: 'Kunde',
      summary: `Der Kunde ist ${customer}.`,
      bullets: vorgang
        ? [`Auftrag: ${vorgang.title}`, `Baustelle: ${vorgang.baustelle}`]
        : [],
      actions: [],
      linkedRoute: vorgang ? `/vorgaenge/${vorgang.id}` : undefined,
    },
    suggestedNextSteps: vorgang
      ? [
          {
            id: 'open_vorgang',
            labelKey: 'brain.nextStep.openVorgaenge',
            route: `/vorgaenge/${vorgang.id}`,
          },
        ]
      : [],
  };
}

function resolveBaustelleQuestion(session: CompanySessionContext): CompanyContextResolution | null {
  const baustelle =
    session.currentBaustelle ??
    (session.currentVorgangId ? getVorgangById(session.currentVorgangId)?.baustelle : undefined);
  if (!baustelle) return null;

  return {
    source: 'memory',
    contextUsed: ['baustelle'],
    assistantAnswer: {
      title: 'Baustelle',
      summary: `Die aktuelle Baustelle ist ${baustelle}.`,
      bullets: session.currentVorgangTitle ? [`Auftrag: ${session.currentVorgangTitle}`] : [],
      actions: [],
    },
  };
}

function resolveContractTotalQuestion(session: CompanySessionContext): CompanyContextResolution | null {
  if (session.contractTotalNet) {
    return {
      source: 'memory',
      contextUsed: ['document', 'contract'],
      assistantAnswer: {
        title: 'Vertragssumme',
        summary: `Die Vertragssumme (netto) beträgt ${session.contractTotalNet}.`,
        bullets: session.contractPositionCount
          ? [`${session.contractPositionCount} Positionen erkannt`]
          : [],
        actions: [],
      },
      uncertaintyNote: 'brain.uncertainty.reviewRecommended',
    };
  }

  const inboxId = session.currentInboxId ?? session.lastUploadInboxId;
  if (!inboxId) return null;
  const item = getInboxItemById(inboxId);
  if (!item) return null;

  const preview = getContractPreviewForInbox(item);
  if (preview.contractSum <= 0) return null;

  return {
    source: 'memory',
    contextUsed: ['document', 'contract'],
    assistantAnswer: {
      title: 'Vertragssumme',
      summary: `Die Vertragssumme (netto) beträgt ${formatEuro(preview.contractSum)}.`,
      bullets: preview.positionCount > 0 ? [`${preview.positionCount} Positionen erkannt`] : [],
      actions: [],
      linkedRoute: `/ablage/${inboxId}`,
    },
    uncertaintyNote: 'brain.uncertainty.reviewRecommended',
    suggestedNextSteps: [inboxNextStep(inboxId)],
  };
}

function resolveInvoiceCreation(session: CompanySessionContext): CompanyContextResolution | null {
  const vorgangId = session.currentVorgangId;
  if (vorgangId) {
    const vorgang = getVorgangById(vorgangId);
    if (!vorgang) return null;
    return {
      source: 'rules',
      contextUsed: ['vorgang', 'invoice'],
      assistantAnswer: {
        title: 'Rechnung erstellen',
        summary: `Für Auftrag „${vorgang.title}“ (${vorgang.customer}) können Sie jetzt eine Rechnung erstellen.`,
        bullets: [
          `Baustelle: ${vorgang.baustelle}`,
          `${vorgang.orderPositions.length} Positionen im Auftrag`,
        ],
        actions: [],
        linkedRoute: `/vorgaenge/${vorgangId}/rechnung`,
      },
      suggestedNextSteps: [invoiceNextStep(vorgangId)],
    };
  }

  const inboxId = session.lastUploadInboxId ?? session.currentInboxId;
  if (inboxId) {
    const item = getInboxItemById(inboxId);
    if (item?.vorgangId) {
      return resolveInvoiceCreation({
        ...session,
        currentVorgangId: item.vorgangId,
      });
    }
  }

  return null;
}

function resolveMaterialAssignment(session: CompanySessionContext): CompanyContextResolution | null {
  const uploadId = session.lastUploadInboxId ?? session.currentInboxId;
  if (!uploadId) return null;

  const item = getInboxItemById(uploadId);
  if (!item) return null;

  if (session.currentVorgangId) {
    const vorgang = getVorgangById(session.currentVorgangId);
    if (vorgang) {
      return {
        source: 'rules',
        contextUsed: ['upload', 'vorgang'],
        assistantAnswer: {
          title: 'Zuordnung',
          summary: `Die Materialrechnung „${item.title}“ kann zum Auftrag „${vorgang.title}“ zugeordnet werden.`,
          bullets: [`Kunde: ${vorgang.customer}`, `Baustelle: ${vorgang.baustelle}`],
          actions: [],
          linkedRoute: `/ablage/${uploadId}`,
        },
        suggestedNextSteps: [inboxNextStep(uploadId)],
      };
    }
  }

  const workflow = processUploadedDocument(uploadId);
  if (!workflow) return null;

  if (workflow.similarVorgaenge.length === 1) {
    const match = workflow.similarVorgaenge[0];
    return {
      source: 'rules',
      contextUsed: ['upload', 'vorgang'],
      assistantAnswer: {
        title: 'Zuordnung',
        summary: `Die Materialrechnung passt wahrscheinlich zu Auftrag „${match.title}“ (${match.customer}).`,
        bullets: [`Baustelle: ${match.baustelle}`],
        actions: [],
        linkedRoute: `/ablage/${uploadId}`,
      },
      suggestedNextSteps: [
        inboxNextStep(uploadId),
        {
          id: 'open_vorgang',
          labelKey: 'brain.nextStep.openVorgaenge',
          route: `/vorgaenge/${match.id}`,
        },
      ],
    };
  }

  if (workflow.similarVorgaenge.length > 1) {
    return {
      source: 'clarification',
      contextUsed: ['upload'],
      assistantAnswer: {
        title: 'Zuordnung',
        summary: 'Mehrere Aufträge passen zu dieser Materialrechnung. Bitte wählen Sie den richtigen Auftrag.',
        bullets: workflow.similarVorgaenge.map((v) => `${v.title} (${v.customer})`),
        actions: [],
      },
      clarificationQuestion: 'companyContext.clarification.whichVorgang',
      suggestedNextSteps: [inboxNextStep(uploadId)],
    };
  }

  return null;
}

function resolveAcceptContract(session: CompanySessionContext): CompanyContextResolution | null {
  const inboxId = session.currentInboxId ?? session.lastUploadInboxId;
  if (!inboxId) {
    return {
      source: 'clarification',
      contextUsed: [],
      assistantAnswer: {
        title: 'Werkvertrag',
        summary: 'Ich habe keinen aktuellen Vertrag in dieser Sitzung. Bitte öffnen Sie das Dokument im Eingang.',
        bullets: [],
        actions: [],
      },
      clarificationQuestion: 'companyContext.clarification.whichDocument',
      suggestedNextSteps: [
        {
          id: 'open_inbox',
          labelKey: 'brain.nextStep.openInbox',
          route: '/eingang',
        },
      ],
    };
  }

  const updated = recordContractAccepted(inboxId);
  const item = getInboxItemById(inboxId);
  const preview = item ? getContractPreviewForInbox(item) : null;

  return {
    source: 'rules',
    contextUsed: ['document', 'contract'],
    assistantAnswer: {
      title: 'Werkvertrag',
      summary: `Verstanden – ich merke mir den Werkvertrag „${item?.title ?? inboxId}“.`,
      bullets: [
        updated.currentCustomer ? `Kunde: ${updated.currentCustomer}` : '',
        preview && preview.contractSum > 0
          ? `Vertragssumme (netto): ${formatEuro(preview.contractSum)}`
          : '',
        preview && preview.positionCount > 0 ? `${preview.positionCount} Positionen erkannt` : '',
      ].filter(Boolean),
      actions: [],
      linkedRoute: `/ablage/${inboxId}`,
    },
    suggestedNextSteps: item?.vorgangId
      ? [invoiceNextStep(item.vorgangId)]
      : [inboxNextStep(inboxId)],
  };
}

export function tryResolveCompanyContextQuestion(
  question: string,
  session: CompanySessionContext = getCompanySession(),
): CompanyContextResolution | null {
  const q = question.trim();
  if (!q) return null;

  if (!hasActiveCompanyContext(session) && !isFollowUpQuestion(q)) {
    return null;
  }

  if (/nimm.*(werkvertrag|vertrag)|übernimm.*vertrag/i.test(q)) {
    return resolveAcceptContract(session);
  }

  if (/wer ist.*(kunde|auftraggeber)|welcher kunde|kunde\??$/i.test(q)) {
    return resolveCustomerQuestion(session);
  }

  if (/welche.*baustelle|baustelle\??$/i.test(q)) {
    return resolveBaustelleQuestion(session);
  }

  if (/vertragssumme|summe.*vertrag|wie hoch.*(summe|betrag|vertrag)/i.test(q)) {
    return resolveContractTotalQuestion(session);
  }

  if (/schreib.*rechnung|rechnung.*(erstellen|schreiben|jetzt)|jetzt.*rechnung/i.test(q)) {
    const resolved = resolveInvoiceCreation(session);
    if (resolved) return resolved;
    if (hasActiveCompanyContext(session)) {
      return {
        source: 'clarification',
        contextUsed: ['vorgang'],
        assistantAnswer: {
          title: 'Rechnung erstellen',
          summary: 'Für welchen Auftrag soll die Rechnung erstellt werden?',
          bullets: [],
          actions: [],
        },
        clarificationQuestion: 'companyContext.clarification.whichVorgang',
        suggestedNextSteps: [
          {
            id: 'open_vorgaenge',
            labelKey: 'brain.nextStep.openVorgaenge',
            route: '/vorgaenge',
          },
        ],
      };
    }
  }

  if (/ordne.*(zu|material)|materialrechnung.*zuordn|zuordn/i.test(q)) {
    return resolveMaterialAssignment(session);
  }

  if (isFollowUpQuestion(q) && hasActiveCompanyContext(session)) {
    const commStep = communicationNextStep(session);
    if (commStep && /formuliere|schreib.*(kunde|kunden|nachricht|mail|absage|antwort)/i.test(q)) {
      const label =
        session.currentVorgangTitle ?? session.currentDocumentTitle ?? session.currentCustomer ?? 'aktuellen Bezug';
      return {
        source: 'rules',
        contextUsed: ['session'],
        assistantAnswer: {
          title: 'Kommunikation',
          summary: `Ich kann einen Entwurf mit Bezug zu „${label}“ in der Kommunikation vorbereiten.`,
          bullets: [],
          actions: [],
          linkedRoute: commStep.route,
        },
        suggestedNextSteps: [commStep],
      };
    }
  }

  return null;
}
