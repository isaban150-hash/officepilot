/**
 * CONTRACT-LV-POSITION-COMPLETENESS-01C — mehrzeilige tabellarische LV-Blöcke.
 *
 * Alle Fixtures sind neutral und synthetisch: keine realen Firmen, Beträge,
 * Dateinamen oder Beschreibungen aus einem Kundendokument.
 */
import { describe, expect, it } from 'vitest';
import {
  extractBillOfQuantitiesPositions,
  extractMultilinePositionBlocks,
  sumPositionsNet,
} from './billOfQuantitiesExtractionService';
import { extractStructuredContractFields } from './contractIntelligenceExtraction';
import { analyzeContractIntelligenceFromText } from './contractIntelligenceService';

/** Ein vollständiger Block im mehrzeiligen Tabellenlayout. */
function block(
  positionNumber: string,
  quantity: string,
  unit: string,
  descriptionLines: string[],
  unitPrice: string,
  lineTotal: string,
): string {
  const [first, ...rest] = descriptionLines;
  return [
    `${positionNumber} ${quantity} ${unit} ${first}`,
    ...rest,
    `${unitPrice} EUR ${lineTotal} EUR`,
  ].join('\n');
}

const THREE_BLOCKS = [
  block('1', '100,00', 'm²', ['Bauteil A montieren'], '2,00', '200,00'),
  block(
    '2',
    '50,00',
    'm',
    ['Bauteil B liefern', 'und ausrichten', 'sowie sichern', 'nach Vorgabe'],
    '4,00',
    '200,00',
  ),
  block('3', '10,00', 'Stk', ['Bauteil C prüfen', 'und abnehmen'], '30,00', '300,00'),
].join('\n');

describe('CONTRACT-LV-POSITION-COMPLETENESS-01C — mehrzeilige Positionsblöcke', () => {
  it('Fall A — drei vollständige Blöcke mit unterschiedlicher Beschreibungslänge', () => {
    const positions = extractMultilinePositionBlocks(THREE_BLOCKS, 7);

    expect(positions).toHaveLength(3);
    expect(positions.map((position) => position.positionNumber)).toEqual(['1', '2', '3']);
    expect(positions.map((position) => position.sourcePage)).toEqual([7, 7, 7]);

    expect(positions[0]!.description).toBe('Bauteil A montieren');
    expect(positions[1]!.description).toBe(
      'Bauteil B liefern und ausrichten sowie sichern nach Vorgabe',
    );
    expect(positions[2]!.description).toBe('Bauteil C prüfen und abnehmen');

    expect(positions[0]!.quantity).toBe(100);
    expect(positions[1]!.quantity).toBe(50);
    expect(positions[2]!.quantity).toBe(10);
    expect(positions[0]!.unitPrice).toBe(2);
    expect(positions[1]!.unitPrice).toBe(4);
    expect(positions[2]!.unitPrice).toBe(30);
    expect(positions.map((position) => position.lineTotal)).toEqual([200, 200, 300]);

    for (const position of positions) {
      expect(position.description.toLowerCase()).not.toContain('eur');
      expect(String(position.unit).toLowerCase()).not.toBe('eur');
      expect(String(position.rawUnit).toLowerCase()).not.toBe('eur');
    }

    expect(sumPositionsNet(positions)).toBe(700);
  });

  it('Fall B — N echte Blöcke ergeben N Positionen, niemals N minus 1', () => {
    for (const count of [1, 2, 5, 11]) {
      const text = Array.from({ length: count }, (_, index) =>
        block(
          `${index + 1}`,
          '10,00',
          'm²',
          [`Leistung ${index + 1} ausführen`, 'zweite Zeile'],
          '3,00',
          '30,00',
        ),
      ).join('\n');

      const positions = extractMultilinePositionBlocks(text, 2);
      expect(positions, `count=${count}`).toHaveLength(count);
      expect(positions.map((position) => position.positionNumber)).toEqual(
        Array.from({ length: count }, (_, index) => `${index + 1}`),
      );
      expect(sumPositionsNet(positions)).toBe(30 * count);
    }
  });

  it('Fall C — der Übergang zweier Blöcke erzeugt keine Phantomposition', () => {
    const text = [
      block('1', '20,00', 'm²', ['Erste Leistung', 'zweite Zeile'], '1,50', '30,00'),
      block('2', '40,00', 'm', ['Zweite Leistung'], '2,50', '100,00'),
    ].join('\n');

    // Über den vollständigen Extraktionspfad, nicht nur über den Blockparser.
    const positions = extractBillOfQuantitiesPositions(text, 3);

    expect(positions).toHaveLength(2);
    expect(positions.map((position) => position.positionNumber)).toEqual(['1', '2']);
    for (const position of positions) {
      expect(String(position.unit).toLowerCase()).not.toBe('eur');
      expect(String(position.rawUnit).toLowerCase()).not.toBe('eur');
      expect(position.description.trim().toLowerCase()).not.toBe('eur');
    }
  });

  it('Fall D — unvollständiger Block in der Mitte beendet die Verarbeitung nicht', () => {
    const text = [
      block('1', '20,00', 'm²', ['Vollständige Leistung'], '1,50', '30,00'),
      '2 15,00 m Unvollständige Leistung',
      'ohne Preiszeile beschrieben',
      block('3', '5,00', 'Stk', ['Weitere vollständige Leistung'], '10,00', '50,00'),
    ].join('\n');

    const positions = extractMultilinePositionBlocks(text, 4);

    expect(positions).toHaveLength(2);
    expect(positions.map((position) => position.positionNumber)).toEqual(['1', '3']);
    expect(positions.some((position) => position.positionNumber === '2')).toBe(false);
  });

  it('Fall E — Summen, Überträge und Zwischensummen starten keine Position', () => {
    const text = [
      block('1', '20,00', 'm²', ['Erste Leistung'], '1,50', '30,00'),
      'Zwischensumme 30,00 EUR',
      'Übertrag 30,00 EUR',
      block('2', '10,00', 'm', ['Zweite Leistung'], '2,00', '20,00'),
      'Seitenübertrag 50,00 EUR',
      'Gesamtsumme 50,00 EUR',
    ].join('\n');

    const positions = extractMultilinePositionBlocks(text, 5);

    expect(positions).toHaveLength(2);
    expect(positions.map((position) => position.positionNumber)).toEqual(['1', '2']);
    for (const position of positions) {
      expect(position.description.toLowerCase()).not.toContain('summe');
      expect(position.description.toLowerCase()).not.toContain('übertrag');
    }
  });

  it('Fall F — unbekannte echte Einheit bleibt erhalten und wird geprüft', () => {
    const text = block('1', '12,00', 'Gebinde', ['Neutrale Leistung', 'zweite Zeile'], '5,00', '60,00');

    const positions = extractMultilinePositionBlocks(text, 6);

    expect(positions).toHaveLength(1);
    const position = positions[0]!;
    expect(position.rawUnit).toBe('Gebinde');
    expect(position.unit).toBe('Gebinde');
    expect(position.reviewStatus).toBe('review_required');
    expect(position.reviewReasons).toContain('unit_unknown');
    expect(position.quantity).toBe(12);
    expect(position.unitPrice).toBe(5);
    expect(position.lineTotal).toBe(60);
  });

  it('Fall G — einzeilige Bestandsformate bleiben unverändert und ohne Dubletten', () => {
    const pipe = extractBillOfQuantitiesPositions(
      '1 | Pipe Leistung | m² | 10,00 | 2,00 | 20,00',
      1,
    );
    expect(pipe).toHaveLength(1);
    expect(pipe[0]!.description).toBe('Pipe Leistung');
    expect(pipe[0]!.lineTotal).toBe(20);

    const space = extractBillOfQuantitiesPositions(
      '2 10,00 m² Space Leistung EP: 3,00 GP: 30,00',
      1,
    );
    expect(space).toHaveLength(1);
    expect(space[0]!.description).toBe('Space Leistung');
    expect(space[0]!.unitPrice).toBe(3);

    const alt = extractBillOfQuantitiesPositions('3 Alt Leistung m² 10,00 4,00 40,00', 1);
    expect(alt).toHaveLength(1);
    expect(alt[0]!.description).toBe('Alt Leistung');
    expect(alt[0]!.lineTotal).toBe(40);

    const flat = extractBillOfQuantitiesPositions('Flatleistung 6,00 m² 5,00 30,00', 1);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.quantity).toBe(6);
    expect(flat[0]!.unitPrice).toBe(5);
  });

  it('Fall G2 — Währungstoken wird im Flat-Format nicht als Einheit akzeptiert', () => {
    const positions = extractBillOfQuantitiesPositions('Flatleistung 10,00 EUR 2,00 20,00', 1);

    expect(positions).toHaveLength(0);
    for (const position of positions) {
      expect(String(position.unit).toLowerCase()).not.toBe('eur');
    }
  });

  it('Fall G3 — unbekannte echte Einheit bleibt im Flat-Format erhalten', () => {
    const positions = extractBillOfQuantitiesPositions('Flatleistung 10,00 Gebinde 2,00 20,00', 1);

    expect(positions).toHaveLength(1);
    const position = positions[0]!;
    expect(position.rawUnit).toBe('Gebinde');
    expect(position.unit).toBe('Gebinde');
    expect(position.quantity).toBe(10);
    expect(position.unitPrice).toBe(2);
    expect(position.reviewStatus).toBe('review_required');
    expect(position.reviewReasons).toContain('unit_unknown');
  });

  it('Fall H — strukturiertes Teilresultat blockiert den Mehrzeilenparser nicht', () => {
    const lvPage = ['Leistungsverzeichnis', 'Pos.', THREE_BLOCKS].join('\n');

    const contractPage = [
      'Werkvertrag (Bauleistung nach VOB/B)',
      'Auftraggeber: Beispiel Auftraggeber GmbH',
      'Auftragnehmer: Beispiel Auftragnehmer GmbH',
      'Bauvorhaben: Neutrales Bauvorhaben',
      'Gesamtsumme netto 700,00 €',
    ].join('\n');

    /**
     * Der strukturierte Parser liest ausschließlich page.items. Die Tokenfolge
     * erzeugt bewusst genau eine kurze Teilposition zur Dokumentnummer 2.
     */
    const pageTexts = [
      { pageNumber: 1, text: contractPage },
      {
        pageNumber: 2,
        text: lvPage,
        items: ['Pos.', '2', '50,00', 'm', 'Kurztext', '4,00', '200,00'],
      },
    ];

    // Positive Vorbedingung: es gibt tatsächlich ein strukturiertes Teilresultat.
    const structuredResult = extractStructuredContractFields(pageTexts);
    expect(structuredResult.positions).toHaveLength(1);
    const partial = structuredResult.positions[0]!;
    expect(partial.positionNumber).toBe('2');
    expect(partial.sourcePage).toBe(2);
    expect(partial.description).toBe('Kurztext');
    const fullDescription = 'Bauteil B liefern und ausrichten sowie sichern nach Vorgabe';
    expect(partial.description.length).toBeLessThan(fullDescription.length);

    const result = analyzeContractIntelligenceFromText(
      `${contractPage}\n${lvPage}`,
      pageTexts,
    );

    expect(result).not.toBeNull();
    const positions = result!.positions;
    expect(positions).toHaveLength(3);

    for (const expected of ['1', '2', '3']) {
      const found = positions.filter(
        (position) => position.positionNumber === expected && position.sourcePage === 2,
      );
      expect(found, `positionNumber=${expected}`).toHaveLength(1);
    }

    // Keine doppelte Dokumentidentität.
    const identities = positions.map(
      (position) => `${position.sourcePage ?? ''}:${position.positionNumber ?? ''}`,
    );
    expect(new Set(identities).size).toBe(identities.length);

    // Der vollständige Block gewinnt gegen den abgeschnittenen Kandidaten.
    const second = positions.find(
      (position) => position.positionNumber === '2' && position.sourcePage === 2,
    )!;
    expect(second.description).toBe(fullDescription);
    expect(second.quantity).toBe(50);
    expect(second.unitPrice).toBe(4);
    expect(second.lineTotal).toBe(200);

    // Die beiden übrigen Positionen bleiben unverändert erhalten.
    const first = positions.find((position) => position.positionNumber === '1')!;
    const third = positions.find((position) => position.positionNumber === '3')!;
    expect(first.description).toBe('Bauteil A montieren');
    expect(first.lineTotal).toBe(200);
    expect(third.description).toBe('Bauteil C prüfen und abnehmen');
    expect(third.lineTotal).toBe(300);
  });
});
