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
