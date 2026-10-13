/**
 * FINANZ-CORE-01A (KUN-01) — die E-Rechnungsfelder des Empfängers überleben
 * den Weg über das Angebot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { copyCustomerBilling } from './customerBillingCopy';
import { addOfferDraft, getOfferById, resetOffers } from '../offer/offerService';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';

const KUNDE = {
  name: 'Stadt Beispielstadt',
  contactPerson: 'Bauamt',
  street: 'Rathausplatz 1',
  zip: '33602',
  city: 'Bielefeld',
  email: 'bauamt@example.invalid',
  phone: '',
  countryCode: 'DE',
  vatId: 'DE999999999',
  buyerReference: '05711-12345-67',
  leitwegId: '05711-12345-67',
};

describe('KUN-01 — vollständiger Rechnungsempfänger', () => {
  beforeEach(() => {
    resetOffers();
    resetCompanyProfile();
    hydrateCompanyProfileStore({ ...createCompanyProfileFromSetup(DEFAULT_SETUP), companyName: 'Beispiel GmbH' });
  });

  it('K1: die Kopie behält Land, USt-IdNr., Käuferreferenz und Leitweg-ID', () => {
    expect(copyCustomerBilling(KUNDE)).toEqual(KUNDE);
  });

  it('K2: leere optionale Felder werden nicht zu Platzhaltern', () => {
    const copy = copyCustomerBilling({ ...KUNDE, vatId: '  ', leitwegId: '' });
    expect(copy).not.toHaveProperty('vatId');
    expect(copy).not.toHaveProperty('leitwegId');
    expect(copy.countryCode).toBe('DE');
  });

  it('K3: ein gespeichertes Angebot trägt die E-Rechnungsfelder weiter', () => {
    const result = addOfferDraft('ws-kun01', {
      customerId: 'cust-1',
      customer: KUNDE,
      title: 'Sanierung Schule',
      baustelle: '',
      positions: [{ id: 'p1', description: 'Dach', quantity: 1, unit: 'Stück', unitPrice: 100 }],
      taxStatus: 'standard_19',
      offerDate: '2026-10-11',
      validUntil: '2026-11-11',
      introText: '',
      closingText: '',
      paymentTermsText: '',
    });
    if (!result.success) throw new Error(result.errorKey);
    const stored = getOfferById(result.offer.id)!;
    expect(stored.customer).toMatchObject({
      countryCode: 'DE',
      vatId: 'DE999999999',
      buyerReference: '05711-12345-67',
      leitwegId: '05711-12345-67',
    });
  });
});
