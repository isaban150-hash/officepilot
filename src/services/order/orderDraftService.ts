/**
 * AUFTRAG-02C — lokale Auftragsentwürfe.
 *
 * Bewusst klein gehalten: ein Entwurf ist eine Notiz auf diesem Gerät, kein
 * Geschäftsobjekt. Er wird **nicht** synchronisiert, steht in keiner
 * Allowlist, erzeugt keinen Vorgang und verbraucht keine Auftragsnummer.
 * Dadurch kann ein unfertiger Entwurf gar nicht erst wie ein Auftrag wirken:
 * er taucht in keiner Vorgangsliste, keiner Rechnung und keinem Sync auf.
 *
 * Seine Kennung ist zugleich die spätere Vorgangskennung. Sie entsteht genau
 * einmal und überlebt Wiederaufnahme und Retry — daran hängt die Idempotenz
 * der serverseitigen Anlage.
 */
import type { OrderDraft, OrderDraftBlocker, OrderDraftInput, OrderDraftPosition } from '../../types/orderDraft';
import type { CustomerBilling, OrderUnit, TaxStatus } from '../../types/models';
import { generateEntityId } from '../sync/syncMetaService';
import { persistAll } from '../persistenceService';
import { getVorgangById } from '../vorgangService';

const ORDER_UNITS: readonly OrderUnit[] = ['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];

let drafts: OrderDraft[] = [];

function now(): string {
  return new Date().toISOString();
}

function cloneDraft(draft: OrderDraft): OrderDraft {
  return {
    ...draft,
    customerBilling: { ...draft.customerBilling },
    positions: draft.positions.map((p) => ({ ...p })),
  };
}

export function normalizeOrderDraftPosition(position: Partial<OrderDraftPosition>): OrderDraftPosition {
  const quantity = Number(position.plannedQuantity);
  const unitPrice = Number(position.unitPrice);
  return {
    id: position.id?.trim() || generateEntityId('op'),
    description: (position.description ?? '').trim(),
    plannedQuantity: Number.isFinite(quantity) ? quantity : 0,
    unit: (ORDER_UNITS as readonly string[]).includes(position.unit ?? '')
      ? (position.unit as OrderUnit)
      : 'Stunden',
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
  };
}

function normalizeDraft(draft: OrderDraft): OrderDraft {
  return {
    ...draft,
    customerBilling: { ...draft.customerBilling },
    positions: (draft.positions ?? []).map(normalizeOrderDraftPosition),
  };
}

export function getOrderDraftStoreSnapshot(): OrderDraft[] {
  return drafts.map(cloneDraft);
}

export function hydrateOrderDrafts(items: OrderDraft[]): void {
  drafts = (items ?? []).map((item) => normalizeDraft(cloneDraft(item)));
}

export function resetOrderDrafts(): void {
  drafts = [];
}

/**
 * Entwürfe, deren Auftrag es bereits gibt, sind erledigt — egal ob die eigene
 * Antwort ankam oder der Auftrag erst über einen Pull von einem anderen Gerät
 * eintraf. Der Serverauftrag gewinnt immer; der Entwurf wird nie darüber
 * geschrieben.
 */
export function pruneConfirmedOrderDrafts(): number {
  const before = drafts.length;
  drafts = drafts.filter((draft) => !getVorgangById(draft.id));
  const removed = before - drafts.length;
  if (removed > 0) persistAll();
  return removed;
}

export function listOrderDrafts(): OrderDraft[] {
  return drafts.filter((draft) => !getVorgangById(draft.id)).map(cloneDraft);
}


/**
 * AUFTRAG-02C2 — was eine konkrete Entwurfsadresse zeigen soll.
 *
 * Die Entwurfskennung ist zugleich die Vorgangskennung. Nach der Bestätigung
 * gibt es den Entwurf nicht mehr, wohl aber den Auftrag — eine alte Adresse
 * (Lesezeichen, offener Tab, Zurück-Taste) darf dann weder ins Leere laufen
 * noch stillschweigend einen zweiten Auftrag beginnen.
 */
export type OrderDraftRoute =
  | { kind: 'draft'; draft: OrderDraft }
  | { kind: 'order'; vorgangId: string }
  | { kind: 'missing' };

export function resolveOrderDraftRoute(draftId: string | undefined): OrderDraftRoute {
  const id = draftId?.trim();
  if (!id) return { kind: 'missing' };
  const vorgang = getVorgangById(id);
  if (vorgang) return { kind: 'order', vorgangId: vorgang.id };
  const draft = drafts.find((item) => item.id === id);
  return draft ? { kind: 'draft', draft: cloneDraft(draft) } : { kind: 'missing' };
}

export function getOrderDraftById(draftId: string): OrderDraft | null {
  if (getVorgangById(draftId)) return null;
  const found = drafts.find((draft) => draft.id === draftId);
  return found ? cloneDraft(found) : null;
}

export type OrderDraftMutationResult =
  | { success: true; draft: OrderDraft }
  | { success: false; errorKey: string };

export function createOrderDraft(workspaceId: string, input: OrderDraftInput): OrderDraftMutationResult {
  const timestamp = now();
  const draft: OrderDraft = normalizeDraft({
    // Genau hier entsteht die Vorgangskennung — einmal, und sie bleibt.
    id: generateEntityId('v'),
    workspaceId,
    customerId: input.customerId?.trim() || undefined,
    customerBilling: { ...input.customerBilling },
    title: input.title,
    baustelle: input.baustelle,
    positions: input.positions,
    taxStatus: input.taxStatus,
    paymentTermsText: input.paymentTermsText,
    introText: input.introText,
    closingText: input.closingText,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  drafts = [...drafts, draft];
  const persisted = persistAll();
  if (!persisted.success) {
    drafts = drafts.filter((item) => item.id !== draft.id);
    return { success: false, errorKey: 'order.draft.saveFailed' };
  }
  return { success: true, draft: cloneDraft(draft) };
}

export function updateOrderDraft(draftId: string, changes: Partial<OrderDraftInput>): OrderDraftMutationResult {
  const index = drafts.findIndex((draft) => draft.id === draftId);
  if (index === -1) return { success: false, errorKey: 'order.draft.notFound' };
  const previous = drafts[index]!;
  const updated = normalizeDraft({
    ...previous,
    ...changes,
    customerId: changes.customerId !== undefined ? changes.customerId?.trim() || undefined : previous.customerId,
    customerBilling: changes.customerBilling ? { ...changes.customerBilling } : previous.customerBilling,
    positions: changes.positions ?? previous.positions,
    updatedAt: now(),
  });
  drafts = drafts.map((draft) => (draft.id === draftId ? updated : draft));
  const persisted = persistAll();
  if (!persisted.success) {
    drafts = drafts.map((draft) => (draft.id === draftId ? previous : draft));
    return { success: false, errorKey: 'order.draft.saveFailed' };
  }
  return { success: true, draft: cloneDraft(updated) };
}

export function deleteOrderDraft(draftId: string): { success: boolean } {
  const before = drafts.length;
  drafts = drafts.filter((draft) => draft.id !== draftId);
  if (drafts.length !== before) persistAll();
  return { success: drafts.length !== before };
}

/**
 * Was den Nutzer noch vom verbindlichen Auftrag trennt. Dieselben Regeln
 * prüft der Server noch einmal — hier geht es darum, sie vorher zu sagen.
 */
export function getOrderDraftBlockers(draft: Pick<OrderDraft, 'customerBilling' | 'title' | 'positions'>): OrderDraftBlocker[] {
  const blockers: OrderDraftBlocker[] = [];
  if (!draft.customerBilling?.name?.trim()) blockers.push('customer_missing');
  if (!draft.title?.trim()) blockers.push('title_missing');
  const positions = draft.positions ?? [];
  if (positions.length === 0) {
    blockers.push('positions_missing');
  } else {
    const ids = new Set<string>();
    const invalid = positions.some((p) => {
      const duplicate = ids.has(p.id);
      ids.add(p.id);
      return (
        duplicate ||
        !p.id.trim() ||
        !p.description.trim() ||
        !(p.plannedQuantity > 0) ||
        !(p.unitPrice >= 0) ||
        !(ORDER_UNITS as readonly string[]).includes(p.unit)
      );
    });
    if (invalid) blockers.push('position_invalid');
  }
  return blockers;
}

export function emptyOrderDraftCustomerBilling(name = ''): CustomerBilling {
  return { name, contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' };
}

export function isOrderDraftReady(draft: OrderDraft, _taxStatus?: TaxStatus): boolean {
  return getOrderDraftBlockers(draft).length === 0;
}
