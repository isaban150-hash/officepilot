/**
 * CUSTOMER-FACHOBJEKT-04E3 — id-safe customer overview.
 *
 * Three separate identity kinds; names never merge identities:
 *  - 'customer': a persisted Customer (key = Customer.id)
 *  - 'legacy'  : Vorgänge without customerId (key = canonical lowercase name)
 *  - 'orphan'  : Vorgänge with a customerId whose Customer is missing
 *
 * Unknown Vorgänge (empty customer) never produce a row.
 */
import { getCustomerStoreSnapshot } from './customerStoreService';
import { getAllInvoiceOverview } from './invoiceOverviewService';
import { getAllVorgaenge } from './vorgangService';
import type { Customer, Vorgang } from '../types/models';

export type KundenIdentityKind = 'customer' | 'legacy' | 'orphan';

export interface KundeOverviewEntry {
  kind: KundenIdentityKind;
  /** Internal key — routing / React key only, never visible text. */
  key: string;
  name: string;
  addressLine: string;
  createdAt?: string;
  orderCount: number;
  openInvoiceCount: number;
  latestOrderTitle?: string;
}

const OPEN_INVOICE_STATUSES = ['offen', 'ueberfaellig', 'teilbezahlt'];

/**
 * CUSTOMER-FACHOBJEKT-04E5 — the pure name primitives live here, so the
 * dependency runs one way only: kundenWorkspaceService → kundenOverviewService.
 */
export function normalizeKundenName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function kundenNamesMatch(a: string, b: string): boolean {
  return normalizeKundenName(a).toLowerCase() === normalizeKundenName(b).toLowerCase();
}

/** Canonical, value-based and order-independent. No lossy slug. */
export function buildLegacyKundenKey(name: string): string {
  return normalizeKundenName(name).toLowerCase();
}

export function buildCustomerAddressLine(
  parts: { street?: string; zip?: string; city?: string },
): string {
  const street = parts.street?.trim() ?? '';
  const place = [parts.zip?.trim(), parts.city?.trim()].filter(Boolean).join(' ');
  return [street, place].filter(Boolean).join(', ');
}

/** Unknown state: no visible customer identity at all. */
export function isUnknownCustomerVorgang(vorgang: Vorgang): boolean {
  const name = normalizeKundenName(vorgang.customer);
  return !name || name.toLowerCase() === 'unbekannt';
}

/**
 * CUSTOMER-FACHOBJEKT-04E7 — readable name of an orphan Vorgang.
 * Only its own snapshot values; never a lookup for a same-named Customer and
 * never the technical customerId. Empty when nothing readable is stored.
 */
function orphanDisplayName(vorgang: Vorgang): string {
  const fromVorgang = normalizeKundenName(vorgang.customer);
  if (fromVorgang) return fromVorgang;
  return normalizeKundenName(vorgang.customerBilling?.name ?? '');
}

function customerEntry(customer: Customer): KundeOverviewEntry {
  return {
    kind: 'customer',
    key: customer.id,
    name: customer.name,
    addressLine: buildCustomerAddressLine(customer),
    createdAt: customer.createdAt,
    orderCount: 0,
    openInvoiceCount: 0,
  };
}

interface OverviewIndex {
  entries: Map<string, KundeOverviewEntry>;
  /** vorgangId → entry map key */
  vorgangOwner: Map<string, string>;
}

function entryMapKey(kind: KundenIdentityKind, key: string): string {
  return `${kind}:${key}`;
}

function buildIndex(): OverviewIndex {
  const entries = new Map<string, KundeOverviewEntry>();
  const vorgangOwner = new Map<string, string>();

  const customersById = new Map<string, Customer>();
  for (const customer of getCustomerStoreSnapshot()) {
    customersById.set(customer.id, customer);
    entries.set(entryMapKey('customer', customer.id), customerEntry(customer));
  }

  for (const vorgang of getAllVorgaenge()) {
    const customerId = vorgang.customerId?.trim();

    if (customerId) {
      const customer = customersById.get(customerId);
      const kind: KundenIdentityKind = customer ? 'customer' : 'orphan';
      const mapKey = entryMapKey(kind, customerId);

      if (!entries.has(mapKey)) {
        // Orphan: the Vorgang must not disappear, and never merges by name.
        entries.set(mapKey, {
          kind: 'orphan',
          key: customerId,
          name: orphanDisplayName(vorgang),
          addressLine: buildCustomerAddressLine(vorgang.customerBilling ?? {}),
          orderCount: 0,
          openInvoiceCount: 0,
        });
      }
      const entry = entries.get(mapKey)!;
      // A later Vorgang of the same orphan group may carry the only readable name.
      if (entry.kind === 'orphan' && !entry.name) entry.name = orphanDisplayName(vorgang);
      entry.orderCount += 1;
      if (!entry.latestOrderTitle) entry.latestOrderTitle = vorgang.title;
      vorgangOwner.set(vorgang.id, mapKey);
      continue;
    }

    if (isUnknownCustomerVorgang(vorgang)) continue;

    const legacyKey = buildLegacyKundenKey(vorgang.customer);
    const mapKey = entryMapKey('legacy', legacyKey);
    if (!entries.has(mapKey)) {
      entries.set(mapKey, {
        kind: 'legacy',
        key: legacyKey,
        name: normalizeKundenName(vorgang.customer),
        addressLine: buildCustomerAddressLine(vorgang.customerBilling ?? {}),
        orderCount: 0,
        openInvoiceCount: 0,
      });
    }
    const entry = entries.get(mapKey)!;
    entry.orderCount += 1;
    if (!entry.latestOrderTitle) entry.latestOrderTitle = vorgang.title;
    vorgangOwner.set(vorgang.id, mapKey);
  }

  return { entries, vorgangOwner };
}

export function getKundenOverview(today?: Date | string): KundeOverviewEntry[] {
  const { entries, vorgangOwner } = buildIndex();

  // Invoices are attributed via vorgangId only — never via invoice.customer.
  for (const item of getAllInvoiceOverview(today)) {
    const mapKey = vorgangOwner.get(item.vorgangId);
    if (!mapKey) continue;
    const entry = entries.get(mapKey);
    if (!entry) continue;
    if (OPEN_INVOICE_STATUSES.includes(item.paymentSummary.status)) {
      entry.openInvoiceCount += 1;
    }
  }

  return [...entries.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'de') ||
      a.addressLine.localeCompare(b.addressLine, 'de') ||
      (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
      a.key.localeCompare(b.key),
  );
}
