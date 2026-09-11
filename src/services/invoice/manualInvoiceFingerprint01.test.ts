/**
 * MANUAL-INVOICE-01B1 — „kein Auftragsbezug" muss stabil dargestellt werden.
 *
 * Eine freie Rechnungsposition trägt keine `orderPositionId`. Der Fingerprint
 * entscheidet über Idempotenz zwischen Gerät und Cloud: Erschiene das Feld
 * einmal als `null` und einmal gar nicht, wären zwei identische Belege
 * verschieden — und der Nutzer sähe einen Idempotenzkonflikt, nicht einen roten
 * Test.
 *
 * Der kanonische Kodierer wirft bei `undefined` ausdrücklich
 * (`invoicePreparedResponseProjection`: „`undefined` und fehlendes Feld dürfen
 * sich nicht vermischen"). Genau darauf stützt sich dieser Test: Ein fehlender
 * Auftragsbezug muss **explizit** zu `null` kanonisiert werden.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { describe, expect, it } from 'vitest';
import { immutableInvoiceFingerprint } from '../vorgangService';
import { buildInvoiceContentFingerprintFromInvoice } from '../invoiceService';
import type { CompanyProfile, CustomerBilling, VorgangInvoice } from '../../types/models';

const COMPANY = {
  companyName: 'Test GmbH',
  legalForm: 'GmbH',
  street: 'Teststr. 1',
  zip: '12345',
  city: 'Teststadt',
  country: 'Deutschland',
  contactPerson: 'Max Muster',
  phone: '030',
  email: 'info@test.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
} as CompanyProfile;

const CUSTOMER: CustomerBilling = {
  name: 'Kunde GmbH',
  contactPerson: '',
  street: 'Kundenweg 2',
  zip: '54321',
  city: 'Kundenstadt',
  email: '',
  phone: '',
};

/** Eine freie Position: Beschreibung, Menge, Einheit, Preis — kein Auftrag. */
function freeInvoice(): VorgangInvoice {
  return {
    id: 'inv-free-1',
    number: '2026-0012',
    invoiceSequenceNumber: 12,
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        description: 'Anfahrt',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 45,
        lineTotal: 45,
      },
    ],
    subtotal: 45,
    taxStatus: 'standard_19',
    amount: 53.55,
    status: 'vorbereitet',
    date: '2026-05-04',
    issueDate: '2026-05-04',
    createdAt: '2026-05-04T09:00:00.000Z',
    paymentDueDate: '2026-05-18',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: CUSTOMER,
    companySnapshot: COMPANY,
  } as unknown as VorgangInvoice;
}

describe('MANUAL-INVOICE-01B1 — Fingerprint ohne Auftragsbezug', () => {
  it('F1: der unveränderliche Fingerprint entsteht auch ohne orderPositionId', () => {
    const invoice = freeInvoice();

    const fingerprint = immutableInvoiceFingerprint(invoice, undefined);

    expect(fingerprint, 'Der Fingerprint konnte nicht gebildet werden').toBeTruthy();
    // `kein Vorgang` ist bereits stabil als null vorgesehen.
    expect(fingerprint).toContain('"vorgangId":null');
    // Und `kein Auftragsbezug` muss es ebenso sein — nicht ein fehlender Schlüssel.
    expect(fingerprint, 'orderPositionId fehlt statt null zu sein').toContain(
      '"orderPositionId":null',
    );
  });

  it('F2: der Inhalts-Fingerprint verhält sich identisch', () => {
    const fingerprint = buildInvoiceContentFingerprintFromInvoice(freeInvoice());

    expect(fingerprint, 'Der Inhalts-Fingerprint konnte nicht gebildet werden').toBeTruthy();
    expect(fingerprint, 'orderPositionId fehlt statt null zu sein').toContain(
      '"orderPositionId":null',
    );
  });

  it('F3: derselbe Beleg ergibt zweimal denselben Fingerprint', () => {
    const a = immutableInvoiceFingerprint(freeInvoice(), undefined);
    const b = immutableInvoiceFingerprint(freeInvoice(), undefined);
    expect(a).toBe(b);

    const contentA = buildInvoiceContentFingerprintFromInvoice(freeInvoice());
    const contentB = buildInvoiceContentFingerprintFromInvoice(freeInvoice());
    expect(contentA).toBe(contentB);
  });

  /*
   * Die Gegenrichtung: Eine auftragsgebundene Position behält ihre echte
   * Kennung. Der Fix darf bestehende Fingerprints nicht verschieben.
   */
  it('F4: eine auftragsgebundene Position behält ihre Kennung im Fingerprint', () => {
    const invoice = freeInvoice();
    invoice.positions = [{ ...invoice.positions[0]!, orderPositionId: 'op-1' }];

    const fingerprint = immutableInvoiceFingerprint(invoice, 'v-1');

    expect(fingerprint).toContain('"orderPositionId":"op-1"');
    expect(fingerprint).toContain('"vorgangId":"v-1"');
  });
});
