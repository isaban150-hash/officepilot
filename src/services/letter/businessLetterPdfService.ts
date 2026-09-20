/**
 * BRIEFE-01D — das druckfertige PDF eines fertiggestellten Geschäftsschreibens.
 *
 * Bewusst ein eigener, kleiner Renderer und **kein** Umbau des Rechnungs-PDFs.
 * Der Rechnungsweg ist erprobt und trägt freigegebene Belege; ein Brief hat ein
 * anderes Layout (Anschriftfeld, Betreffzeile, Fliesstext statt Positionen), und
 * eine gemeinsame Abstraktion hätte den stabilen Rechnungscode anfassen müssen.
 * Übernommen werden nur die unveränderten Bausteine: dieselbe Schrift, dieselbe
 * Zeichensäuberung, derselbe Download-Weg.
 *
 * **Quelle ist ausschliesslich der eingefrorene Brief.** Firmenprofil,
 * Kundenstamm und Anschriftbuch werden hier nicht gelesen. Ein Schreiben, das
 * einmal fertiggestellt war, druckt in einem Jahr Zeichen für Zeichen gleich.
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadInvoicePdfFont } from '../invoice/invoicePdfFonts';
import { toPdfSafeText, downloadInvoicePdfBytes } from '../invoicePdfService';
import type { BusinessLetter } from '../../types/businessLetter';
import type { CompanyProfile } from '../../types/models';

/* DIN-A4 in Punkt; Ränder wie beim Geschäftsbrief üblich. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_LEFT = 62;
const MARGIN_RIGHT = 56;
const MARGIN_TOP = 52;
const MARGIN_BOTTOM = 62;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

const LOGO_MAX_WIDTH = 150;
const LOGO_MAX_HEIGHT = 52;

const TEXT_COLOR = rgb(0.1, 0.1, 0.1);
const MUTED_COLOR = rgb(0.38, 0.4, 0.44);
const RULE_COLOR = rgb(0.78, 0.8, 0.84);

const BODY_SIZE = 10.5;
const BODY_LEADING = 5.5;
const SENDER_SIZE = 8;

export type BusinessLetterPdfResult =
  | {
      ok: true;
      bytes: Uint8Array;
      filename: string;
      mimeType: 'application/pdf';
    }
  | {
      ok: false;
      reason: 'not_finalized' | 'incomplete' | 'encode_failed';
      message?: string;
    };

/* ------------------------------------------------------------------ */
/* Dateiname                                                           */
/* ------------------------------------------------------------------ */

/**
 * Datum, bereinigter Betreff und eine kurze stabile Briefkennung.
 *
 * Die Kennung ist das Ende der ohnehin vorhandenen Brief-Id — keine eigene
 * Briefnummern-Serie. Sie steht dahinter, damit zwei Schreiben mit gleichem
 * Betreff am selben Tag nicht dieselbe Datei ergeben, und sie ist stabil: Der
 * Brief lädt morgen unter demselben Namen herunter wie heute.
 */
export function buildBusinessLetterPdfFilename(letter: BusinessLetter): string {
  const datum = (letter.letterDate || letter.createdAt || '').slice(0, 10) || 'ohne-datum';
  const betreff = bereinigterBetreff(letter.subject);
  const kennung = kurzeKennung(letter.id);
  const teile = [datum, betreff, kennung].filter(Boolean);
  return `${teile.join('_')}.pdf`;
}

function bereinigterBetreff(subject: string): string {
  const umlautfrei = subject
    .trim()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss');
  const gekuerzt = umlautfrei
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/g, '');
  return gekuerzt || 'Geschaeftsschreiben';
}

function kurzeKennung(id: string): string {
  const roh = id.replace(/[^a-zA-Z0-9]/g, '');
  return roh.slice(-6).toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Erzeugung                                                           */
/* ------------------------------------------------------------------ */

/**
 * Erzeugt die PDF-Bytes. Ändert am Brief nichts und legt nichts ab.
 *
 * Entwürfe bekommen bewusst kein PDF: Ein Entwurf hat noch keine eingefrorenen
 * Absenderdaten, das Ergebnis wäre kein Beleg, sondern eine Momentaufnahme.
 */
export async function generateBusinessLetterPdf(
  letter: BusinessLetter,
): Promise<BusinessLetterPdfResult> {
  if (letter.status !== 'finalized') return { ok: false, reason: 'not_finalized' };
  if (!letter.subject.trim() || !letter.body.trim()) return { ok: false, reason: 'incomplete' };

  const empfaenger = letter.recipient;
  if (!empfaenger?.name?.trim() && !empfaenger?.company?.trim()) {
    return { ok: false, reason: 'incomplete' };
  }

  try {
    const bytes = await renderLetterToPdf(letter);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5) {
      return { ok: false, reason: 'encode_failed', message: 'empty_pdf' };
    }
    const kopf = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
    if (kopf !== '%PDF-') {
      return { ok: false, reason: 'encode_failed', message: 'invalid_pdf_header' };
    }
    return {
      ok: true,
      bytes,
      filename: buildBusinessLetterPdfFilename(letter),
      mimeType: 'application/pdf',
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'encode_failed',
      message: error instanceof Error ? error.message : 'encode_failed',
    };
  }
}

/** Erzeugen und herunterladen in einem Schritt — nur auf ausdrückliche Handlung. */
export async function downloadBusinessLetterPdf(
  letter: BusinessLetter,
): Promise<BusinessLetterPdfResult> {
  const ergebnis = await generateBusinessLetterPdf(letter);
  if (ergebnis.ok) downloadInvoicePdfBytes(ergebnis.bytes, ergebnis.filename);
  return ergebnis;
}

/* ------------------------------------------------------------------ */
/* Satz                                                                */
/* ------------------------------------------------------------------ */

interface Cursor {
  pdfDoc: PDFDocument;
  page: PDFPage;
  y: number;
  font: PDFFont;
  fontBold: PDFFont;
}

/**
 * Sorgt für Platz. Reicht die Seite nicht mehr, beginnt eine neue — der Text
 * läuft weiter, nichts wird abgeschnitten.
 */
function ensureSpace(cursor: Cursor, needed: number): void {
  if (cursor.y - needed >= MARGIN_BOTTOM) return;
  cursor.page = cursor.pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  cursor.y = PAGE_HEIGHT - MARGIN_TOP;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [''];
  const woerter = text.split(/\s+/).filter(Boolean);
  if (woerter.length === 0) return [''];
  const zeilen: string[] = [];
  let laufend = '';
  for (const wort of woerter) {
    const naechste = laufend ? `${laufend} ${wort}` : wort;
    if (font.widthOfTextAtSize(naechste, size) <= maxWidth) {
      laufend = naechste;
    } else {
      if (laufend) zeilen.push(laufend);
      laufend = wort;
    }
  }
  if (laufend) zeilen.push(laufend);
  return zeilen.length > 0 ? zeilen : [''];
}

function drawLine(
  cursor: Cursor,
  text: string,
  options: { size?: number; bold?: boolean; muted?: boolean; x?: number } = {},
): void {
  const size = options.size ?? BODY_SIZE;
  const font = options.bold ? cursor.fontBold : cursor.font;
  ensureSpace(cursor, size + BODY_LEADING);
  cursor.page.drawText(toPdfSafeText(text), {
    x: options.x ?? MARGIN_LEFT,
    y: cursor.y - size,
    size,
    font,
    color: options.muted ? MUTED_COLOR : TEXT_COLOR,
  });
  cursor.y -= size + BODY_LEADING;
}

function drawWrapped(
  cursor: Cursor,
  text: string,
  options: { size?: number; bold?: boolean; muted?: boolean } = {},
): void {
  const size = options.size ?? BODY_SIZE;
  const font = options.bold ? cursor.fontBold : cursor.font;
  for (const zeile of wrapText(toPdfSafeText(text), font, size, CONTENT_WIDTH)) {
    drawLine(cursor, zeile, { ...options, size });
  }
}

/**
 * Der Brieftext, Absatz für Absatz.
 *
 * Leerzeilen des Verfassers bleiben Leerzeilen; jeder Absatz wird für sich
 * umbrochen. Ein langer Absatz darf über den Seitenrand hinauswachsen — er
 * läuft dann auf der nächsten Seite weiter.
 */
function drawBody(cursor: Cursor, body: string): void {
  const absaetze = body.replace(/\r\n/g, '\n').split('\n');
  for (const absatz of absaetze) {
    if (!absatz.trim()) {
      ensureSpace(cursor, BODY_SIZE);
      cursor.y -= BODY_SIZE * 0.7;
      continue;
    }
    drawWrapped(cursor, absatz);
  }
}

/** Nur Base64-Bilder, die `pdf-lib` auch wirklich einbetten kann. */
function parseLogoDataUrl(dataUrl: string): { bytes: Uint8Array; png: boolean } | null {
  const treffer = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!treffer) return null;
  try {
    const binaer = atob(treffer[2].replace(/\s+/g, ''));
    const bytes = new Uint8Array(binaer.length);
    for (let i = 0; i < binaer.length; i += 1) bytes[i] = binaer.charCodeAt(i);
    if (bytes.length === 0) return null;
    return { bytes, png: treffer[1] === 'image/png' };
  } catch {
    return null;
  }
}

/**
 * Das Logo oben rechts, eingepasst und nie verzerrt.
 *
 * Es stammt aus den **eingefrorenen** Firmendaten des Briefes. Schlägt das
 * Einbetten fehl, entsteht der Brief trotzdem — nur ohne Bild.
 */
async function drawLogo(cursor: Cursor, profil: CompanyProfile): Promise<number> {
  const quelle = profil.logoDataUrl?.trim();
  if (!quelle) return 0;
  const geparst = parseLogoDataUrl(quelle);
  if (!geparst) return 0;

  let bild;
  try {
    bild = geparst.png
      ? await cursor.pdfDoc.embedPng(geparst.bytes)
      : await cursor.pdfDoc.embedJpg(geparst.bytes);
  } catch {
    return 0;
  }

  const { width, height } = bild;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;

  const faktor = Math.min(LOGO_MAX_WIDTH / width, LOGO_MAX_HEIGHT / height, 1);
  const breite = width * faktor;
  const hoehe = height * faktor;
  cursor.page.drawImage(bild, {
    x: PAGE_WIDTH - MARGIN_RIGHT - breite,
    y: PAGE_HEIGHT - MARGIN_TOP - hoehe,
    width: breite,
    height: hoehe,
  });
  return hoehe;
}

/** Absenderzeilen aus den eingefrorenen Firmendaten — ohne leere Bestandteile. */
function senderLines(profil: CompanyProfile): string[] {
  const zeilen: string[] = [];
  const name = [profil.companyName, profil.legalForm].map((t) => t?.trim()).filter(Boolean).join(' ');
  if (name) zeilen.push(name);
  if (profil.street?.trim()) zeilen.push(profil.street.trim());
  const ort = [profil.zip, profil.city].map((t) => t?.trim()).filter(Boolean).join(' ');
  if (ort) zeilen.push(ort);
  if (profil.country?.trim()) zeilen.push(profil.country.trim());
  return zeilen;
}

/** Die Fusszeile: Erreichbarkeit und Registerangaben, klein und ruhig. */
function footerLines(profil: CompanyProfile): string[] {
  const zeilen: string[] = [];
  const kontakt = [
    profil.phone?.trim() ? `Telefon ${profil.phone.trim()}` : '',
    profil.email?.trim(),
    profil.website?.trim(),
  ].filter(Boolean);
  if (kontakt.length > 0) zeilen.push(kontakt.join('  ·  '));

  const register = [
    profil.registrationAuthority?.trim() && profil.registrationNumber?.trim()
      ? `${profil.registrationAuthority.trim()} ${profil.registrationNumber.trim()}`
      : profil.registrationNumber?.trim() || '',
    profil.vatId?.trim() ? `USt-IdNr. ${profil.vatId.trim()}` : '',
    profil.taxNumber?.trim() ? `Steuernummer ${profil.taxNumber.trim()}` : '',
  ].filter(Boolean);
  if (register.length > 0) zeilen.push(register.join('  ·  '));

  return zeilen;
}

/** Die Empfängeranschrift genau so, wie sie am Brief steht. */
function recipientLines(letter: BusinessLetter): string[] {
  const e = letter.recipient;
  const zeilen: string[] = [];
  if (e.company?.trim()) zeilen.push(e.company.trim());
  if (e.name?.trim()) zeilen.push(e.name.trim());
  if (e.street?.trim()) zeilen.push(e.street.trim());
  const ort = [e.zip, e.city].map((t) => t?.trim()).filter(Boolean).join(' ');
  if (ort) zeilen.push(ort);
  if (e.country?.trim()) zeilen.push(e.country.trim());
  return zeilen;
}

/** Tagesdatum in der im Geschäftsbrief üblichen Form. */
function formatLetterDate(iso: string): string {
  const treffer = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!treffer) return iso;
  return `${Number(treffer[3])}. ${MONATE[Number(treffer[2]) - 1] ?? ''} ${treffer[1]}`.replace(/\s+/g, ' ').trim();
}

const MONATE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

async function renderLetterToPdf(letter: BusinessLetter): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const [regular, bold] = await Promise.all([
    loadInvoicePdfFont('regular'),
    loadInvoicePdfFont('bold'),
  ]);
  const font = await pdfDoc.embedFont(regular, { subset: true });
  const fontBold = await pdfDoc.embedFont(bold, { subset: true });

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const cursor: Cursor = { pdfDoc, page, y: PAGE_HEIGHT - MARGIN_TOP, font, fontBold };

  /*
   * Ausschliesslich die eingefrorenen Firmendaten. Fehlen sie — ein Brief aus
   * einer sehr frühen Fassung —, bleibt der Absenderblock leer, statt heutige
   * Daten in ein altes Schreiben zu schreiben.
   */
  const profil = letter.companySnapshot;

  /* Kopf: Logo rechts, Absender links. */
  let kopfhoehe = 0;
  if (profil) kopfhoehe = await drawLogo(cursor, profil);

  if (profil) {
    for (const zeile of senderLines(profil)) {
      drawLine(cursor, zeile, { size: SENDER_SIZE, muted: true });
    }
  }
  if (kopfhoehe > 0) {
    const verbraucht = PAGE_HEIGHT - MARGIN_TOP - cursor.y;
    if (verbraucht < kopfhoehe) cursor.y -= kopfhoehe - verbraucht;
  }

  cursor.y -= 26;

  /* Anschriftfeld. */
  if (profil) {
    const rueckzeile = senderLines(profil).join(' · ');
    if (rueckzeile) {
      drawLine(cursor, rueckzeile, { size: 7, muted: true });
      ensureSpace(cursor, 6);
      cursor.page.drawLine({
        start: { x: MARGIN_LEFT, y: cursor.y + 2 },
        end: { x: MARGIN_LEFT + 240, y: cursor.y + 2 },
        thickness: 0.5,
        color: RULE_COLOR,
      });
      cursor.y -= 8;
    }
  }
  for (const zeile of recipientLines(letter)) {
    drawLine(cursor, zeile, { size: BODY_SIZE });
  }

  cursor.y -= 34;

  /* Datum rechtsbündig. */
  const datum = formatLetterDate(letter.letterDate);
  if (datum) {
    const breite = font.widthOfTextAtSize(toPdfSafeText(datum), BODY_SIZE);
    ensureSpace(cursor, BODY_SIZE + BODY_LEADING);
    cursor.page.drawText(toPdfSafeText(datum), {
      x: PAGE_WIDTH - MARGIN_RIGHT - breite,
      y: cursor.y - BODY_SIZE,
      size: BODY_SIZE,
      font,
      color: TEXT_COLOR,
    });
    cursor.y -= BODY_SIZE + BODY_LEADING;
  }

  cursor.y -= 20;

  /* Betreff. */
  drawWrapped(cursor, letter.subject, { size: BODY_SIZE + 1.5, bold: true });
  cursor.y -= 16;

  /* Brieftext. */
  drawBody(cursor, letter.body);

  /* Fusszeile auf jeder Seite — Erreichbarkeit gehört auf jedes Blatt. */
  if (profil) {
    const zeilen = footerLines(profil);
    if (zeilen.length > 0) {
      for (const seite of pdfDoc.getPages()) {
        seite.drawLine({
          start: { x: MARGIN_LEFT, y: MARGIN_BOTTOM - 10 },
          end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: MARGIN_BOTTOM - 10 },
          thickness: 0.5,
          color: RULE_COLOR,
        });
        let fussY = MARGIN_BOTTOM - 20;
        for (const zeile of zeilen) {
          seite.drawText(toPdfSafeText(zeile), {
            x: MARGIN_LEFT,
            y: fussY,
            size: 7,
            font,
            color: MUTED_COLOR,
          });
          fussY -= 9;
        }
      }
    }
  }

  return pdfDoc.save();
}
