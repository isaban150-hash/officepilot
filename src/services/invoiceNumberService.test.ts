import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  formatInvoiceNumber,
  getCurrentInvoiceYear,
  getNextInvoiceNumberPreview,
  hydrateInvoiceNumberSequence,
  reserveNextInvoiceNumber,
  resetInvoiceNumberSequence,
} from './invoiceNumberService';
import { hydrateVorgangStore } from './vorgangService';
import { createAbschlagInvoice, createTestVorgang } from '../test/fixtures';

describe('formatInvoiceNumber', () => {
  it('formats with four-digit padding', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('2026-0001');
    expect(formatInvoiceNumber(2026, 42)).toBe('2026-0042');
  });
});

describe('getNextInvoiceNumberPreview', () => {
  beforeEach(() => {
    resetInvoiceNumberSequence();
    hydrateVorgangStore([]);
  });

  it('returns first number for empty store', () => {
    expect(getNextInvoiceNumberPreview()).toBe(`${getCurrentInvoiceYear()}-0001`);
  });

  it('increments after reserved numbers', () => {
    hydrateInvoiceNumberSequence({ year: getCurrentInvoiceYear(), lastIssuedNumber: 2 });
    expect(getNextInvoiceNumberPreview()).toBe(`${getCurrentInvoiceYear()}-0003`);
  });
});

describe('reserveNextInvoiceNumber', () => {
  beforeEach(() => {
    resetInvoiceNumberSequence();
    hydrateVorgangStore([]);
  });

  it('reserves sequential numbers', () => {
    const first = reserveNextInvoiceNumber();
    const second = reserveNextInvoiceNumber();
    expect(first.formatted).toBe(`${getCurrentInvoiceYear()}-0001`);
    expect(second.formatted).toBe(`${getCurrentInvoiceYear()}-0002`);
  });

  it('avoids duplicate numbers already stored on invoices', () => {
    const year = getCurrentInvoiceYear();
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [
          createAbschlagInvoice('op-test-1', 1, {
            number: formatInvoiceNumber(year, 1),
            invoiceSequenceNumber: 1,
            issueDate: `${year}-03-01`,
          }),
        ],
      }),
    ]);
    resetInvoiceNumberSequence();

    const reserved = reserveNextInvoiceNumber();
    expect(reserved.formatted).toBe(formatInvoiceNumber(year, 2));
  });
});

describe('year rollover', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at 0001 after year change', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-15T12:00:00.000Z'));
    hydrateInvoiceNumberSequence({ year: 2026, lastIssuedNumber: 15 });
    hydrateVorgangStore([]);

    const reserved = reserveNextInvoiceNumber();
    expect(reserved.year).toBe(2027);
    expect(reserved.formatted).toBe('2027-0001');
  });
});
