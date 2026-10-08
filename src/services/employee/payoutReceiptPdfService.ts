/**
 * P1 MITARBEITERZAHLUNGEN — das PDF der Auszahlungsquittung.
 *
 * Bewusst ein eigener, kleiner Renderer — kein Umbau des Rechnungs- oder
 * Brief-PDFs und kein Vorlagensystem. Übernommen werden nur die erprobten
 * Bausteine: dieselbe Schrift (Liberation Sans), dieselbe Zeichensäuberung,
 * derselbe Logo-Weg (Branding-Resolver, WebP → JPEG) und derselbe Download.
 *
 * A4, schwarz/weiss drucktauglich, ohne Produktbranding. Der Satz läuft zweimal
 * über **denselben** Code: erst als Probelauf, der nur misst, dann als echter
 * Lauf. Passt die Quittung nicht auf eine Seite, wird sie stufenweise kleiner
 * gesetzt — abgeschnitten wird nie. Der Unterschriftsbereich bleibt immer
 * zusammen.
 */
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadInvoicePdfFont } from '../invoice/invoicePdfFonts';
import { downloadInvoicePdfBytes, toPdfSafeText } from '../invoicePdfService';
import { selectHistoricalInvoiceLogo } from '../invoice/invoiceHistoricalLogo';
import { resolveBrandingAsset } from '../branding/brandingAssetResolver';
import { encodeDocumentFileRasterToJpeg } from '../documentFileRasterEncodeService';
import { getSyncClient } from '../sync/syncClientService';
import { getCompanyProfile } from '../companyProfileService';
import type { CompanyProfile } from '../../types/models';
import type { EmployeePayment } from '../../types/employee';
import {
  buildPayoutReceiptFilename,
  buildPayoutReceiptModel,
  type PayoutReceiptModel,
} from './payoutReceiptModel';

/* DIN-A4 in Punkt; Ränder wie im Geschäftsbrief. */
export const PAYOUT_RECEIPT_PAGE_WIDTH = 595.28;
export const PAYOUT_RECEIPT_PAGE_HEIGHT = 841.89;
export const PAYOUT_RECEIPT_MARGIN_LEFT = 62;
export const PAYOUT_RECEIPT_MARGIN_RIGHT = 56;
const MARGIN_TOP = 52;
export const PAYOUT_RECEIPT_MARGIN_BOTTOM = 70;
const PAGE_WIDTH = PAYOUT_RECEIPT_PAGE_WIDTH;
const PAGE_HEIGHT = PAYOUT_RECEIPT_PAGE_HEIGHT;
const MARGIN_LEFT = PAYOUT_RECEIPT_MARGIN_LEFT;
const MARGIN_RIGHT = PAYOUT_RECEIPT_MARGIN_RIGHT;
const MARGIN_BOTTOM = PAYOUT_RECEIPT_MARGIN_BOTTOM;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

const LOGO_MAX_WIDTH = 140;
const LOGO_MAX_HEIGHT = 50;
const LABEL_COLUMN = 128;

/* Nur Grautöne — die Quittung wird ausgedruckt und unterschrieben. */
const TEXT_COLOR = rgb(0.08, 0.08, 0.08);
const MUTED_COLOR = rgb(0.32, 0.32, 0.32);
const RULE_COLOR = rgb(0.5, 0.5, 0.5);
const FRAME_COLOR = rgb(0.1, 0.1, 0.1);

/** Von „normal" bis „kompakt": die erste Stufe, die auf eine Seite passt, gewinnt. */
const SCALES = [1, 0.92, 0.85, 0.78, 0.72, 0.66] as const;

export interface PayoutReceiptLogoBytes {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
}

export interface PayoutReceiptTextRun {
  page: number;
  text: string;
  x: number;
  /** Grundlinie in PDF-Koordinaten (unten = 0). */
  y: number;
  size: number;
  width: number;
  bold: boolean;
}

export type PayoutReceiptBoxRole =
  | 'logo'
  | 'amount'
  | 'handwritten'
  | 'place_date'
  | 'signature_recipient'
  | 'signature_payer';

export interface PayoutReceiptBox {
  page: number;
  role: PayoutReceiptBoxRole;
  x: number;
  /** Unterkante in PDF-Koordinaten. */
  y: number;
  width: number;
  height: number;
}

export interface PayoutReceiptLayout {
  pageCount: number;
  scale: number;
  texts: PayoutReceiptTextRun[];
  boxes: PayoutReceiptBox[];
}

export type PayoutReceiptPdfResult =
  | {
      ok: true;
      bytes: Uint8Array;
      filename: string;
      mimeType: 'application/pdf';
      layout: PayoutReceiptLayout;
    }
  | {
      ok: false;
      reason: 'not_cash' | 'reversed' | 'invalid_payment' | 'encode_failed';
      message?: string;
    };

export interface PayoutReceiptPdfOptions {
  /** Firmendaten zum Zeitpunkt der Erstellung; ohne Angabe das heutige Profil. */
  company?: CompanyProfile;
  /** Logo-Beschaffung; ohne Angabe der Branding-Weg des Betriebs. */
  loadLogo?: (company: CompanyProfile) => Promise<PayoutReceiptLogoBytes | null>;
  now?: Date;
}

/* ------------------------------------------------------------------ */
/* Erzeugung                                                           */
/* ------------------------------------------------------------------ */

/**
 * Erzeugt die PDF-Bytes einer Auszahlungsquittung. Ändert an der Zahlung
 * nichts und legt nichts ab — das tut ausschliesslich die Archivierung.
 */
export async function generatePayoutReceiptPdf(
  payment: EmployeePayment,
  options: PayoutReceiptPdfOptions = {},
): Promise<PayoutReceiptPdfResult> {
  const company = options.company ?? getCompanyProfile();
  const modell = buildPayoutReceiptModel(payment, company);
  if (!modell.ok) return { ok: false, reason: modell.reason };

  let logo: PayoutReceiptLogoBytes | null = null;
  try {
    logo = await (options.loadLogo ?? loadPayoutReceiptLogo)(company);
  } catch {
    // Kein Logo ist richtig; eine fehlende Quittung wäre falsch.
    logo = null;
  }

  try {
    const { bytes, layout } = await renderPayoutReceiptPdf(modell.model, logo, options.now ?? new Date());
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5) {
      return { ok: false, reason: 'encode_failed', message: 'empty_pdf' };
    }
    const kopf = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
    if (kopf !== '%PDF-') return { ok: false, reason: 'encode_failed', message: 'invalid_pdf_header' };
    return {
      ok: true,
      bytes,
      filename: buildPayoutReceiptFilename(modell.model.reference),
      mimeType: 'application/pdf',
      layout,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'encode_failed',
      message: error instanceof Error ? error.message : 'encode_failed',
    };
  }
}

/** Lädt vorhandene Bytes (das archivierte Original) herunter — nie neu erzeugt. */
export function downloadPayoutReceiptBytes(bytes: Uint8Array, filename: string): void {
  downloadInvoicePdfBytes(bytes, filename);
}

/* ------------------------------------------------------------------ */
/* Logo                                                                */
/* ------------------------------------------------------------------ */

function decodeBase64(base64: string): Uint8Array | null {
  try {
    const binaer = atob(base64);
    const bytes = new Uint8Array(binaer.length);
    for (let i = 0; i < binaer.length; i += 1) bytes[i] = binaer.charCodeAt(i);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** Nur Base64-PNG/JPEG/WebP — kein SVG, keine entfernte URL. */
function parseLegacyLogo(dataUrl: string): { bytes: Uint8Array; mimeType: string } | null {
  const treffer = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!treffer) return null;
  const bytes = decodeBase64(treffer[2].replace(/\s+/g, ''));
  return bytes ? { bytes, mimeType: treffer[1] } : null;
}

/** WebP kann pdf-lib nicht einbetten — temporär nach JPEG, wie im Rechnungs-PDF. */
async function toEmbeddable(bytes: Uint8Array, mimeType: string): Promise<PayoutReceiptLogoBytes | null> {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg') return { bytes, mimeType };
  if (mimeType !== 'image/webp') return null;
  try {
    const encoded = await encodeDocumentFileRasterToJpeg({ bytes, sourceMimeType: 'image/webp' });
    return { bytes: encoded.bytes, mimeType: 'image/jpeg' };
  } catch {
    return null;
  }
}

/**
 * Das Firmenlogo zum Zeitpunkt der Erstellung: strukturierte Referenz über den
 * bestehenden Resolver, sonst das eingebettete Alt-Bild. Scheitert das Laden,
 * entsteht die Quittung ohne Logo.
 */
export async function loadPayoutReceiptLogo(company: CompanyProfile): Promise<PayoutReceiptLogoBytes | null> {
  const quelle = selectHistoricalInvoiceLogo({ companySnapshot: company, brandingSnapshot: undefined });
  if (quelle.kind === 'none') return null;
  if (quelle.kind === 'legacy_data_url') {
    const geparst = parseLegacyLogo(quelle.dataUrl);
    return geparst ? toEmbeddable(geparst.bytes, geparst.mimeType) : null;
  }
  const workspaceId = getSyncClient().serverWorkspaceId;
  if (!workspaceId) return null;
  try {
    const aufgeloest = await resolveBrandingAsset(workspaceId, quelle.reference);
    if (!aufgeloest.ok) return null;
    const buffer = await aufgeloest.blob.arrayBuffer();
    return toEmbeddable(new Uint8Array(buffer), quelle.reference.mimeType);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Satz                                                                */
/* ------------------------------------------------------------------ */

interface Painter {
  doc: PDFDocument;
  font: PDFFont;
  fontBold: PDFFont;
  scale: number;
  /** `false` im Probelauf: gemessen wird alles, gezeichnet nichts. */
  draw: boolean;
  pages: PDFPage[];
  pageIndex: number;
  y: number;
  layout: PayoutReceiptLayout;
}

function newPainter(
  doc: PDFDocument,
  font: PDFFont,
  fontBold: PDFFont,
  scale: number,
  draw: boolean,
): Painter {
  const painter: Painter = {
    doc,
    font,
    fontBold,
    scale,
    draw,
    pages: [],
    pageIndex: 0,
    y: PAGE_HEIGHT - MARGIN_TOP,
    layout: { pageCount: 1, scale, texts: [], boxes: [] },
  };
  if (draw) painter.pages.push(doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]));
  return painter;
}

function page(p: Painter): PDFPage | null {
  return p.draw ? (p.pages[p.pageIndex] ?? null) : null;
}

function newPage(p: Painter): void {
  p.pageIndex += 1;
  p.layout.pageCount = p.pageIndex + 1;
  if (p.draw) p.pages.push(p.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]));
  p.y = PAGE_HEIGHT - MARGIN_TOP;
}

/** Platz für einen zusammenhängenden Block — sonst beginnt er auf der nächsten Seite. */
function ensureSpace(p: Painter, needed: number): void {
  if (p.y - needed >= MARGIN_BOTTOM) return;
  newPage(p);
}

/**
 * Umbruch an Leerzeichen; ein einzelnes Wort, das breiter ist als die Spalte
 * (ein sehr langer Name ohne Leerzeichen), wird zeichenweise getrennt statt
 * über den Rand zu laufen.
 */
export function wrapReceiptText(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const sauber = toPdfSafeText(value).replace(/\s+/g, ' ').trim();
  if (!sauber) return [];
  const zeilen: string[] = [];
  let laufend = '';
  const passt = (t: string) => font.widthOfTextAtSize(t, size) <= maxWidth;

  for (const wort of sauber.split(' ')) {
    const kandidat = laufend ? `${laufend} ${wort}` : wort;
    if (passt(kandidat)) {
      laufend = kandidat;
      continue;
    }
    if (laufend) zeilen.push(laufend);
    laufend = '';
    if (passt(wort)) {
      laufend = wort;
      continue;
    }
    let stueck = '';
    for (const zeichen of Array.from(wort)) {
      if (stueck && !passt(stueck + zeichen)) {
        zeilen.push(stueck);
        stueck = zeichen;
      } else {
        stueck += zeichen;
      }
    }
    laufend = stueck;
  }
  if (laufend) zeilen.push(laufend);
  return zeilen;
}

function drawText(
  p: Painter,
  value: string,
  options: { x: number; y: number; size: number; bold?: boolean; muted?: boolean },
): void {
  const font = options.bold ? p.fontBold : p.font;
  const sicher = toPdfSafeText(value);
  const width = font.widthOfTextAtSize(sicher, options.size);
  p.layout.texts.push({
    page: p.pageIndex,
    text: sicher,
    x: options.x,
    y: options.y,
    size: options.size,
    width,
    bold: Boolean(options.bold),
  });
  page(p)?.drawText(sicher, {
    x: options.x,
    y: options.y,
    size: options.size,
    font,
    color: options.muted ? MUTED_COLOR : TEXT_COLOR,
  });
}

function recordBox(p: Painter, role: PayoutReceiptBoxRole, x: number, y: number, width: number, height: number): void {
  p.layout.boxes.push({ page: p.pageIndex, role, x, y, width, height });
}

function drawRule(p: Painter, x1: number, x2: number, y: number, thickness = 0.6, color = RULE_COLOR): void {
  page(p)?.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
}

function drawFrame(p: Painter, x: number, y: number, width: number, height: number, thickness: number): void {
  page(p)?.drawRectangle({ x, y, width, height, borderColor: FRAME_COLOR, borderWidth: thickness });
}

/** Ein umbrochener Absatz in voller Breite; der Cursor wandert mit. */
function paragraph(
  p: Painter,
  value: string,
  options: { size: number; bold?: boolean; muted?: boolean; x?: number; width?: number; leading?: number },
): void {
  const x = options.x ?? MARGIN_LEFT;
  const breite = options.width ?? CONTENT_WIDTH;
  const font = options.bold ? p.fontBold : p.font;
  const zeilenabstand = options.size + (options.leading ?? 3.5 * p.scale);
  for (const zeile of wrapReceiptText(value, font, options.size, breite)) {
    ensureSpace(p, zeilenabstand);
    drawText(p, zeile, { x, y: p.y - options.size, size: options.size, bold: options.bold, muted: options.muted });
    p.y -= zeilenabstand;
  }
}

interface EmbeddedLogo {
  image: PDFImage;
  width: number;
  height: number;
}

/** Kopf: Firmenblock links, Logo rechts — der Firmenblock weicht dem Logo aus. */
function drawHeader(p: Painter, model: PayoutReceiptModel, logo: EmbeddedLogo | null): void {
  const s = p.scale;
  const oben = p.y;
  let logoHoehe = 0;
  let linkeBreite = CONTENT_WIDTH;

  if (logo) {
    const faktor = Math.min(LOGO_MAX_WIDTH / logo.width, (LOGO_MAX_HEIGHT * s) / logo.height, 1);
    const breite = logo.width * faktor;
    logoHoehe = logo.height * faktor;
    const x = PAGE_WIDTH - MARGIN_RIGHT - breite;
    const y = oben - logoHoehe;
    recordBox(p, 'logo', x, y, breite, logoHoehe);
    page(p)?.drawImage(logo.image, { x, y, width: breite, height: logoHoehe });
    linkeBreite = CONTENT_WIDTH - breite - 18;
  }

  const [name, ...anschrift] = model.companyLines;
  if (name) paragraph(p, name, { size: 11.5 * s, bold: true, width: linkeBreite });
  for (const zeile of anschrift) paragraph(p, zeile, { size: 9 * s, muted: true, width: linkeBreite, leading: 2.5 * s });
  if (model.contactLine) paragraph(p, model.contactLine, { size: 8.5 * s, muted: true, width: linkeBreite, leading: 2.5 * s });
  if (model.registerLine) paragraph(p, model.registerLine, { size: 8 * s, muted: true, width: linkeBreite, leading: 2.5 * s });

  const verbraucht = oben - p.y;
  if (verbraucht < logoHoehe) p.y = oben - logoHoehe;

  p.y -= 12 * s;
  drawRule(p, MARGIN_LEFT, PAGE_WIDTH - MARGIN_RIGHT, p.y);
  p.y -= 22 * s;
}

function drawTitle(p: Painter, model: PayoutReceiptModel): void {
  const s = p.scale;
  paragraph(p, model.title, { size: 21 * s, bold: true, leading: 6 * s });
  paragraph(p, model.subtitle, { size: 11 * s, muted: true });
  p.y -= 14 * s;
}

/** Die Angaben als zweispaltige Tabelle; lange Werte brechen in ihrer Spalte um. */
function drawFacts(p: Painter, model: PayoutReceiptModel): void {
  const s = p.scale;
  const labelGroesse = 9.5 * s;
  const wertGroesse = 10.5 * s;
  const zeilenabstand = wertGroesse + 4 * s;
  const wertX = MARGIN_LEFT + LABEL_COLUMN;
  const wertBreite = CONTENT_WIDTH - LABEL_COLUMN;

  for (const fakt of model.facts) {
    const fett = fakt.label === 'Referenz';
    const labelZeilen = wrapReceiptText(fakt.label, p.font, labelGroesse, LABEL_COLUMN - 10);
    const wertZeilen = fakt.handwritten
      ? ['']
      : wrapReceiptText(fakt.value, fett ? p.fontBold : p.font, wertGroesse, wertBreite);
    const zeilen = Math.max(labelZeilen.length, wertZeilen.length, 1);
    const hoehe = zeilen * zeilenabstand + (fakt.handwritten ? 8 * s : 0);
    ensureSpace(p, hoehe + 3 * s);

    labelZeilen.forEach((zeile, index) => {
      drawText(p, zeile, {
        x: MARGIN_LEFT,
        y: p.y - wertGroesse - index * zeilenabstand,
        size: labelGroesse,
        muted: true,
      });
    });
    if (fakt.handwritten) {
      /* Leer gelassen, um es von Hand einzutragen — eine Linie statt eines Platzhalters. */
      const linieY = p.y - wertGroesse - 6 * s;
      recordBox(p, 'handwritten', wertX, linieY, Math.min(220, wertBreite), 0);
      drawRule(p, wertX, wertX + Math.min(220, wertBreite), linieY, 0.7, FRAME_COLOR);
    } else {
      wertZeilen.forEach((zeile, index) => {
        drawText(p, zeile, {
          x: wertX,
          y: p.y - wertGroesse - index * zeilenabstand,
          size: wertGroesse,
          bold: fett,
        });
      });
    }
    p.y -= hoehe + 3 * s;
  }
  p.y -= 10 * s;
}

/** Der Betrag, deutlich hervorgehoben, in einem Rahmen — mit Worten, falls vorhanden. */
function drawAmount(p: Painter, model: PayoutReceiptModel): void {
  const s = p.scale;
  const innen = 12 * s;
  const labelGroesse = 9.5 * s;
  const betragGroesse = 24 * s;
  const worteGroesse = 9.5 * s;
  const worteAbstand = worteGroesse + 3 * s;
  const worteZeilen = model.amountInWords
    ? wrapReceiptText(`in Worten: ${model.amountInWords}`, p.font, worteGroesse, CONTENT_WIDTH - 2 * innen)
    : [];
  const hoehe =
    innen + labelGroesse + 7 * s + betragGroesse + (worteZeilen.length > 0 ? 9 * s + worteZeilen.length * worteAbstand : 0) + innen;

  ensureSpace(p, hoehe);
  const oben = p.y;
  const unten = oben - hoehe;
  recordBox(p, 'amount', MARGIN_LEFT, unten, CONTENT_WIDTH, hoehe);
  drawFrame(p, MARGIN_LEFT, unten, CONTENT_WIDTH, hoehe, 1.2);

  let y = oben - innen - labelGroesse;
  drawText(p, 'Ausgezahlter Betrag', { x: MARGIN_LEFT + innen, y, size: labelGroesse, muted: true });
  y -= 7 * s + betragGroesse;
  drawText(p, model.amountText, { x: MARGIN_LEFT + innen, y: y + 4 * s, size: betragGroesse, bold: true });
  if (worteZeilen.length > 0) {
    y -= 9 * s;
    for (const zeile of worteZeilen) {
      drawText(p, zeile, { x: MARGIN_LEFT + innen, y: y - worteGroesse + 3 * s, size: worteGroesse });
      y -= worteAbstand;
    }
  }
  p.y = unten - 16 * s;
}

function drawTexts(p: Painter, model: PayoutReceiptModel): void {
  const s = p.scale;
  const abschnitte: Array<[string, string | null]> = [
    ['Verwendungszweck', model.purpose],
    ['Notiz', model.note],
  ];
  for (const [label, wert] of abschnitte) {
    if (!wert) continue;
    ensureSpace(p, 9 * s + 10 * s + 12 * s);
    paragraph(p, label, { size: 9 * s, bold: true, leading: 2.5 * s });
    paragraph(p, wert, { size: 10 * s });
    p.y -= 8 * s;
  }
  if (model.advanceHint) {
    paragraph(p, model.advanceHint, { size: 9.5 * s, bold: true });
    p.y -= 8 * s;
  }
  p.y -= 4 * s;
  paragraph(p, model.confirmationText, { size: 10.5 * s });
  p.y -= 18 * s;
}

/**
 * Ort/Datum, das grosse Feld für die Unterschrift der Empfängerin oder des
 * Empfängers und daneben das kleinere für die auszahlende Person. Der ganze
 * Block wird vorher gemessen und nie über einen Seitenwechsel getrennt.
 */
function drawSignatures(p: Painter, model: PayoutReceiptModel): void {
  const s = p.scale;
  const labelGroesse = 8.5 * s;
  const nameGroesse = 9 * s;
  const labelAbstand = labelGroesse + 3 * s;
  const nameAbstand = nameGroesse + 3 * s;

  const ortHoehe = 30 * s;
  const ortBlock = ortHoehe + 4 * s + labelAbstand + 18 * s;

  const luecke = CONTENT_WIDTH * 0.04;
  const empfaengerBreite = CONTENT_WIDTH * 0.58;
  const zahlerBreite = CONTENT_WIDTH - empfaengerBreite - luecke;
  const empfaengerHoehe = 84 * s;
  const zahlerHoehe = 58 * s;

  const empfaengerNamen = wrapReceiptText(model.recipientName, p.font, nameGroesse, empfaengerBreite);
  const zahlerNamen = model.paidByName ? wrapReceiptText(model.paidByName, p.font, nameGroesse, zahlerBreite) : [];
  const empfaengerLabel = wrapReceiptText('Unterschrift Empfänger/in', p.font, labelGroesse, empfaengerBreite);
  const zahlerLabel = wrapReceiptText('Unterschrift Auszahlende/r', p.font, labelGroesse, zahlerBreite);

  const unterEmpfaenger = 5 * s + empfaengerLabel.length * labelAbstand + empfaengerNamen.length * nameAbstand;
  const unterZahler = 5 * s + zahlerLabel.length * labelAbstand + zahlerNamen.length * nameAbstand;
  const feldBlock = Math.max(empfaengerHoehe + unterEmpfaenger, zahlerHoehe + unterZahler);

  ensureSpace(p, ortBlock + feldBlock);

  /* Ort, Datum — von Hand. */
  const ortLinie = p.y - ortHoehe;
  recordBox(p, 'place_date', MARGIN_LEFT, ortLinie, 230, ortHoehe);
  drawRule(p, MARGIN_LEFT, MARGIN_LEFT + 230, ortLinie, 0.8, FRAME_COLOR);
  drawText(p, 'Ort, Datum', { x: MARGIN_LEFT, y: ortLinie - 4 * s - labelGroesse, size: labelGroesse, muted: true });
  p.y -= ortBlock;

  /* Unterschriftsfelder nebeneinander, oben bündig. */
  const oben = p.y;
  const empfaengerUnten = oben - empfaengerHoehe;
  recordBox(p, 'signature_recipient', MARGIN_LEFT, empfaengerUnten, empfaengerBreite, empfaengerHoehe);
  drawFrame(p, MARGIN_LEFT, empfaengerUnten, empfaengerBreite, empfaengerHoehe, 0.9);

  const zahlerX = MARGIN_LEFT + empfaengerBreite + luecke;
  const zahlerUnten = oben - zahlerHoehe;
  recordBox(p, 'signature_payer', zahlerX, zahlerUnten, zahlerBreite, zahlerHoehe);
  drawFrame(p, zahlerX, zahlerUnten, zahlerBreite, zahlerHoehe, 0.7);

  let y = empfaengerUnten - 5 * s;
  for (const zeile of empfaengerLabel) {
    drawText(p, zeile, { x: MARGIN_LEFT, y: y - labelGroesse, size: labelGroesse, muted: true });
    y -= labelAbstand;
  }
  for (const zeile of empfaengerNamen) {
    drawText(p, zeile, { x: MARGIN_LEFT, y: y - nameGroesse, size: nameGroesse });
    y -= nameAbstand;
  }

  y = zahlerUnten - 5 * s;
  for (const zeile of zahlerLabel) {
    drawText(p, zeile, { x: zahlerX, y: y - labelGroesse, size: labelGroesse, muted: true });
    y -= labelAbstand;
  }
  for (const zeile of zahlerNamen) {
    drawText(p, zeile, { x: zahlerX, y: y - nameGroesse, size: nameGroesse });
    y -= nameAbstand;
  }

  p.y = oben - feldBlock;
}

/** Fusszeile auf jeder Seite: MZ-Referenz links, Seitenzahl rechts. */
function drawFooters(p: Painter, model: PayoutReceiptModel): void {
  const gesamt = p.layout.pageCount;
  for (let index = 0; index < gesamt; index += 1) {
    const vorher = p.pageIndex;
    p.pageIndex = index;
    drawRule(p, MARGIN_LEFT, PAGE_WIDTH - MARGIN_RIGHT, MARGIN_BOTTOM - 18, 0.5);
    drawText(p, model.footerLeft, { x: MARGIN_LEFT, y: MARGIN_BOTTOM - 30, size: 8, muted: true });
    const seite = `Seite ${index + 1} von ${gesamt}`;
    const breite = p.font.widthOfTextAtSize(seite, 8);
    drawText(p, seite, { x: PAGE_WIDTH - MARGIN_RIGHT - breite, y: MARGIN_BOTTOM - 30, size: 8, muted: true });
    p.pageIndex = vorher;
  }
}

function setBody(p: Painter, model: PayoutReceiptModel, logo: EmbeddedLogo | null): void {
  drawHeader(p, model, logo);
  drawTitle(p, model);
  drawFacts(p, model);
  drawAmount(p, model);
  drawTexts(p, model);
  drawSignatures(p, model);
}

/**
 * Setzt die Quittung. Exportiert für die Tests, die Lage und Vollständigkeit
 * der gezeichneten Inhalte prüfen.
 */
export async function renderPayoutReceiptPdf(
  model: PayoutReceiptModel,
  logo: PayoutReceiptLogoBytes | null,
  now: Date = new Date(),
): Promise<{ bytes: Uint8Array; layout: PayoutReceiptLayout }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const [regular, bold] = await Promise.all([loadInvoicePdfFont('regular'), loadInvoicePdfFont('bold')]);
  const font = await doc.embedFont(regular, { subset: true });
  const fontBold = await doc.embedFont(bold, { subset: true });

  let eingebettet: EmbeddedLogo | null = null;
  if (logo) {
    try {
      const image = logo.mimeType === 'image/jpeg' ? await doc.embedJpg(logo.bytes) : await doc.embedPng(logo.bytes);
      if (Number.isFinite(image.width) && Number.isFinite(image.height) && image.width > 0 && image.height > 0) {
        eingebettet = { image, width: image.width, height: image.height };
      }
    } catch {
      eingebettet = null;
    }
  }

  /* Probelauf: die grösste Stufe, die auf eine Seite passt. */
  let gewaehlt: number = SCALES[SCALES.length - 1];
  for (const stufe of SCALES) {
    const probe = newPainter(doc, font, fontBold, stufe, false);
    setBody(probe, model, eingebettet);
    if (probe.layout.pageCount === 1) {
      gewaehlt = stufe;
      break;
    }
  }

  const painter = newPainter(doc, font, fontBold, gewaehlt, true);
  setBody(painter, model, eingebettet);
  drawFooters(painter, model);

  doc.setTitle(`${model.title} ${model.reference}`);
  doc.setSubject(model.subtitle);
  doc.setLanguage('de-DE');
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  const bytes = await doc.save();
  return { bytes, layout: painter.layout };
}
