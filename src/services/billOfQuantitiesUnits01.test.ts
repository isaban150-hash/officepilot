/**
 * WV-LV-ROBUSTHEIT-01A — Einheiten in allen LV-Zeilenformaten.
 *
 * Zuvor hatte jedes der drei Zeilenformate eine eigene, fest codierte
 * Einheitenliste. Passte die Schreibweise nicht, verschwand die komplette
 * Position samt Menge und Preis.
 */
import { describe, expect, it } from 'vitest';
import { extractBillOfQuantitiesPositions } from './billOfQuantitiesExtractionService';

const SPELLINGS = [
  'qm', 'm²', 'm2', 'lfm', 'lfdm', 'm', 'Stück', 'Stk.', 'St.',
  'Pauschal', 'psch', 'Std.', 'h', 'kg', 't', 'Sack', 'Zwirbel',
];

/** Alle vier produktiven Zeilenformate mit identischem fachlichen Inhalt. */
const ROW_FORMATS: Array<[string, (unit: string) => string]> = [
  ['pipe', (unit) => `1 | Testleistung | ${unit} | 10,00 | 5,00 | 50,00`],
  ['space', (unit) => `1 10,00 ${unit} Testleistung EP 5,00 € GP 50,00 €`],
  ['alt', (unit) => `1 Testleistung ${unit} 10,00 5,00 50,00`],
  ['flat', (unit) => `Testleistung 10,00 ${unit} 5,00 50,00 €`],
];

const EXPECTED_UNIT: Record<string, string> = {
  qm: 'm²', 'm²': 'm²', m2: 'm²',
  lfm: 'lfm', lfdm: 'lfm',
  m: 'Meter',
  'Stück': 'Stück', 'Stk.': 'Stück', 'St.': 'Stück',
  Pauschal: 'Pauschal', psch: 'Pauschal',
  'Std.': 'Stunden', h: 'Stunden',
};

const UNSUPPORTED = ['kg', 't', 'Sack', 'Zwirbel'];

describe('WV-LV-ROBUSTHEIT-01A – Einheiten je Zeilenformat', () => {
  for (const [formatName, build] of ROW_FORMATS) {
    it.each(SPELLINGS)(`${formatName}: „%s" erzeugt eine vollständige Position`, (unit) => {
      const positions = extractBillOfQuantitiesPositions(build(unit), 1);

      expect(positions).toHaveLength(1);
      const position = positions[0]!;
      expect(position.description).toContain('Testleistung');
      expect(position.quantity).toBe(10);
      expect(position.unitPrice).toBe(5);
      expect(position.lineTotal).toBe(50);
      expect(position.rawUnit).toBe(unit);
    });
  }

  it('qm wird durchgängig zu m², nie zu Stück', () => {
    for (const [, build] of ROW_FORMATS) {
      const position = extractBillOfQuantitiesPositions(build('qm'), 1)[0]!;
      expect(position.unit).toBe('m²');
      expect(position.unit).not.toBe('Stück');
    }
  });

  it('Stk. und h gehen nicht mehr wegen abweichender Regex-Listen verloren', () => {
    for (const [, build] of ROW_FORMATS) {
      expect(extractBillOfQuantitiesPositions(build('Stk.'), 1)).toHaveLength(1);
      expect(extractBillOfQuantitiesPositions(build('h'), 1)).toHaveLength(1);
    }
  });

  it.each(Object.entries(EXPECTED_UNIT))('„%s" normalisiert auf %s', (raw, expected) => {
    const position = extractBillOfQuantitiesPositions(ROW_FORMATS[0]![1](raw), 1)[0]!;
    expect(position.unit).toBe(expected);
    expect(position.reviewReasons ?? []).not.toContain('unit_unknown');
  });

  it.each(UNSUPPORTED)('unbekannte Einheit „%s" bleibt Position und wird nie Stück', (unit) => {
    const position = extractBillOfQuantitiesPositions(ROW_FORMATS[0]![1](unit), 1)[0]!;

    expect(position.unit).not.toBe('Stück');
    expect(position.rawUnit).toBe(unit);
    expect(position.reviewStatus).toBe('review_required');
    expect(position.reviewReasons).toContain('unit_unknown');
    expect(position.quantity).toBe(10);
    expect(position.lineTotal).toBe(50);
  });

  it.each(ROW_FORMATS.map(([name]) => name))(
    '%s: mehrdeutige Einheit „Stk/m" bleibt vollständige Position mit unit_ambiguous',
    (formatName) => {
      const build = ROW_FORMATS.find(([name]) => name === formatName)![1];
      const positions = extractBillOfQuantitiesPositions(build('Stk/m'), 1);

      expect(positions).toHaveLength(1);
      const position = positions[0]!;
      expect(position.rawUnit).toBe('Stk/m');
      expect(position.unit).not.toBe('Stück');
      expect(position.reviewStatus).toBe('review_required');
      expect(position.reviewReasons).toContain('unit_ambiguous');
      expect(position.quantity).toBe(10);
      expect(position.lineTotal).toBe(50);
    },
  );

  it.each(ROW_FORMATS.map(([name]) => name))(
    '%s: bekannte, unbekannte und mehrdeutige Einheit verhalten sich konsistent',
    (formatName) => {
      const build = ROW_FORMATS.find(([name]) => name === formatName)![1];

      const known = extractBillOfQuantitiesPositions(build('qm'), 1)[0]!;
      const unknown = extractBillOfQuantitiesPositions(build('Zwirbel'), 1)[0]!;
      const ambiguous = extractBillOfQuantitiesPositions(build('Stk/m'), 1)[0]!;

      expect(known.unit).toBe('m²');
      expect(known.reviewReasons).toBeUndefined();
      expect(unknown.reviewReasons).toContain('unit_unknown');
      expect(ambiguous.reviewReasons).toContain('unit_ambiguous');
      for (const position of [known, unknown, ambiguous]) {
        expect(position.quantity).toBe(10);
        expect(position.unitPrice).toBe(5);
      }
    },
  );

  it('Beschreibungstext wird nicht als Einheit verschluckt', () => {
    const positions = extractBillOfQuantitiesPositions(
      '1 10,00 qm Abdichtung Flachdach herstellen EP 5,00 € GP 50,00 €',
      1,
    );

    expect(positions).toHaveLength(1);
    expect(positions[0]!.unit).toBe('m²');
    expect(positions[0]!.description).toBe('Abdichtung Flachdach herstellen');
  });
});
