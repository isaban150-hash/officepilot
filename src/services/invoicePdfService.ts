import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadInvoicePdfFont } from './invoice/invoicePdfFonts';
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
import { resolveBrandingAsset } from './branding/brandingAssetResolver';
import { encodeDocumentFileRasterToJpeg } from './documentFileRasterEncodeService';
import { getSyncClient } from './sync/syncClientService';
import type { HistoricalInvoiceLogoSource } from '../types/branding';
import type { InvoicePrintModel, VorgangInvoice } from '../types/models';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LINE_GAP = 4;

/**
 * BRANDING-01F-3 — Platz für das Logo oben rechts.
 *
 * Bewusst klein und fest: Das Bild wird in dieses Rechteck **eingepasst**, nie
 * gestreckt und nie vergrössert. Der Absendertext links behält seine Position;
 * ohne Logo entsteht kein Versatz, das Layout bleibt exakt wie bisher.
 */
const LOGO_MAX_WIDTH = 140;
const LOGO_MAX_HEIGHT = 48;

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

/**
 * PDF-TEXT-RENDERING-01B \u2014 Schutz vor Steuerzeichen, **keine** Zeichensatzgrenze
 * mehr.
 *
 * Bis hierher galt: Alles ausserhalb Latin-1 wird zu `?`. Das war f\u00fcr die
 * WinAnsi-Standardschriften folgerichtig und f\u00fcr ein Rechnungsdokument trotzdem
 * untragbar \u2014 aus `\u00c7\u0131rmak` wurde `\u00c7?rmak`, aus einem Halbgeviertstrich ein
 * Fragezeichen. Mit der eingebetteten Unicode-Schrift entf\u00e4llt der Grund.
 *
 * Entfernt werden nur noch Zeichen, die kein Text sind: die C0-Steuerzeichen
 * ohne Tab/LF/CR, DEL und die C1-Spanne. Sie tragen keine Bedeutung, k\u00f6nnen den
 * Textstrom aber st\u00f6ren.
 *
 * Ausdr\u00fccklich **keine** Transliteration und kein Ersetzen von `\u20ac` durch `EUR`:
 * Nutzdaten werden originalgetreu ausgegeben.
 */
/** Steuerzeichen ohne Tabulator, Zeilenumbruch und Wagenruecklauf. */
function isControlCharacter(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return false;
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

export function toPdfSafeText(value: string): string {
  let result = '';
  for (const character of value) {
    if (!isControlCharacter(character.codePointAt(0) ?? 0)) result += character;
  }
  return result;
}

function formatMoneyPdf(value: number): string {
  // Das Eurozeichen bleibt jetzt stehen — die eingebettete Schrift kennt es.
  return toPdfSafeText(formatInvoiceCurrency(value));
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

/** Roh-Bytes plus tatsächlicher Typ — was `pdf-lib` zum Einbetten braucht. */
interface PdfLogoBytes {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
}

function decodeBase64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Ein Alt-Logo aus einer Data-URL. Bewusst eng: nur Base64, nur PNG, JPEG und
 * WebP. Kein SVG, kein Fremdinhalt, keine entfernte URL — was hier ankommt,
 * wird eingebettet und muss deshalb ein Bild sein und nichts anderes.
 */
function parseLegacyLogoDataUrl(dataUrl: string): { bytes: Uint8Array; mimeType: string } | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  const bytes = decodeBase64ToBytes(match[2].replace(/\s+/g, ''));
  if (!bytes || bytes.length === 0) return null;
  return { bytes, mimeType: match[1] };
}

/**
 * WebP kann `pdf-lib` nicht einbetten, der Branding-Vertrag erlaubt es aber.
 * Deshalb wird es hier **temporär** nach JPEG umgewandelt — über denselben
 * Dienst, der schon die Dokumentenablage bedient und auf iPhone Safari erprobt
 * ist. Es entsteht dabei kein Asset, kein Upload und keine neue `assetId`; die
 * Bytes leben nur für dieses eine PDF.
 */
async function toEmbeddableLogoBytes(
  bytes: Uint8Array,
  mimeType: string,
): Promise<PdfLogoBytes | null> {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
    return { bytes, mimeType };
  }
  if (mimeType !== 'image/webp') return null;

  try {
    const encoded = await encodeDocumentFileRasterToJpeg({ bytes, sourceMimeType: 'image/webp' });
    return { bytes: encoded.bytes, mimeType: 'image/jpeg' };
  } catch {
    // Kein Logo ist richtig; ein anderes Logo wäre falsch.
    return null;
  }
}

/**
 * Beschafft das **historische** Logo dieser Rechnung — und nur dieses.
 *
 * Für eine strukturierte Referenz läuft der bestehende Resolver (Cache zuerst,
 * dann Cloud). Scheitert er, gibt es kein Logo: kein Rückfall auf das
 * eingebettete Alt-Bild und erst recht keiner auf die heutigen Firmendaten.
 */
async function loadHistoricalLogoBytes(
  source: HistoricalInvoiceLogoSource,
): Promise<PdfLogoBytes | null> {
  if (source.kind === 'none') return null;

  if (source.kind === 'legacy_data_url') {
    const parsed = parseLegacyLogoDataUrl(source.dataUrl);
    if (!parsed) return null;
    return toEmbeddableLogoBytes(parsed.bytes, parsed.mimeType);
  }

  const workspaceId = getSyncClient().serverWorkspaceId;
  if (!workspaceId) return null;

  let resolved;
  try {
    resolved = await resolveBrandingAsset(workspaceId, source.reference);
  } catch {
    return null;
  }
  if (!resolved.ok) return null;

  try {
    const buffer = await resolved.blob.arrayBuffer();
    return toEmbeddableLogoBytes(new Uint8Array(buffer), source.reference.mimeType);
  } catch {
    return null;
  }
}

/**
 * Zeichnet das Logo oben rechts, eingepasst und ohne Verzerrung.
 *
 * Der Cursor wird **nicht** bewegt: Das Logo liegt neben dem Absenderblock, und
 * ohne Logo bleibt das Layout unverändert. Ein Einbettungsfehler bleibt
 * folgenlos — die Rechnung entsteht trotzdem, nur ohne Bild.
 */
async function drawHistoricalLogo(cursor: PdfCursor, logo: PdfLogoBytes): Promise<void> {
  let embedded;
  try {
    embedded =
      logo.mimeType === 'image/jpeg'
        ? await cursor.pdfDoc.embedJpg(logo.bytes)
        : await cursor.pdfDoc.embedPng(logo.bytes);
  } catch {
    return;
  }

  const { width, height } = embedded;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

  // Einpassen, nie vergrössern — das Seitenverhältnis bleibt erhalten.
  const scale = Math.min(LOGO_MAX_WIDTH / width, LOGO_MAX_HEIGHT / height, 1);
  const drawWidth = width * scale;
  const drawHeight = height * scale;

  cursor.page.drawImage(embedded, {
    x: PAGE_WIDTH - MARGIN - drawWidth,
    y: PAGE_HEIGHT - MARGIN - drawHeight,
    width: drawWidth,
    height: drawHeight,
  });
}

async function renderInvoicePrintModelToPdf(model: InvoicePrintModel): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  /*
   * PDF-TEXT-RENDERING-01B — echte Unicode-Schriften statt der WinAnsi-Standard-
   * schriften. `subset: true` bettet nur die tatsächlich benutzten Glyphen ein,
   * die PDF-Grösse wächst dadurch nur um wenige Kilobyte.
   *
   * Beide Schnitte werden hier gebunden und über den Cursor an jede Zeichen- und
   * jede Messfunktion weitergereicht — Umbruch und Spaltenbreiten rechnen damit
   * mit genau der Schrift, die auch gezeichnet wird.
   */
  pdfDoc.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    loadInvoicePdfFont('regular'),
    loadInvoicePdfFont('bold'),
  ]);
  const font = await pdfDoc.embedFont(regularBytes, { subset: true });
  const fontBold = await pdfDoc.embedFont(boldBytes, { subset: true });
  const cursor: PdfCursor = {
    pdfDoc,
    page: pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN,
    font,
    fontBold,
  };

  /*
   * BRANDING-01F-3 — das Logo zuerst, weil es oben rechts an einer festen
   * Position liegt und den Textfluss links nicht berührt. Nur auf der ersten
   * Seite: Es gehört zum Rechnungskopf, nicht auf jede Folgeseite.
   */
  const logoBytes = await loadHistoricalLogoBytes(model.logo);
  if (logoBytes) {
    await drawHistoricalLogo(cursor, logoBytes);
  }

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
  const projectTitle = model.projectTitle?.trim() ?? '';
  const projectSite = model.projectSite?.trim() ?? '';
  if (projectTitle) drawLine(cursor, model.projectTitle, { size: 10 });
  /*
   * PDF-TEXT-RENDERING-01B — Baustelle nur, wenn sie etwas hinzufügt.
   *
   * In der Praxis tragen Vorgangstitel und Baustelle häufig denselben Text; die
   * Zeile erschien dann zweimal untereinander. Verglichen wird getrimmt, gedruckt
   * wird weiterhin der **unveränderte** Wert — hier wird nichts bereinigt.
   */
  if (projectSite && projectSite !== projectTitle) {
    drawLine(cursor, model.projectSite, { size: 9 });
  }

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
