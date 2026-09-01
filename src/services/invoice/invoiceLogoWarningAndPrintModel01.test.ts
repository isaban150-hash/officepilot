/**
 * BRANDING-01F-3 — Logowarnung und Druckmodell.
 *
 * Zwei Stellen, die bis zu diesem Block nur das Legacy-Feld kannten: Die
 * Warnung „kein Logo" hätte einem Betrieb mit ausschliesslich strukturiertem
 * Logo dauerhaft widersprochen, und das Druckmodell trug die historische Quelle
 * gar nicht erst mit.
 *
 * Neutrale Beispieldaten, keine Netzzugriffe.
 */
import { describe, expect, it } from 'vitest';

import { validateInvoiceDraftForApproval } from '../invoiceValidationService';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { CompanyProfile, InvoiceDraft, VorgangInvoice } from '../../types/models';

const LOGO_A = { assetId: 'asset-a-1111', mimeType: 'image/png' } as const;
const LEGACY = 'data:image/png;base64,AAAA';

function company(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Betrieb GmbH',
    street: 'Musterweg 5',
    zip: '10115',
    city: 'Berlin',
    email: 'kontakt@example.invalid',
    phone: '030 000000',
    taxNumber: '11/222/33333',
    iban: 'DE89370400440532013000',
    ...overrides,
  };
}

function draft(fields: Partial<InvoiceDraft>): InvoiceDraft {
  return {
    id: 'draft-1',
    vorgangId: 'vg-1',
    vorgangTitle: 'Beispielvorgang',
    customer: 'Beispiel Kundschaft GmbH',
    baustelle: 'Musterweg 1',
    type: 'rechnung',
    taxStatus: 'standard_19',
    materialSource: 'betrieb',
    positions: [],
    issueDate: '2026-09-01',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-31',
    paymentDueDate: '2026-09-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    skontoText: '',
    customerBilling: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '10115',
      city: 'Berlin',
      email: '',
      phone: '',
    },
    companySnapshot: company(),
    legalNotices: [],
    previousAbschlagDeductions: [],
    invoiceNumberPreview: 'ENTWURF',
    introText: '',
    closingText: '',
    ...fields,
  } as unknown as InvoiceDraft;
}

function warnsAboutLogo(input: InvoiceDraft): boolean {
  const result = validateInvoiceDraftForApproval(input, company(), undefined);
  return result.warnings.some((warning) => warning.code === 'company_logo');
}

describe('BRANDING-01F-3 — Logowarnung erkennt alle Generationen', () => {
  // TEST 20
  it('wertet ein Snapshot-Logo als vorhanden', () => {
    expect(warnsAboutLogo(draft({ brandingSnapshot: { version: 1, logo: { ...LOGO_A } } }))).toBe(
      false,
    );
  });

  // TEST 21
  it('wertet ein Übergangs-Branding als vorhanden', () => {
    expect(
      warnsAboutLogo(draft({ companySnapshot: company({ branding: { logo: { ...LOGO_A } } }) })),
    ).toBe(false);
  });

  // TEST 22
  it('wertet ein Legacy-Logo als vorhanden', () => {
    expect(warnsAboutLogo(draft({ companySnapshot: company({ logoDataUrl: LEGACY }) }))).toBe(false);
  });

  // TEST 23
  it('warnt weiterhin, wenn gar kein Logo vorliegt', () => {
    expect(warnsAboutLogo(draft({ brandingSnapshot: { version: 1 } }))).toBe(true);
  });

  it('warnt nicht wegen des heutigen Firmenlogos', () => {
    /*
     * Das übergebene Firmenprofil trägt ein Logo, die Rechnung nicht. Die
     * Warnung gehört zur Rechnung — sie muss bestehen bleiben.
     */
    const result = validateInvoiceDraftForApproval(
      draft({ brandingSnapshot: { version: 1 } }),
      company({ branding: { logo: { ...LOGO_A } }, logoDataUrl: LEGACY }),
      undefined,
    );
    expect(result.warnings.some((warning) => warning.code === 'company_logo')).toBe(true);
  });
});

describe('BRANDING-01F-3 — Druckmodell trägt die historische Quelle', () => {
  function invoice(fields: Partial<VorgangInvoice>): VorgangInvoice {
    return {
      id: 'inv-1',
      number: '2026-0001',
      type: 'rechnung',
      positions: [],
      subtotal: 0,
      amount: 0,
      taxStatus: 'standard_19',
      status: 'vorbereitet',
      date: '2026-09-01',
      createdAt: '2026-09-01T08:00:00.000Z',
      companySnapshot: company(),
      customerSnapshot: {
        name: 'Beispiel Kundschaft GmbH',
        contactPerson: '',
        street: 'Musterweg 1',
        zip: '10115',
        city: 'Berlin',
        email: '',
        phone: '',
      },
      ...fields,
    } as unknown as VorgangInvoice;
  }

  // TEST 24
  it('überträgt die Snapshot-Referenz', () => {
    const model = buildInvoicePrintModelFromInvoice(
      invoice({ brandingSnapshot: { version: 1, logo: { ...LOGO_A } } }),
    );
    expect(model.logo).toEqual({ kind: 'asset', reference: LOGO_A });
  });

  it('überträgt das Legacy-Bild', () => {
    const model = buildInvoicePrintModelFromInvoice(
      invoice({ companySnapshot: company({ logoDataUrl: LEGACY }) }),
    );
    expect(model.logo).toEqual({ kind: 'legacy_data_url', dataUrl: LEGACY });
  });

  it('überträgt keine Quelle, wenn die Rechnung keine hat', () => {
    expect(buildInvoicePrintModelFromInvoice(invoice({})).logo).toEqual({ kind: 'none' });
  });

  it('enthält weder Bildbytes noch Pfade oder URLs', () => {
    const model = buildInvoicePrintModelFromInvoice(
      invoice({ brandingSnapshot: { version: 1, logo: { ...LOGO_A } } }),
    );
    const serialized = JSON.stringify(model.logo);
    for (const forbidden of ['storagePath', 'signedUrl', 'publicUrl', 'bytes', 'blob', 'http']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
