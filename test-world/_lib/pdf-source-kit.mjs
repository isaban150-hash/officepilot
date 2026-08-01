/**
 * Shared drawing helpers for TestWorld gold source PDFs (A4, German office look).
 */
import { readFileSync, existsSync } from 'fs';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export const A4 = { w: 595.28, h: 841.89 };
export const MARGIN = 48;
export const COLORS = {
  ink: rgb(0.12, 0.14, 0.18),
  muted: rgb(0.35, 0.38, 0.42),
  line: rgb(0.78, 0.8, 0.84),
  accent: rgb(0.08, 0.35, 0.48),
  soft: rgb(0.94, 0.96, 0.97),
  danger: rgb(0.55, 0.12, 0.12),
  paper: rgb(1, 1, 1),
};

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/calibri.ttf',
  'C:/Windows/Fonts/segoeui.ttf',
];
const FONT_BOLD_CANDIDATES = [
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/calibrib.ttf',
  'C:/Windows/Fonts/segoeuib.ttf',
];

function firstExisting(paths) {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  throw new Error(`No usable TTF font found. Tried: ${paths.join(', ')}`);
}

export function loadFontBytes() {
  return {
    regular: readFileSync(firstExisting(FONT_CANDIDATES)),
    bold: readFileSync(firstExisting(FONT_BOLD_CANDIDATES)),
  };
}

export async function createDoc(fontBytes) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes.regular, { subset: true });
  const fontBold = await pdf.embedFont(fontBytes.bold, { subset: true });
  return { pdf, font, fontBold };
}

export function addPage(pdf) {
  return pdf.addPage([A4.w, A4.h]);
}

export function money(n) {
  return `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function addrBlock(entity) {
  const lines = [entity.name || entity.legalName || entity.tradeName];
  if (entity.contactPerson) lines.push(`z. Hd. ${entity.contactPerson}`);
  if (entity.street) lines.push(entity.street);
  if (entity.zip || entity.city) lines.push(`${entity.zip || ''} ${entity.city || ''}`.trim());
  return lines.filter(Boolean);
}

export function drawText(page, text, x, y, opts = {}) {
  const {
    font,
    size = 10,
    color = COLORS.ink,
    maxWidth,
  } = opts;
  const value = String(text ?? '');
  if (!value) return y;
  if (!maxWidth) {
    page.drawText(value, { x, y, size, font, color });
    return y;
  }
  const words = value.split(/\s+/);
  let line = '';
  let cursor = y;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      page.drawText(line, { x, y: cursor, size, font, color });
      cursor -= size + 3;
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    page.drawText(line, { x, y: cursor, size, font, color });
    cursor -= size + 3;
  }
  return cursor;
}

export function drawRight(page, text, rightX, y, opts = {}) {
  const { font, size = 10, color = COLORS.ink } = opts;
  const value = String(text ?? '');
  const w = font.widthOfTextAtSize(value, size);
  page.drawText(value, { x: rightX - w, y, size, font, color });
}

export function drawLine(page, x1, y, x2, color = COLORS.line, thickness = 0.8) {
  page.drawLine({
    start: { x: x1, y },
    end: { x: x2, y },
    thickness,
    color,
  });
}

export function drawLogoMark(page, x, y, label, fontBold) {
  page.drawRectangle({
    x,
    y: y - 18,
    width: 28,
    height: 28,
    color: COLORS.accent,
  });
  const initial = (label || 'X').trim().charAt(0).toUpperCase();
  page.drawText(initial, {
    x: x + 8,
    y: y - 10,
    size: 14,
    font: fontBold,
    color: COLORS.paper,
  });
}

export function drawIssuerHeader(page, issuer, fonts, subtitle) {
  const { font, fontBold } = fonts;
  let y = A4.h - MARGIN;
  drawLogoMark(page, MARGIN, y, issuer.name || issuer.legalName, fontBold);
  drawText(page, issuer.name || issuer.legalName || issuer.tradeName, MARGIN + 36, y - 2, {
    font: fontBold,
    size: 13,
    color: COLORS.accent,
  });
  y -= 18;
  if (subtitle) {
    drawText(page, subtitle, MARGIN + 36, y, { font, size: 9, color: COLORS.muted });
    y -= 12;
  }
  const meta = [
    issuer.street,
    `${issuer.zip || ''} ${issuer.city || ''}`.trim(),
    issuer.phone,
    issuer.email,
  ].filter(Boolean);
  drawText(page, meta.join(' · '), MARGIN + 36, y, {
    font,
    size: 8,
    color: COLORS.muted,
    maxWidth: A4.w - MARGIN * 2 - 36,
  });
  y -= 16;
  drawLine(page, MARGIN, y, A4.w - MARGIN, COLORS.accent, 1.4);
  return y - 18;
}

export function drawRecipient(page, lines, fonts, y) {
  const { font } = fonts;
  page.drawRectangle({
    x: MARGIN,
    y: y - 62,
    width: 260,
    height: 70,
    color: COLORS.soft,
  });
  let cursor = y - 14;
  for (const line of lines) {
    drawText(page, line, MARGIN + 10, cursor, { font, size: 10 });
    cursor -= 13;
  }
  return y - 82;
}

export function drawDocTitle(page, title, fonts, y, metaLines = []) {
  const { font, fontBold } = fonts;
  drawText(page, title, MARGIN, y, { font: fontBold, size: 16, color: COLORS.ink });
  let cursor = y - 18;
  for (const line of metaLines) {
    drawText(page, line, MARGIN, cursor, { font, size: 9, color: COLORS.muted });
    cursor -= 12;
  }
  return cursor - 8;
}

export function drawKV(page, rows, fonts, y, col = MARGIN) {
  const { font, fontBold } = fonts;
  let cursor = y;
  for (const [k, v] of rows) {
    drawText(page, k, col, cursor, { font: fontBold, size: 9, color: COLORS.muted });
    drawText(page, v, col + 130, cursor, { font, size: 9, color: COLORS.ink, maxWidth: 340 });
    cursor -= 14;
  }
  return cursor - 6;
}

export function drawTable(page, headers, rows, fonts, y, colWidths) {
  const { font, fontBold } = fonts;
  const startX = MARGIN;
  const tableW = colWidths.reduce((a, b) => a + b, 0);
  let cursor = y;

  page.drawRectangle({
    x: startX,
    y: cursor - 16,
    width: tableW,
    height: 20,
    color: COLORS.soft,
  });
  let x = startX + 4;
  headers.forEach((h, i) => {
    drawText(page, h, x, cursor - 11, { font: fontBold, size: 8, color: COLORS.muted });
    x += colWidths[i];
  });
  cursor -= 24;

  for (const row of rows) {
    x = startX + 4;
    let rowH = 14;
    row.forEach((cell, i) => {
      const before = cursor;
      const after = drawText(page, cell, x, cursor, {
        font,
        size: 8.5,
        color: COLORS.ink,
        maxWidth: colWidths[i] - 8,
      });
      rowH = Math.max(rowH, before - after + 4);
      x += colWidths[i];
    });
    cursor -= rowH;
    drawLine(page, startX, cursor + 4, startX + tableW, COLORS.line, 0.4);
    if (cursor < 90) break;
  }
  return cursor - 8;
}

export function drawTotals(page, lines, fonts, y) {
  const { font, fontBold } = fonts;
  const boxW = 220;
  const boxX = A4.w - MARGIN - boxW;
  let cursor = y;
  for (let i = 0; i < lines.length; i += 1) {
    const [label, value, strong] = lines[i];
    const f = strong ? fontBold : font;
    drawText(page, label, boxX, cursor, { font: f, size: strong ? 11 : 9 });
    drawRight(page, value, boxX + boxW, cursor, { font: f, size: strong ? 11 : 9 });
    cursor -= strong ? 16 : 13;
  }
  return cursor;
}

export function drawFooter(page, fonts, left, right) {
  const { font } = fonts;
  drawLine(page, MARGIN, 56, A4.w - MARGIN);
  drawText(page, left, MARGIN, 40, { font, size: 7.5, color: COLORS.muted, maxWidth: 340 });
  drawRight(page, right, A4.w - MARGIN, 40, { font, size: 7.5, color: COLORS.muted });
}

export function drawParagraphs(page, paragraphs, fonts, y, size = 10) {
  const { font } = fonts;
  let cursor = y;
  for (const p of paragraphs) {
    cursor = drawText(page, p, MARGIN, cursor, {
      font,
      size,
      color: COLORS.ink,
      maxWidth: A4.w - MARGIN * 2,
    });
    cursor -= 8;
  }
  return cursor;
}
