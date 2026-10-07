/**
 * CLOUD-SYNC S5 — der Workspace-Spiegel der Cloud-Rechnungsentwürfe.
 *
 * Er liegt im `AppPersistedState` (`invoiceDrafts`) und ist damit das, was der
 * Änderungsverfolger sieht: Eine fachliche Änderung am Spiegel erzeugt über die
 * bestehende Kette einen Sendeauftrag, ein Abzug schreibt ihn über denselben
 * Weg zurück wie jede andere Entität.
 *
 * Der Spiegel ersetzt die IndexedDB nicht. Dort liegt weiterhin der vollständige
 * Arbeitsstand des Editors, sofort und offline gespeichert; hier nur der
 * fachliche Kern, der zwischen Geräten reist.
 *
 * Bewusst ohne Persistenz-Import: Gespeichert wird an der bestehenden
 * Persistenzgrenze (`persistAll`) durch den Aufrufer.
 */
import type { InvoiceDocumentType } from '../../types/models';
import type { InvoiceDraftCloudEntity } from '../../types/invoiceDraftCloud';

let entities: InvoiceDraftCloudEntity[] = [];
let onReset: (() => void) | null = null;

function clone(entity: InvoiceDraftCloudEntity): InvoiceDraftCloudEntity {
  return JSON.parse(JSON.stringify(entity)) as InvoiceDraftCloudEntity;
}

export function hydrateInvoiceDraftCloudStore(items: InvoiceDraftCloudEntity[]): void {
  entities = (items ?? []).map(clone);
}

export function resetInvoiceDraftCloudStore(): void {
  entities = [];
  onReset?.();
}

/**
 * Die Bridge meldet hier, was mit dem Spiegel zusammen verfallen muss: ihre
 * gebündelt wartenden Commits. So bleibt dieser Store frei von schweren
 * Importen und ein Bereichswechsel lässt nichts Altes nachträglich hineinschreiben.
 */
export function registerInvoiceDraftCloudStoreResetHook(hook: () => void): void {
  onReset = hook;
}

export function getInvoiceDraftCloudSnapshot(): InvoiceDraftCloudEntity[] {
  return entities.map(clone);
}

export function getInvoiceDraftCloudEntity(id: string): InvoiceDraftCloudEntity | null {
  const found = entities.find((entity) => entity.id === id);
  return found ? clone(found) : null;
}

/** Alle Spiegeleinträge eines Slots — Grabsteine eingeschlossen. */
export function listInvoiceDraftCloudEntitiesForSlot(
  vorgangId: string | null,
  invoiceType: InvoiceDocumentType,
): InvoiceDraftCloudEntity[] {
  return entities
    .filter((entity) => entity.vorgangId === vorgangId && entity.invoiceType === invoiceType)
    .map(clone);
}

export function putInvoiceDraftCloudEntity(entity: InvoiceDraftCloudEntity): void {
  const next = clone(entity);
  const index = entities.findIndex((item) => item.id === next.id);
  entities = index < 0 ? [next, ...entities] : [...entities.slice(0, index), next, ...entities.slice(index + 1)];
}

export function removeInvoiceDraftCloudEntity(id: string): void {
  entities = entities.filter((entity) => entity.id !== id);
}
