/**
 * OFFICEPILOT-LV-STANDARD-SINGLE-LINE-ROW-01B
 *
 * Das im Baugewerbe übliche einzeilige LV-Format
 *
 *   <Nr> <Menge> <Einheit> <Beschreibung …> <EP> <Gesamt>
 *
 * war bisher von keinem Parserpfad abgedeckt: Pipe, Space und Alt erwarten eine
 * andere Feldreihenfolge, und der Blockparser wartet auf eine separate
 * Preiszeile, die es hier nicht gibt. Übrig blieb der ungeankerte Flat-Fallback,
 * der mitten in „Dachabläufe DN 100 einbauen 210,00 1.680,00“ eine
 * Phantomposition erfand.
 *
 * Entscheidend ist deshalb, dass Zahlen innerhalb der Beschreibung — DN 100,
 * 1,8 mm, 160 mm — dort bleiben, wo sie hingehören.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { describe, expect, it } from 'vitest';
import {
  extractBillOfQuantitiesFromPages,
  extractBillOfQuantitiesPositions,
} from './billOfQuantitiesExtractionService';

/** Aufbau wie auf einer realen LV-Seite: Tabellenkopf, elf Zeilen, Summe. */
const LV_PAGE = [
  'Anlage 2 - Leistungsverzeichnis',
  'Pos. Menge Einh. Bezeichnung EP netto Gesamt netto',
  '01 950 m² PE-Dampfsperre luftdicht herstellen 3,80 3.610,00',
  '02 950 m² Wärmedämmung 160 mm liefern und verlegen 14,50 13.775,00',
  '03 950 m² FPO-Folie 1,8 mm verlegen 16,90 16.055,00',
  '04 118 lfm Attikaanschlüsse herstellen 24,00 2.832,00',
  '05 86 lfm Traufanschlüsse ausführen 19,50 1.677,00',
  '06 12 Stk Lichtkuppeln fachgerecht eindichten 185,00 2.220,00',
  '07 8 Stk Dachabläufe DN 100 einbauen 210,00 1.680,00',
  '08 16 Stk Sekuranten montieren 135,00 2.160,00',
  '09 74 lfm Sickerfüller nach Plan herstellen 12,80 947,20',
  '10 1 Psch Aufmaß und Fotodokumentation 780,00 780,00',
  '11 1 Psch Baustelleneinrichtung und Nebenleistungen 1.250,00 1.250,00',
  'Gesamtsumme netto 46.986,20 EUR',
].join('\n');

const rowOf = (line: string) => extractBillOfQuantitiesPositions(line, 7);

describe('OFFICEPILOT-LV-STANDARD-SINGLE-LINE-ROW-01B', () => {
  it('A: eine Standardzeile ergibt genau eine vollständige Position', () => {
    const positions = rowOf('01 950 m² PE-Dampfsperre luftdicht herstellen 3,80 3.610,00');

    expect(positions).toHaveLength(1);
    const position = positions[0]!;
    expect(position.positionNumber).toBe('01');
    expect(position.quantity).toBe(950);
    expect(position.unit).toBe('m²');
    expect(position.description).toBe('PE-Dampfsperre luftdicht herstellen');
    expect(position.unitPrice).toBe(3.8);
    expect(position.lineTotal).toBe(3610);
    expect(position.reviewReasons ?? []).toEqual([]);
  });

  it('B: eine Maßangabe in der Beschreibung wird nicht zum Preis', () => {
    const positions = rowOf('03 950 m² FPO-Folie 1,8 mm verlegen 16,90 16.055,00');

    expect(positions).toHaveLength(1);
    expect(positions[0]!.description).toBe('FPO-Folie 1,8 mm verlegen');
    expect(positions[0]!.unitPrice).toBe(16.9);
    expect(positions[0]!.lineTotal).toBe(16055);
  });

  it('C: eine Nennweite in der Beschreibung bleibt vollständig erhalten', () => {
    const positions = rowOf('07 8 Stk Dachabläufe DN 100 einbauen 210,00 1.680,00');

    expect(positions).toHaveLength(1);
    const position = positions[0]!;
    expect(position.description).toBe('Dachabläufe DN 100 einbauen');
    expect(position.quantity).toBe(8);
    expect(position.unit).toBe('Stück');
    expect(position.unitPrice).toBe(210);
    expect(position.lineTotal).toBe(1680);
  });

  it('C2: die Phantomposition DN/100/einbauen entsteht nicht mehr', () => {
    const positions = rowOf('07 8 Stk Dachabläufe DN 100 einbauen 210,00 1.680,00');

    expect(positions.some((p) => p.description === 'DN')).toBe(false);
    expect(positions.some((p) => p.rawUnit === 'einbauen')).toBe(false);
    expect(positions.some((p) => p.quantity === 100)).toBe(false);
  });

  it('D: deutsche Tausendertrennung wird korrekt gelesen', () => {
    const positions = rowOf('11 1 Psch Baustelleneinrichtung und Nebenleistungen 1.250,00 1.250,00');

    expect(positions).toHaveLength(1);
    expect(positions[0]!.quantity).toBe(1);
    expect(positions[0]!.unitPrice).toBe(1250);
    expect(positions[0]!.lineTotal).toBe(1250);
    expect(positions[0]!.description).toBe('Baustelleneinrichtung und Nebenleistungen');
  });

  it('E: eine ganze LV-Seite ergibt genau elf Positionen', () => {
    const positions = extractBillOfQuantitiesFromPages([{ pageNumber: 7, text: LV_PAGE }], [7]);

    expect(positions).toHaveLength(11);
    expect(positions.map((p) => p.positionNumber)).toEqual([
      '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11',
    ]);
    expect(positions.find((p) => p.positionNumber === '03')?.description).toBe(
      'FPO-Folie 1,8 mm verlegen',
    );
    expect(positions.find((p) => p.positionNumber === '07')?.description).toBe(
      'Dachabläufe DN 100 einbauen',
    );
    expect(positions.find((p) => p.positionNumber === '11')?.description).toBe(
      'Baustelleneinrichtung und Nebenleistungen',
    );
  });

  it('F: die Summe der elf Positionen stimmt mit der ausgewiesenen überein', () => {
    const positions = extractBillOfQuantitiesFromPages([{ pageNumber: 7, text: LV_PAGE }], [7]);
    const total = positions.reduce((sum, p) => sum + (p.lineTotal ?? 0), 0);

    expect(Math.round(total * 100) / 100).toBe(46986.2);
  });

  it('G: das EP/GP-beschriftete Format bleibt eine einzige Position', () => {
    const positions = rowOf('2 10,00 m² Space Leistung EP: 3,00 GP: 30,00');

    expect(positions).toHaveLength(1);
    expect(positions[0]!.description).toBe('Space Leistung');
    expect(positions[0]!.unitPrice).toBe(3);
  });

  it('H: das Pipe-Format bleibt unverändert', () => {
    const positions = rowOf('1 | Pipe Leistung | m² | 10,00 | 2,00 | 20,00');

    expect(positions).toHaveLength(1);
    expect(positions[0]!.description).toBe('Pipe Leistung');
    expect(positions[0]!.lineTotal).toBe(20);
  });

  it('I: das Alt-Format bleibt unverändert', () => {
    const positions = rowOf('3 Alt Leistung m² 10,00 4,00 40,00');

    expect(positions).toHaveLength(1);
    expect(positions[0]!.description).toBe('Alt Leistung');
    expect(positions[0]!.lineTotal).toBe(40);
  });

  it('K: der echte Flat-Fallback ohne Positionsnummer funktioniert weiter', () => {
    const positions = rowOf('Flatleistung 6,00 m² 5,00 30,00');

    expect(positions).toHaveLength(1);
    expect(positions[0]!.description).toBe('Flatleistung');
    expect(positions[0]!.lineTotal).toBe(30);
  });

  it('L: eine unbekannte Einheit bleibt prüfpflichtig', () => {
    const positions = rowOf('05 10 Zwirbel Sonderleistung ausführen 5,00 50,00');

    expect(positions).toHaveLength(1);
    expect(positions[0]!.rawUnit).toBe('Zwirbel');
    expect(positions[0]!.reviewReasons).toContain('unit_unknown');
  });

  it('M: eine widersprüchliche Zeilenrechnung bleibt prüfpflichtig', () => {
    const positions = rowOf('06 10 m² Falsche Rechnung 5,00 99,00');

    expect(positions).toHaveLength(1);
    expect(positions[0]!.reviewReasons).toContain('line_math_mismatch');
  });
});
