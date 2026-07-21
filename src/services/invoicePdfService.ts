import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { isFinalizedInvoice } from './invoiceArchiveService';
import {
  buildInvoicePrintModelFromInvoice,
  formatInvoiceCurrency,
  formatInvoiceDate,
} from './invoicePrintModel';
import {
  validateFinalizedInvoiceForPdf,
  type InvoiceValidationResult,
} from './invoiceValidationService';
import type { InvoicePrintModel, VorgangInvoice } from '../types/models';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LINE_GAP = 4;

export type GenerateApprovedInvoicePdfResult =
  | {
      ok: true;
      bytes: Uint8Array;
      filename: string;
      mimeType: 'application/pdf';
      /** Snapshot of status at generation — PDF never mutates invoice. */
      statusUnchanged: VorgangInvoice['status'];
    }
  | {
      ok: false;
      reason: 'not_finalized' | 'validation_failed' | 'encode_failed';
      validation?: InvoiceValidationResult;
      message?: string;
    };

/**
 * Safe download filename, e.g. Rechnung_2026-0001.pdf
 */
export function buildInvoicePdfFilename(invoiceNumber: string): string {
  const base = invoiceNumber
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.pdf$/i, '')
    .trim() ?? '';
  const cleaned = base
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = cleaned || 'ohne_Nummer';
  return `Rechnung_${safe}.pdf`;
}

/** WinAnsi-safe text for StandardFonts (no invented content). */
export function toPdfSafeText(value: string): string {
  return value
    .replace(/\u20ac/g, 'EUR')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');
}

function formatMoneyPdf(value: number): string {
  return toPdfSafeText(formatInvoiceCurrency(value).replace('€', 'EUR'));
}

/**
 * Builds real PDF bytes from a finalized invoice. Does not change status or persist.
 */
export async function generateApprovedInvoicePdf(
  invoice: VorgangInvoice,
): Promise<GenerateApprovedInvoicePdfResult> {
  const statusBefore = invoice.status;

  if (!isFinalizedInvoice(invoice)) {
    return { ok: false, reason: 'not_finalized' };
  }

  const validation = validateFinalizedInvoiceForPdf(invoice);
  if (validation.blockingErrors.length > 0) {
    return { ok: false, reason: 'validation_failed', validation };
  }

  let model: InvoicePrintModel;
  try {
    model = buildInvoicePrintModelFromInvoice(invoice);
  } catch (error) {
    return {
      ok: false,
      reason: 'encode_failed',
      message: error instanceof Error ? error.message : 'print_model_failed',
    };
  }

  try {
    const bytes = await renderInvoicePrintModelToPdf(model);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5) {
      return { ok: false, reason: 'encode_failed', message: 'empty_pdf' };
    }
    const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
    if (header !== '%PDF-') {
      return { ok: false, reason: 'encode_failed', message: 'invalid_pdf_header' };
    }

    return {
      ok: true,
      bytes,
      filename: buildInvoicePdfFilename(invoice.number),
      mimeType: 'application/pdf',
      statusUnchanged: statusBefore,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'encode_failed',
      message: error instanceof Error ? error.message : 'encode_failed',
    };
  }
}

export interface InvoicePdfDownloadHandle {
  objectUrl: string;
  revoke: () => void;
}

/**
 * Triggers a browser download for PDF bytes. Caller should revoke on unmount.
 * Does not run unless explicitly invoked.
 */
export function downloadInvoicePdfBytes(
  bytes: Uint8Array,
  filename: string,
): InvoicePdfDownloadHandle {
  const copy = bytes.slice();
  const blob = new Blob([copy], { type: 'application/pdf' });
  const objectUrl = URL.createObjectURL(blob);
  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    URL.revokeObjectURL(objectUrl);
  };

  if (typeof document !== 'undefined') {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  if (typeof window !== 'undefined') {
    window.setTimeout(revoke, 60_000);
  }

  return { objectUrl, revoke };
}

/**
 * Generate and download in one step (explicit user/auto action).
 */
export async function exportInvoiceAsPdf(
  invoice: VorgangInvoice,
): Promise<GenerateApprovedInvoicePdfResult> {
  const result = await generateApprovedInvoicePdf(invoice);
  if (result.ok) {
    downloadInvoicePdfBytes(result.bytes, result.filename);
  }
  return result;
}

interface PdfCursor {
  pdfDoc: PDFDocument;
  page: PDFPage;
  y: number;
  font: PDFFont;
  fontBold: PDFFont;
}

function ensureSpace(cursor: PdfCursor, needed: number): void {
  if (cursor.y - needed >= MARGIN) return;
  cursor.page = cursor.pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  cursor.y = PAGE_HEIGHT - MARGIN;
}

function drawLine(
  cursor: PdfCursor,
  text: string,
  options: { size?: number; bold?: boolean } = {},
): void {
  const size = options.size ?? 10;
  const activeFont = options.bold ? cursor.fontBold : cursor.font;
  const safe = toPdfSafeText(text);
  ensureSpace(cursor, size + LINE_GAP);
  cursor.page.drawText(safe, {
    x: MARGIN,
    y: cursor.y - size,
    size,
    font: activeFont,
    color: rgb(0.1, 0.1, 0.1),
    maxWidth: CONTENT_WIDTH,
  });
  cursor.y -= size + LINE_GAP;
}

function drawWrapped(
  cursor: PdfCursor,
  text: string,
  size = 10,
  bold = false,
): void {
  const activeFont = bold ? cursor.fontBold : cursor.font;
  const lines = wrapText(toPdfSafeText(text), activeFont, size, CONTENT_WIDTH);
  for (const line of lines) {
    ensureSpace(cursor, size + LINE_GAP);
    cursor.page.drawText(line, {
      x: MARGIN,
      y: cursor.y - size,
      size,
      font: activeFont,
      color: rgb(0.1, 0.1, 0.1),
    });
    cursor.y -= size + LINE_GAP;
  }
}

async function renderInvoicePrintModelToPdf(model: InvoicePrintModel): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const cursor: PdfCursor = {
    pdfDoc,
    page: pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN,
    font,
    fontBold,
  };

  const company = model.company;
  drawLine(cursor, [company.companyName, company.legalForm].filter(Boolean).join(' '), {
    size: 14,
    bold: true,
  });
  const companyAddress = [company.street, `${company.zip} ${company.city}`.trim(), company.country]
    .filter(Boolean)
    .join(', ');
  if (companyAddress) drawWrapped(cursor, companyAddress, 9);
  if (company.phone?.trim()) drawLine(cursor, `Tel.: ${company.phone}`, { size: 9 });
  if (company.email?.trim()) drawLine(cursor, `E-Mail: ${company.email}`, { size: 9 });
  if (company.website?.trim()) drawLine(cursor, company.website, { size: 9 });
  if (company.taxNumber?.trim()) {
    drawLine(cursor, `Steuernummer: ${company.taxNumber}`, { size: 9 });
  }
  if (company.vatId?.trim()) drawLine(cursor, `USt-IdNr.: ${company.vatId}`, { size: 9 });

  cursor.y -= 8;
  drawLine(cursor, model.documentTitle, { size: 16, bold: true });
  drawLine(cursor, `Rechnungsnummer: ${model.invoiceNumber}`, { size: 11, bold: true });
  drawLine(cursor, `Rechnungsdatum: ${formatInvoiceDate(model.issueDate)}`, { size: 10 });

  cursor.y -= 6;
  drawLine(cursor, 'Rechnungsempfänger', { size: 11, bold: true });
  const customer = model.customer;
  if (customer.name?.trim()) drawLine(cursor, customer.name, { size: 10 });
  if (customer.contactPerson?.trim()) drawLine(cursor, customer.contactPerson, { size: 9 });
  const customerAddress = [customer.street, `${customer.zip} ${customer.city}`.trim()]
    .filter(Boolean)
    .join(', ');
  if (customerAddress) drawWrapped(cursor, customerAddress, 9);
  if (customer.email?.trim()) drawLine(cursor, customer.email, { size: 9 });
  if (customer.phone?.trim()) drawLine(cursor, customer.phone, { size: 9 });

  if (model.introText.trim()) {
    cursor.y -= 6;
    drawWrapped(cursor, model.introText.trim(), 10);
  }

  cursor.y -= 4;
  drawLine(cursor, 'Projekt', { size: 11, bold: true });
  if (model.projectTitle?.trim()) drawLine(cursor, model.projectTitle, { size: 10 });
  if (model.projectSite?.trim()) drawLine(cursor, model.projectSite, { size: 9 });

  drawLine(
    cursor,
    `Leistungszeitraum: ${formatInvoiceDate(model.servicePeriodFrom)} - ${formatInvoiceDate(model.servicePeriodTo)}`,
    { size: 10 },
  );

  cursor.y -= 8;
  drawLine(cursor, 'Positionen', { size: 11, bold: true });
  drawPositionsTable(cursor, model);

  cursor.y -= 6;
  const summary = model.summary;
  drawLine(cursor, `Zwischensumme netto: ${formatMoneyPdf(summary.subtotalNet)}`, { size: 10 });
  drawLine(
    cursor,
    `Umsatzsteuer (${summary.taxRate} %): ${formatMoneyPdf(summary.taxAmount)}`,
    { size: 10 },
  );
  drawLine(cursor, `Bruttosumme: ${formatMoneyPdf(summary.grossTotal)}`, {
    size: 10,
    bold: true,
  });
  for (const deduction of summary.deductionLines) {
    const label = deduction.invoiceNumber
      ? `${deduction.label} (${deduction.invoiceNumber})`
      : deduction.label;
    drawLine(cursor, `${label}: -${formatMoneyPdf(deduction.amount)}`, { size: 9 });
  }
  if (summary.deductionLines.length > 0) {
    drawLine(cursor, `Bereits berechnet: ${formatMoneyPdf(summary.deductionsTotal)}`, {
      size: 10,
    });
  }
  drawLine(cursor, `Fälliger Betrag: ${formatMoneyPdf(summary.amountDue)}`, {
    size: 12,
    bold: true,
  });

  for (const notice of model.taxNotices) {
    if (notice.trim()) drawWrapped(cursor, notice.trim(), 9);
  }

  cursor.y -= 4;
  drawLine(cursor, 'Zahlungsinformationen', { size: 11, bold: true });
  if (model.paymentDueDate) {
    drawLine(cursor, `Fällig am: ${formatInvoiceDate(model.paymentDueDate)}`, { size: 10 });
  }
  if (model.paymentTermsText.trim()) drawWrapped(cursor, model.paymentTermsText.trim(), 9);
  if (model.skontoText.trim()) drawWrapped(cursor, model.skontoText.trim(), 9);
  if (company.iban?.trim()) drawLine(cursor, `IBAN: ${company.iban}`, { size: 9 });
  if (company.bic?.trim()) drawLine(cursor, `BIC: ${company.bic}`, { size: 9 });
  if (company.bankName?.trim()) drawLine(cursor, `Bank: ${company.bankName}`, { size: 9 });

  if (model.closingText.trim()) {
    cursor.y -= 6;
    drawWrapped(cursor, model.closingText.trim(), 10);
  }
  if (model.footerNotes.trim()) {
    cursor.y -= 4;
    drawWrapped(cursor, model.footerNotes.trim(), 8);
  }

  return pdfDoc.save();
}

function drawPositionsTable(cursor: PdfCursor, model: InvoicePrintModel): void {
  const size = 9;
  const rowHeight = 14;
  const cols = {
    nr: 28,
    desc: CONTENT_WIDTH - 28 - 50 - 70 - 70,
    qty: 50,
    price: 70,
    total: 70,
  };

  const drawHeader = () => {
    ensureSpace(cursor, rowHeight + 4);
    let x = MARGIN;
    const y = cursor.y - size;
    const headers: Array<[string, number]> = [
      ['Pos.', cols.nr],
      ['Beschreibung', cols.desc],
      ['Menge', cols.qty],
      ['EP', cols.price],
      ['Gesamt', cols.total],
    ];
    for (const [label, width] of headers) {
      cursor.page.drawText(toPdfSafeText(label), {
        x,
        y,
        size,
        font: cursor.fontBold,
      });
      x += width;
    }
    cursor.y -= rowHeight;
  };

  drawHeader();

  for (const position of model.positions) {
    const descLines = wrapText(
      toPdfSafeText(position.description),
      cursor.font,
      size,
      cols.desc - 4,
    );
    const blockHeight = Math.max(rowHeight, descLines.length * (size + 2) + 4);
    ensureSpace(cursor, blockHeight);
    let x = MARGIN;
    const top = cursor.y - size;
    cursor.page.drawText(String(position.index), {
      x,
      y: top,
      size,
      font: cursor.font,
    });
    x += cols.nr;
    let dy = 0;
    for (const line of descLines) {
      cursor.page.drawText(line, {
        x,
        y: top - dy,
        size,
        font: cursor.font,
      });
      dy += size + 2;
    }
    x += cols.desc;
    cursor.page.drawText(toPdfSafeText(`${position.quantity} ${position.unit}`), {
      x,
      y: top,
      size,
      font: cursor.font,
      maxWidth: cols.qty - 2,
    });
    x += cols.qty;
    cursor.page.drawText(formatMoneyPdf(position.unitPrice), {
      x,
      y: top,
      size,
      font: cursor.font,
      maxWidth: cols.price - 2,
    });
    x += cols.price;
    cursor.page.drawText(formatMoneyPdf(position.lineTotal), {
      x,
      y: top,
      size,
      font: cursor.font,
      maxWidth: cols.total - 2,
    });
    cursor.y -= blockHeight;
  }
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [''];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
