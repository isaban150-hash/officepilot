import type {
  CompanySessionAction,
  CompanySessionContext,
  CommunicationContextRef,
} from '../../types/companySession';
import { getDocumentById } from '../documentService';
import { getInboxItemById } from '../inboxService';
import { getContractPreviewForInbox, processUploadedDocument } from '../intakeWorkflowService';
import { getVorgangById } from '../vorgangService';

const STORAGE_KEY = 'officepilot-company-session';
const MAX_CONVERSATION_TURNS = 8;

const EMPTY_SESSION: CompanySessionContext = {
  updatedAt: new Date(0).toISOString(),
  conversationTurns: [],
};

function formatEuro(amount: number): string {
  return `${amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function readStorage(): CompanySessionContext {
  if (typeof sessionStorage === 'undefined') return { ...EMPTY_SESSION };
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_SESSION };
    const parsed = JSON.parse(raw) as Partial<CompanySessionContext>;
    return {
      ...EMPTY_SESSION,
      ...parsed,
      conversationTurns: Array.isArray(parsed.conversationTurns) ? parsed.conversationTurns : [],
    };
  } catch {
    return { ...EMPTY_SESSION };
  }
}

function writeStorage(session: CompanySessionContext): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function getCompanySession(): CompanySessionContext {
  return readStorage();
}

export function updateCompanySession(
  partial: Partial<CompanySessionContext>,
): CompanySessionContext {
  const next: CompanySessionContext = {
    ...readStorage(),
    ...partial,
    updatedAt: new Date().toISOString(),
    conversationTurns: partial.conversationTurns ?? readStorage().conversationTurns,
  };
  writeStorage(next);
  return next;
}

export function resetCompanySessionForTests(): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

export function recordAssistantQuestion(question: string): CompanySessionContext {
  const session = readStorage();
  const turns = [...session.conversationTurns, question.trim()].filter(Boolean).slice(-MAX_CONVERSATION_TURNS);
  return updateCompanySession({
    conversationTurns: turns,
    lastAction: 'ask_assistant',
  });
}

export function recordInboxContext(inboxId: string, action: CompanySessionAction = 'view_inbox'): CompanySessionContext {
  const item = getInboxItemById(inboxId);
  if (!item) return getCompanySession();

  const preview = getContractPreviewForInbox(item);
  const workflow = processUploadedDocument(inboxId);
  const linkedVorgang = item.vorgangId ? getVorgangById(item.vorgangId) : undefined;

  const previous = readStorage();

  return updateCompanySession({
    currentInboxId: inboxId,
    currentDocumentId: undefined,
    currentVorgangId: linkedVorgang?.id ?? item.vorgangId,
    currentVorgangTitle: linkedVorgang?.title ?? workflow?.suggestedVorgang?.vorgangTitle,
    currentCustomer: item.recognizedData.Kunde ?? item.sender ?? linkedVorgang?.customer,
    currentBaustelle: item.recognizedData.Baustelle ?? linkedVorgang?.baustelle,
    currentDocumentKind: item.classifiedKind ?? item.documentType,
    currentDocumentTitle: item.title,
    contractTotalNet: preview.contractSum > 0 ? formatEuro(preview.contractSum) : undefined,
    contractPositionCount: preview.positionCount > 0 ? preview.positionCount : undefined,
    lastUploadInboxId: action === 'upload_document' ? inboxId : previous.lastUploadInboxId,
    lastUploadTitle: action === 'upload_document' ? item.title : previous.lastUploadTitle,
    lastAction: action,
  });
}

export function recordDocumentContext(documentId: string): CompanySessionContext {
  const doc = getDocumentById(documentId);
  if (!doc) return getCompanySession();

  const linkedVorgang = doc.linkedVorgang
    ? getVorgangById(doc.linkedVorgang.vorgangId)
    : undefined;

  return updateCompanySession({
    currentDocumentId: documentId,
    currentInboxId: undefined,
    currentVorgangId: linkedVorgang?.id,
    currentVorgangTitle: linkedVorgang?.title,
    currentCustomer: linkedVorgang?.customer ?? doc.issuer,
    currentBaustelle: linkedVorgang?.baustelle,
    currentDocumentKind: doc.category,
    currentDocumentTitle: doc.title,
    lastAction: 'view_document',
  });
}

export function recordVorgangContext(vorgangId: string): CompanySessionContext {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return getCompanySession();

  return updateCompanySession({
    currentVorgangId: vorgang.id,
    currentVorgangTitle: vorgang.title,
    currentCustomer: vorgang.customer,
    currentBaustelle: vorgang.baustelle,
    currentInboxId: undefined,
    currentDocumentId: undefined,
    lastAction: 'view_vorgang',
  });
}

export function recordInvoiceContext(
  vorgangId: string,
  invoiceId: string,
): CompanySessionContext {
  const vorgang = getVorgangById(vorgangId);
  return updateCompanySession({
    currentVorgangId: vorgangId,
    currentVorgangTitle: vorgang?.title,
    currentCustomer: vorgang?.customer,
    currentBaustelle: vorgang?.baustelle,
    lastInvoiceId: invoiceId,
    lastInvoiceVorgangId: vorgangId,
    lastAction: 'view_invoice',
  });
}

export function recordContractAccepted(inboxId: string): CompanySessionContext {
  return recordInboxContext(inboxId, 'accept_contract');
}

export function getContextRefFromSession(
  session: CompanySessionContext = getCompanySession(),
): CommunicationContextRef {
  if (session.currentVorgangId) {
    return { type: 'vorgang', id: session.currentVorgangId };
  }
  if (session.currentInboxId) {
    return { type: 'inbox', id: session.currentInboxId };
  }
  if (session.currentDocumentId) {
    return { type: 'document', id: session.currentDocumentId };
  }
  if (session.lastInvoiceId && session.lastInvoiceVorgangId) {
    return {
      type: 'invoice',
      id: session.lastInvoiceId,
      vorgangId: session.lastInvoiceVorgangId,
    };
  }
  if (session.lastUploadInboxId) {
    return { type: 'inbox', id: session.lastUploadInboxId };
  }
  return { type: 'none' };
}

export function buildSessionContextBlock(session: CompanySessionContext): string {
  const lines: string[] = ['GESPRÄCHSKONTEXT (aktuelle Arbeitssitzung):'];

  if (session.currentVorgangTitle || session.currentVorgangId) {
    lines.push(
      `Aktueller Auftrag: ${session.currentVorgangTitle ?? session.currentVorgangId}${session.currentCustomer ? ` (${session.currentCustomer})` : ''}`,
    );
  }
  if (session.currentCustomer) {
    lines.push(`Aktueller Kunde: ${session.currentCustomer}`);
  }
  if (session.currentBaustelle) {
    lines.push(`Aktuelle Baustelle: ${session.currentBaustelle}`);
  }
  if (session.currentDocumentTitle || session.currentInboxId) {
    lines.push(
      `Aktuelles Dokument: ${session.currentDocumentTitle ?? session.currentInboxId}${session.currentDocumentKind ? ` (${session.currentDocumentKind})` : ''}`,
    );
  }
  if (session.contractTotalNet) {
    lines.push(`Vertragssumme (netto): ${session.contractTotalNet}`);
  }
  if (session.contractPositionCount) {
    lines.push(`Erkannte Positionen: ${session.contractPositionCount}`);
  }
  if (session.lastUploadTitle) {
    lines.push(`Letzter Upload: ${session.lastUploadTitle}`);
  }
  if (session.conversationTurns.length > 0) {
    lines.push(`Letzte Fragen: ${session.conversationTurns.slice(-3).join(' → ')}`);
  }

  if (lines.length === 1) {
    lines.push('- (noch kein Bezug in dieser Sitzung)');
  }

  return lines.join('\n');
}

export function hasActiveCompanyContext(session: CompanySessionContext = getCompanySession()): boolean {
  return Boolean(
    session.currentVorgangId ||
      session.currentInboxId ||
      session.currentDocumentId ||
      session.lastUploadInboxId,
  );
}
