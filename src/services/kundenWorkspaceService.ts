/**
 * CUSTOMER-WORKSPACE-01A / CUSTOMER-FACHOBJEKT-04E — read-only customer workspace.
 * Resolved per identity kind: 'customer' via Customer.id, 'legacy' via the
 * canonical name key of Vorgänge without customerId, 'orphan' via a customerId
 * whose Customer is missing. Read-only: no new persistence and no mutation.
 */
import { getCustomerById } from './customerStoreService';
import { getAllDocuments } from './documentService';
import {
  buildCustomerAddressLine,
  buildLegacyKundenKey,
  getKundenOverview,
  isUnknownCustomerVorgang,
  kundenNamesMatch,
  normalizeKundenName,
  type KundenIdentityKind,
} from './kundenOverviewService';
import {
  getAllInvoiceOverview,
  summarizeInvoiceOverview,
  type InvoiceOverviewItem,
} from './invoiceOverviewService';
import { buildInvoiceDetailPath } from './invoiceNavigation';
import { formatPaymentCurrency } from './invoicePaymentService';
import { getAllTasksFromStore } from './taskStore';
import { isTaskOpen } from './taskNormalize';
import { getAllVorgaenge } from './vorgangService';
import type {
  CustomerBilling,
  DocumentType,
  Vorgang,
  VorgangStatus,
} from '../types/models';

export interface KundenWorkspaceContact {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  street: string;
  zip: string;
  city: string;
  addressLine: string;
}

export interface KundenWorkspaceBaustelle {
  label: string;
  vorgangId: string;
  vorgangTitle: string;
}

export interface KundenWorkspaceVorgangRef {
  id: string;
  title: string;
  baustelle: string;
  status: VorgangStatus;
  route: string;
}

export interface KundenWorkspaceInvoiceRef {
  id: string;
  number: string;
  vorgangId: string;
  vorgangTitle: string;
  status: string;
  openAmount: number;
  openAmountLabel: string;
  route: string;
}

export interface KundenWorkspaceDocumentRef {
  id: string;
  title: string;
  kindLabel: string;
  route: string;
  date?: string;
}

export interface KundenWorkspaceTaskRef {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string;
  route: string;
  vorgangTitle?: string;
}

export interface KundenWorkspace {
  name: string;
  contact: KundenWorkspaceContact;
  baustellen: KundenWorkspaceBaustelle[];
  openVorgaenge: KundenWorkspaceVorgangRef[];
  closedVorgaenge: KundenWorkspaceVorgangRef[];
  openInvoices: KundenWorkspaceInvoiceRef[];
  paidInvoices: KundenWorkspaceInvoiceRef[];
  openReceivableTotal: number;
  openReceivableLabel: string;
  documents: KundenWorkspaceDocumentRef[];
  tasks: KundenWorkspaceTaskRef[];
}

// Single implementation lives in kundenOverviewService; re-exported for existing callers.
export { kundenNamesMatch, normalizeKundenName };

/** CUSTOMER-FACHOBJEKT-04E3 — route per identity kind; the key is encoded exactly once. */
export function buildKundenDetailPath(
  target: { kind: KundenIdentityKind; key: string },
): string {
  const segment = encodeURIComponent(target.key);
  if (target.kind === 'customer') return `/kunden/customer/${segment}`;
  if (target.kind === 'orphan') return `/kunden/orphan/${segment}`;
  return `/kunden/legacy/${segment}`;
}

export interface KundenLinkTarget {
  kind: KundenIdentityKind;
  key: string;
  name: string;
  addressLine: string;
  route: string;
}

/**
 * Legacy link resolution for /kunden/:name — counts every real target.
 * Never picks one automatically when several exist.
 */
export function resolveKundenLinkTargets(rawName: string): KundenLinkTarget[] {
  const name = normalizeKundenName(rawName);
  if (!name) return [];

  const targets: KundenLinkTarget[] = [];
  for (const entry of getKundenOverview()) {
    if (!kundenNamesMatch(entry.name, name)) continue;
    targets.push({
      kind: entry.kind,
      key: entry.key,
      name: entry.name,
      addressLine: entry.addressLine,
      route: buildKundenDetailPath(entry),
    });
  }

  // A document-only legacy workspace has no Vorgang and therefore no overview row.
  const legacyKey = buildLegacyKundenKey(name);
  const hasLegacyRow = targets.some((t) => t.kind === 'legacy' && t.key === legacyKey);
  if (!hasLegacyRow && hasNameOnlyDocuments(name)) {
    targets.push({
      kind: 'legacy',
      key: legacyKey,
      name,
      addressLine: '',
      route: buildKundenDetailPath({ kind: 'legacy', key: legacyKey }),
    });
  }

  return targets;
}

function isClosedVorgang(status: VorgangStatus): boolean {
  return status === 'abgeschlossen';
}

function vorgangRecency(vorgang: Vorgang): string {
  const invoiceDates = (vorgang.invoices ?? []).map((invoice) => invoice.createdAt ?? '');
  const latestInvoice = invoiceDates.sort().at(-1) ?? '';
  return vorgang.sync?.updatedAt ?? latestInvoice ?? vorgang.executionStartedAt ?? vorgang.id;
}

function pickNonEmpty(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function mergeContact(name: string, vorgaenge: Vorgang[]): KundenWorkspaceContact {
  const sorted = [...vorgaenge].sort((a, b) =>
    vorgangRecency(b).localeCompare(vorgangRecency(a)),
  );

  const billings: CustomerBilling[] = [];
  for (const vorgang of sorted) {
    if (vorgang.customerBilling) billings.push(vorgang.customerBilling);
    for (const invoice of [...(vorgang.invoices ?? [])].sort((a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
    )) {
      if (invoice.customerSnapshot) billings.push(invoice.customerSnapshot);
    }
  }

  const contactPerson = pickNonEmpty(...billings.map((b) => b.contactPerson));
  const phone = pickNonEmpty(...billings.map((b) => b.phone));
  const email = pickNonEmpty(...billings.map((b) => b.email));
  const street = pickNonEmpty(...billings.map((b) => b.street));
  const zip = pickNonEmpty(...billings.map((b) => b.zip));
  const city = pickNonEmpty(...billings.map((b) => b.city));
  const displayName = pickNonEmpty(...billings.map((b) => b.name), name);

  const addressLine = [street, [zip, city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  return {
    name: displayName,
    contactPerson,
    phone,
    email,
    street,
    zip,
    city,
    addressLine,
  };
}

function documentKindLabel(type: DocumentType | string | undefined): string {
  switch (type) {
    case 'vertrag':
    case 'werkvertrag':
      return 'Vertrag';
    case 'angebot':
      return 'Angebot';
    case 'ausgangsrechnung':
    case 'rechnung':
    case 'eingangsrechnung':
      return 'Rechnung';
    case 'kundenauftrag':
      return 'Auftrag';
    case 'behoerde':
      return 'Behörde';
    case 'brief':
      return 'Brief';
    case 'foto':
      return 'Foto';
    default:
      return type ? String(type) : 'Dokument';
  }
}

function toInvoiceRef(item: InvoiceOverviewItem): KundenWorkspaceInvoiceRef {
  return {
    id: item.invoice.id,
    number: item.invoice.number,
    vorgangId: item.vorgangId,
    vorgangTitle: item.vorgangTitle,
    status: item.paymentSummary.status,
    openAmount: item.paymentSummary.openAmount,
    openAmountLabel: formatPaymentCurrency(item.paymentSummary.openAmount),
    route: buildInvoiceDetailPath(item.vorgangId, item.invoice.id),
  };
}

/** Original spelling of the customer segment in a document folder path, if any. */
function kundenPathSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === 'kunden');
  if (index < 0) return '';
  return normalizeKundenName(parts[index + 1] ?? '');
}

/**
 * CUSTOMER-FACHOBJEKT-04E5 — visible name of a legacy workspace.
 * Never the canonical lowercase route key; empty when no original spelling
 * can be recovered safely, so the UI can show a neutral legacy title.
 */
function resolveLegacyDisplayName(key: string, vorgaenge: Vorgang[]): string {
  const fromVorgang = normalizeKundenName(vorgaenge[0]?.customer ?? '');
  if (fromVorgang) return fromVorgang;

  const documents = getAllDocuments();
  for (const doc of documents) {
    const linked = normalizeKundenName(doc.linkedCompany ?? '');
    if (linked && buildLegacyKundenKey(linked) === key) return linked;
  }
  for (const doc of documents) {
    const segment = kundenPathSegment(doc.digitalFolder.path);
    // Only a segment that actually carries capitalisation proves an original spelling.
    if (!segment || segment === segment.toLowerCase()) continue;
    if (buildLegacyKundenKey(segment) === key) return segment;
  }
  return '';
}

function hasNameOnlyDocuments(name: string): boolean {
  const lower = name.toLowerCase();
  return getAllDocuments().some(
    (doc) =>
      kundenNamesMatch(doc.linkedCompany, name) ||
      doc.digitalFolder.path.toLowerCase().includes(`/kunden/${lower}`),
  );
}

/** Vorgänge per identity kind — never by name for an id-based customer. */
function collectVorgaengeForTarget(kind: KundenIdentityKind, key: string): Vorgang[] {
  const all = getAllVorgaenge();
  if (kind === 'customer' || kind === 'orphan') {
    return all.filter((vorgang) => vorgang.customerId?.trim() === key);
  }
  return all.filter(
    (vorgang) =>
      !vorgang.customerId?.trim() &&
      !isUnknownCustomerVorgang(vorgang) &&
      buildLegacyKundenKey(vorgang.customer) === key,
  );
}

/**
 * Builds the read-only customer workspace, or null if no matching data exists.
 */
export function getKundenWorkspace(
  kind: KundenIdentityKind,
  rawKey: string,
  today?: Date | string,
): KundenWorkspace | null {
  const key = kind === 'legacy' ? buildLegacyKundenKey(rawKey) : rawKey.trim();
  if (!key) return null;

  // One store lookup per call; it decides both identity guards.
  const storedCustomer = kind === 'legacy' ? undefined : getCustomerById(key);
  if (kind === 'customer' && !storedCustomer) return null;
  // An orphan exists only while no Customer carries this id.
  if (kind === 'orphan' && storedCustomer) return null;
  const customer = kind === 'customer' ? storedCustomer : undefined;

  const vorgaenge = collectVorgaengeForTarget(kind, key);
  const vorgangIds = new Set(vorgaenge.map((v) => v.id));
  // Invoices strictly via vorgangId — never via invoice.customer.
  const invoices = getAllInvoiceOverview(today).filter((item) => vorgangIds.has(item.vorgangId));

  if (kind !== 'customer' && vorgaenge.length === 0 && invoices.length === 0) {
    // Document-only legacy workspace stays reachable; orphan without data does not.
    if (kind !== 'legacy' || !hasNameOnlyDocuments(rawKey)) return null;
  }

  const name =
    kind === 'customer'
      ? customer!.name
      : kind === 'legacy'
        ? resolveLegacyDisplayName(key, vorgaenge)
        : // Orphan: only its own snapshots, never a same-named Customer.
          pickNonEmpty(
            ...vorgaenge.map((v) => v.customer),
            ...vorgaenge.map((v) => v.customerBilling?.name),
          );

  const contact: KundenWorkspaceContact = customer
    ? {
        name: customer.name,
        contactPerson: customer.contactPerson,
        phone: customer.phone,
        email: customer.email,
        street: customer.street,
        zip: customer.zip,
        city: customer.city,
        addressLine: buildCustomerAddressLine(customer),
      }
    // Never the route key — an unrecoverable name stays empty for the UI fallback.
    : mergeContact(name, vorgaenge);

  const baustelleMap = new Map<string, KundenWorkspaceBaustelle>();
  for (const vorgang of [...vorgaenge].sort((a, b) =>
    vorgangRecency(b).localeCompare(vorgangRecency(a)),
  )) {
    const label = vorgang.baustelle?.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (baustelleMap.has(key)) continue;
    baustelleMap.set(key, {
      label,
      vorgangId: vorgang.id,
      vorgangTitle: vorgang.title,
    });
  }

  const openVorgaenge: KundenWorkspaceVorgangRef[] = [];
  const closedVorgaenge: KundenWorkspaceVorgangRef[] = [];
  for (const vorgang of vorgaenge) {
    const ref: KundenWorkspaceVorgangRef = {
      id: vorgang.id,
      title: vorgang.title,
      baustelle: vorgang.baustelle,
      status: vorgang.status,
      route: `/vorgaenge/${vorgang.id}`,
    };
    if (isClosedVorgang(vorgang.status)) closedVorgaenge.push(ref);
    else openVorgaenge.push(ref);
  }

  const openInvoices = invoices
    .filter((item) =>
      ['offen', 'teilbezahlt', 'ueberfaellig'].includes(item.paymentSummary.status),
    )
    .map(toInvoiceRef);
  const paidInvoices = invoices
    .filter((item) => item.paymentSummary.status === 'bezahlt')
    .map(toInvoiceRef);
  const totals = summarizeInvoiceOverview(invoices);

  const documents: KundenWorkspaceDocumentRef[] = [];
  const seenDocIds = new Set<string>();

  for (const vorgang of vorgaenge) {
    for (const doc of vorgang.documents ?? []) {
      const id = doc.companyDocumentId ?? `vorgang-doc:${vorgang.id}:${doc.id}`;
      if (seenDocIds.has(id)) continue;
      seenDocIds.add(id);
      documents.push({
        id,
        title: doc.name,
        kindLabel: documentKindLabel(doc.type),
        route: doc.companyDocumentId
          ? `/dokumente/${doc.companyDocumentId}`
          : `/vorgaenge/${vorgang.id}`,
        date: doc.date,
      });
    }
  }

  for (const doc of getAllDocuments()) {
    const linkedVorgangId = doc.linkedVorgang?.vorgangId;
    const linkedToCustomerVorgang = Boolean(linkedVorgangId) && vorgangIds.has(linkedVorgangId!);
    // Name and path only ever apply to a legacy workspace — never to an id-customer.
    const nameKey = kind === 'legacy' ? rawKey : '';
    const linkedCompanyMatch =
      kind === 'legacy' && Boolean(nameKey) && kundenNamesMatch(doc.linkedCompany, nameKey);
    const pathMatch =
      kind === 'legacy' &&
      Boolean(nameKey) &&
      doc.digitalFolder.path.toLowerCase().includes(`/kunden/${nameKey.toLowerCase()}`);
    if (!linkedToCustomerVorgang && !linkedCompanyMatch && !pathMatch) continue;
    if (seenDocIds.has(doc.id)) continue;
    seenDocIds.add(doc.id);
    documents.push({
      id: doc.id,
      title: doc.title,
      kindLabel: documentKindLabel(doc.classifiedKind ?? doc.category),
      route: `/dokumente/${doc.id}`,
      date: doc.documentDate ?? doc.issueDate ?? undefined,
    });
  }

  const tasks: KundenWorkspaceTaskRef[] = [];
  const seenTaskIds = new Set<string>();

  for (const task of getAllTasksFromStore()) {
    if (!task.linkedVorgangId || !vorgangIds.has(task.linkedVorgangId)) continue;
    if (seenTaskIds.has(task.id)) continue;
    seenTaskIds.add(task.id);
    tasks.push({
      id: task.id,
      title: task.title,
      done: !isTaskOpen(task),
      dueDate: task.dueDate,
      route: `/vorgaenge/${task.linkedVorgangId}`,
      vorgangTitle: task.linkedVorgangTitle,
    });
  }

  for (const vorgang of vorgaenge) {
    for (const task of vorgang.tasks ?? []) {
      const id = `vorgang-task:${vorgang.id}:${task.id}`;
      if (seenTaskIds.has(id)) continue;
      seenTaskIds.add(id);
      tasks.push({
        id,
        title: task.title,
        done: task.done,
        dueDate: task.dueDate,
        route: `/vorgaenge/${vorgang.id}`,
        vorgangTitle: vorgang.title,
      });
    }
  }

  return {
    name,
    contact,
    baustellen: [...baustelleMap.values()],
    openVorgaenge,
    closedVorgaenge,
    openInvoices,
    paidInvoices,
    openReceivableTotal: totals.openReceivables,
    openReceivableLabel: formatPaymentCurrency(totals.openReceivables),
    documents,
    tasks,
  };
}
