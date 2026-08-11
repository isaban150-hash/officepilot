/**
 * PDF-TEXT-STRUCTURE-01 — pdf.js meldet Zeilenumbrüche über hasEOL.
 *
 * Bisher wurden alle TextItems einer Seite zu einer flachen Zeile verbunden,
 * wodurch jede zeilenbasierte Extraktion ins Leere lief. Hier wird nur die
 * Strukturinformation erhalten — keine Semantik, keine Geometrie.
 */
import { describe, expect, it } from 'vitest';
import { textItemsToPageText, type PdfTextItemLike } from './pdfDocumentService';

describe('PDF-TEXT-STRUCTURE-01 – Zeilenstruktur aus hasEOL', () => {
  it('A: mehrere Items je Zeile, hasEOL trennt die Zeilen', () => {
    const items: PdfTextItemLike[] = [
      { str: 'Geplanter Ausführungsbeginn:' },
      { str: '31.08.2026', hasEOL: true },
      { str: 'Geplantes Ausführungsende:' },
      { str: '18.09.2026', hasEOL: true },
      { str: 'Zwischentermine werden mit der Bauleitung abgestimmt.', hasEOL: true },
      { str: '§ 7 Behinderungen und Unterbrechungen' },
    ];

    expect(textItemsToPageText(items)).toBe(
      [
        'Geplanter Ausführungsbeginn: 31.08.2026',
        'Geplantes Ausführungsende: 18.09.2026',
        'Zwischentermine werden mit der Bauleitung abgestimmt.',
        '§ 7 Behinderungen und Unterbrechungen',
      ].join('\n'),
    );
  });

  it('A2: der gelabelte Rohwert endet an der Zeile', () => {
    const pageText = textItemsToPageText([
      { str: 'Geplanter Ausführungsbeginn:' },
      { str: '31.08.2026', hasEOL: true },
      { str: 'Geplantes Ausführungsende:' },
      { str: '18.09.2026', hasEOL: true },
      { str: '§ 7 Behinderungen, fehlende Vorleistungen oder sonstige Umstände' },
    ]);

    const beginn = /(?:vertrags)?beginn\s*:\s*([^\n]+)/i.exec(pageText)?.[1]?.trim();
    const ende = /(?:vertrags)?ende\s*:\s*([^\n]+)/i.exec(pageText)?.[1]?.trim();

    expect(beginn).toBe('31.08.2026');
    expect(ende).toBe('18.09.2026');
  });

  it('B: ohne hasEOL bleibt es eine Zeile', () => {
    const items: PdfTextItemLike[] = [{ str: 'Rechnung' }, { str: 'Nr.' }, { str: '1234' }];

    expect(textItemsToPageText(items)).toBe('Rechnung Nr. 1234');
  });

  it('C: Tabellenzeilen bleiben je Zeile zusammen', () => {
    const items: PdfTextItemLike[] = [
      { str: 'Pos.' },
      { str: 'Bezeichnung' },
      { str: 'Menge' },
      { str: 'Gesamt', hasEOL: true },
      { str: '1' },
      { str: 'Sanitär-Rohrset DN 32' },
      { str: '4 St' },
      { str: '99,60 EUR', hasEOL: true },
      { str: '2' },
      { str: 'Dichtungsband Profi' },
      { str: '6 St' },
      { str: '51,00 EUR', hasEOL: true },
    ];

    expect(textItemsToPageText(items).split('\n')).toEqual([
      'Pos. Bezeichnung Menge Gesamt',
      '1 Sanitär-Rohrset DN 32 4 St 99,60 EUR',
      '2 Dichtungsband Profi 6 St 51,00 EUR',
    ]);
  });

  it('D: leere Items erzeugen keine Leerzeilen', () => {
    const items: PdfTextItemLike[] = [
      { str: '' },
      { str: '   ', hasEOL: true },
      { str: 'Finanzamt Musterstadt', hasEOL: true },
      { str: '', hasEOL: true },
      { str: '  ' },
      { str: 'Steuernummer: 99 999 888 777', hasEOL: true },
    ];

    expect(textItemsToPageText(items)).toBe(
      'Finanzamt Musterstadt\nSteuernummer: 99 999 888 777',
    );
  });

  it('D2: ein leeres Item mit hasEOL schließt die angesammelte Zeile ab', () => {
    const items: PdfTextItemLike[] = [
      { str: 'Zeile eins' },
      { str: '', hasEOL: true },
      { str: 'Zeile zwei' },
    ];

    expect(textItemsToPageText(items)).toBe('Zeile eins\nZeile zwei');
  });

  it('E: letztes Item mit hasEOL erzeugt kein abschließendes Newline', () => {
    const text = textItemsToPageText([
      { str: 'Erste Zeile', hasEOL: true },
      { str: 'Letzte Zeile', hasEOL: true },
    ]);

    expect(text).toBe('Erste Zeile\nLetzte Zeile');
    expect(text.endsWith('\n')).toBe(false);
  });

  it('F: Whitespace wird nur innerhalb einer Zeile normalisiert', () => {
    const text = textItemsToPageText([
      { str: 'Betrag' },
      { str: '   1.234,00   €', hasEOL: true },
      { str: 'Fällig' },
      { str: '  sofort' },
    ]);

    expect(text).toBe('Betrag 1.234,00 €\nFällig sofort');
    expect(text.split('\n')).toHaveLength(2);
  });

  it('G: keine Items ergibt leeren Text', () => {
    expect(textItemsToPageText([])).toBe('');
    expect(textItemsToPageText([{ str: '  ' }])).toBe('');
  });
});
