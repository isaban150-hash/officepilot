import { PAPER_FOLDERS } from '../data/mockData';
import { addDocument, getDocumentByLinkedInvoiceId } from './documentService';
import { getTaxRateForStatus } from './invoiceService';
import { getVorgangById, updateInvoiceArchiveDocumentId } from './vorgangService';
import type {
  CompanyDocument,
  CompanyDocumentInput,
  InvoicePrintModel,
  Vorgang,
  VorgangInvoice,
} from '../types/models';

import { getInvoiceDocumentTitle } from './invoiceTypeService';

function invoiceTypeLabel(invoice: VorgangInvoice): string {
  return getInvoiceDocumentTitle(invoice.type, invoice.abschlagNumber);
}

function buildRecognizedText(invoice: VorgangInvoice, vorgang: Vorgang, companyName: string): string {
  const customerName = invoice.customerSnapshot?.name ?? vorgang.customer;
  return [
    `Rechnungsnummer: ${invoice.number}`,
    `Firma: ${companyName}`,
    `Kunde: ${customerName}`,
    `Vorgang: ${invoice.vorgangTitle ?? vorgang.title}`,
    `Datum: ${invoice.issueDate ?? invoice.date}`,
    `Typ: ${invoiceTypeLabel(invoice)}`,
    `Invoice-ID: ${invoice.id}`,
    `Brutto: ${invoice.amount.toLocaleString('de-DE')} €`,
  ].join('\n');
}

function buildPaperFolder() {
  const folder = PAPER_FOLDERS.find((item) => item.id === 'folder-3') ?? PAPER_FOLDERS[0];
  return {
    folderId: folder.id,
    register: folder.registers[0] ?? 'A',
    label: folder.name,
  };
}

export function buildOutgoingInvoiceDocumentInput(
  invoice: VorgangInvoice,
  vorgang: Vorgang,
  companyName: string,
): CompanyDocumentInput {
  const customerName = invoice.customerSnapshot?.name ?? vorgang.customer;

  return {
    title: `${invoice.number} – ${invoiceTypeLabel(invoice)}`,
    category: 'ausgangsrechnung',
    issuer: companyName,
    recognizedText: buildRecognizedText(invoice, vorgang, companyName),
    issueDate: invoice.issueDate ?? invoice.date,
    validUntil: invoice.paymentDueDate ?? null,
    digitalFolder: {
      id: `dig-inv-${invoice.id}`,
      name: 'Ausgangsrechnungen',
      path: `/Vorgänge/${vorgang.title}/Ausgangsrechnungen/`,
    },
    paperFolder: buildPaperFolder(),
    tags: [
      'Ausgangsrechnung',
      invoice.number,
      customerName,
      vorgang.title,
      invoiceTypeLabel(invoice),
    ],
    linkedCompany: companyName,
    linkedVorgang: { vorgangId: vorgang.id, vorgangTitle: vorgang.title },
    linkedInvoiceId: invoice.id,
    archived: true,
    imagePreview: '🧾',
  };
}

export type ArchiveOutgoingInvoiceResult =
  | { success: true; invoice: VorgangInvoice; document: CompanyDocument; created: boolean }
  | { success: false; invoice: VorgangInvoice; reason: 'vorgang_not_found' | 'archive_failed' };

export function archiveOutgoingInvoice(
  vorgangId: string,
  invoice: VorgangInvoice,
  companyName: string,
): ArchiveOutgoingInvoiceResult {
  if (invoice.archiveDocumentId) {
    const existing = getDocumentByLinkedInvoiceId(invoice.id);
    if (existing) {
      return { success: true, invoice, document: existing, created: false };
    }
  }

  const existingDocument = getDocumentByLinkedInvoiceId(invoice.id);
  if (existingDocument) {
    const linked = updateInvoiceArchiveDocumentId(vorgangId, invoice.id, existingDocument.id);
    if (!linked) {
      return { success: false, invoice, reason: 'vorgang_not_found' };
    }
    return { success: true, invoice: linked, document: existingDocument, created: false };
  }

  const resolvedVorgang = getVorgangById(vorgangId);
  if (!resolvedVorgang) {
    return { success: false, invoice, reason: 'vorgang_not_found' };
  }

  const result = addDocument(
    buildOutgoingInvoiceDocumentInput(invoice, resolvedVorgang, companyName),
  );

  if (!result.success) {
    return { success: false, invoice, reason: 'archive_failed' };
  }

  const linkedInvoice = updateInvoiceArchiveDocumentId(vorgangId, invoice.id, result.document.id);
  if (!linkedInvoice) {
    return { success: false, invoice, reason: 'vorgang_not_found' };
  }

  return {
    success: true,
    invoice: linkedInvoice,
    document: result.document,
    created: true,
  };
}

export function isFinalizedInvoice(invoice: VorgangInvoice): boolean {
  return invoice.status === 'vorbereitet' || invoice.status === 'versendet';
}

export function getInvoiceGrossAmount(invoice: VorgangInvoice): number {
  const taxRate = getTaxRateForStatus(invoice.taxStatus);
  const taxAmount = invoice.subtotal * (taxRate / 100);
  return invoice.subtotal + taxAmount;
}

export function buildPrintTitle(model: InvoicePrintModel): string {
  return `${model.invoiceNumber} – ${model.documentTitle}`;
}
