/**
 * CUSTOMER-WORKSPACE-01A — read-only customer work file.
 * Aggregates existing Vorgang / invoice / document / task data by customer name.
 * No CRM entity, no new persistence.
 */
import { getAllDocuments } from './documentService';
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

export function normalizeKundenName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function kundenNamesMatch(a: string, b: string): boolean {
  return normalizeKundenName(a).toLowerCase() === normalizeKundenName(b).toLowerCase();
}

export function buildKundenDetailPath(name: string): string {
  return `/kunden/${encodeURIComponent(normalizeKundenName(name))}`;
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

function collectVorgaengeForCustomer(name: string): Vorgang[] {
  const normalized = normalizeKundenName(name);
  if (!normalized) return [];
  return getAllVorgaenge().filter((vorgang) => kundenNamesMatch(vorgang.customer, normalized));
}

/**
 * Builds the read-only customer workspace, or null if no matching data exists.
 */
export function getKundenWorkspace(
  rawName: string,
  today?: Date | string,
): KundenWorkspace | null {
  const name = normalizeKundenName(decodeURIComponent(rawName));
  if (!name || name.toLowerCase() === 'unbekannt') return null;

  const vorgaenge = collectVorgaengeForCustomer(name);
  const invoices = getAllInvoiceOverview(today).filter((item) =>
    kundenNamesMatch(item.customer, name),
  );

  if (vorgaenge.length === 0 && invoices.length === 0) {
    // Still allow workspace if archive docs match the name
    const docsOnly = getAllDocuments().some(
      (doc) =>
        kundenNamesMatch(doc.linkedCompany, name) ||
        doc.digitalFolder.path.toLowerCase().includes(`/kunden/${name.toLowerCase()}`),
    );
    if (!docsOnly) return null;
  }

  const vorgangIds = new Set(vorgaenge.map((v) => v.id));
  const contact = mergeContact(name, vorgaenge);

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
    const linkedCompanyMatch = kundenNamesMatch(doc.linkedCompany, name);
    const pathMatch = doc.digitalFolder.path
      .toLowerCase()
      .includes(`/kunden/${name.toLowerCase()}`);
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
