/**
 * TESTWORLD-IMPLEMENTATION-04A — realistic source.pdf + source.jpg for 35 gold docs.
 * Usage: node test-world/_lib/seed-04a-sources.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  A4,
  MARGIN,
  COLORS,
  loadFontBytes,
  createDoc,
  addPage,
  money,
  fmtDate,
  addrBlock,
  drawText,
  drawRight,
  drawLine,
  drawIssuerHeader,
  drawRecipient,
  drawDocTitle,
  drawKV,
  drawTable,
  drawTotals,
  drawFooter,
  drawParagraphs,
  drawLogoMark,
} from './pdf-source-kit.mjs';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadMap(dir) {
  const map = new Map();
  for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.json'))) {
    const row = JSON.parse(readFileSync(join(root, dir, file), 'utf8'));
    map.set(row.id, row);
  }
  return map;
}

const company = JSON.parse(readFileSync(join(root, 'companies', 'COMPANY-001.json'), 'utf8'));
const customers = loadMap('customers');
const suppliers = loadMap('suppliers');
const employees = loadMap('employees');
const vehicles = loadMap('vehicles');
const projects = loadMap('projects');

function cirmakIssuer() {
  return {
    name: company.legalName,
    street: company.street,
    zip: company.zip,
    city: company.city,
    phone: company.phone,
    email: company.email,
    vatId: company.vatId,
    taxNumber: company.taxNumber,
    iban: company.iban,
    bic: company.bic,
    bankName: company.bankName,
  };
}

function siteOf(project) {
  if (!project) return '';
  return `${project.siteStreet || ''}, ${project.siteZip || ''} ${project.siteCity || ''}`.replace(
    /^, /,
    '',
  );
}

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

function finishPage(page, fonts, left, right = 'Seite 1 / 1') {
  drawFooter(page, fonts, left, right);
}

/** @type {Record<string, (ctx: any) => Promise<Uint8Array>>} */
const builders = {};

builders['DOC-00001'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const cust = customers.get('CUST-001');
  const prj = projects.get('PRJ-001');
  let y = drawIssuerHeader(page, cirmakIssuer(), F, 'SHK · Werkverträge');
  y = drawRecipient(page, addrBlock(cust), F, y);
  y = drawDocTitle(page, 'Werkvertrag', F, y, [
    `Vertragsnr. WV-2025-0912 · Datum ${fmtDate('2025-09-12')}`,
    `Bauvorhaben: ${prj.title}`,
    `Baustelle: ${siteOf(prj)}`,
  ]);
  y = drawParagraphs(
    page,
    [
      `Zwischen der ${company.legalName}, ${company.street}, ${company.zip} ${company.city} (Auftragnehmer) und der ${cust.name}, ${cust.street}, ${cust.zip} ${cust.city} (Auftraggeber), vertreten durch ${cust.contactPerson}, wird folgender Werkvertrag geschlossen.`,
      '§ 1 Vertragsgegenstand — Der Auftragnehmer errichtet die Heizzentrale inkl. Rohrleitungen, Regelung und Inbetriebnahme gemäß Leistungsverzeichnis.',
      '§ 2 Vergütung — Pauschalpreis netto 186.400,00 € zuzüglich gesetzlicher Umsatzsteuer.',
      '§ 3 Ausführungszeit — Beginn 01.09.2025, Fertigstellung 30.06.2026.',
      '§ 4 Gewährleistung — 5 Jahre ab Abnahme gemäß VOB/B, ergänzend BGB.',
    ],
    F,
    y,
  );
  y = drawTable(
    page,
    ['Pos.', 'Leistung', 'Menge', 'EP', 'GP'],
    [
      ['1', 'Heizzentrale komplette Installation', '1 psch', money(142000), money(142000)],
      ['2', 'Regelungstechnik und Inbetriebnahme', '1 psch', money(28400), money(28400)],
      ['3', 'Dokumentation / Einweisung', '1 psch', money(16000), money(16000)],
    ],
    F,
    y - 4,
    [36, 250, 70, 70, 70],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(186400)],
      ['USt 19 %', money(35416)],
      ['Brutto', money(221816), true],
    ],
    F,
    y,
  );
  drawText(page, `Ansprechpartner Auftragnehmer: ${employees.get('EMP-001').firstName} ${employees.get('EMP-001').lastName} (GF)`, MARGIN, y - 24, {
    font,
    size: 9,
  });
  drawText(page, `Polier vor Ort: ${employees.get('EMP-003').firstName} ${employees.get('EMP-003').lastName}`, MARGIN, y - 38, {
    font,
    size: 9,
  });
  finishPage(page, F, `${company.legalName} · ${company.commercialRegister} · USt-Id ${company.vatId}`);
  return pdf.save();
};

builders['DOC-00002'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const cust = customers.get('CUST-005');
  const prj = projects.get('PRJ-005');
  let y = drawIssuerHeader(page, cirmakIssuer(), F, 'Angebot');
  y = drawRecipient(page, addrBlock(cust), F, y);
  y = drawDocTitle(page, 'Angebot Nr. ANG-2026-0308', F, y, [
    `Datum ${fmtDate('2026-03-08')} · gültig bis ${fmtDate('2026-04-08')}`,
    `Projekt: ${prj.title} · ${siteOf(prj)}`,
  ]);
  y = drawParagraphs(
    page,
    [
      `Sehr geehrte Damen und Herren,`,
      `für die Sanitäre Modernisierung im Objekt ${prj.title} unterbreiten wir folgendes Angebot:`,
    ],
    F,
    y,
  );
  y = drawTable(
    page,
    ['Pos.', 'Beschreibung', 'Menge', 'EP', 'GP'],
    [
      ['1', 'Badkomplettsanierung WE 1–4', '4 Stk', money(6850), money(27400)],
      ['2', 'Steigleitungen Kupfer erneuern', '1 psch', money(9200), money(9200)],
      ['3', 'Entwässerung / Revision', '1 psch', money(4100), money(4100)],
    ],
    F,
    y,
    [36, 250, 70, 70, 70],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(40700)],
      ['USt 19 %', money(7733)],
      ['Brutto', money(48433), true],
    ],
    F,
    y,
  );
  drawText(page, `Bearbeiter: ${employees.get('EMP-002').firstName} ${employees.get('EMP-002').lastName}`, MARGIN, y - 20, {
    font,
    size: 9,
  });
  finishPage(page, F, `${company.legalName} · Tel. ${company.phone}`);
  return pdf.save();
};

builders['DOC-00003'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const sup = suppliers.get('SUP-001');
  const cust = customers.get('CUST-001');
  const prj = projects.get('PRJ-001');
  let y = drawIssuerHeader(page, sup, F, 'Großhandel SHK');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Rechnung RE-2026-11842', F, y, [
    `Datum ${fmtDate('2026-01-20')} · Kunden-Nr. C-88421 · Lieferschein LS-11840`,
    `Ihre Baustelle: ${prj.title}`,
  ]);
  y = drawKV(
    page,
    [
      ['Auftraggeber vor Ort', cust.name],
      ['Lieferadresse', siteOf(prj)],
      ['Zahlungsziel', '14 Tage netto'],
    ],
    F,
    y,
  );
  y = drawTable(
    page,
    ['Art.-Nr.', 'Bezeichnung', 'Menge', 'EP', 'GP'],
    [
      ['HZ-4410', 'Pumpengruppe DN32', '2 Stk', money(418.5), money(837)],
      ['RO-2201', 'Kupferrohr 22×1,0', '48 m', money(12.4), money(595.2)],
      ['FT-0890', 'Pressfittinge Sortiment', '1 Set', money(286.3), money(286.3)],
    ],
    F,
    y,
    [70, 216, 70, 70, 70],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(1718.5)],
      ['USt 19 %', money(326.52)],
      ['Brutto', money(2045.02), true],
    ],
    F,
    y,
  );
  finishPage(page, F, `${sup.name} · ${sup.city}`);
  return pdf.save();
};

builders['DOC-00004'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const cust = customers.get('CUST-001');
  const prj = projects.get('PRJ-001');
  let y = drawIssuerHeader(page, cirmakIssuer(), F, 'Ausgangsrechnung');
  y = drawRecipient(page, addrBlock(cust), F, y);
  y = drawDocTitle(page, 'Abschlagsrechnung Nr. AR-2026-0028', F, y, [
    `Datum ${fmtDate('2026-02-28')} · zu Werkvertrag WV-2025-0912`,
    `Projekt: ${prj.title}`,
  ]);
  y = drawTable(
    page,
    ['Pos.', 'Bezeichnung', 'Anteil', 'Betrag'],
    [
      ['1', '1. Abschlag gemäß Zahlungsplan (30 %)', '30 %', money(55920)],
      ['2', 'abzgl. Sicherheitseinbehalt 5 %', '', money(-2796)],
    ],
    F,
    y,
    [40, 320, 70, 80],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(53124)],
      ['USt 19 %', money(10093.56)],
      ['Brutto fällig', money(63217.56), true],
    ],
    F,
    y,
  );
  drawText(page, `Bitte überweisen auf ${company.iban} · ${company.bankName}`, MARGIN, y - 20, {
    font,
    size: 9,
    color: COLORS.muted,
  });
  finishPage(page, F, `${company.legalName} · Steuernummer ${company.taxNumber}`);
  return pdf.save();
};

builders['DOC-00005'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const sup = suppliers.get('SUP-002');
  const prj = projects.get('PRJ-001');
  let y = drawIssuerHeader(page, { ...sup, phone: '+49 5261 900-0' }, F, 'Lieferschein');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Lieferschein LS-2026-441', F, y, [
    `Lieferdatum ${fmtDate('2026-01-18')} · Bestellung PO-2026-014`,
    `Baustelle: ${prj.title} · ${siteOf(prj)}`,
  ]);
  y = drawTable(
    page,
    ['Pos.', 'Artikel', 'Menge', 'Einheit'],
    [
      ['1', 'Waschtischarmatur chrom', '6', 'Stk'],
      ['2', 'UP-Spülkasten 6–9 l', '4', 'Stk'],
      ['3', 'Ablaufgarnitur DN50', '8', 'Stk'],
    ],
    F,
    y,
    [40, 320, 70, 70],
  );
  drawText(page, `Empfangen: ${employees.get('EMP-003').firstName} ${employees.get('EMP-003').lastName} (Polier)`, MARGIN, y - 10, {
    font,
    size: 9,
  });
  finishPage(page, F, `${sup.name}`);
  return pdf.save();
};

builders['DOC-00006'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const sup = suppliers.get('SUP-005');
  const veh = vehicles.get('VEH-001');
  const emp = employees.get('EMP-003');
  let y = drawIssuerHeader(page, { name: sup.name, street: sup.street, zip: sup.zip, city: sup.city }, F, 'Tankstelle');
  y = drawDocTitle(page, 'Kundenbeleg / Tankbeleg', F, y - 10, [
    `Datum ${fmtDate('2026-02-10')} · Beleg 884421`,
    `Kennzeichen ${veh.licensePlate} · Fahrer ${emp.firstName} ${emp.lastName}`,
  ]);
  y = drawTable(
    page,
    ['Produkt', 'Menge', 'EP', 'Betrag'],
    [
      ['Diesel', '52,40 l', '1,689 €/l', money(88.5)],
      ['AdBlue', '5,00 l', '0,890 €/l', money(4.45)],
    ],
    F,
    y,
    [180, 100, 100, 100],
  );
  y = drawTotals(page, [['Brutto inkl. MwSt', money(92.95), true]], F, y);
  drawText(page, 'Kartenzahlung · Vielen Dank!', MARGIN, y - 16, { font, size: 9, color: COLORS.muted });
  finishPage(page, F, `${sup.name} · ${sup.city}`);
  return pdf.save();
};

builders['DOC-00007'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const hotel = suppliers.get('SUP-006');
  const emp = employees.get('EMP-004');
  let y = drawIssuerHeader(page, hotel, F, 'Hotelrechnung');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Hotelrechnung Nr. H-2026-0125', F, y, [
    `Aufenthalt 24.–25.01.2026 · Gast ${emp.firstName} ${emp.lastName}`,
  ]);
  y = drawTable(
    page,
    ['Leistung', 'Nächte', 'EP', 'Betrag'],
    [
      ['EZ Komfort inkl. Frühstück', '1', money(98), money(98)],
      ['Kurtaxe', '1', money(3.5), money(3.5)],
      ['Parkplatz', '1', money(8), money(8)],
    ],
    F,
    y,
    [260, 70, 80, 80],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(92.02)],
      ['USt 7 %', money(6.44)],
      ['USt 19 %', money(11.04)],
      ['Brutto', money(109.5), true],
    ],
    F,
    y,
  );
  finishPage(page, F, `${hotel.name}`);
  return pdf.save();
};

function authorityLetter(fonts, { issuer, title, date, body, ref, amount }) {
  return (async () => {
    const { pdf, font, fontBold } = await createDoc(fonts);
    const page = addPage(pdf);
    const F = { font, fontBold };
    let y = drawIssuerHeader(page, issuer, F, 'Behördenschreiben');
    y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
    y = drawDocTitle(page, title, F, y, [`Datum ${fmtDate(date)}${ref ? ` · Az. ${ref}` : ''}`]);
    y = drawParagraphs(page, body, F, y);
    if (amount != null) {
      y = drawTotals(page, [['Forderung / Beitrag', money(amount), true]], F, y - 8);
    }
    finishPage(page, F, `${issuer.name}`);
    return pdf.save();
  })();
}

builders['DOC-00008'] = async ({ fonts }) =>
  authorityLetter(fonts, {
    issuer: suppliers.get('SUP-011'),
    title: 'Erinnerung Umsatzsteuer-Voranmeldung',
    date: '2026-03-01',
    ref: '305/5803/1234-USt',
    body: [
      'Sehr geehrte Damen und Herren,',
      'für den Voranmeldungszeitraum Januar 2026 liegt uns noch keine Umsatzsteuer-Voranmeldung vor. Bitte reichen Sie diese innerhalb von 10 Tagen elektronisch ein.',
      'Bei Fragen wenden Sie sich an das Finanzamt Detmold, Team USt.',
    ],
  });

builders['DOC-00009'] = async ({ fonts }) =>
  authorityLetter(fonts, {
    issuer: suppliers.get('SUP-012'),
    title: 'Beitragsbescheid BG BAU',
    date: '2026-02-15',
    ref: company.bgBauMemberNumber,
    amount: 4280.4,
    body: [
      'Sehr geehrte Damen und Herren,',
      'auf Grundlage der Lohnsummenmeldung setzen wir den Beitrag für das Beitragsjahr 2025 fest.',
      'Bitte überweisen Sie den Betrag unter Angabe der Mitgliedsnummer.',
    ],
  });

builders['DOC-00010'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  page.drawRectangle({ x: 0, y: 0, width: A4.w, height: A4.h, color: rgbSoft() });
  drawLogoMark(page, MARGIN, A4.h - 60, 'W', fontBold);
  drawText(page, 'Werkzeugkatalog Frühjahr 2026', MARGIN + 40, A4.h - 70, {
    font: fontBold,
    size: 20,
    color: COLORS.accent,
  });
  drawText(page, 'Prospekt — keine Rechnung · keine Verpflichtung', MARGIN + 40, A4.h - 92, {
    font,
    size: 10,
    color: COLORS.muted,
  });
  drawParagraphs(
    page,
    [
      'Neu im Sortiment: Akku-Schlagschrauber, Rohrschneider-Sets und Pressbacken für SHK-Betriebe.',
      'Jetzt blättern — unverbindliche Produktübersicht für Handwerksbetriebe in OWL.',
    ],
    F,
    A4.h - 140,
    11,
  );
  finishPage(page, F, 'Werbung / Katalogbeilage');
  return pdf.save();
};

function rgbSoft() {
  return COLORS.soft;
}

builders['DOC-00011'] = async ({ fonts }) =>
  authorityLetter(fonts, {
    issuer: suppliers.get('SUP-014'),
    title: 'Beitragsnachweis Arbeitgeber',
    date: '2026-03-05',
    ref: 'BN-2026-03-Cirmak',
    amount: 6120.15,
    body: [
      'Sehr geehrte Damen und Herren,',
      'anbei der Beitragsnachweis für den Abrechnungsmonat Februar 2026. Bitte prüfen Sie die gemeldeten Beschäftigten.',
    ],
  });

builders['DOC-00012'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const stb = suppliers.get('SUP-016');
  let y = drawIssuerHeader(page, stb, F, 'Steuerberatung');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Honorarrechnung StB-2026-041', F, y, [`Datum ${fmtDate('2026-04-02')}`]);
  y = drawTable(
    page,
    ['Pos.', 'Leistung', 'Betrag'],
    [
      ['1', 'Laufende Buchführung Q1/2026', money(980)],
      ['2', 'USt-VA Januar–März 2026', money(240)],
      ['3', 'Lohnabrechnung Feb. 2026 (10 MA)', money(320)],
    ],
    F,
    y,
    [40, 360, 100],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(1540)],
      ['USt 19 %', money(292.6)],
      ['Brutto', money(1832.6), true],
    ],
    F,
    y,
  );
  finishPage(page, F, stb.name);
  return pdf.save();
};

builders['DOC-00013'] = async ({ fonts }) =>
  authorityLetter(fonts, {
    issuer: suppliers.get('SUP-016'),
    title: 'Checkliste Unterlagen Jahresabschluss 2025',
    date: '2026-03-18',
    ref: 'JA-2025-Cirmak',
    body: [
      'Sehr geehrter Herr Cirmak,',
      'für den Jahresabschluss 2025 benötigen wir: Anlagenverzeichnis, offene Posten per 31.12., Inventurlisten sowie Kontoauszüge Dezember.',
      'Bitte bis 15.04.2026 bereitstellen.',
    ],
  });

function utilityBill(fonts, { title, date, zähler, verbrauch, netto }) {
  return (async () => {
    const { pdf, font, fontBold } = await createDoc(fonts);
    const page = addPage(pdf);
    const F = { font, fontBold };
    const sw = suppliers.get('SUP-007');
    let y = drawIssuerHeader(page, sw, F, 'Energie / Versorgung');
    y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
    y = drawDocTitle(page, title, F, y, [`Datum ${fmtDate(date)} · Kundenkonto 32105-88421`]);
    y = drawKV(
      page,
      [
        ['Zählernummer', zähler],
        ['Verbrauch', verbrauch],
        ['Lieferstelle', `${company.street}, ${company.zip} ${company.city}`],
      ],
      F,
      y,
    );
    y = drawTotals(
      page,
      [
        ['Netto', money(netto)],
        ['USt', money(netto * 0.19)],
        ['Brutto', money(netto * 1.19), true],
      ],
      F,
      y,
    );
    finishPage(page, F, sw.name);
    return pdf.save();
  })();
}

builders['DOC-00014'] = async ({ fonts }) =>
  utilityBill(fonts, {
    title: 'Stromrechnung 02/2026',
    date: '2026-02-12',
    zähler: '1STR88421001',
    verbrauch: '4.820 kWh',
    netto: 1124.6,
  });
builders['DOC-00015'] = async ({ fonts }) =>
  utilityBill(fonts, {
    title: 'Gasrechnung 02/2026',
    date: '2026-02-12',
    zähler: '1GAS88421002',
    verbrauch: '1.960 kWh',
    netto: 286.4,
  });
builders['DOC-00016'] = async ({ fonts }) =>
  utilityBill(fonts, {
    title: 'Wasser-/Abwasserrechnung 02/2026',
    date: '2026-02-14',
    zähler: '1WAS88421003',
    verbrauch: '38 m³',
    netto: 142.8,
  });

builders['DOC-00017'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const tel = suppliers.get('SUP-008');
  const emp = employees.get('EMP-003');
  let y = drawIssuerHeader(page, { name: tel.name, city: tel.city }, F, 'Mobilfunk');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Mobilfunkrechnung 03/2026', F, y, [`Datum ${fmtDate('2026-03-03')}`]);
  y = drawTable(
    page,
    ['Rufnummer', 'Tarif / Nutzer', 'Betrag'],
    [
      ['0151 88421001', `Business M · ${emp.firstName} ${emp.lastName}`, money(39.95)],
      ['0151 88421002', 'Business M · Pool', money(39.95)],
      ['0151 88421003', 'Business M · Pool', money(39.95)],
    ],
    F,
    y,
    [130, 280, 90],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(100.63)],
      ['USt 19 %', money(19.12)],
      ['Brutto', money(119.75), true],
    ],
    F,
    y,
  );
  finishPage(page, F, tel.name);
  return pdf.save();
};

builders['DOC-00018'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const tel = suppliers.get('SUP-008');
  let y = drawIssuerHeader(page, { name: tel.name, city: tel.city }, F, 'Festnetz / Internet');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Rechnung Internet & Festnetz', F, y, [`Datum ${fmtDate('2026-03-03')}`]);
  y = drawTable(
    page,
    ['Leistung', 'Zeitraum', 'Betrag'],
    [
      ['Company Flex 250 MBit', '01.–29.02.2026', money(69.95)],
      ['Nebenstellenanlage SIP', '01.–29.02.2026', money(24.95)],
    ],
    F,
    y,
    [260, 140, 90],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(79.75)],
      ['USt 19 %', money(15.15)],
      ['Brutto', money(94.9), true],
    ],
    F,
    y,
  );
  finishPage(page, F, tel.name);
  return pdf.save();
};

builders['DOC-00019'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const ins = suppliers.get('SUP-009');
  const veh = vehicles.get('VEH-002');
  let y = drawIssuerHeader(page, ins, F, 'Kfz-Versicherung');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Beitragsrechnung Kfz-Versicherung', F, y, [
    `Datum ${fmtDate('2026-01-08')} · Kennzeichen ${veh.licensePlate}`,
    `${veh.make} ${veh.model} · ${veh.label}`,
  ]);
  y = drawKV(
    page,
    [
      ['Versicherungsschein', 'VHV-KFZ-88421-02'],
      ['Deckungen', 'Vollkasko, Haftpflicht, Schutzbrief'],
      ['Zeitraum', '01.01.2026 – 31.12.2026'],
    ],
    F,
    y,
  );
  y = drawTotals(page, [['Jahresbeitrag brutto', money(1684), true]], F, y);
  finishPage(page, F, ins.name);
  return pdf.save();
};

builders['DOC-00020'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const ins = suppliers.get('SUP-009');
  let y = drawIssuerHeader(page, ins, F, 'Gewerbeversicherung');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Betriebshaftpflicht — Beitragsrechnung', F, y, [
    `Datum ${fmtDate('2026-01-15')} · Police VHV-BH-77412`,
  ]);
  y = drawParagraphs(
    page,
    [
      'Versichert ist die betriebliche Haftpflicht für Heizungs-, Sanitär- und Klimatechnik inkl. erweiterter Produkthaftpflicht.',
      'Beitrag für das Versicherungsjahr 2026:',
    ],
    F,
    y,
  );
  y = drawTotals(page, [['Jahresbeitrag brutto', money(2148.6), true]], F, y);
  finishPage(page, F, ins.name);
  return pdf.save();
};

builders['DOC-00021'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const leasing = suppliers.get('SUP-010');
  const veh = vehicles.get('VEH-003');
  let y = drawIssuerHeader(page, { name: leasing.name, city: leasing.city }, F, 'Fuhrparkleasing');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Leasingvertrag / Vertragsübersicht', F, y, [
    `Datum ${fmtDate('2025-11-20')} · Vertrag LV-OWL-55301`,
    `Fahrzeug: ${veh.make} ${veh.model} · ${veh.licensePlate}`,
  ]);
  y = drawKV(
    page,
    [
      ['Laufzeit', '48 Monate'],
      ['km/Jahr', '30.000'],
      ['Monatliche Rate netto', money(489)],
      ['Sonderzahlung', money(2500)],
    ],
    F,
    y,
  );
  finishPage(page, F, leasing.name);
  return pdf.save();
};

builders['DOC-00022'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const shop = suppliers.get('SUP-024');
  const veh = vehicles.get('VEH-001');
  let y = drawIssuerHeader(page, shop, F, 'Prüfbericht');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'HU / AU Prüfbericht', F, y, [
    `Prüfdatum ${fmtDate('2026-02-20')} · ${veh.licensePlate}`,
  ]);
  y = drawKV(
    page,
    [
      ['Fahrzeug', `${veh.make} ${veh.model}`],
      ['Ergebnis HU', 'ohne Mangel bestanden'],
      ['Ergebnis AU', 'bestanden'],
      ['Nächste HU', '02/2028'],
    ],
    F,
    y,
  );
  y = drawTotals(page, [['Prüfgebühr brutto', money(148.5), true]], F, y);
  finishPage(page, F, shop.name);
  return pdf.save();
};

builders['DOC-00023'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const shop = suppliers.get('SUP-024');
  const veh = vehicles.get('VEH-004');
  let y = drawIssuerHeader(page, shop, F, 'Werkstattrechnung');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Rechnung WR-2026-0222', F, y, [
    `Datum ${fmtDate('2026-02-22')} · ${veh.licensePlate} · ${veh.label}`,
  ]);
  y = drawTable(
    page,
    ['Pos.', 'Leistung / Teile', 'Betrag'],
    [
      ['1', 'Bremsbeläge Vorderachse inkl. Montage', money(286)],
      ['2', 'Bremsscheiben Vorderachse', money(214)],
      ['3', 'Verschleißprüfung / Probefahrt', money(48)],
    ],
    F,
    y,
    [40, 380, 90],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(548)],
      ['USt 19 %', money(104.12)],
      ['Brutto', money(652.12), true],
    ],
    F,
    y,
  );
  finishPage(page, F, shop.name);
  return pdf.save();
};

builders['DOC-00024'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const emp = employees.get('EMP-007');
  let y = drawIssuerHeader(page, cirmakIssuer(), F, 'Personal');
  y = drawDocTitle(page, 'Arbeitsvertrag', F, y - 20, [
    `Datum ${fmtDate('2025-08-01')} · Mitarbeiter ${emp.firstName} ${emp.lastName}`,
  ]);
  y = drawParagraphs(
    page,
    [
      `Zwischen ${company.legalName} und ${emp.firstName} ${emp.lastName} wird ein unbefristetes Arbeitsverhältnis als Monteur SHK geschlossen.`,
      'Beginn: 01.08.2025. Wochenarbeitszeit: 39 Stunden. Probezeit: 6 Monate.',
      'Vergütung: 3.450,00 € brutto monatlich zuzüglich vermögenswirksamer Leistungen.',
      'Einsatzort: Betriebssitz Bad Salzuflen sowie Baustellen der Gesellschaft, u. a. OWL.',
    ],
    F,
    y,
  );
  finishPage(page, F, `${company.legalName} · Personalakte`);
  return pdf.save();
};

builders['DOC-00025'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const emp = employees.get('EMP-004');
  const aok = suppliers.get('SUP-014');
  let y = drawIssuerHeader(page, { name: 'Arbeitsunfähigkeitsbescheinigung', city: 'Lemgo' }, F, 'eAU');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Krankmeldung / AU', F, y, [`Ausgestellt ${fmtDate('2026-03-10')}`]);
  y = drawKV(
    page,
    [
      ['Versicherter', `${emp.firstName} ${emp.lastName}`],
      ['Krankenkasse', aok.name],
      ['arbeitsunfähig seit', '10.03.2026'],
      ['voraussichtlich bis', '14.03.2026'],
      ['Erstbescheinigung', 'ja'],
    ],
    F,
    y,
  );
  finishPage(page, F, 'Muster-eAU TestWorld');
  return pdf.save();
};

builders['DOC-00026'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const emp = employees.get('EMP-005');
  let y = drawIssuerHeader(page, cirmakIssuer(), F, 'Personal · Urlaub');
  y = drawDocTitle(page, 'Urlaubsantrag', F, y - 20, [`Eingang ${fmtDate('2026-03-01')}`]);
  y = drawKV(
    page,
    [
      ['Mitarbeiter', `${emp.firstName} ${emp.lastName}`],
      ['Zeitraum', '14.07.2026 – 25.07.2026'],
      ['Arbeitstage', '10'],
      ['Resturlaub vorher', '22 Tage'],
      ['Genehmigung', 'erteilt durch EMP-001'],
    ],
    F,
    y,
  );
  finishPage(page, F, company.legalName);
  return pdf.save();
};

builders['DOC-00027'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const emp = employees.get('EMP-002');
  const stb = suppliers.get('SUP-016');
  let y = drawIssuerHeader(page, { name: company.legalName, street: company.street, zip: company.zip, city: company.city }, F, 'Gehaltsabrechnung');
  y = drawDocTitle(page, 'Lohnabrechnung Februar 2026', F, y - 10, [
    `${emp.firstName} ${emp.lastName} · erstellt über ${stb.name}`,
  ]);
  y = drawTable(
    page,
    ['Bezeichnung', 'Betrag'],
    [
      ['Bruttogehalt', money(3200)],
      ['Steuer / SV-Abzüge', money(-1084.2)],
      ['Nettogehalt', money(2115.8)],
    ],
    F,
    y,
    [360, 120],
  );
  finishPage(page, F, company.legalName);
  return pdf.save();
};

builders['DOC-00028'] = async ({ fonts }) =>
  authorityLetter(fonts, {
    issuer: suppliers.get('SUP-021'),
    title: 'Beitragsbescheid Handwerkskammer 2026',
    date: '2026-01-28',
    ref: 'HWK-OWL-2026-88421',
    amount: 312,
    body: [
      'Sehr geehrte Damen und Herren,',
      'für das Beitragsjahr 2026 setzen wir den Kammerbeitrag gemäß Beitragsordnung fest.',
    ],
  });

builders['DOC-00029'] = async ({ fonts }) =>
  authorityLetter(fonts, {
    issuer: suppliers.get('SUP-017'),
    title: 'Anwaltliches Schreiben — Forderungsangelegenheit',
    date: '2026-03-14',
    ref: 'WP-2026-0314',
    body: [
      'Sehr geehrte Damen und Herren,',
      'wir vertreten die Interessen der Cirmak Haustechnik GmbH in einer offenen Forderungssache. Bitte nehmen Sie innerhalb von 14 Tagen Stellung.',
      'Ohne Rückmeldung behalten wir uns weitere Schritte vor.',
    ],
  });

builders['DOC-00030'] = async ({ fonts }) =>
  authorityLetter(fonts, {
    issuer: suppliers.get('SUP-023'),
    title: 'Inkasso-Ankündigung',
    date: '2026-03-16',
    ref: 'CR-OWL-55201',
    amount: 2045.02,
    body: [
      'Sehr geehrte Damen und Herren,',
      'unser Auftraggeber GC-Großhandel OWL GmbH hat uns die Forderung aus Rechnung RE-2026-11842 zur Einziehung übergeben.',
      'Zur Vermeidung weiterer Kosten bitten wir um Zahlung binnen 7 Tagen.',
    ],
  });

builders['DOC-00031'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const court = suppliers.get('SUP-022');
  const cust = customers.get('CUST-001');
  const prj = projects.get('PRJ-001');
  let y = drawIssuerHeader(page, court, F, 'Gerichtsschreiben');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Ladung zum Termin / Hinweis', F, y, [
    `Datum ${fmtDate('2026-03-20')} · Az. 12 C 184/26`,
  ]);
  y = drawParagraphs(
    page,
    [
      `In dem Rechtsstreit betreffend das Bauvorhaben „${prj.title}“ (Auftraggeber ${cust.name}) wird Termin bestimmt.`,
      'Ort: Amtsgericht Lemgo, Rampendal 2. Bitte erscheinen Sie persönlich oder vertreten.',
    ],
    F,
    y,
  );
  finishPage(page, F, court.name);
  return pdf.save();
};

builders['DOC-00032'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const sup = suppliers.get('SUP-001');
  const prj = projects.get('PRJ-001');
  let y = drawIssuerHeader(page, sup, F, 'Gutschrift');
  y = drawRecipient(page, addrBlock(cirmakIssuer()), F, y);
  y = drawDocTitle(page, 'Gutschrift GS-2026-0205', F, y, [
    `Datum ${fmtDate('2026-02-05')} · zu RE-2026-11842`,
    `Baustelle: ${prj.title}`,
  ]);
  y = drawTable(
    page,
    ['Pos.', 'Bezeichnung', 'Betrag'],
    [['1', 'Retoure Pressfittinge (Teilmenge)', money(-186.3)]],
    F,
    y,
    [40, 360, 100],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(-156.55)],
      ['USt 19 %', money(-29.75)],
      ['Gutschrift brutto', money(-186.3), true],
    ],
    F,
    y,
  );
  finishPage(page, F, sup.name);
  return pdf.save();
};

builders['DOC-00033'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  const cust = customers.get('CUST-001');
  const prj = projects.get('PRJ-001');
  let y = drawIssuerHeader(page, cirmakIssuer(), F, 'Gutschrift an Kunden');
  y = drawRecipient(page, addrBlock(cust), F, y);
  y = drawDocTitle(page, 'Gutschrift GS-K-2026-0322', F, y, [
    `Datum ${fmtDate('2026-03-22')} · zu AR-2026-0028`,
    `Projekt: ${prj.title}`,
  ]);
  y = drawTable(
    page,
    ['Pos.', 'Grund', 'Betrag'],
    [['1', 'Minderung wegen Mindermaß Rohrleitungsabschnitt B', money(-2400)]],
    F,
    y,
    [40, 360, 100],
  );
  y = drawTotals(
    page,
    [
      ['Netto', money(-2400)],
      ['USt 19 %', money(-456)],
      ['Gutschrift brutto', money(-2856), true],
    ],
    F,
    y,
  );
  finishPage(page, F, company.legalName);
  return pdf.save();
};

builders['DOC-00034'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  page.drawRectangle({ x: MARGIN, y: A4.h - 220, width: A4.w - MARGIN * 2, height: 160, color: COLORS.soft });
  drawText(page, 'GEWINNSPIEL — Sie haben gewonnen!', MARGIN + 20, A4.h - 90, {
    font: fontBold,
    size: 18,
    color: COLORS.danger,
  });
  drawParagraphs(
    page,
    [
      'Klicken Sie den Link in der Begleit-Mail und geben Sie Ihre Bankdaten frei. (Phishing-Beispiel — TestWorld Negativdokument)',
      'Keine geschäftliche Beziehung zur Cirmak Haustechnik GmbH.',
    ],
    F,
    A4.h - 250,
  );
  finishPage(page, F, 'SPAM / Phishing-Beispiel');
  return pdf.save();
};

builders['DOC-00035'] = async ({ fonts }) => {
  const { pdf, font, fontBold } = await createDoc(fonts);
  const page = addPage(pdf);
  const F = { font, fontBold };
  drawLogoMark(page, MARGIN, A4.h - 60, 'H', fontBold);
  drawText(page, 'Handwerk OWL — Newsletter', MARGIN + 40, A4.h - 70, {
    font: fontBold,
    size: 16,
    color: COLORS.accent,
  });
  drawText(page, fmtDate('2026-03-26'), MARGIN + 40, A4.h - 90, {
    font,
    size: 9,
    color: COLORS.muted,
  });
  drawParagraphs(
    page,
    [
      'Thema der Woche: Förderungen für effiziente Heizsysteme 2026.',
      'Termine: Meistervorbereitung, Azubi-Speeddating Lemgo, Infoabend Wärmepumpe.',
      'Dies ist ein Branchen-Newsletter ohne Rechnungs- oder Auftragsbezug.',
    ],
    F,
    A4.h - 130,
  );
  finishPage(page, F, 'Newsletter');
  return pdf.save();
};

async function main() {
  const fontBytes = loadFontBytes();
  const docsDir = join(root, 'documents');
  const ids = readdirSync(docsDir)
    .filter((n) => n.startsWith('DOC-') && existsSync(join(docsDir, n, 'meta.json')))
    .sort();

  let pdfCount = 0;
  let jpgCount = 0;

  for (const id of ids) {
    const builder = builders[id];
    if (!builder) throw new Error(`No PDF builder for ${id}`);
    const dir = join(docsDir, id);
    const metaPath = join(dir, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const pdfBytes = await builder({ fonts: fontBytes });
    const pdfPath = join(dir, 'source.pdf');
    const jpgPath = join(dir, 'source.jpg');
    writeFileSync(pdfPath, pdfBytes);
    pdfCount += 1;
    await renderJpgFromPdf(pdfBytes, jpgPath);
    jpgCount += 1;

    meta.sourceKind = 'pdf';
    meta.sourceFile = 'source.pdf';
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    console.log('wrote', id, 'source.pdf + source.jpg');
  }

  console.log(`Seed 04A complete: pdf=${pdfCount} jpg=${jpgCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
