/**
 * P1 EINGANGSSCHREIBEN — „Antwort vorbereiten": vom Eingangsschreiben in die
 * vorhandenen Schreibwege.
 *
 * Gebaut wird nur die Vorbelegung aus vorhandener Wahrheit — Quelle, bestätigter
 * Vorgang, Kunde aus dem Vorgang, Empfänger, Betreff „Ihr Schreiben vom …".
 * Hier wird nichts gespeichert, nichts fertiggestellt und nichts gesendet; das
 * entscheidet der Benutzer in Briefeditor bzw. E-Mail-Editor.
 *
 * Eine E-Mail-Antwort gibt es nur auf belastbarem Weg: als Antwort auf die
 * ursprüngliche Mail (das Schreiben kam als Mail-Anhang) oder an die E-Mail-
 * Adresse des bestätigten Kunden. Eine Adresse wird nie erfunden.
 */
import type { CommunicationContextRef } from '../../types/communication';
import type { CompanyDocument, InboxItem } from '../../types/models';
import {
  formatDocumentReplySourceParam,
  type DocumentReplySourceRef,
} from '../../types/documentReply';
import { getDocumentById } from '../documentService';
import { getDocumentWorkResult } from '../documentWorkResultStoreService';
import { getInboxItemById } from '../inboxService';
import { getVorgangById, isInboxLinkedToVorgang } from '../vorgangService';
import { toCanonicalIsoDay } from '../../utils/documentDateDisplay';
import {
  hasEmailAddress,
  resolveReplyRecipient,
  resolveReplyRecipientForDocument,
  type LetterDraftPrefill,
  type ReplyRecipient,
} from './documentReplyBridgeService';

export type DocumentReplyEmailPath =
  | { kind: 'inbound_reply'; messageId: string }
  | { kind: 'customer'; address: string };

export interface DocumentReplySourceInfo {
  ref: DocumentReplySourceRef;
  inboxItem?: InboxItem;
  document?: CompanyDocument;
  /** Titel des Schreibens, wie OfficeTakt ihn führt. */
  title: string;
  /** Betreff laut Schreiben, falls erkannt. */
  subject?: string;
  /** Datum des Schreibens (ISO-Tag), falls belegt. */
  letterDate?: string;
  recipient: ReplyRecipient;
  /** Bestätigter Vorgang (Dokument → Vorgang), sonst nichts. */
  vorgangId?: string;
  /** Belastbarer E-Mail-Weg, sonst `null`. */
  email: DocumentReplyEmailPath | null;
}

export function replySourceToContextRef(ref: DocumentReplySourceRef): CommunicationContextRef {
  return { type: ref.type, id: ref.id };
}

function confirmedVorgangId(
  inboxItem: InboxItem | undefined,
  document: CompanyDocument | undefined,
): string | undefined {
  const id = inboxItem
    ? isInboxLinkedToVorgang(inboxItem)
      ? inboxItem.vorgangId
      : undefined
    : document?.linkedVorgang?.vorgangId;
  return id && getVorgangById(id) ? id : undefined;
}

export function resolveDocumentReplySource(ref: DocumentReplySourceRef): DocumentReplySourceInfo | null {
  const inboxItem = ref.type === 'inbox' ? getInboxItemById(ref.id) : undefined;
  const document = ref.type === 'document' ? getDocumentById(ref.id) : undefined;
  if (!inboxItem && !document) return null;

  const sourceInbox =
    inboxItem ?? (document?.sourceInboxItemId ? getInboxItemById(document.sourceInboxItemId) : undefined);
  const sourceInboxId = (sourceInbox?.id ?? document?.sourceInboxItemId ?? '').trim();
  const interpretation =
    (sourceInboxId ? getDocumentWorkResult(sourceInboxId)?.businessInterpretation : null) ??
    document?.archiveTruthSnapshot?.businessInterpretation ??
    null;
  const core = interpretation?.semantic;

  const recipient = inboxItem
    ? resolveReplyRecipient(inboxItem, core)
    : resolveReplyRecipientForDocument(document!);
  const subject = core?.subject?.value?.trim() || undefined;
  const title = (document?.title ?? inboxItem?.title ?? '').trim();
  const letterDate =
    toCanonicalIsoDay(document?.issueDate ?? null) ??
    toCanonicalIsoDay(sourceInbox?.recognizedData?.Datum ?? null) ??
    undefined;

  const messageId = sourceInbox?.emailOrigin?.messageId?.trim();
  const email: DocumentReplyEmailPath | null = messageId
    ? { kind: 'inbound_reply', messageId }
    : hasEmailAddress(recipient)
      ? { kind: 'customer', address: recipient.email!.trim() }
      : null;

  const vorgangId = confirmedVorgangId(inboxItem, document);
  return {
    ref: { type: ref.type, id: ref.id },
    ...(inboxItem ? { inboxItem } : {}),
    ...(document ? { document } : {}),
    title,
    ...(subject ? { subject } : {}),
    ...(letterDate ? { letterDate } : {}),
    recipient,
    ...(vorgangId ? { vorgangId } : {}),
    email,
  };
}

function formatGermanDay(isoDay: string): string {
  const [year, month, day] = isoDay.split('-');
  return `${day}.${month}.${year}`;
}

const BETREFF_BEZUG_MAX = 100;

/** „Ihr Schreiben vom 05.10.2026 – Betreff"; ohne belegtes Datum „Ihr Schreiben – Betreff". */
export function buildReplySubject(info: Pick<DocumentReplySourceInfo, 'letterDate' | 'subject' | 'title'>): string {
  const kopf = info.letterDate ? `Ihr Schreiben vom ${formatGermanDay(info.letterDate)}` : 'Ihr Schreiben';
  const bezug = (info.subject || info.title || '').replace(/\s+/g, ' ').trim();
  if (!bezug) return kopf;
  const kurz = bezug.length > BETREFF_BEZUG_MAX ? `${bezug.slice(0, BETREFF_BEZUG_MAX - 1).trimEnd()}…` : bezug;
  return `${kopf} – ${kurz}`;
}

/** Vorbelegung des bestehenden Briefeditors — dieselbe Form wie aus dem Dokument-Assistenten. */
export function buildReplyLetterPrefill(info: DocumentReplySourceInfo): LetterDraftPrefill {
  const recipient = info.recipient;
  return {
    subject: buildReplySubject(info),
    body: '',
    recipient: {
      name: recipient.name,
      company: recipient.organization,
      street: recipient.street,
      zip: recipient.zip,
      city: recipient.city,
    },
    ...(recipient.source === 'confirmed_customer' && recipient.customerId
      ? { customerId: recipient.customerId }
      : {}),
    ...(info.vorgangId ? { vorgangId: info.vorgangId } : {}),
    replyTo: { type: info.ref.type, id: info.ref.id },
  };
}

/** Ziel des bestehenden E-Mail-Editors — nur bei belastbarem Weg, sonst `null`. */
export function buildReplyEmailHref(info: DocumentReplySourceInfo): string | null {
  if (!info.email) return null;
  const quelle = encodeURIComponent(formatDocumentReplySourceParam(info.ref));
  if (info.email.kind === 'inbound_reply') {
    return `/kommunikation/email/neu?antwortAuf=${encodeURIComponent(info.email.messageId)}&quelle=${quelle}`;
  }
  return `/kommunikation/email/neu?quelle=${quelle}`;
}

/** Vorbelegung für eine neue E-Mail an den bestätigten Kunden. */
export function buildReplyEmailPrefill(info: DocumentReplySourceInfo): {
  to: string;
  subject: string;
  customerId?: string;
  vorgangId?: string;
} {
  return {
    to: info.email?.kind === 'customer' ? info.email.address : '',
    subject: buildReplySubject(info),
    ...(info.recipient.source === 'confirmed_customer' && info.recipient.customerId
      ? { customerId: info.recipient.customerId }
      : {}),
    ...(info.vorgangId ? { vorgangId: info.vorgangId } : {}),
  };
}
