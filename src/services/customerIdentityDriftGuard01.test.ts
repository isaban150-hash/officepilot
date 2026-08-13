/**
 * CUSTOMER-FACHOBJEKT-03B3 — a chosen customer identity and an explicitly
 * unknown customer survive later document-based contract writes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCompanyProfile, hydrateCompanyProfileStore } from './companyProfileService';
import { createCustomer } from './customerService';
import { getCustomerStoreSnapshot } from './customerStoreService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { bootstrapBusinessState } from './storage/storageBootstrapService';
import {
  mergeVorgaengeFromPull,
  stripVorgangForCloud,
  type WorkspaceVorgangRow,
} from './vorgang/vorgangCloudService';
import {
  applyContractAcceptFieldsToVorgang,
  applyContractFieldsToVorgang,
  createVorgangFromInbox,
  getVorgangById,
} from './vorgangService';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import type { CustomerDecision } from './customerService';
import type { InboxItem, Vorgang } from '../types/models';

const OWN = 'Cirmak Haustechnik GmbH';
const NORDWEST = {
  name: 'NordWest Dachbau GmbH',
  contactPerson: 'Frau Nordmann',
  street: 'Hafenstraße 12',
  zip: '45356',
  city: 'Essen',
  email: 'kontakt@nordwest-dachbau.de',
  phone: '0201 4711',
};
const RHEINBAU = 'Rheinbau Partner GmbH';

const RHEINBAU_FIELDS = {
  auftraggeber: RHEINBAU,
  ansprechpartner: 'Herr Rhein',
  telefon: '0221 3030',
  email: 'info@rheinbau-partner.de',
};

let inboxCounter = 0;

function seedItem(overrides: Partial<InboxItem> = {}): InboxItem {
  inboxCounter += 1;
  const item = createAuftragInboxItem({
    id: `inbox-03b3-${inboxCounter}`,
    sender: RHEINBAU,
    recognizedData: { Kunde: RHEINBAU },
    ...overrides,
  });
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

function bootstrapScope(workspaceId = 'ws-03b3') {
  return bootstrapBusinessState({ userId: 'user-03b3', workspaceId });
}

/** Creates one Vorgang through the atomic handoff. */
function createVorgang(decision?: CustomerDecision, item = seedItem()): Vorgang {
  const result = createVorgangFromInbox(item, undefined, 'unclear', {
    customerDecision: decision,
  });
  expect(result).not.toBeNull();
  return result!.vorgang;
}

function buildRow(vorgang: Vorgang, rowVersion: number): WorkspaceVorgangRow {
  return {
    workspace_id: 'ws-03b3',
    vorgang_id: vorgang.id,
    payload: stripVorgangForCloud(vorgang) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-08-13T10:00:00.000Z',
    updated_by: 'other-device',
  };
}

describe('CUSTOMER-FACHOBJEKT-03B3', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
  });

  afterEach(() => {
    resetTestStores();
    localStorage.clear();
  });

  function selectedNordwestVorgang(): Vorgang {
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) throw new Error('customer setup failed');
    return createVorgang({ kind: 'existing', customerId: created.customer.id });
  }

  it('Fall A — abweichender Auftraggeber ändert die Identität nicht', () => {
    for (const writer of ['fields', 'accept'] as const) {
      resetTestStores();
      hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
      const vorgang = selectedNordwestVorgang();
      const customerId = vorgang.customerId!;

      const applied =
        writer === 'fields'
          ? applyContractFieldsToVorgang(vorgang.id, { auftraggeber: RHEINBAU })
          : applyContractAcceptFieldsToVorgang(vorgang.id, { auftraggeber: RHEINBAU });
      expect(applied.success, writer).toBe(true);

      const after = getVorgangById(vorgang.id)!;
      expect(after.customer, writer).toBe(NORDWEST.name);
      expect(after.customerBilling?.name, writer).toBe(NORDWEST.name);
      expect(after.customerId, writer).toBe(customerId);
    }
  });

  it('Fall B — normalisiert gleicher Auftraggeber lässt Kontaktdaten zu', () => {
    for (const writer of ['fields', 'accept'] as const) {
      resetTestStores();
      hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
      const vorgang = selectedNordwestVorgang();

      const sameFields = {
        auftraggeber: '  nordwest   DACHBAU    gmbh  ',
        ansprechpartner: 'Herr Nordmann',
        telefon: '0201 555555',
        email: 'neu@nordwest-dachbau.de',
      };
      const applied =
        writer === 'fields'
          ? applyContractFieldsToVorgang(vorgang.id, sameFields)
          : applyContractAcceptFieldsToVorgang(vorgang.id, sameFields);
      expect(applied.success, writer).toBe(true);

      const after = getVorgangById(vorgang.id)!;
      // Gespeicherte Schreibweise bleibt unverändert.
      expect(after.customer, writer).toBe(NORDWEST.name);
      expect(after.customerBilling?.name, writer).toBe(NORDWEST.name);
      expect(after.customerId, writer).toBe(vorgang.customerId);
      // Zulässige Kontaktfelder werden übernommen.
      expect(after.customerBilling?.contactPerson, writer).toBe('Herr Nordmann');
      expect(after.customerBilling?.phone, writer).toBe('0201 555555');
      expect(after.customerBilling?.email, writer).toBe('neu@nordwest-dachbau.de');
    }
  });

  it('Fall C — kein gemischter Kundensnapshot', () => {
    const vorgang = selectedNordwestVorgang();
    const customersBefore = getCustomerStoreSnapshot();

    const applied = applyContractAcceptFieldsToVorgang(vorgang.id, RHEINBAU_FIELDS);
    expect(applied.success).toBe(true);

    const after = getVorgangById(vorgang.id)!;
    expect(after.customer).toBe(NORDWEST.name);
    expect(after.customerBilling?.name).toBe(NORDWEST.name);
    expect(after.customerBilling?.contactPerson).toBe(NORDWEST.contactPerson);
    expect(after.customerBilling?.phone).toBe(NORDWEST.phone);
    expect(after.customerBilling?.email).toBe(NORDWEST.email);
    expect(after.customerBilling?.contactPerson).not.toBe('Herr Rhein');
    expect(after.customerBilling?.phone).not.toBe('0221 3030');
    expect(after.customerBilling?.email).not.toBe('info@rheinbau-partner.de');
    expect(getCustomerStoreSnapshot()).toEqual(customersBefore);
  });

  it('Fall D — fehlender Auftraggeber lässt Kontaktdaten zu', () => {
    const vorgang = selectedNordwestVorgang();

    const applied = applyContractAcceptFieldsToVorgang(vorgang.id, {
      ansprechpartner: 'Herr Neu',
      telefon: '0201 121212',
      email: 'neu@nordwest-dachbau.de',
    });
    expect(applied.success).toBe(true);

    const after = getVorgangById(vorgang.id)!;
    expect(after.customer).toBe(NORDWEST.name);
    expect(after.customerBilling?.name).toBe(NORDWEST.name);
    expect(after.customerId).toBe(vorgang.customerId);
    expect(after.customerBilling?.contactPerson).toBe('Herr Neu');
    expect(after.customerBilling?.phone).toBe('0201 121212');
    expect(after.customerBilling?.email).toBe('neu@nordwest-dachbau.de');
  });

  it('Fall E — eigene Firma überschreibt nichts', () => {
    for (const writer of ['fields', 'accept'] as const) {
      resetTestStores();
      hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
      const vorgang = selectedNordwestVorgang();

      const ownFields = {
        auftraggeber: OWN,
        ansprechpartner: 'Herr Cirmak',
        telefon: '0201 999999',
        email: 'buero@cirmak-haustechnik.de',
      };
      const applied =
        writer === 'fields'
          ? applyContractFieldsToVorgang(vorgang.id, ownFields)
          : applyContractAcceptFieldsToVorgang(vorgang.id, ownFields);
      expect(applied.success, writer).toBe(true);

      const after = getVorgangById(vorgang.id)!;
      expect(after.customer, writer).toBe(NORDWEST.name);
      expect(after.customerBilling?.name, writer).toBe(NORDWEST.name);
      expect(after.customerBilling?.contactPerson, writer).toBe(NORDWEST.contactPerson);
      expect(after.customerBilling?.phone, writer).toBe(NORDWEST.phone);
      expect(after.customerBilling?.email, writer).toBe(NORDWEST.email);
      expect(after.customerId, writer).toBe(vorgang.customerId);
    }
  });

  it('Fall F — explicit none im unmittelbaren Vertragsannahmepfad', () => {
    const vorgang = createVorgang({ kind: 'none' });
    expect(vorgang.customerExplicitlyUnknown).toBe(true);

    const applied = applyContractAcceptFieldsToVorgang(vorgang.id, {
      ...RHEINBAU_FIELDS,
      auftraggeber: NORDWEST.name,
      bauvorhaben: 'Dachsanierung Nord',
      baustellenadresse: 'Ruhrallee 5, 45138 Essen',
    });
    expect(applied.success).toBe(true);

    const after = getVorgangById(vorgang.id)!;
    expect(after.customer).toBe('');
    expect(after.customerId).toBeUndefined();
    expect(after.customerExplicitlyUnknown).toBe(true);
    expect(after.customerBilling).toEqual({
      name: '',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    });
    // Übrige Vertragsfelder werden weiterhin übernommen.
    expect(after.title).toBe('Dachsanierung Nord');
    expect(after.baustelle).toBe('Ruhrallee 5, 45138 Essen');
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });

  it('Fall G — explicit none überlebt Bootstrap', () => {
    bootstrapScope();
    // applyContractFieldsToVorgang ersetzt den Titel nur bei leerem Titel oder
    // 'Gerade erfasst'-Präfix — dieser Vertrag bleibt unverändert.
    const created = createVorgangFromInbox(
      seedItem(),
      { title: 'Gerade erfasst: Vertragsprüfung' },
      'unclear',
      { customerDecision: { kind: 'none' } },
    );
    expect(created).not.toBeNull();
    const vorgang = created!.vorgang;
    expect(vorgang.title).toBe('Gerade erfasst: Vertragsprüfung');

    bootstrapScope();

    const reloaded = getVorgangById(vorgang.id)!;
    expect(reloaded.title).toBe('Gerade erfasst: Vertragsprüfung');
    expect(reloaded.customerExplicitlyUnknown).toBe(true);

    const applied = applyContractFieldsToVorgang(vorgang.id, {
      ...RHEINBAU_FIELDS,
      bauvorhaben: 'Dachsanierung Nord',
    });
    expect(applied.success).toBe(true);

    const after = getVorgangById(vorgang.id)!;
    expect(after.customer).toBe('');
    expect(after.customerBilling?.name).toBe('');
    expect(after.customerBilling?.contactPerson).toBe('');
    expect(after.customerBilling?.phone).toBe('');
    expect(after.customerBilling?.email).toBe('');
    expect(after.customerId).toBeUndefined();
    expect(after.customerExplicitlyUnknown).toBe(true);
    expect(after.title).toBe('Dachsanierung Nord');
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });

  it('Fall H — Legacy-Vorgänge verhalten sich unverändert', () => {
    // applyContractFieldsToVorgang: leerer Legacy-Kunde wird gefüllt.
    const legacyEmpty = createVorgang(undefined, seedItem({ sender: OWN, recognizedData: { Kunde: OWN } }));
    expect(legacyEmpty.customer).toBe('');
    expect(legacyEmpty.customerId).toBeUndefined();
    expect(legacyEmpty.customerExplicitlyUnknown).toBeUndefined();

    const appliedFields = applyContractFieldsToVorgang(legacyEmpty.id, RHEINBAU_FIELDS);
    expect(appliedFields.success).toBe(true);
    const afterFields = getVorgangById(legacyEmpty.id)!;
    expect(afterFields.customer).toBe(RHEINBAU);
    expect(afterFields.customerBilling?.name).toBe(RHEINBAU);
    expect(afterFields.customerBilling?.contactPerson).toBe('Herr Rhein');

    // applyContractAcceptFieldsToVorgang: separater Legacy-Vorgang.
    const legacyOther = createVorgang(undefined, seedItem());
    expect(legacyOther.customer).toBe(RHEINBAU);
    const appliedAccept = applyContractAcceptFieldsToVorgang(legacyOther.id, {
      auftraggeber: NORDWEST.name,
      ansprechpartner: NORDWEST.contactPerson,
      telefon: NORDWEST.phone,
      email: NORDWEST.email,
    });
    expect(appliedAccept.success).toBe(true);
    const afterAccept = getVorgangById(legacyOther.id)!;
    expect(afterAccept.customer).toBe(NORDWEST.name);
    expect(afterAccept.customerBilling?.name).toBe(NORDWEST.name);
    expect(afterAccept.customerBilling?.phone).toBe(NORDWEST.phone);
  });

  it('Fall I — Marker-Semantik aller CustomerDecision-Varianten', () => {
    const undefinedVorgang = createVorgang(undefined);
    expect(undefinedVorgang.customerExplicitlyUnknown).toBeUndefined();
    expect(undefinedVorgang.customerId).toBeUndefined();

    resetTestStores();
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
    const existingVorgang = selectedNordwestVorgang();
    expect(existingVorgang.customerExplicitlyUnknown).toBeUndefined();
    expect(existingVorgang.customerId).toBeTruthy();

    resetTestStores();
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
    const newVorgang = createVorgang({ kind: 'new', input: NORDWEST });
    expect(newVorgang.customerExplicitlyUnknown).toBeUndefined();
    expect(newVorgang.customerId).toBeTruthy();

    resetTestStores();
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
    const noneVorgang = createVorgang({ kind: 'none' });
    expect(noneVorgang.customerExplicitlyUnknown).toBe(true);
    expect(noneVorgang.customerId).toBeUndefined();
  });

  it('Fall J — Cloud-Merge erhält den lokalen Marker', () => {
    bootstrapScope();
    const local = getVorgangById(createVorgang({ kind: 'none' }).id)!;
    expect(local.customerExplicitlyUnknown).toBe(true);

    const payload = stripVorgangForCloud(local);
    expect(Object.keys(payload)).not.toContain('customerExplicitlyUnknown');
    expect((payload as Record<string, unknown>).customerExplicitlyUnknown).toBeUndefined();

    const rowVersion = local.sync?.version ?? 1;
    const merged = mergeVorgaengeFromPull(
      [local],
      [buildRow(local, rowVersion)],
      'other-device',
      'ws-03b3',
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.vorgaenge[0]?.customerExplicitlyUnknown).toBe(true);

    // Frisches Gerät: ausschließlich aus der Cloud erzeugt.
    const created = mergeVorgaengeFromPull(
      [],
      [buildRow(local, rowVersion)],
      'fresh-device',
      'ws-03b3',
    );
    expect(created.vorgaenge).toHaveLength(1);
    expect(created.vorgaenge[0]?.customerExplicitlyUnknown).toBeUndefined();
    expect(created.vorgaenge[0]?.customerId).toBeUndefined();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });
});
