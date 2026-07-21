import { describe, expect, it } from 'vitest';
import {
  buildInvoiceCreatePath,
  buildInvoiceDetailPath,
  buildOpenInvoicesPath,
} from './invoiceNavigation';

describe('invoiceNavigation', () => {
  it('builds invoice detail path with plural rechnungen segment', () => {
    expect(buildInvoiceDetailPath('v-1', 'inv-1')).toBe('/vorgaenge/v-1/rechnungen/inv-1');
  });

  it('builds create and overview paths', () => {
    expect(buildInvoiceCreatePath('v-1')).toBe('/vorgaenge/v-1/rechnung');
    expect(buildOpenInvoicesPath()).toBe('/rechnungen/offen');
  });
});
