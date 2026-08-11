/**
 * NON-BILLABLE-POSITION-01 — strukturelle Nicht-Leistungszeilen sind nie abrechenbar.
 *
 * Ein LV druckt AGB-, Summen- und Übertragszeilen mit denselben Mengen- und
 * Preisspalten wie echte Positionen. Vollständige Zahlen dürfen solche Zeilen
 * daher nicht legitimieren. Weiche Verweise auf technische Anlagen bleiben
 * dagegen durch strukturierte Abrechnungsdaten überstimmbar.
 */
import { describe, expect, it } from 'vitest';
import { isImportableLvPosition } from './contractPositionImportService';
import type { DetectedOrderPosition } from '../types/models';

function position(overrides: Partial<DetectedOrderPosition> & { description: string }): DetectedOrderPosition {
  return {
    positionNumber: overrides.positionNumber ?? '1',
    description: overrides.description,
    unit: overrides.unit ?? 'Stück',
    quantity: overrides.quantity ?? 1,
    unitPrice: overrides.unitPrice ?? 1,
    lineTotal: overrides.lineTotal ?? 1,
  };
}

/** Vollständige, plausible Abrechnungsdaten — der kritische Fall. */
function billed(description: string): DetectedOrderPosition {
  return position({ description, unit: 'qm', quantity: 100, unitPrice: 12.5, lineTotal: 1250 });
}

describe('NON-BILLABLE-POSITION-01 – harte Nicht-Leistungszeilen', () => {
  const HART: Array<[string, DetectedOrderPosition]> = [
    ['A: AGB-Vertragszeile', position({ description: 'AGB Allgemeine Vertragsbedingungen' })],
    ['B: Allgemeine Geschäftsbedingungen', billed('Allgemeine Geschäftsbedingungen')],
    ['C: Allgemeine Vertragsbedingungen', billed('Allgemeine Vertragsbedingungen')],
    ['D: Zwischensumme', billed('Zwischensumme Titel 01')],
    ['E: Übertrag', billed('Übertrag Seite 4')],
    ['E2: Seitenübertrag', billed('Seitenübertrag')],
    ['E3: Summenzeile', billed('Summe Titel 01')],
    ['E4: Titelüberschrift', billed('Titel 01 Dachabdichtung')],
    ['E5: Besondere Vertragsbedingungen', billed('Besondere Vertragsbedingungen')],
  ];

  it.each(HART)('%s ist trotz vollständiger Zahlen nicht importierbar', (_name, entry) => {
    expect(isImportableLvPosition(entry)).toBe(false);
  });
});

describe('NON-BILLABLE-POSITION-01 – echte Leistungspositionen', () => {
  it('F: vollständige Leistungsposition bleibt importierbar', () => {
    expect(
      isImportableLvPosition(
        position({
          description: 'PE-Folie verlegen',
          unit: 'qm',
          quantity: 100,
          unitPrice: 0.35,
          lineTotal: 35,
        }),
      ),
    ).toBe(true);
  });

  it('G: nur Gesamtpreis ohne Menge/EP bleibt importierbar', () => {
    expect(
      isImportableLvPosition(
        position({
          description: 'Dämmung verlegen',
          unit: 'qm',
          quantity: 0,
          unitPrice: 0,
          lineTotal: 13437.2,
        }),
      ),
    ).toBe(true);
  });

  it('H: ohne Einheit nicht importierbar', () => {
    expect(isImportableLvPosition(position({ description: 'Randabschluss', unit: '' }))).toBe(false);
  });

  const GEGENPROBEN: Array<[string, string]> = [
    ['I: AGB als Wortbestandteil', 'AGB-Abdichtung herstellen'],
    ['J: Verweis auf Statik', 'Abdichtung nach Statik ausführen'],
    ['K: Verweis auf Detailzeichnung', 'Attikaabdeckung nach Detailzeichnung herstellen'],
    ['L: Hinweisschild', 'Hinweisschild montieren'],
    ['M: Nachtragsposition', 'Nachtragsposition 01'],
    ['M2: Vorbemerkung als Leistung', 'Vorbemerkung Baustelleneinrichtung'],
  ];

  it.each(GEGENPROBEN)('%s bleibt mit echten Abrechnungsdaten importierbar', (_name, description) => {
    expect(isImportableLvPosition(billed(description))).toBe(true);
  });

  it('weiche technische Begriffe bleiben ohne strukturierte Zahlen gesperrt', () => {
    const onlyTotal = position({
      description: 'Statik Nachweis Dachaufbau',
      unit: 'Stück',
      quantity: 0,
      unitPrice: 0,
      lineTotal: 500,
    });

    expect(isImportableLvPosition(onlyTotal)).toBe(false);
  });
});
