import { describe, expect, it } from 'vitest';
import {
  buildOrderPositionsFromInbox,
  parseOfferAmount,
} from './orderPositionFactory';
import { createAuftragInboxItem, createMaterialInboxItem } from '../test/fixtures';

describe('parseOfferAmount', () => {
  it('parses "ca. 8.500 €" as 8500', () => {
    expect(parseOfferAmount('ca. 8.500 €')).toBe(8500);
  });

  it('parses "8500 €" as 8500', () => {
    expect(parseOfferAmount('8500 €')).toBe(8500);
  });

  it('parses "8.500,50 €" as 8500.5', () => {
    expect(parseOfferAmount('8.500,50 €')).toBe(8500.5);
  });

  it('returns 0 for empty string', () => {
    expect(parseOfferAmount('')).toBe(0);
  });

  it('returns 0 for unparseable text', () => {
    expect(parseOfferAmount('unbekannt')).toBe(0);
  });

  /*
   * FINANZ-CORE-01A (ANG-04) — „8.500,- €" ergab bisher 8,5 und „8.500,00 €
   * netto" ebenfalls: ein um den Faktor 1000 zu niedriger Auftragspreis ohne
   * Hinweis. Unklares ergibt jetzt 0 und damit „Preis fehlt".
   */
  it.each([
    ['8.500,- €', 8500],
    ['8.500,-- EUR', 8500],
    ['8.500,00 € netto', 8500],
    ['8.500,00 € zzgl. MwSt.', 8500],
    ['ca. 12.345,67 Euro brutto', 12345.67],
    ['€ 1.250.000', 1250000],
    ['8500.50', 8500.5],
    ['950', 950],
  ])('liest %s als %s', (text, expected) => {
    expect(parseOfferAmount(text)).toBe(expected);
  });

  it.each([['8.500.-'], ['8.500 € laut Angebot vom 3.9.'], ['ab 8.500 €'], ['8,5 Tsd. €'], ['8.50.0']])(
    'liest %s nicht als Betrag (0 → Hinweis „Preis fehlt")',
    (text) => {
      expect(parseOfferAmount(text)).toBe(0);
    },
  );
});

describe('buildOrderPositionsFromInbox', () => {
  it('creates one Pauschal position for Auftrag', () => {
    const positions = buildOrderPositionsFromInbox(createAuftragInboxItem());

    expect(positions).toHaveLength(1);
    expect(positions[0].unit).toBe('Pauschal');
    expect(positions[0].plannedQuantity).toBe(1);
    expect(positions[0].unitPrice).toBe(8500);
    expect(positions[0].description).toBe('Badezimmer-Sanierung');
    expect(positions[0].category).toBe('arbeit');
  });

  it('returns empty array for Materialrechnung', () => {
    expect(buildOrderPositionsFromInbox(createMaterialInboxItem())).toEqual([]);
  });
});
