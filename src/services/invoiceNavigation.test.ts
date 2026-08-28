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

  it('builds overview path', () => {
    expect(buildOpenInvoicesPath()).toBe('/rechnungen/offen');
  });

  /*
   * INVOICE-CREATE-ROUTE-TYPE-01 — die Anlege-Route trägt den Rechnungstyp
   * ausdrücklich. Sie verlässt sich nicht mehr auf den Parser-Fallback von
   * `parseInvoiceDocumentType`, der aus einem fehlenden Parameter still
   * `rechnung` macht. Der Fallback bleibt für alte Lesezeichen bestehen —
   * unsere eigenen Links dürfen ihn nur nicht mehr brauchen.
   */
  it('builds create paths with an explicit invoice type', () => {
    expect(buildInvoiceCreatePath('v-1', 'rechnung')).toBe('/vorgaenge/v-1/rechnung?type=rechnung');
    expect(buildInvoiceCreatePath('v-1', 'abschlag')).toBe('/vorgaenge/v-1/rechnung?type=abschlag');
    expect(buildInvoiceCreatePath('v-1', 'schluss')).toBe('/vorgaenge/v-1/rechnung?type=schluss');
  });

  it('leaves the vorgang id untouched', () => {
    // Bestandsverhalten: die ID wird unverändert eingesetzt, nicht kodiert.
    expect(buildInvoiceCreatePath('abc', 'rechnung')).toBe('/vorgaenge/abc/rechnung?type=rechnung');
  });
});
