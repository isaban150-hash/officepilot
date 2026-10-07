/**
 * P1 EINGANGSSCHREIBEN — die eine Antwortbedarf-Wahrheit.
 *
 * Lebenszyklus, Dokumenterklärung, Assistent und der sichtbare Antwortblock
 * lesen den Antwortbedarf ausschliesslich hier. Gespeichert wird dafür nichts
 * Neues — die Ableitung liest vorhandene, synchronisierte Wahrheit:
 *
 *  - die erkannte **Antwortfrist** aus dem gespeicherten Analyse-Ergebnis
 *    (semantischer Kern: Art `response_due`, handlungsrelevant und von der
 *    echten Antwortregel erkannt). Die Ersatzregel „bis zum …" setzt dieselbe
 *    Art mit `appliesTo: 'Handlung'`; sie bleibt hier bewusst draussen — ein
 *    unsicherer Text-Rückfall erzeugt keinen Antwortbedarf;
 *  - die Geschäftsdeutung **`communication_request`** — die ausdrückliche Bitte
 *    um Rückmeldung in einem Schreiben;
 *  - die **Entscheidungen des Nutzers** aus den Kommunikationsereignissen.
 *
 * Eine Zahlungs-, Unterlagen-, Leistungs- oder Kündigungsfrist ist keine
 * Antwortfrist. Ein Altbestand ohne gespeichertes Analyse-Ergebnis bekommt
 * keinen erfundenen Antwortbedarf.
 *
 * Über den Status entscheidet das jüngste Statusereignis — über Eingang und
 * archiviertes Dokument hinweg, denn beide meinen dasselbe Schreiben. Die
 * Fristdaten selbst werden hier weder gelesen noch verändert, um „erledigt"
 * zu bestimmen; sie bleiben, was sie sind.
 */
import type { CommunicationContextRef } from '../types/communication';
import type {
  CommunicationEvent,
  CommunicationEventType,
  CommunicationReplyStatus,
} from '../types/communicationHistory';
import type { BusinessInterpretationResult } from '../types/businessInterpretation';
import type { SemanticDeadline } from '../types/documentSemanticCore';
import type { CompanyDocument, InboxItem } from '../types/models';
import { getEventsForContext } from './communicationHistoryService';
import { getDocumentById, isGeneratedOutgoingInvoiceDocument } from './documentService';
import { getDocumentWorkResult } from './documentWorkResultStoreService';
import { getInboxItemById } from './inboxService';
import { toCanonicalIsoDay } from '../utils/documentDateDisplay';

export type DocumentReplyNeedState =
  /** Keine Antwort erkannt und keine Entscheidung — kein Antwortbedarf. */
  | 'not_required'
  /** Antwort erforderlich und noch nicht erledigt. */
  | 'open'
  /** Ein Entwurf wurde in der Kommunikation erstellt (bestehender Vertrag). */
  | 'draft_ready'
  /** Der Entwurf wurde zum Versand kopiert (bestehender Vertrag). */
  | 'copied'
  | 'answered'
  | 'no_reply_needed';

export type DocumentReplyNeedReason =
  | 'response_deadline'
  | 'communication_request'
  /** Kein Inhaltsbefund, aber „Später erinnern" hält die Antwort offen. */
  | 'user_reopened'
  | 'none';

export interface DocumentReplyNeed {
  state: DocumentReplyNeedState;
  reason: DocumentReplyNeedReason;
  /** Inhaltlich erkannt: echte Antwortfrist oder Bitte um Rückmeldung. */
  recognized: boolean;
  /** ISO-Tag der erkannten Antwortfrist — nur bei einer echten Antwortfrist. */
  dueDate?: string;
  /** Alle Kontexte dieses Schreibens: archiviertes Dokument und/oder Eingang. */
  contexts: CommunicationContextRef[];
  /** Das jüngste Statusereignis, falls es eines gibt. */
  decisiveEvent?: CommunicationEvent;
  inboxItem?: InboxItem;
  document?: CompanyDocument;
}

export interface DocumentReplyNeedRef {
  inboxId?: string;
  documentId?: string;
}

/** Dieselben Ereignisarten, die der Lebenszyklus schon immer als Status las. */
const STATE_BY_EVENT: Partial<Record<CommunicationEventType, DocumentReplyNeedState>> = {
  marked_answered: 'answered',
  marked_no_reply_needed: 'no_reply_needed',
  draft_copied: 'copied',
  draft_created: 'draft_ready',
  document_answer: 'draft_ready',
  marked_remind_later: 'open',
};

/**
 * Eine echte Antwortfrist: Art `response_due`, der eigene Betrieb muss handeln,
 * und erkannt hat sie die Antwortregel („Nehmen Sie … Stellung", „beantworten
 * Sie", „Teilen Sie uns … mit") — nicht die Ersatzregel „bis zum …".
 */
export function isGenuineResponseDeadline(deadline: SemanticDeadline): boolean {
  return (
    deadline.type === 'response_due' &&
    deadline.actionRequired === true &&
    deadline.appliesTo === 'Antwort'
  );
}

function resolveLetter(ref: DocumentReplyNeedRef): {
  inboxItem?: InboxItem;
  document?: CompanyDocument;
} {
  let inboxItem = ref.inboxId ? getInboxItemById(ref.inboxId) : undefined;
  let document = ref.documentId ? getDocumentById(ref.documentId) : undefined;
  if (!document && inboxItem?.archiveDocumentId) document = getDocumentById(inboxItem.archiveDocumentId);
  if (!inboxItem && document?.sourceInboxItemId) inboxItem = getInboxItemById(document.sourceInboxItemId);
  return { inboxItem, document };
}

/** Das gespeicherte Analyse-Ergebnis des Ursprungseingangs, sonst die Momentaufnahme der Ablage. */
function resolveInterpretation(
  inboxItem: InboxItem | undefined,
  document: CompanyDocument | undefined,
): BusinessInterpretationResult | null {
  const sourceInboxId = (inboxItem?.id ?? document?.sourceInboxItemId ?? '').trim();
  const workResult = sourceInboxId ? getDocumentWorkResult(sourceInboxId) : null;
  return workResult?.businessInterpretation ?? document?.archiveTruthSnapshot?.businessInterpretation ?? null;
}

/** Werbung und eigene, ausgehende Schreiben verlangen keine Antwort von uns. */
function isNotIncomingCorrespondence(
  inboxItem: InboxItem | undefined,
  document: CompanyDocument | undefined,
  interpretation: BusinessInterpretationResult,
): boolean {
  if (inboxItem?.isAdvertisement) return true;
  if (document) {
    if (isGeneratedOutgoingInvoiceDocument(document)) return true;
    if (document.category === 'geschaeftsschreiben') return true;
    if (document.linkedLetterId || document.linkedOfferId) return true;
  }
  return interpretation.semantic?.complaint?.direction === 'outgoing';
}

function recognize(
  inboxItem: InboxItem | undefined,
  document: CompanyDocument | undefined,
): { recognized: boolean; reason: DocumentReplyNeedReason; dueDate?: string } {
  const interpretation = resolveInterpretation(inboxItem, document);
  if (!interpretation || isNotIncomingCorrespondence(inboxItem, document, interpretation)) {
    return { recognized: false, reason: 'none' };
  }

  const days = (interpretation.semantic?.deadlines ?? [])
    .filter(isGenuineResponseDeadline)
    .map((deadline) => toCanonicalIsoDay(deadline.date))
    .filter((day): day is string => Boolean(day))
    .sort();
  if (days.length > 0) {
    /* Die kanonische Frist am Eingang geht vor, wenn sie dieselbe Antwortfrist ist. */
    const canonical =
      inboxItem?.deadlineType === 'response_due' ? toCanonicalIsoDay(inboxItem.deadline) : null;
    const dueDate = canonical && days.includes(canonical) ? canonical : days[0];
    return { recognized: true, reason: 'response_deadline', dueDate };
  }

  if (interpretation.operational?.primaryCase === 'communication_request') {
    return { recognized: true, reason: 'communication_request' };
  }
  return { recognized: false, reason: 'none' };
}

function latestStatusEvent(contexts: CommunicationContextRef[]): CommunicationEvent | undefined {
  let latest: CommunicationEvent | undefined;
  const seen = new Set<string>();
  for (const context of contexts) {
    for (const event of getEventsForContext(context)) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (!STATE_BY_EVENT[event.type]) continue;
      if (
        !latest ||
        event.timestamp > latest.timestamp ||
        (event.timestamp === latest.timestamp && event.id > latest.id)
      ) {
        latest = event;
      }
    }
  }
  return latest;
}

export function resolveDocumentReplyNeed(ref: DocumentReplyNeedRef): DocumentReplyNeed {
  const { inboxItem, document } = resolveLetter(ref);

  const contexts: CommunicationContextRef[] = [];
  const documentId = document?.id ?? ref.documentId?.trim();
  const inboxId = inboxItem?.id ?? ref.inboxId?.trim();
  if (documentId) contexts.push({ type: 'document', id: documentId });
  if (inboxId) contexts.push({ type: 'inbox', id: inboxId });

  const recognition =
    inboxItem || document ? recognize(inboxItem, document) : { recognized: false, reason: 'none' as const };
  const decisiveEvent = latestStatusEvent(contexts);

  const base = {
    recognized: recognition.recognized,
    ...(recognition.dueDate ? { dueDate: recognition.dueDate } : {}),
    contexts,
    ...(inboxItem ? { inboxItem } : {}),
    ...(document ? { document } : {}),
  };

  if (decisiveEvent) {
    const state = STATE_BY_EVENT[decisiveEvent.type] ?? 'not_required';
    const reason: DocumentReplyNeedReason = recognition.recognized
      ? recognition.reason
      : decisiveEvent.type === 'marked_remind_later'
        ? 'user_reopened'
        : 'none';
    return { ...base, state, reason, decisiveEvent };
  }

  return {
    ...base,
    state: recognition.recognized ? 'open' : 'not_required',
    reason: recognition.reason,
  };
}

/** Übersetzung in den bestehenden Antwortstatus des Lebenszyklus. */
export function toLifecycleReplyStatus(need: DocumentReplyNeed): CommunicationReplyStatus {
  switch (need.state) {
    case 'open':
      return 'needs_reply';
    case 'draft_ready':
      return 'draft_ready';
    case 'copied':
      return 'copied';
    case 'answered':
      return 'answered';
    default:
      return 'no_reply_needed';
  }
}

/** Antwort fachlich noch offen (erforderlich, aber weder erledigt noch abgewählt). */
export function isReplyNeedPending(need: DocumentReplyNeed): boolean {
  return need.state === 'open' || need.state === 'draft_ready' || need.state === 'copied';
}
