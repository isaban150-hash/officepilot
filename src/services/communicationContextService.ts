import { analyzeContractFromInbox } from './contractAnalysisService';
import {
  checkCompanyRelevance,
  checkCompanyRelevanceFromInbox,
} from './companyRelevanceService';
import { getCompanyProfile } from './companyProfileService';
import { getDocumentById } from './documentService';
import { getExpenseById } from './expenseService';
import { calculateExpensePaymentSummary } from './expensePaymentCalculations';
import { getInboxItemById } from './inboxService';
import { getMailImportById } from './mailImportService';
import { getLetterExplanation } from './letterExplanationService';
import { calculatePaymentSummary } from './invoicePaymentService';
import { getVorgangById, getVorgangInvoice } from './vorgangService';
import { getNotesForVorgang } from './vorgangNoteService';
import { getKnowledgeFactsForCommunicationContext } from './knowledgeService';
import {
  COMMUNICATION_DISCLAIMER,
  MAX_RECOGNIZED_TEXT_LENGTH,
  MAX_VORGANG_NOTES_IN_CONTEXT,
} from './communicationConstants';
import type {
  CommunicationContext,
  CommunicationContextRef,
  CommunicationFact,
  CommunicationLetterSummary,
} from '../types/communication';
import type { CompanyDocument, InboxItem } from '../types/models';

function truncateText(text: string, max = MAX_RECOGNIZED_TEXT_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function buildRecognizedTextFromInbox(item: InboxItem): string {
  const vertragstext =
    item.recognizedData._vertragstext ?? item.recognizedData.Vertragstext ?? '';
  const dataText = Object.entries(item.recognizedData)
    .filter(([key]) => key !== '_vertragstext' && key !== 'Vertragstext')
    .map(([, value]) => value)
    .join('\n');
  return truncateText(
    [item.title, item.sender, item.officePilotSuggestion, vertragstext, dataText]
      .filter(Boolean)
      .join('\n'),
  );
}

function buildRecognizedTextFromDocument(doc: CompanyDocument): string {
  return truncateText([doc.title, doc.issuer, doc.recognizedText, ...doc.tags].filter(Boolean).join('\n'));
}

function letterToSummary(
  explanation: NonNullable<ReturnType<typeof getLetterExplanation>>,
): CommunicationLetterSummary {
  return {
    kind: explanation.kind,
    about: explanation.about,
    importance: explanation.importance,
    deadline: explanation.deadline,
    nextSteps: explanation.nextSteps,
  };
}

function checkDocumentRelevance(doc: CompanyDocument): boolean {
  if (doc.linkedVorgang) return true;
  const profile = getCompanyProfile();
  const text = [doc.title, doc.issuer, doc.recognizedText, doc.linkedCompany ?? ''].join('\n');
  return checkCompanyRelevance(
    {
      text,
      markedAsCompanyDocument: true,
    },
    profile,
  ).isRelevant;
}

function appendVorgangNotesFacts(vorgangId: string | undefined, facts: CommunicationFact[]): void {
  if (!vorgangId) return;
  const notes = getNotesForVorgang(vorgangId).slice(0, MAX_VORGANG_NOTES_IN_CONTEXT);
  for (const note of notes) {
    facts.push({
      key: `note:${note.id}`,
      value: note.body,
      source: 'note',
    });
  }
}

function appendKnowledgeFacts(ref: CommunicationContextRef, facts: CommunicationFact[]): void {
  for (const fact of getKnowledgeFactsForCommunicationContext(ref)) {
    facts.push({
      key: `knowledge:${fact.id}`,
      value: fact.displayText,
      source: 'knowledge',
    });
  }
}

function resolveVorgangId(ref: CommunicationContextRef): string | undefined {
  if (ref.type === 'vorgang') return ref.id;
  if (ref.type === 'invoice') return ref.vorgangId;
  if (ref.type === 'inbox') {
    const item = ref.id ? getInboxItemById(ref.id) : undefined;
    return item?.vorgangId;
  }
  if (ref.type === 'document') {
    const doc = ref.id ? getDocumentById(ref.id) : undefined;
    return doc?.linkedVorgang?.vorgangId;
  }
  return undefined;
}

export function buildCommunicationContext(
  ref: CommunicationContextRef = { type: 'none' },
): CommunicationContext {
  const profile = getCompanyProfile();
  const facts: CommunicationFact[] = [];
  let relevanceAllowed = true;
  let relevanceBlockReason: string | undefined;
  let recognizedText: string | undefined;
  let recognizedData: Record<string, string> | undefined;
  let classifiedKind: CommunicationContext['classifiedKind'];
  let letterExplanation: CommunicationLetterSummary | null = null;
  let contractRequiredDocuments: string[] | undefined;
  let recipient: CommunicationContext['recipient'];
  let subject: string | undefined;
  let vorgangSummary: CommunicationContext['vorgangSummary'];
  let invoiceSummary: CommunicationContext['invoiceSummary'];
  let expenseSummary: CommunicationContext['expenseSummary'];

  if (ref.type === 'none') {
    return {
      ref,
      companyName: profile.companyName,
      facts,
      relevanceAllowed: true,
      disclaimer: COMMUNICATION_DISCLAIMER,
    };
  }

  if (ref.type === 'inbox' && ref.id) {
    const item = getInboxItemById(ref.id);
    if (!item) {
      return {
        ref,
        companyName: profile.companyName,
        facts,
        relevanceAllowed: false,
        relevanceBlockReason: 'communication.block.inboxNotFound',
        disclaimer: COMMUNICATION_DISCLAIMER,
      };
    }

    const relevance = checkCompanyRelevanceFromInbox(item);
    relevanceAllowed = relevance.isRelevant || Boolean(item.markedAsCompanyDocument);
    if (!relevanceAllowed) {
      relevanceBlockReason = 'communication.block.notRelevant';
    }

    recognizedText = buildRecognizedTextFromInbox(item);
    recognizedData = { ...item.recognizedData };
    classifiedKind = item.classifiedKind;
    recipient = { name: item.sender, organization: item.sender };
    subject = item.recognizedData.Betreff ?? item.recognizedData.betreff ?? item.title;

    const explanation = getLetterExplanation(item);
    if (explanation) {
      letterExplanation = letterToSummary(explanation);
    }

    if (relevanceAllowed) {
      const contract = analyzeContractFromInbox(item);
      if (contract.isContract && contract.requiredDocuments.length > 0) {
        contractRequiredDocuments = contract.requiredDocuments.map(
          (doc) => doc.reason || doc.type.replace(/_/g, ' '),
        );
      }
    }

    if (item.vorgangId) {
      const vorgang = getVorgangById(item.vorgangId);
      if (vorgang) {
        vorgangSummary = {
          id: vorgang.id,
          title: vorgang.title,
          customer: vorgang.customer,
          baustelle: vorgang.baustelle,
        };
      }
    }
  }

  if (ref.type === 'document' && ref.id) {
    const doc = getDocumentById(ref.id);
    if (!doc) {
      return {
        ref,
        companyName: profile.companyName,
        facts,
        relevanceAllowed: false,
        relevanceBlockReason: 'communication.block.documentNotFound',
        disclaimer: COMMUNICATION_DISCLAIMER,
      };
    }

    relevanceAllowed = checkDocumentRelevance(doc);
    if (!relevanceAllowed) {
      relevanceBlockReason = 'communication.block.notRelevant';
    }

    recognizedText = buildRecognizedTextFromDocument(doc);
    recognizedData = { issuer: doc.issuer, category: doc.category };
    recipient = { name: doc.issuer, organization: doc.issuer };
    subject = doc.title;

    if (doc.linkedVorgang) {
      const vorgang = getVorgangById(doc.linkedVorgang.vorgangId);
      if (vorgang) {
        vorgangSummary = {
          id: vorgang.id,
          title: vorgang.title,
          customer: vorgang.customer,
          baustelle: vorgang.baustelle,
        };
      }
    }
  }

  if (ref.type === 'vorgang' && ref.id) {
    const vorgang = getVorgangById(ref.id);
    if (vorgang) {
      vorgangSummary = {
        id: vorgang.id,
        title: vorgang.title,
        customer: vorgang.customer,
        baustelle: vorgang.baustelle,
      };
      recipient = { name: vorgang.customer, organization: vorgang.customer };
      subject = vorgang.title;
      facts.push({
        key: 'vorgang:baustelle',
        value: vorgang.baustelle,
        source: 'system',
      });
    }
  }

  if (ref.type === 'invoice' && ref.id && ref.vorgangId) {
    const invoice = getVorgangInvoice(ref.vorgangId, ref.id);
    const vorgang = getVorgangById(ref.vorgangId);
    if (invoice && vorgang) {
      const summary = calculatePaymentSummary(invoice);
      invoiceSummary = {
        id: invoice.id,
        number: invoice.number,
        amount: invoice.amount,
        openAmount: summary.openAmount,
        dueDate: invoice.paymentDueDate,
        vorgangTitle: vorgang.title,
      };
      vorgangSummary = {
        id: vorgang.id,
        title: vorgang.title,
        customer: vorgang.customer,
        baustelle: vorgang.baustelle,
      };
      recipient = {
        name: invoice.customerSnapshot?.name ?? vorgang.customer,
        organization: invoice.customerSnapshot?.name ?? vorgang.customer,
      };
      subject = `Rechnung ${invoice.number}`;
      facts.push({
        key: 'invoice:number',
        value: invoice.number,
        source: 'system',
      });
      facts.push({
        key: 'invoice:openAmount',
        value: String(summary.openAmount),
        source: 'system',
      });
    }
  }

  if (ref.type === 'mail' && ref.id) {
    const mailImport = getMailImportById(ref.id);
    if (!mailImport) {
      return {
        ref,
        companyName: profile.companyName,
        facts,
        relevanceAllowed: false,
        relevanceBlockReason: 'communication.block.mailNotFound',
        disclaimer: COMMUNICATION_DISCLAIMER,
      };
    }

    const linkedInboxId = mailImport.linkedInboxIds[0];
    const linkedInbox = linkedInboxId ? getInboxItemById(linkedInboxId) : undefined;

    recognizedText = [
      mailImport.subject,
      mailImport.from,
      mailImport.bodyText,
      linkedInbox ? buildRecognizedTextFromInbox(linkedInbox) : '',
    ]
      .filter(Boolean)
      .join('\n');
    recognizedData = {
      Betreff: mailImport.subject,
      Von: mailImport.from,
      ...(linkedInbox?.recognizedData ?? {}),
    };
    classifiedKind = linkedInbox?.classifiedKind;
    recipient = { name: mailImport.from, organization: mailImport.from };
    subject = mailImport.subject;
    relevanceAllowed = true;

    if (linkedInbox) {
      const explanation = getLetterExplanation(linkedInbox);
      if (explanation) {
        letterExplanation = letterToSummary(explanation);
      }
    }

    facts.push(
      { key: 'mail:from', value: mailImport.from, source: 'system' },
      { key: 'mail:subject', value: mailImport.subject, source: 'system' },
    );
  }

  if (ref.type === 'expense' && ref.id) {
    const expense = getExpenseById(ref.id);
    if (expense) {
      const summary = calculateExpensePaymentSummary(expense);
      expenseSummary = {
        id: expense.id,
        supplierName: expense.supplierName,
        title: expense.title,
        grossAmount: expense.grossAmount,
        openAmount: summary.openAmount,
        dueDate: expense.paymentDueDate,
      };
      recipient = { name: expense.supplierName, organization: expense.supplierName };
      subject = expense.invoiceNumber
        ? `Rechnung ${expense.invoiceNumber}`
        : expense.title;
      facts.push({
        key: 'expense:supplier',
        value: expense.supplierName,
        source: 'system',
      });
    }
  }

  appendVorgangNotesFacts(resolveVorgangId(ref), facts);
  appendKnowledgeFacts(ref, facts);

  return {
    ref,
    companyName: profile.companyName,
    recipient,
    subject,
    facts,
    recognizedText,
    recognizedData,
    classifiedKind,
    letterExplanation,
    contractRequiredDocuments,
    relevanceAllowed,
    relevanceBlockReason,
    disclaimer: COMMUNICATION_DISCLAIMER,
    vorgangSummary,
    invoiceSummary,
    expenseSummary,
  };
}
