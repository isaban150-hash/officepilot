import type { CompanyDocument, VorgangInvoice } from '../../types/models';
import type { WorkspaceDocumentRow } from '../document/workspaceDocumentCloudService';
import { buildOutgoingInvoicePaperFolder } from '../invoiceArchiveService';
import { INVOICE_CORRECTION_DOCUMENT_TITLE, resolveCorrectionIssueDate } from './invoiceCorrectionModel';

/**
 * NORMAL-INVOICE-CANCELLATION-01B — der Korrekturbeleg als lokales Archivdokument.
 *
 * Der Beleg ist Serverwahrheit (`workspace_documents`, Art
 * `generated_invoice_correction`); lokal existiert nur eine **Projektion**
 * — wie beim Original-Archivdokument (`archiveDocumentId`). Zwei Wege führen
 * hierher, beide deterministisch und idempotent:
 *
 *   1. Direkt nach dem bestätigten Storno aus dem lokalen Original und den
 *      Stornofakten (`projectInvoiceCorrectionDocument`);
 *   2. beim Pull aus der Cloud-Zeile (`buildInvoiceCorrectionDocumentFromCloudRow`).
 *
 * Beide erzeugen dasselbe Dokument mit derselben Kennung
 * (`correctionDocumentId` = `corr-<invoiceId>`). Ordner, Tags und Suchtext
 * werden hier gebildet — der Server rechnet nichts und legt nichts ab.
 *
 * Kein Fake-Vorgang: Ohne Auftrag liegt der Beleg direkt unter
 * `/Ausgangsrechnungen/`, mit Auftrag im Vorgangsordner des Originals.
 */
export interface InvoiceCorrectionCloudPayload {
  documentType: 'rechnungskorrektur';
  originalClientInvoiceId: string;
  originalInvoiceNumber: string;
  originalIssueDate: string;
  cancelledAt: string;
  correctionIssueDate: string;
  cancelReason: string;
  linkedVorgangId: string | null;
  customerName: string;
  companyName: string;
  vorgangTitle: string;
  originalAmount: number | null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseInvoiceCorrectionPayload(
  payload: Record<string, unknown>,
): InvoiceCorrectionCloudPayload | null {
  if (payload.documentType !== 'rechnungskorrektur') return null;
  const originalClientInvoiceId = text(payload.originalClientInvoiceId);
  const originalInvoiceNumber = text(payload.originalInvoiceNumber);
  const cancelledAt = text(payload.cancelledAt);
  const cancelReason = text(payload.cancelReason);
  if (!originalClientInvoiceId || !originalInvoiceNumber || !cancelledAt || !cancelReason) return null;

  const snapshot =
    typeof payload.originalInvoiceSnapshot === 'object' && payload.originalInvoiceSnapshot !== null
      ? (payload.originalInvoiceSnapshot as Record<string, unknown>)
      : {};
  const company =
    typeof payload.companySnapshot === 'object' && payload.companySnapshot !== null
      ? (payload.companySnapshot as Record<string, unknown>)
      : {};
  const customer =
    typeof payload.customerSnapshot === 'object' && payload.customerSnapshot !== null
      ? (payload.customerSnapshot as Record<string, unknown>)
      : {};

  return {
    documentType: 'rechnungskorrektur',
    originalClientInvoiceId,
    originalInvoiceNumber,
    originalIssueDate: text(payload.originalIssueDate),
    cancelledAt,
    correctionIssueDate: text(payload.correctionIssueDate) || cancelledAt.slice(0, 10),
    cancelReason,
    linkedVorgangId: typeof payload.linkedVorgangId === 'string' ? payload.linkedVorgangId : null,
    customerName: text(customer.name),
    companyName: text(company.companyName),
    vorgangTitle: text(snapshot.vorgangTitle),
    originalAmount: typeof snapshot.amount === 'number' ? snapshot.amount : null,
  };
}

export function buildInvoiceCorrectionDocumentId(invoiceId: string): string {
  return `corr-${invoiceId}`;
}

interface CorrectionDocumentFacts {
  id: string;
  invoiceId: string;
  originalInvoiceNumber: string;
  originalIssueDate: string;
  correctionIssueDate: string;
  cancelledAt: string;
  cancelReason: string;
  companyName: string;
  customerName: string;
  vorgang: { vorgangId: string; vorgangTitle: string } | null;
  originalAmount: number | null;
  createdAt: string;
  sync?: CompanyDocument['sync'];
}

function buildCorrectionDocument(facts: CorrectionDocumentFacts): CompanyDocument {
  const recognizedText = [
    `${INVOICE_CORRECTION_DOCUMENT_TITLE} zu Rechnung ${facts.originalInvoiceNumber}`,
    `Firma: ${facts.companyName}`,
    `Kunde: ${facts.customerName}`,
    ...(facts.vorgang ? [`Vorgang: ${facts.vorgang.vorgangTitle}`] : []),
    `Originaldatum: ${facts.originalIssueDate}`,
    `Korrekturdatum: ${facts.correctionIssueDate}`,
    `Grund: ${facts.cancelReason}`,
    `Invoice-ID: ${facts.invoiceId}`,
    ...(facts.originalAmount !== null
      ? [`Gegenbuchung brutto: -${facts.originalAmount.toLocaleString('de-DE')} €`]
      : []),
  ].join('\n');

  return {
    id: facts.id,
    title: `${INVOICE_CORRECTION_DOCUMENT_TITLE} zu Rechnung ${facts.originalInvoiceNumber}`,
    category: 'ausgangsrechnung',
    classifiedKind: 'rechnungskorrektur',
    issuer: facts.companyName,
    recognizedText,
    issueDate: facts.correctionIssueDate,
    documentDate: facts.correctionIssueDate,
    validUntil: null,
    digitalFolder: {
      id: `dig-inv-corr-${facts.invoiceId}`,
      name: 'Ausgangsrechnungen',
      path: facts.vorgang
        ? `/Vorgänge/${facts.vorgang.vorgangTitle}/Ausgangsrechnungen/`
        : '/Ausgangsrechnungen/',
    },
    paperFolder: buildOutgoingInvoicePaperFolder(),
    tags: [
      'Rechnungskorrektur',
      'Storno',
      facts.originalInvoiceNumber,
      ...(facts.customerName ? [facts.customerName] : []),
      ...(facts.vorgang ? [facts.vorgang.vorgangTitle] : []),
    ],
    linkedCompany: facts.companyName,
    linkedVorgang: facts.vorgang,
    linkedInvoiceId: facts.invoiceId,
    archived: true,
    createdAt: facts.createdAt,
    imagePreview: '↩️',
    ...(facts.sync ? { sync: facts.sync } : {}),
  };
}

/** Cloud-Zeile → lokales Dokument. `null`, wenn die Zeile kein Korrekturbeleg ist. */
export function buildInvoiceCorrectionDocumentFromCloudRow(
  row: WorkspaceDocumentRow,
): CompanyDocument | null {
  const parsed = parseInvoiceCorrectionPayload(row.payload);
  if (!parsed || parsed.originalClientInvoiceId !== row.linkedInvoiceId) return null;
  const vorgangId = row.linkedVorgangId ?? parsed.linkedVorgangId;
  return buildCorrectionDocument({
    id: row.clientDocumentId,
    invoiceId: row.linkedInvoiceId,
    originalInvoiceNumber: parsed.originalInvoiceNumber,
    originalIssueDate: parsed.originalIssueDate,
    correctionIssueDate: parsed.correctionIssueDate,
    cancelledAt: parsed.cancelledAt,
    cancelReason: parsed.cancelReason,
    companyName: parsed.companyName,
    customerName: parsed.customerName,
    vorgang: vorgangId ? { vorgangId, vorgangTitle: parsed.vorgangTitle } : null,
    originalAmount: parsed.originalAmount,
    createdAt: row.createdAt,
    sync: {
      updatedAt: row.updatedAt,
      version: row.rowVersion,
      deleted: false,
      deviceId: 'cloud',
      workspaceId: row.workspaceId,
    },
  });
}

/**
 * Lokale Projektion unmittelbar nach dem bestätigten Storno — aus dem
 * Original und seinen Stornofakten. Dieselbe Kennung wie die Cloud-Zeile.
 */
export function projectInvoiceCorrectionDocument(
  invoice: VorgangInvoice,
  vorgang: { vorgangId: string; vorgangTitle: string } | null,
): CompanyDocument | null {
  if (!invoice.cancelledAt || !invoice.cancelReason || invoice.cancellationKind !== 'correction') {
    return null;
  }
  const id = invoice.correctionDocumentId ?? buildInvoiceCorrectionDocumentId(invoice.id);
  return buildCorrectionDocument({
    id,
    invoiceId: invoice.id,
    originalInvoiceNumber: invoice.number,
    originalIssueDate: invoice.issueDate ?? invoice.date,
    correctionIssueDate: resolveCorrectionIssueDate({
      cancelledAt: invoice.cancelledAt,
      cancelReason: invoice.cancelReason,
    }),
    cancelledAt: invoice.cancelledAt,
    cancelReason: invoice.cancelReason,
    companyName: invoice.companySnapshot?.companyName ?? '',
    customerName: invoice.customerSnapshot?.name ?? '',
    vorgang,
    originalAmount: invoice.amount,
    createdAt: invoice.cancelledAt,
  });
}
