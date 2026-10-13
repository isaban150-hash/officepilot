/**
 * FINANZ-CORE-01A (ANG-03) — Versionskonflikt am Angebot entscheidbar.
 *
 *  K1  ein blockierter Angebotsauftrag mit Versionskonflikt ist eine Entscheidung,
 *      nicht zusätzlich „wartet" oder „nicht übertragen"
 *  K2  Online-Version verwenden: Cloud-Stand übernommen, Auftrag erledigt
 *  K3  Änderungen behalten: Inhalt bleibt, Cloud-Version wird Basis, Auftrag wartet wieder
 *  K4  Behalten geht nicht, wenn das Angebot online schon freigegeben ist
 *  K5  Freigabe und Annahme melden den Konflikt statt „wird noch gespeichert"
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as persistence from '../persistenceService';
import * as syncUi from '../sync/syncUiService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { getSyncUiSnapshot, summarizeSyncStatus } from '../sync/syncUiService';
import { resetTestStores } from '../../test/resetStores';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { getOfferById, setOfferStoreForTests } from './offerService';
import { listOfferConflicts, resolveOfferConflict } from './offerConflictService';
import { finalizeOfferWithCloud } from './offerFinalizeCloudService';
import { acceptOfferWithCloud } from './offerAcceptCloudService';
import type { WorkspaceOfferRow } from './offerCloudService';
import type { Offer } from '../../types/offer';
import type { SyncOutboxEntry } from '../../types/sync';

const WS = '00000000-0000-4000-8000-0000000fc0a3';
const OFFER_ID = 'off-ang03';

function lokal(title: string, version: number, status: Offer['status'] = 'entwurf'): Offer {
  return {
    id: OFFER_ID,
    workspaceId: WS,
    status,
    customer: { name: 'Muster Bau GmbH', contactPerson: '', street: 'Weg 6', zip: '33602', city: 'Bielefeld', email: '', phone: '' },
    title,
    baustelle: '',
    positions: [{ id: 'offer-pos-1', description: 'Montage', quantity: 2, unit: 'Stunden', unitPrice: 100 }],
    taxStatus: 'standard_19',
    offerDate: '2026-10-11',
    validUntil: '2026-11-10',
    introText: '',
    closingText: '',
    paymentTermsText: '',
    createdAt: '2026-10-11T08:00:00.000Z',
    sync: { updatedAt: '2026-10-11T08:00:00.000Z', version, deleted: false, deviceId: 'dev-b', workspaceId: WS },
  };
}

function cloudRow(title: string, version: number, status = 'entwurf', offerNumber: string | null = null): WorkspaceOfferRow {
  const offer = lokal(title, version);
  const { sync: _sync, ...payload } = offer;
  return {
    workspace_id: WS,
    client_offer_id: OFFER_ID,
    client_customer_id: null,
    offer_number: offerNumber,
    offer_sequence_number: null,
    status,
    payload: { ...payload, status, ...(offerNumber ? { offerNumber } : {}) } as unknown as Record<string, unknown>,
    row_version: version,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-10-11T09:00:00.000Z',
  };
}

function konflikt(message = 'Versionskonflikt offer:2'): SyncOutboxEntry {
  return {
    id: 'ob-off-ang03',
    entityType: 'offer',
    entityId: OFFER_ID,
    operation: 'update',
    version: 1,
    queuedAt: 'x',
    retryCount: 1,
    status: 'blocked',
    lastErrorMessage: message,
    lastErrorAt: 'x',
    lastErrorRetryable: false,
  };
}

const pullWith = (rows: WorkspaceOfferRow[]) => async () => rows;

beforeEach(() => {
  resetTestStores();
  resetSyncOutboxForTests([]);
  vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockImplementation(
    () => ({ syncClient: { serverWorkspaceId: WS, syncPolicy: 'cloud_ready' } }) as never,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  resetSyncOutboxForTests([]);
  resetTestStores();
});

describe('ANG-03 — Konflikt erkennen', () => {
  it('K1: eine Entscheidung, kein „wartet" — ein anders blockierter Auftrag ist keine', () => {
    setOfferStoreForTests([lokal('Mein Stand', 1)]);
    resetSyncOutboxForTests([konflikt()]);
    expect(listOfferConflicts()).toEqual([{ outboxId: 'ob-off-ang03', offerId: OFFER_ID, title: 'Mein Stand' }]);
    const snapshot = getSyncUiSnapshot();
    expect(snapshot.offerConflicts).toHaveLength(1);
    expect(snapshot.pendingOutboxEntries.some((entry) => entry.id === 'ob-off-ang03')).toBe(false);
    expect(snapshot.failedOutboxEntries.some((entry) => entry.outboxId === 'ob-off-ang03')).toBe(false);
    const summary = summarizeSyncStatus(snapshot);
    expect(summary.conflictCount).toBe(1);
    expect(summary.waitingCount).toBe(0);

    resetSyncOutboxForTests([konflikt('Keine Schreibberechtigung')]);
    expect(listOfferConflicts()).toEqual([]);
  });
});

describe('ANG-03 — entscheiden', () => {
  it('K2: Online-Version verwenden übernimmt den Cloud-Stand und erledigt den Auftrag', async () => {
    setOfferStoreForTests([lokal('Mein Stand', 1)]);
    resetSyncOutboxForTests([konflikt()]);
    const result = await resolveOfferConflict(OFFER_ID, 'take_cloud', { pullOffers: pullWith([cloudRow('Online-Stand', 2)]) });
    expect(result).toEqual({ ok: true, decision: 'take_cloud', cloudVersion: 2 });
    expect(getOfferById(OFFER_ID)?.title).toBe('Online-Stand');
    expect(getOfferById(OFFER_ID)?.sync?.version).toBe(2);
    expect(getSyncOutboxSnapshot().find((entry) => entry.id === 'ob-off-ang03')?.status).toBe('completed');
    expect(listOfferConflicts()).toEqual([]);
  });

  it('K3: Änderungen behalten — Inhalt bleibt, die Cloud-Version wird Basis, der Auftrag wartet wieder', async () => {
    setOfferStoreForTests([lokal('Mein Stand', 1)]);
    resetSyncOutboxForTests([konflikt()]);
    const result = await resolveOfferConflict(OFFER_ID, 'keep_local', { pullOffers: pullWith([cloudRow('Online-Stand', 2)]) });
    expect(result).toEqual({ ok: true, decision: 'keep_local', cloudVersion: 2 });
    expect(getOfferById(OFFER_ID)?.title).toBe('Mein Stand');
    expect(getOfferById(OFFER_ID)?.sync?.version).toBe(2);
    const entry = getSyncOutboxSnapshot().find((candidate) => candidate.id === 'ob-off-ang03');
    expect(entry?.status).toBe('pending');
    expect(entry?.version).toBe(2);
  });

  it('K4: online schon freigegeben — Behalten ist nicht möglich, nichts wird geändert', async () => {
    setOfferStoreForTests([lokal('Mein Stand', 1)]);
    resetSyncOutboxForTests([konflikt()]);
    const result = await resolveOfferConflict(OFFER_ID, 'keep_local', {
      pullOffers: pullWith([cloudRow('Online-Stand', 3, 'freigegeben', 'AN-2026-0009')]),
    });
    expect(result).toEqual({ ok: false, reason: 'cloud_frozen' });
    expect(getOfferById(OFFER_ID)?.title).toBe('Mein Stand');
    expect(getSyncOutboxSnapshot().find((entry) => entry.id === 'ob-off-ang03')?.status).toBe('blocked');
  });
});

describe('ANG-03 — Freigabe und Annahme benennen den Konflikt', () => {
  it('K5: „Synchronisierung entscheiden" statt „wird noch gespeichert"; kein Serveraufruf', async () => {
    const rpc = vi.fn();
    const client = { rpc } as unknown as SupabaseClient;
    vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue(undefined as never);
    // ANG-06 — ein freigabefähiger Absender, damit der Konflikt und nicht das Profil entscheidet.
    hydrateCompanyProfileStore({
      ...createCompanyProfileFromSetup(DEFAULT_SETUP),
      companyName: 'Beispiel Haustechnik GmbH',
      street: 'Musterstrasse 5',
      zip: '33602',
      city: 'Bielefeld',
    });

    setOfferStoreForTests([lokal('Mein Stand', 1)]);
    resetSyncOutboxForTests([konflikt()]);
    expect(await finalizeOfferWithCloud(OFFER_ID, client)).toEqual({ ok: false, reason: 'sync_conflict' });

    setOfferStoreForTests([lokal('Mein Stand', 1, 'versendet')]);
    resetSyncOutboxForTests([konflikt()]);
    expect(await acceptOfferWithCloud(OFFER_ID, client)).toEqual({ ok: false, reason: 'sync_conflict' });
    expect(rpc).not.toHaveBeenCalled();
  });
});
