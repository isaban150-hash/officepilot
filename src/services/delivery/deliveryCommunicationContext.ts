/**
 * E-MAIL-07C — zu welchem Kunden und welchem Vorgang gehört ein Versand?
 *
 * Ausschliesslich über echte Kennungen, nie über Namen:
 *
 *   Rechnung        → Vorgang der Rechnung; Kunde der Rechnung, sonst des Vorgangs
 *   Geschäftsbrief  → Archivdokument.linkedLetterId → Brief.customerId / Brief.vorgangId
 *   Angebot         → Archivdokument.linkedOfferId  → Angebot.customerId / Angebot.resultingVorgangId
 *   sonstiges Dok.  → Archivdokument.linkedVorgang.vorgangId → Kunde des Vorgangs
 *
 * Dieselbe Ableitung dient zwei Zwecken: Beim Anlegen reist der Kontext mit
 * (`create_workspace_document_delivery_with_context`), und ältere Versand-
 * aufträge ohne gespeicherten Kontext werden in der Historie genauso eindeutig
 * zugeordnet — oder gar nicht.
 */
import type { DeliveryDocumentIdentity, DocumentDelivery } from '../../types/documentDelivery';
import { isInvoiceDeliveryIdentity } from '../../types/documentDelivery';
import { getBusinessLetterById } from '../businessLetterService';
import { getDocumentById } from '../documentService';
import { getInvoiceStoreSnapshot } from '../invoice/invoiceStore';
import { getOfferById } from '../offer/offerService';
import { getVorgangById } from '../vorgangService';

export interface DeliveryContext {
  customerId?: string;
  vorgangId?: string;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed || undefined;
}

function customerOfVorgang(vorgangId: string | undefined): string | undefined {
  return vorgangId ? clean(getVorgangById(vorgangId)?.customerId) : undefined;
}

export function resolveInvoiceContext(clientInvoiceId: string): DeliveryContext {
  const entry = getInvoiceStoreSnapshot().find((candidate) => candidate.invoice.id === clientInvoiceId);
  if (!entry) return {};
  const vorgangId = clean(entry.vorgangId);
  return { vorgangId, customerId: clean(entry.invoice.customerId) ?? customerOfVorgang(vorgangId) };
}

export function resolveArchivedDocumentContext(clientDocumentId: string): DeliveryContext {
  const document = getDocumentById(clientDocumentId);
  if (!document) return {};
  if (document.linkedLetterId) {
    const letter = getBusinessLetterById(document.linkedLetterId);
    if (letter) {
      const vorgangId = clean(letter.vorgangId);
      return { customerId: clean(letter.customerId) ?? customerOfVorgang(vorgangId), vorgangId };
    }
  }
  if (document.linkedOfferId) {
    const offer = getOfferById(document.linkedOfferId);
    if (offer) {
      const vorgangId = clean(offer.resultingVorgangId);
      return { customerId: clean(offer.customerId) ?? customerOfVorgang(vorgangId), vorgangId };
    }
  }
  if (document.linkedInvoiceId) {
    const invoiceContext = resolveInvoiceContext(document.linkedInvoiceId);
    if (invoiceContext.customerId || invoiceContext.vorgangId) return invoiceContext;
  }
  const vorgangId = clean(document.linkedVorgang?.vorgangId);
  return { vorgangId, customerId: customerOfVorgang(vorgangId) };
}

/** Kontext für einen neuen Versand. */
export function resolveDeliveryContext(identity: DeliveryDocumentIdentity): DeliveryContext {
  return isInvoiceDeliveryIdentity(identity)
    ? resolveInvoiceContext(identity.clientInvoiceId)
    : resolveArchivedDocumentContext(identity.clientDocumentId);
}

/**
 * Kontext eines bestehenden Versandauftrags: gespeichert geht vor, sonst
 * eindeutig über die Dokument-Verknüpfung abgeleitet.
 */
export function resolveContextOfDelivery(delivery: DocumentDelivery): DeliveryContext {
  const derived = delivery.linkedInvoiceId
    ? resolveInvoiceContext(delivery.linkedInvoiceId)
    : delivery.linkedDocumentId
      ? resolveArchivedDocumentContext(delivery.linkedDocumentId)
      : {};
  return {
    customerId: delivery.customerId ?? derived.customerId,
    vorgangId: delivery.vorgangId ?? derived.vorgangId,
  };
}

export function deliveryBelongsTo(delivery: DocumentDelivery, target: DeliveryContext): boolean {
  const context = resolveContextOfDelivery(delivery);
  return Boolean(
    (target.customerId && context.customerId === target.customerId) ||
      (target.vorgangId && context.vorgangId === target.vorgangId),
  );
}

/** Welche Dokumente gehören (über Kennungen) zu diesem Kunden bzw. Vorgang? */
export interface ContextDocumentIdentities {
  invoiceIds: string[];
  documentIds: string[];
}

export function collectContextDocumentIdentities(
  target: DeliveryContext,
  sources: {
    invoices: Array<{ id: string }>;
    documents: Array<{ id: string }>;
  },
): ContextDocumentIdentities {
  const invoiceIds = sources.invoices
    .map((invoice) => invoice.id)
    .filter((id) => {
      const context = resolveInvoiceContext(id);
      return (target.customerId && context.customerId === target.customerId) || (target.vorgangId && context.vorgangId === target.vorgangId);
    });
  const documentIds = sources.documents
    .map((document) => document.id)
    .filter((id) => {
      const context = resolveArchivedDocumentContext(id);
      return (target.customerId && context.customerId === target.customerId) || (target.vorgangId && context.vorgangId === target.vorgangId);
    });
  return { invoiceIds, documentIds };
}

/**
 * Eine Versandkette: der erste Versuch und alle Neuversuche, die über
 * `retryOfDeliveryId` an ihm hängen. Ein erneuter, eigenständiger Versand
 * desselben Dokuments ist eine eigene Kette — kein Zusammenführen, nur
 * Darstellung.
 */
export interface DeliveryThread {
  id: string;
  /** Neuester Versuch — er bestimmt Status und Zeitpunkt der Zeile. */
  latest: DocumentDelivery;
  /** Alle Versuche, ältester zuerst. */
  attempts: DocumentDelivery[];
}

export function groupDeliveryThreads(deliveries: DocumentDelivery[]): DeliveryThread[] {
  const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
  const rootOf = (delivery: DocumentDelivery): string => {
    let current = delivery;
    const seen = new Set<string>();
    while (current.retryOfDeliveryId && byId.has(current.retryOfDeliveryId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.retryOfDeliveryId)!;
    }
    return current.id;
  };
  const threads = new Map<string, DocumentDelivery[]>();
  for (const delivery of byId.values()) {
    const root = rootOf(delivery);
    threads.set(root, [...(threads.get(root) ?? []), delivery]);
  }
  const time = (delivery: DocumentDelivery) => Date.parse(delivery.providerAcceptedAt ?? delivery.requestedAt) || 0;
  return [...threads.entries()]
    .map(([id, attempts]) => {
      const ordered = [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber || Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
      return { id, attempts: ordered, latest: ordered[ordered.length - 1] };
    })
    .sort((a, b) => time(b.latest) - time(a.latest));
}
