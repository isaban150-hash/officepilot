/**
 * CUSTOMER-FACHOBJEKT-02A — local customer store, persistence and reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCompanyProfile,
  hydrateCompanyProfileStore,
} from './companyProfileService';
import { createCustomer, updateCustomer } from './customerService';
import { getCustomerById, getCustomerStoreSnapshot } from './customerStoreService';
import { clearInMemoryBusinessState } from './persistenceService';
import { bootstrapBusinessState } from './storage/storageBootstrapService';
import { hydrateInboxStore } from './inboxService';
import { createVorgangFromInbox, getVorgangById } from './vorgangService';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';

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

function bootstrapScope(workspaceId: string) {
  return bootstrapBusinessState({ userId: 'user-02a', workspaceId });
}

describe('CUSTOMER-FACHOBJEKT-02A', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    localStorage.clear();
  });

  it('Fall A — Customer anlegen', () => {
    const result = createCustomer(NORDWEST, { createdFromInboxId: 'inbox-02a' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const created = result.customer;
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(NORDWEST.name);
    expect(created.contactPerson).toBe(NORDWEST.contactPerson);
    expect(created.street).toBe(NORDWEST.street);
    expect(created.zip).toBe(NORDWEST.zip);
    expect(created.city).toBe(NORDWEST.city);
    expect(created.email).toBe(NORDWEST.email);
    expect(created.phone).toBe(NORDWEST.phone);
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBe(created.createdAt);
    expect(created.createdFromInboxId).toBe('inbox-02a');

    const read = getCustomerById(created.id)!;
    expect(read).toEqual(created);
    // Sicherer Clone: Mutation der Kopie erreicht den Store nicht.
    read.name = 'Manipuliert';
    expect(getCustomerById(created.id)?.name).toBe(NORDWEST.name);
  });

  it('Fall B — gleiche Namen bleiben getrennt', () => {
    const first = createCustomer({ ...NORDWEST, street: 'Hafenstraße 12' });
    const second = createCustomer({ ...NORDWEST, street: 'Ruhrallee 5', city: 'Bochum' });
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;

    expect(first.customer.id).not.toBe(second.customer.id);
    expect(first.customer.name).toBe(second.customer.name);
    expect(getCustomerStoreSnapshot()).toHaveLength(2);
    expect(getCustomerById(first.customer.id)?.street).toBe('Hafenstraße 12');
    expect(getCustomerById(second.customer.id)?.city).toBe('Bochum');
  });

  it('Fall C — Customer aktualisieren', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T08:00:00.000Z'));
    const created = createCustomer(NORDWEST, { createdFromInboxId: 'inbox-02a' });
    const other = createCustomer({ ...NORDWEST, name: 'Rheinbau Partner GmbH' });
    expect(created.success && other.success).toBe(true);
    if (!created.success || !other.success) {
      vi.useRealTimers();
      return;
    }
    expect(created.customer.createdAt).toBe('2026-08-13T08:00:00.000Z');

    vi.setSystemTime(new Date('2026-08-13T09:30:00.000Z'));
    const updated = updateCustomer(created.customer.id, {
      contactPerson: 'Herr Nordmann',
      street: 'Ruhrallee 5',
      phone: '0201 999999',
    });
    vi.useRealTimers();
    expect(updated.success).toBe(true);
    if (!updated.success) return;

    expect(updated.customer.id).toBe(created.customer.id);
    expect(updated.customer.createdAt).toBe(created.customer.createdAt);
    expect(updated.customer.createdAt).toBe('2026-08-13T08:00:00.000Z');
    expect(updated.customer.updatedAt).toBe('2026-08-13T09:30:00.000Z');
    expect(updated.customer.updatedAt).not.toBe(updated.customer.createdAt);
    expect(
      Date.parse(updated.customer.updatedAt) > Date.parse(updated.customer.createdAt),
    ).toBe(true);
    expect(updated.customer.createdFromInboxId).toBe('inbox-02a');
    expect(updated.customer.contactPerson).toBe('Herr Nordmann');
    expect(updated.customer.street).toBe('Ruhrallee 5');
    expect(updated.customer.phone).toBe('0201 999999');
    // Nicht übergebene Felder bleiben erhalten.
    expect(updated.customer.name).toBe(NORDWEST.name);
    expect(updated.customer.email).toBe(NORDWEST.email);

    expect(getCustomerById(other.customer.id)).toEqual(other.customer);
    expect(getCustomerStoreSnapshot()).toHaveLength(2);
  });

  it('Fall D — Validierung', () => {
    const seeded = createCustomer(NORDWEST);
    expect(seeded.success).toBe(true);
    if (!seeded.success) return;
    const before = getCustomerStoreSnapshot();

    const emptyName = createCustomer({ name: '   ' });
    expect(emptyName).toEqual({ success: false, errorKey: 'customer.nameRequired' });

    const ownCompany = createCustomer({ name: `  ${OWN.toUpperCase()}  ` });
    expect(ownCompany).toEqual({ success: false, errorKey: 'customer.ownCompanyNotAllowed' });

    const renameEmpty = updateCustomer(seeded.customer.id, { name: '  ' });
    expect(renameEmpty).toEqual({ success: false, errorKey: 'customer.nameRequired' });

    const renameOwn = updateCustomer(seeded.customer.id, { name: OWN });
    expect(renameOwn).toEqual({ success: false, errorKey: 'customer.ownCompanyNotAllowed' });

    expect(getCustomerStoreSnapshot()).toEqual(before);
  });

  it('Fall E — Persistenzfehler rollt vollständig zurück', () => {
    const seeded = createCustomer(NORDWEST);
    expect(seeded.success).toBe(true);
    if (!seeded.success) return;
    const before = getCustomerStoreSnapshot();

    // Etablierter Fehlerinjektionspunkt (vgl. persistenceDiagnostic.test.ts).
    // Keine Produktionslogik und kein persistAll gemockt.
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    const created = createCustomer({ ...NORDWEST, name: 'Rheinbau Partner GmbH' });
    expect(setItemSpy).toHaveBeenCalled();
    expect(created).toEqual({ success: false, errorKey: 'customer.persistFailed' });
    expect(getCustomerStoreSnapshot()).toEqual(before);

    const callsBeforeUpdate = setItemSpy.mock.calls.length;
    const updated = updateCustomer(seeded.customer.id, { city: 'Bochum' });
    expect(setItemSpy.mock.calls.length).toBeGreaterThan(callsBeforeUpdate);
    expect(updated).toEqual({ success: false, errorKey: 'customer.persistFailed' });
    expect(getCustomerStoreSnapshot()).toEqual(before);

    setItemSpy.mockRestore();
    expect(getCustomerStoreSnapshot()).toEqual(before);
  });

  it('Fall F — normaler Bootstrap stellt den Customer wieder her', () => {
    bootstrapScope('ws-02a');
    const created = createCustomer(NORDWEST, { createdFromInboxId: 'inbox-02a' });
    expect(created.success).toBe(true);
    if (!created.success) return;

    bootstrapScope('ws-02a');

    const reloaded = getCustomerById(created.customer.id);
    expect(reloaded).toBeDefined();
    expect(reloaded).toEqual(created.customer);
    expect(reloaded?.createdFromInboxId).toBe('inbox-02a');
    expect(reloaded?.createdAt).toBe(created.customer.createdAt);
    expect(reloaded?.updatedAt).toBe(created.customer.updatedAt);
  });

  it('Fall F2 — vollständige Stammdatenänderung übersteht Speicherverlust und Bootstrap', () => {
    bootstrapScope('ws-05a');
    const created = createCustomer(NORDWEST, { createdFromInboxId: 'inbox-05a' });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const updated = updateCustomer(created.customer.id, {
      name: 'NordWest Dachbau Nord GmbH',
      contactPerson: 'Herr Nordmann',
      street: 'Ruhrallee 5',
      zip: '44787',
      city: 'Bochum',
      email: 'neu@nordwest-dachbau.de',
      phone: '0234 999999',
    });
    expect(updated.success).toBe(true);
    if (!updated.success) return;
    expect(updated.customer.name).toBe('NordWest Dachbau Nord GmbH');
    expect(updated.customer.city).toBe('Bochum');

    // Nur der In-Memory-Zustand wird verworfen; localStorage bleibt bestehen.
    const storedKeys = Object.keys(localStorage);
    clearInMemoryBusinessState();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getCustomerById(created.customer.id)).toBeUndefined();
    expect(Object.keys(localStorage)).toEqual(storedKeys);

    bootstrapScope('ws-05a');
    const reloaded = getCustomerById(created.customer.id);
    expect(reloaded).toBeDefined();
    expect(reloaded).toEqual(updated.customer);
    expect(reloaded?.id).toBe(created.customer.id);
    expect(reloaded?.createdAt).toBe(created.customer.createdAt);
    expect(reloaded?.createdFromInboxId).toBe('inbox-05a');
  });

  it('Fall G — Workspace-Isolation über den Storage-Scope', () => {
    bootstrapScope('ws-a');
    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    if (!created.success) return;

    bootstrapScope('ws-b');
    expect(getCustomerById(created.customer.id)).toBeUndefined();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);

    bootstrapScope('ws-a');
    expect(getCustomerById(created.customer.id)).toEqual(created.customer);
  });

  it('Fall H — kein automatischer Backfill aus Vorgang.customer', () => {
    bootstrapScope('ws-02a-h');

    const item = createAuftragInboxItem({
      id: 'inbox-02a-h',
      sender: NORDWEST.name,
      recognizedData: { Kunde: NORDWEST.name },
    });
    hydrateInboxStore([item]);

    const result = createVorgangFromInbox(item);
    expect(result).not.toBeNull();
    expect(result!.vorgang.customer).toBe(NORDWEST.name);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);

    bootstrapScope('ws-02a-h');

    const reloaded = getVorgangById(result!.vorgang.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.customer).toBe(NORDWEST.name);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);

    const created = createCustomer(NORDWEST);
    expect(created.success).toBe(true);
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
  });
});
