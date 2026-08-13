/**
 * CUSTOMER-OWN-COMPANY-GUARD-01 — the own company must never become Vorgang.customer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCompanyProfile,
  hydrateCompanyProfileStore,
} from './companyProfileService';
import { hydrateInboxStore } from './inboxService';
import {
  applyContractAcceptFieldsToVorgang,
  applyContractFieldsToVorgang,
  createVorgangFromInbox,
  getVorgangById,
} from './vorgangService';
import { buildVorgangDraftFromInbox } from './vorgangMatchingService';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import type { InboxItem } from '../types/models';

const OWN = 'Cirmak Haustechnik GmbH';
const EXTERNAL = 'NordWest Dachbau GmbH';

function seed(overrides: Partial<InboxItem> = {}): InboxItem {
  const item = createAuftragInboxItem({ id: 'inbox-own-company-guard-01', ...overrides });
  hydrateInboxStore([item]);
  return item;
}

function createVorgangWithCustomer(customer: string) {
  const item = seed({ sender: customer, recognizedData: { Kunde: customer } });
  const result = createVorgangFromInbox(item);
  expect(result).not.toBeNull();
  return result!.vorgang;
}

describe('CUSTOMER-OWN-COMPANY-GUARD-01', () => {
  beforeEach(() => {
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
  });

  afterEach(() => {
    resetTestStores();
  });

  it('Fall A — externe Counterparty gewinnt, eigene Firma wird nicht gespeichert', () => {
    const item = seed({ sender: OWN, recognizedData: { Kunde: OWN } });
    const draft = buildVorgangDraftFromInbox(item, 'unclear', { customer: EXTERNAL });
    expect(draft.customer).toBe(EXTERNAL);

    const result = createVorgangFromInbox(item, { customer: EXTERNAL });
    expect(result?.vorgang.customer).toBe(EXTERNAL);
    expect(result?.vorgang.customer).not.toBe(OWN);
    expect(result?.vorgang.customerBilling?.name).toBe(EXTERNAL);
  });

  it('Fall B — Own-Company im Fallback wird übersprungen, nächster Kandidat gewinnt', () => {
    const item = seed({ sender: EXTERNAL, recognizedData: { Kunde: OWN } });
    const draft = buildVorgangDraftFromInbox(item);
    expect(draft.customer).toBe(EXTERNAL);

    const result = createVorgangFromInbox(item);
    expect(result?.vorgang.customer).toBe(EXTERNAL);
  });

  it('Fall C — nur Own-Company-Kandidaten führen zum Unbekannt-Zustand', () => {
    const item = seed({ sender: `  ${OWN.toUpperCase()}  `, recognizedData: { Kunde: OWN } });
    const draft = buildVorgangDraftFromInbox(item);
    expect(draft.customer).toBe('');

    const result = createVorgangFromInbox(item);
    expect(result).not.toBeNull();
    const stored = getVorgangById(result!.vorgang.id)!;
    expect(stored.customer).toBe('');
    expect(stored.customer).not.toBe(OWN);
    expect(stored.customerBilling?.name).toBe('');
  });

  it('Fall D — kein zu breites Matching bei geteilten Wortbestandteilen', () => {
    const similar = 'Cirmak Dachbau GmbH';
    const item = seed({ sender: 'Haustechnik Nord GmbH', recognizedData: { Kunde: similar } });
    const draft = buildVorgangDraftFromInbox(item);
    expect(draft.customer).toBe(similar);

    const result = createVorgangFromInbox(item);
    expect(result?.vorgang.customer).toBe(similar);
  });

  it('Fall E — eigener Auftraggeber verwirft alle Kundenfelder, externe bleiben unberührt', () => {
    const vorgang = createVorgangWithCustomer(EXTERNAL);
    expect(vorgang.customer).toBe(EXTERNAL);

    // Bestehende externe Kundenkontaktdaten über den produktiven Vertragspfad setzen.
    const seeded = applyContractFieldsToVorgang(vorgang.id, {
      auftraggeber: EXTERNAL,
      ansprechpartner: 'Frau Nordmann',
      telefon: '0251 4711',
      email: 'kontakt@nordwest-dachbau.de',
    });
    expect(seeded.success).toBe(true);
    expect(getVorgangById(vorgang.id)?.customerBilling?.contactPerson).toBe('Frau Nordmann');

    const ownFields = {
      auftraggeber: OWN,
      ansprechpartner: 'Herr Cirmak',
      telefon: '0201 999999',
      email: 'buero@cirmak-haustechnik.de',
      baustellenadresse: 'Ruhrallee 5, 45138 Essen',
    };

    const applied = applyContractFieldsToVorgang(vorgang.id, ownFields);
    expect(applied.success).toBe(true);

    const afterApply = getVorgangById(vorgang.id)!;
    expect(afterApply.customer).toBe(EXTERNAL);
    expect(afterApply.customerBilling?.name).toBe(EXTERNAL);
    expect(afterApply.customerBilling?.contactPerson).toBe('Frau Nordmann');
    expect(afterApply.customerBilling?.phone).toBe('0251 4711');
    expect(afterApply.customerBilling?.email).toBe('kontakt@nordwest-dachbau.de');
    expect(afterApply.customerBilling?.contactPerson).not.toBe('Herr Cirmak');
    expect(afterApply.customerBilling?.phone).not.toBe('0201 999999');
    expect(afterApply.customerBilling?.email).not.toBe('buero@cirmak-haustechnik.de');
    // Nicht kundenbezogenes Vertragsfeld bleibt übernehmbar.
    expect(afterApply.baustelle).toBe('Ruhrallee 5, 45138 Essen');

    const accepted = applyContractAcceptFieldsToVorgang(vorgang.id, {
      ...ownFields,
      baustellenadresse: 'Hafenstraße 12, 45356 Essen',
    });
    expect(accepted.success).toBe(true);

    const afterAccept = getVorgangById(vorgang.id)!;
    expect(afterAccept.customer).toBe(EXTERNAL);
    expect(afterAccept.customerBilling?.name).toBe(EXTERNAL);
    expect(afterAccept.customerBilling?.contactPerson).toBe('Frau Nordmann');
    expect(afterAccept.customerBilling?.phone).toBe('0251 4711');
    expect(afterAccept.customerBilling?.email).toBe('kontakt@nordwest-dachbau.de');
    expect(afterAccept.baustelle).toBe('Hafenstraße 12, 45356 Essen');
  });

  it('Fall F — externe Vertragspartei bleibt unverändert zulässig', () => {
    const vorgang = createVorgangWithCustomer(EXTERNAL);
    const other = 'Rheinbau Partner GmbH';

    const accepted = applyContractAcceptFieldsToVorgang(vorgang.id, {
      auftraggeber: other,
      ansprechpartner: 'Herr Rhein',
      telefon: '0221 3030',
      email: 'info@rheinbau-partner.de',
    });
    expect(accepted.success).toBe(true);

    const afterAccept = getVorgangById(vorgang.id)!;
    expect(afterAccept.customer).toBe(other);
    expect(afterAccept.customerBilling?.name).toBe(other);
    expect(afterAccept.customerBilling?.contactPerson).toBe('Herr Rhein');
    expect(afterAccept.customerBilling?.phone).toBe('0221 3030');
    expect(afterAccept.customerBilling?.email).toBe('info@rheinbau-partner.de');
  });
});
