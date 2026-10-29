/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.24) — Formatbausteine des lesbaren Exports.
 *
 * Katalog AP5–AP9 v2:
 *   D-06.2  Umlaute, „€“, Zeilenumbruch, `;`, `"` → UTF-8 mit BOM, korrekt gequotet
 *   D-06.3  Geschäftstexte mit `<script>`, `<img onerror>`, `"`, `'`, `&` → als Text escaped
 *   D-06.4  `../a.pdf`, `/etc/x`, `C:\x.pdf`, `\\srv\x`, `CON.pdf`, Steuerzeichen, gleiche Namen → bereinigte relative
 *           Pfade, Kollisionen `-2`, `-3`
 *   D-07.1  Text beginnt mit `=`, `+`, `-`, `@`, Tab, CR → `'` vorangestellt
 *   D-07.2  negativer numerischer Betrag in einer Zahlenspalte → als Zahl, ohne Voranstellung
 *   D-07.3  verschleierte Anfänge, Vollbreitformen, Text „-5“ → `'` vorangestellt
 */
import { describe, expect, it } from 'vitest';
import {
  amount,
  buildCsv,
  createZipNameAllocator,
  CSV_BOM,
  date,
  datetime,
  escapeHtml,
  formatCsvAmount,
  formatCsvDate,
  integer,
  protectCsvText,
  quoteCsvField,
  sanitizeZipFileName,
  sanitizeZipFolderName,
  text,
  yesNo,
  type CsvColumn,
} from './dataExportFormat';

describe('EINRICHTUNG-01 AP7 — CSV (1.24, D-06.2, D-07)', () => {
  it('D-07.1: Formelzeichen und Tab/CR am Anfang erhalten ein vorangestelltes Hochkomma', () => {
    for (const wert of ['=SUMME(A1)', '+49 521 1', '-5', '@SUM(1)', '\tTab', '\rCR']) {
      expect(protectCsvText(wert), JSON.stringify(wert)).toBe(`'${wert}`);
    }
    for (const wert of ['Müller', '5-3', 'a=b', 'E-Mail', '', '1.5', '€ 5']) {
      expect(protectCsvText(wert), JSON.stringify(wert)).toBe(wert);
    }
  });

  it('D-07.3: verschleierte Anfänge und Vollbreitformen werden ebenso geschützt', () => {
    const faelle = [
      ' =1+1', '   +1', '\u00a0=HYPERLINK("x")', '\n=1', '\r\n@x', '\u2028-1', '\u3000=1', '\ufeff=1', '\u200b=1',
      '＝1+1', '＋1', '－5', '＠SUM', '﹦1', '﹢1', '﹣1', '﹫x', '−5', ' \u00a0\n －1',
    ];
    for (const wert of faelle) {
      expect(protectCsvText(wert), JSON.stringify(wert)).toBe(`'${wert}`);
    }
  });

  it('D-07.2: Beträge bleiben Zahlen mit Dezimalkomma, auch negative; kein Tausendertrenner', () => {
    expect(formatCsvAmount(-12.5)).toBe('-12,50');
    expect(formatCsvAmount(1234567.891)).toBe('1234567,89');
    expect(formatCsvAmount(0)).toBe('0,00');
    expect(formatCsvAmount(-0.001)).toBe('0,00');
    expect(formatCsvAmount(19, 0)).toBe('19');
    expect(formatCsvAmount(null)).toBe('');
    expect(formatCsvAmount(Number.NaN)).toBe('');
    const spalten: CsvColumn<{ betrag: number; text: string }>[] = [
      { header: 'Betrag', cell: (r) => amount(r.betrag) },
      { header: 'Text', cell: (r) => text(r.text) },
    ];
    const csv = buildCsv(spalten, [{ betrag: -5, text: '-5' }]);
    expect(csv.split('\r\n')[1]).toBe(`-5,00;'-5`);
  });

  it('D-06.2: UTF-8 mit BOM, Trenner ;, CRLF, Quoting nach RFC 4180', () => {
    const spalten: CsvColumn<{ name: string; notiz: string; datum: string; anzahl: number; bezahlt: boolean }>[] = [
      { header: 'Name', cell: (r) => text(r.name) },
      { header: 'Notiz', cell: (r) => text(r.notiz) },
      { header: 'Datum', cell: (r) => date(r.datum) },
      { header: 'Anzahl', cell: (r) => integer(r.anzahl) },
      { header: 'Bezahlt', cell: (r) => yesNo(r.bezahlt) },
    ];
    const csv = buildCsv(spalten, [
      { name: 'Müller & Söhne', notiz: 'Zeile 1\nZeile 2; "Zitat" 5 €', datum: '2026-10-25', anzahl: 3, bezahlt: true },
    ]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    const ohneBom = csv.slice(1);
    expect(ohneBom.startsWith('Name;Notiz;Datum;Anzahl;Bezahlt\r\n')).toBe(true);
    expect(ohneBom).toContain('Müller & Söhne;"Zeile 1\nZeile 2; ""Zitat"" 5 €";2026-10-25;3;ja\r\n');
    expect(quoteCsvField('a;b')).toBe('"a;b"');
    expect(quoteCsvField('ohne')).toBe('ohne');
    // Bytes: UTF-8 (€ = E2 82 AC), BOM EF BB BF.
    const bytes = new TextEncoder().encode(csv);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('Datum JJJJ-MM-TT, Zeitpunkt in Ortszeit, Unlesbares leer', () => {
    expect(formatCsvDate('2026-02-03')).toBe('2026-02-03');
    const lokal = new Date(2026, 1, 3, 9, 7);
    expect(formatCsvDate(lokal.toISOString())).toBe('2026-02-03');
    expect(buildCsv([{ header: 'Zeit', cell: (r: { t: string }) => datetime(r.t) }], [{ t: lokal.toISOString() }]).split('\r\n')[1]).toBe('2026-02-03 09:07');
    expect(formatCsvDate('kein Datum')).toBe('');
    expect(formatCsvDate(null)).toBe('');
  });
});

describe('EINRICHTUNG-01 AP7 — sichere Inhalte (1.24, D-06.3, D-06.4)', () => {
  it('D-06.3: HTML-Escaping für & < > " \'', () => {
    expect(escapeHtml(`<script>alert('x')</script>`)).toBe('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('A & "B"')).toBe('A &amp; &quot;B&quot;');
    expect(escapeHtml(null)).toBe('');
  });

  it('D-06.4: Pfadteile, Laufwerke, UNC, Steuerzeichen und Gerätenamen werden bereinigt', () => {
    const faelle: Array<[string, string]> = [
      ['../a.pdf', 'a.pdf'],
      ['../../../etc/passwd', 'passwd'],
      ['/etc/x', 'x'],
      ['C:\\x.pdf', 'x.pdf'],
      ['C:x.pdf', 'x.pdf'],
      ['\\\\srv\\freigabe\\x.pdf', 'x.pdf'],
      ['CON.pdf', '_CON.pdf'],
      ['con', '_con'],
      ['LPT1.txt', '_LPT1.txt'],
      ['nul.tar.gz', '_nul.tar.gz'],
      ['Rech\u0000nung\u0007.pdf', 'Rechnung.pdf'],
      ['a<b>c:d"e|f?g*h.pdf', 'a_b_c_d_e_f_g_h.pdf'],
      ['..', 'datei'],
      ['', 'datei'],
      ['   .versteckt', 'versteckt'],
      ['Ende. ', 'Ende'],
    ];
    for (const [eingabe, erwartet] of faelle) {
      expect(sanitizeZipFileName(eingabe), JSON.stringify(eingabe)).toBe(erwartet);
    }
    const lang = sanitizeZipFileName(`${'x'.repeat(300)}.pdf`);
    expect(lang.length).toBeLessThanOrEqual(100);
    expect(lang.endsWith('.pdf')).toBe(true);
    expect(sanitizeZipFolderName('Ausgaben & Belege')).toBe('ausgaben-belege');
  });

  it('D-06.4: gleiche Namen werden deterministisch mit -2, -3 aufgelöst (ohne Groß/klein)', () => {
    const vergib = createZipNameAllocator();
    expect(vergib('dateien/dokumente', 'beleg.pdf')).toBe('dateien/dokumente/beleg.pdf');
    expect(vergib('dateien/dokumente', 'Beleg.pdf')).toBe('dateien/dokumente/Beleg-2.pdf');
    expect(vergib('dateien/dokumente', '../beleg.pdf')).toBe('dateien/dokumente/beleg-3.pdf');
    expect(vergib('dateien/ausgaben', 'beleg.pdf')).toBe('dateien/ausgaben/beleg.pdf');
    for (const pfad of ['dateien/dokumente/beleg.pdf', 'dateien/dokumente/Beleg-2.pdf']) {
      expect(pfad.startsWith('/')).toBe(false);
      expect(pfad.split('/')).not.toContain('..');
    }
  });
});
