/**
 * TESTWORLD-ORDER-WITH-POSITIONS-01B — Quelldokument für DOC-00036.
 *
 * Ein Werkvertrag mit Leistungsverzeichnis. Er füllt eine Lücke, die beim
 * ersten Rechnungs-E2E sichtbar wurde: Kein bestehender Goldfall trägt
 * Auftragspositionen, und ohne Positionen gibt es nichts abzurechnen.
 *
 * ⚠️ Der Fall ist bewusst der Normalfall, nicht der Grenzfall: drei saubere
 * Arbeitspositionen, unterstützte Einheiten, stimmige Multiplikation. Kein
 * Material, kein §13b, kein Prüfbedarf, kein Mehrzeilenblock. Sonderfälle
 * gehören in eigene Fälle — hier soll ein einziges Merkmal beweisbar sein:
 * dass ein realistisches Vertragsdokument durch den echten Extraktor
 * brauchbare Positionsvorschläge liefert.
 *
 * Das Zeilenformat ist nicht frei gewählt, sondern das vom Produkt gelesene:
 * `LV_STANDARD_ROW` in `billOfQuantitiesExtractionService` erwartet
 * Positionsnummer, Menge, Einheit, Beschreibung, Einzelpreis, Gesamtpreis in
 * genau dieser Reihenfolge auf **einer** Zeile. Die Tabellenhilfe des
 * PDF-Kits erzeugt je Zeile genau einen Textabschnitt, sodass die
 * Textextraktion sie wieder als eine Zeile zurückgibt.
 *
 * Firmen- und Kundendaten stammen aus der Testwelt, nicht aus diesem Skript —
 * eine zweite Kopie derselben Stammdaten würde beim nächsten Update lautlos
 * veralten.
 *
 * Aufruf: node test-world/_lib/seed-05a-doc00036.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  MARGIN,
  A4,
  loadFontBytes,
  createDoc,
  addPage,
  money,
  fmtDate,
  addrBlock,
  drawIssuerHeader,
  drawRecipient,
  drawDocTitle,
  drawKV,
  drawTable,
  drawTotals,
  drawFooter,
  drawParagraphs,
} from './pdf-source-kit.mjs';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_ID = 'DOC-00036';

/** Clean scan JPG from PDF text layer (avoids pdfjs font glyph paint issues). */
async function renderJpgFromPdf(pdfBytes, outPath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const scale = 2.2;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  // Slight off-white paper + soft edge (scan feel, still clean).
  ctx.fillStyle = '#f3f4f6';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(10, 10, canvas.width - 20, canvas.height - 20);
  ctx.strokeStyle = '#d7dbe2';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

  const text = await page.getTextContent();
  for (const item of text.items) {
    if (!item.str?.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const fontSize = Math.max(9, Math.hypot(tx[0], tx[1]));
    const x = tx[4];
    const y = tx[5];
    ctx.fillStyle = '#1c2430';
    ctx.font = `${item.fontName?.includes('Bold') || fontSize > 14 ? 'bold ' : ''}${fontSize}px Arial`;
    ctx.fillText(item.str, x, y);
  }
  writeFileSync(outPath, canvas.toBuffer('image/jpeg', 0.93));
}

const company = JSON.parse(readFileSync(join(root, 'companies', 'COMPANY-001.json'), 'utf8'));
/*
 * Ein Kunde ohne bestehendes Projekt: So bleibt der Fallabgleich eindeutig
 * (kein Treffer), und der Fall bildet genau die Lage ab, die der spätere
 * Browsertest braucht — ein neuer Auftrag für einen noch unbekannten Kunden.
 */
const customer = JSON.parse(readFileSync(join(root, 'customers', 'CUST-015.json'), 'utf8'));

/** Vertragsdaten des Falls. Rein synthetisch, deterministisch, ohne Zufall. */
const CONTRACT = {
  number: 'WV-2026-0036',
  date: '2026-02-09',
  serviceFrom: '2026-03-02',
  serviceTo: '2026-04-17',
  site: 'Sanierung Heizungsanlage, Bestandsgebäude',
};

/**
 * Drei Arbeitspositionen. Einheiten ausschliesslich aus dem Vokabular, das
 * `orderUnitMapper` sicher auflöst; Gesamtpreis exakt Menge × Einzelpreis,
 * damit keine Position als prüfbedürftig gilt.
 */
const POSITIONS = [
  { no: '01', qty: 96, unit: 'm²', text: 'Altbelag aufnehmen und Untergrund für Rohrführung vorbereiten', unitPrice: 12.5 },
  { no: '02', qty: 148, unit: 'm', text: 'Heizungsrohrleitung verlegen, dämmen und dicht anschliessen', unitPrice: 34.8 },
  { no: '03', qty: 42, unit: 'Std', text: 'Demontage Altanlage und fachgerechte Entsorgung durch Fachpersonal', unitPrice: 68.0 },
];

function deQuantity(value) {
  return value.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Cent-genau, damit die Mathematikprüfung des Extraktors zufrieden ist. */
function lineTotal(position) {
  return Math.round(position.qty * position.unitPrice * 100) / 100;
}

async function build() {
  const fontBytes = loadFontBytes();
  const { pdf, font, fontBold } = await createDoc(fontBytes);
  const fonts = { font, fontBold };
  const page = addPage(pdf);

  const issuer = {
    name: company.legalName,
    street: company.street,
    zip: company.zip,
    city: company.city,
    phone: company.phone,
    email: company.email,
  };

  let y = drawIssuerHeader(page, issuer, fonts, 'Auftragnehmer');
  y = drawRecipient(page, ['Auftraggeber:', ...addrBlock(customer)], fonts, y);

  y = drawDocTitle(page, 'Werkvertrag', fonts, y, [
    `Vertragsnummer ${CONTRACT.number} · Vertragsdatum ${fmtDate(CONTRACT.date)}`,
  ]);

  y = drawKV(
    page,
    [
      ['Auftragnehmer', `${company.legalName}, USt-IdNr. ${company.vatId}`],
      ['Auftraggeber', customer.name],
      ['Bauvorhaben', CONTRACT.site],
      ['Ausführungszeitraum', `${fmtDate(CONTRACT.serviceFrom)} bis ${fmtDate(CONTRACT.serviceTo)}`],
    ],
    fonts,
    y,
  );

  y = drawParagraphs(
    page,
    [
      'Der Auftragnehmer übernimmt die nachstehend im Leistungsverzeichnis aufgeführten Werkleistungen. Die Vergütung erfolgt nach tatsächlich erbrachter Leistung auf Grundlage der vereinbarten Einheitspreise.',
    ],
    fonts,
    y - 4,
    9,
  );

  /*
   * Spaltenreihenfolge Pos · Menge · Einheit · Leistung · EP · GP — genau die
   * Reihenfolge, die der Produktextraktor liest. Eine hübschere Anordnung wäre
   * für ihn unlesbar, und der Fall wäre wertlos.
   */
  const rows = POSITIONS.map((position) => [
    position.no,
    deQuantity(position.qty),
    position.unit,
    position.text,
    money(position.unitPrice),
    money(lineTotal(position)),
  ]);

  y = drawTable(
    page,
    ['Pos.', 'Menge', 'Einheit', 'Leistung', 'Einzelpreis', 'Gesamtpreis'],
    rows,
    fonts,
    y - 6,
    [30, 46, 44, 220, 78, 81],
  );

  const net = POSITIONS.reduce((sum, position) => sum + lineTotal(position), 0);
  const tax = Math.round(net * 0.19 * 100) / 100;

  y = drawTotals(
    page,
    [
      ['Nettosumme', money(net)],
      ['zzgl. 19 % USt.', money(tax)],
      ['Auftragssumme brutto', money(Math.round((net + tax) * 100) / 100), true],
    ],
    fonts,
    y - 6,
  );

  drawParagraphs(
    page,
    [
      'Abschlagsrechnungen sind nach Leistungsstand zulässig. Die Schlussrechnung erfolgt nach Abnahme der Gesamtleistung.',
      'Zahlungsbedingungen gemäss den Angaben des Auftragnehmers. Mehr- oder Mindermengen werden nach den vereinbarten Einheitspreisen abgerechnet.',
    ],
    fonts,
    y - 10,
    9,
  );

  drawFooter(
    page,
    fonts,
    `${company.legalName} · ${company.street} · ${company.zip} ${company.city}`,
    `Steuernummer ${company.taxNumber}`,
  );

  const outDir = join(root, 'documents', DOC_ID);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  /* Einmal erzeugen, zweimal verwenden — PDF und Scanbild sind derselbe Beleg. */
  const pdfBytes = await pdf.save();
  writeFileSync(join(outDir, 'source.pdf'), pdfBytes);
  await renderJpgFromPdf(pdfBytes, join(outDir, 'source.jpg'));

  /* Nur Struktur, keine Werte — dasselbe Prinzip wie in den Berichten. */
  console.log(
    `${DOC_ID}: source.pdf + source.jpg geschrieben, ${POSITIONS.length} LV-Zeilen, 1 Seite.`,
  );
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
