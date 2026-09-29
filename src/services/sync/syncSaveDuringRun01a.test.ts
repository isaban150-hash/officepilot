/**
 * SYNC-AUTOMATIK-01A — Erkenntnis 1: Speichern während eines laufenden Syncs.
 *
 * Der Lauf rechnet auf dem Stand seines Starts. Speichert der Nutzer, während
 * Push/Pull noch unterwegs sind, darf das spätere Anwenden des Ergebnisses
 * diese neue Eingabe weder lokal überschreiben noch ihren Sendeauftrag als
 * erledigt schliessen.
 *
 * Geprüft über den produktiven Weg (`runSyncFromUi` → Coordinator →
 * `applySyncPullCandidateSafely`) mit echten Speichern; nur der Cloud-Adapter
 * ist ein steuerbarer Ersatz, der wie der echte nach einem Push allein die
 * Serverversion übernimmt.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPersistedStateSnapshot, getLocalMutationRevision } from '../persistenceService';
import { createCustomer, updateCustomer } from '../customerService';
import { getCustomerById } from '../customerStoreService';
import { bootstrapBusinessState } from '../storage/storageBootstrapService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import { createSyncClient, hydrateSyncClient, resetSyncClientForTests } from './syncClientService';
import { getSyncCoordinator, resetSyncCoordinatorForTests } from './syncCoordinator';
import { applySyncPullCandidateSafely } from './syncPullPersistService';
import { runSyncFromUi } from './syncUiService';
import { resetSyncOperationQueueForTests } from './syncOperationQueue';
import { createEmptySyncSimulationReport } from './syncSimulationReportService';
import { resetTestStores } from '../../test/resetStores';
import type { SyncAdapter, SyncPullInput, SyncPushInput } from './syncAdapter';
import type { AppPersistedState, Customer } from '../../types/models';

const WORKSPACE = 'ws-save-during-run-01a';
const USER = 'user-save-during-run-01a';

interface SentWrite {
  entityId: string;
  name: string;
  rowVersion: number;
}

/** Steuerbarer Cloud-Ersatz: Push übernimmt nur die Serverversion, Pull wartet auf Freigabe. */
function createControlledAdapter() {
  const server = new Map<string, { name: string; rowVersion: number }>();
  const sent: SentWrite[] = [];
  let releasePull: (() => void) | null = null;
  let pullStarted: (() => void) | null = null;
  let holdPull = false;
  /** Optional: der Pull bringt eine Änderung eines anderen Geräts mit. */
  let remoteEdit: ((state: AppPersistedState) => AppPersistedState) | null = null;

  const adapter: SyncAdapter = {
    providerKind: 'supabase',
    async pushChanges(input: SyncPushInput) {
      const completed: string[] = [];
      let customers = [...(input.state.customers ?? [])];
      const outbox = (input.outbox ?? []).map((entry) => ({ ...entry }));
      for (const entry of outbox) {
        if (entry.entityType !== 'customer' || (entry.status !== 'pending' && entry.status !== 'error')) continue;
        const customer = customers.find((candidate) => candidate.id === entry.entityId);
        if (!customer) continue;
        const expected = customer.sync?.version ?? 0;
        const current = server.get(customer.id)?.rowVersion ?? 0;
        sent.push({ entityId: customer.id, name: customer.name, rowVersion: expected });
        if (expected !== current) {
          entry.status = 'blocked';
          continue;
        }
        const next = current + 1;
        server.set(customer.id, { name: customer.name, rowVersion: next });
        customers = customers.map((candidate) =>
          candidate.id === customer.id
            ? ({
                ...candidate,
                sync: {
                  version: next,
                  updatedAt: '2026-09-26T10:00:00.000Z',
                  deleted: false,
                  deviceId: input.deviceId,
                  workspaceId: WORKSPACE,
                },
              } as Customer)
            : candidate,
        );
        entry.status = 'completed';
        completed.push(entry.id);
      }
      return {
        success: true,
        state: { ...input.state, customers, syncOutbox: outbox },
        completedOutboxIds: completed,
        failedOutbox: [],
        report: createEmptySyncSimulationReport(new Date().toISOString()),
      };
    },
    async pullChanges(input: SyncPullInput) {
      pullStarted?.();
      if (holdPull) {
        await new Promise<void>((resolve) => {
          releasePull = resolve;
        });
      }
      const state = remoteEdit ? remoteEdit(input.state) : input.state;
      return {
        success: true,
        state,
        report: createEmptySyncSimulationReport(new Date().toISOString()),
      };
    },
    async acknowledgeChanges() {},
    async reserveInvoiceNumber() {
      throw new Error('not used');
    },
    async uploadBlob() {
      throw new Error('not used');
    },
    async downloadBlob() {
      return null;
    },
    getSyncStatus() {
      return { syncState: 'idle', pendingChanges: 0 };
    },
  };

  return {
    adapter,
    server,
    sent,
    /** Hält den nächsten Pull an; liefert ein Promise, das beim Pull-Start erfüllt wird. */
    holdNextPull(): Promise<void> {
      holdPull = true;
      return new Promise<void>((resolve) => {
        pullStarted = resolve;
      });
    },
    releasePull() {
      holdPull = false;
      pullStarted = null;
      releasePull?.();
      releasePull = null;
    },
    setRemoteEdit(edit: ((state: AppPersistedState) => AppPersistedState) | null) {
      remoteEdit = edit;
    },
  };
}

function customerOutbox(customerId: string) {
  return getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'customer' && entry.entityId === customerId);
}

function storedCustomer(customerId: string): Customer | undefined {
  const key = Object.keys(localStorage).find((candidate) => candidate.startsWith('officepilot-state:'));
  if (!key) return undefined;
  const stored = JSON.parse(localStorage.getItem(key)!) as AppPersistedState;
  return stored.customers?.find((customer) => customer.id === customerId);
}

function newCustomer(name: string): Customer {
  const created = createCustomer({ name, street: 'Beispielstraße 1', zip: '20000', city: 'Beispielstadt' });
  if (!created.success) throw new Error('create failed');
  return created.customer;
}

describe('SYNC-AUTOMATIK-01A — Speichern während eines laufenden Syncs', () => {
  let cloud: ReturnType<typeof createControlledAdapter>;

  beforeEach(async () => {
    localStorage.clear();
    resetTestStores();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
    resetSyncCoordinatorForTests();
    resetSyncOperationQueueForTests();
    hydrateSyncClient({ ...createSyncClient(), workspaceId: WORKSPACE, syncPolicy: 'cloud_ready' });
    bootstrapBusinessState({ userId: USER, workspaceId: WORKSPACE });
    cloud = createControlledAdapter();
    getSyncCoordinator().setAdapter(cloud.adapter);
  });

  async function syncedCustomer(name: string): Promise<Customer> {
    const customer = newCustomer(name);
    await runSyncFromUi();
    expect(getCustomerById(customer.id)?.sync?.version).toBe(1);
    expect(customerOutbox(customer.id).every((entry) => entry.status === 'completed')).toBe(true);
    return customer;
  }

  it('Test 1 / A–E: Save während des Laufs bleibt erhalten und wird mit der richtigen Version gesendet', async () => {
    const customer = await syncedCustomer('Beispiel Bau GmbH');

    // Änderung 1 — sie ist es, die der kommende Lauf sendet.
    expect(updateCustomer(customer.id, { name: 'Beispiel Bau GmbH – Änderung 1' }).success).toBe(true);

    // A. Sync startet; der Pull wird angehalten.
    const pullReached = cloud.holdNextPull();
    const run = runSyncFromUi();
    await pullReached;
    expect(cloud.server.get(customer.id)).toEqual({ name: 'Beispiel Bau GmbH – Änderung 1', rowVersion: 2 });

    // B. Während der Lauf noch unterwegs ist, speichert der Nutzer erneut.
    const revisionBefore = getLocalMutationRevision();
    expect(updateCustomer(customer.id, { name: 'Beispiel Bau GmbH – Änderung 2' }).success).toBe(true);
    expect(getLocalMutationRevision()).toBe(revisionBefore + 1);

    // C. Das Pull-Ergebnis des älteren Laufs kommt zurück.
    cloud.releasePull();
    const report = await run;
    expect(report.errorCount).toBe(0);

    // D. Die neue lokale Änderung ist erhalten — im Speicher und persistiert.
    expect(getCustomerById(customer.id)?.name).toBe('Beispiel Bau GmbH – Änderung 2');
    expect(storedCustomer(customer.id)?.name).toBe('Beispiel Bau GmbH – Änderung 2');
    // … und steht auf der bestätigten Serverversion des eben gesendeten Stands.
    expect(getCustomerById(customer.id)?.sync?.version).toBe(2);

    // E. Der Auftrag ist nicht als erledigt geschlossen, sondern wartet.
    const offen = customerOutbox(customer.id).filter((entry) => entry.status === 'pending');
    expect(offen).toHaveLength(1);
    expect(offen[0].sentContentKey).toBeUndefined();

    // Der nächste Lauf sendet genau diese Änderung mit der erwarteten Version.
    await runSyncFromUi();
    expect(cloud.sent.at(-1)).toEqual({ entityId: customer.id, name: 'Beispiel Bau GmbH – Änderung 2', rowVersion: 2 });
    expect(cloud.server.get(customer.id)).toEqual({ name: 'Beispiel Bau GmbH – Änderung 2', rowVersion: 3 });
    expect(customerOutbox(customer.id).every((entry) => entry.status === 'completed')).toBe(true);
    expect(getCustomerById(customer.id)?.sync?.version).toBe(3);
  });

  it('Gegenprobe: ohne Laufstart-Basis (alter Weg) ginge genau diese Änderung verloren', async () => {
    const customer = await syncedCustomer('Beispiel Gegenprobe GmbH');
    const staleCandidate = buildPersistedStateSnapshot();
    expect(updateCustomer(customer.id, { name: 'Nach dem Laufstart gespeichert' }).success).toBe(true);

    applySyncPullCandidateSafely({
      state: staleCandidate,
      report: { ...createEmptySyncSimulationReport(new Date().toISOString()), retryAttempts: 0, uploadCount: 0, downloadCount: 0 },
    });
    // Beleg für den behobenen Fehler: der alte Kandidat überschreibt die Eingabe.
    expect(getCustomerById(customer.id)?.name).toBe('Beispiel Gegenprobe GmbH');
  });

  it('Test 2: mehrere Saves während eines Laufs — alle bleiben erhalten und sendbar', async () => {
    const first = await syncedCustomer('Beispiel Erst GmbH');
    expect(updateCustomer(first.id, { name: 'Beispiel Erst GmbH – gesendet' }).success).toBe(true);

    const pullReached = cloud.holdNextPull();
    const run = runSyncFromUi();
    await pullReached;

    // Drei schnelle Saves: zweimal derselbe Kunde, einmal ein neuer.
    expect(updateCustomer(first.id, { city: 'Beispielstadt Nord' }).success).toBe(true);
    expect(updateCustomer(first.id, { name: 'Beispiel Erst GmbH – zuletzt' }).success).toBe(true);
    const second = newCustomer('Beispiel Neu GmbH');

    cloud.releasePull();
    await run;

    expect(getCustomerById(first.id)).toMatchObject({ name: 'Beispiel Erst GmbH – zuletzt', city: 'Beispielstadt Nord' });
    expect(getCustomerById(first.id)?.sync?.version).toBe(2);
    expect(getCustomerById(second.id)?.name).toBe('Beispiel Neu GmbH');
    expect(storedCustomer(first.id)).toMatchObject({ name: 'Beispiel Erst GmbH – zuletzt', city: 'Beispielstadt Nord' });
    expect(storedCustomer(second.id)?.name).toBe('Beispiel Neu GmbH');
    expect(customerOutbox(first.id).filter((entry) => entry.status === 'pending')).toHaveLength(1);
    expect(customerOutbox(second.id).filter((entry) => entry.status === 'pending')).toHaveLength(1);

    await runSyncFromUi();
    expect(cloud.server.get(first.id)).toEqual({ name: 'Beispiel Erst GmbH – zuletzt', rowVersion: 3 });
    expect(cloud.server.get(second.id)).toEqual({ name: 'Beispiel Neu GmbH', rowVersion: 1 });
    expect(getSyncOutboxSnapshot().filter((entry) => entry.status === 'pending')).toHaveLength(0);
  });

  it('echter Konflikt im Lauf-Fenster: lokal bleibt, alte Version bleibt — der Server entscheidet (kein Last-Write-Wins)', async () => {
    const customer = await syncedCustomer('Beispiel Konflikt GmbH');

    // Ein anderes Gerät ändert denselben Kunden; der Pull bringt es mit.
    cloud.server.set(customer.id, { name: 'Anderes Gerät', rowVersion: 2 });
    cloud.setRemoteEdit((state) => ({
      ...state,
      customers: (state.customers ?? []).map((candidate) =>
        candidate.id === customer.id
          ? ({ ...candidate, name: 'Anderes Gerät', sync: { ...candidate.sync!, version: 2 } } as Customer)
          : candidate,
      ),
    }));

    const pullReached = cloud.holdNextPull();
    const run = runSyncFromUi();
    await pullReached;
    expect(updateCustomer(customer.id, { name: 'Dieses Gerät' }).success).toBe(true);
    cloud.releasePull();
    await run;

    // Lokal nichts verloren, und die Version wurde nicht still auf die fremde gehoben.
    expect(getCustomerById(customer.id)?.name).toBe('Dieses Gerät');
    expect(getCustomerById(customer.id)?.sync?.version).toBe(1);

    // Der nächste Push trägt die alte Version → der Server lehnt ab, nichts wird überschrieben.
    cloud.setRemoteEdit(null);
    await runSyncFromUi();
    expect(cloud.server.get(customer.id)).toEqual({ name: 'Anderes Gerät', rowVersion: 2 });
    expect(customerOutbox(customer.id).some((entry) => entry.status === 'blocked')).toBe(true);
  });

  it('Cloud-Änderung an einer anderen Entität und lokaler Save im Lauf-Fenster: beide bleiben', async () => {
    const lokal = await syncedCustomer('Beispiel Lokal GmbH');
    const fremd = await syncedCustomer('Beispiel Fremd GmbH');

    cloud.setRemoteEdit((state) => ({
      ...state,
      customers: (state.customers ?? []).map((candidate) =>
        candidate.id === fremd.id
          ? ({ ...candidate, city: 'Neue Stadt', sync: { ...candidate.sync!, version: 2 } } as Customer)
          : candidate,
      ),
    }));
    const pullReached = cloud.holdNextPull();
    const run = runSyncFromUi();
    await pullReached;
    expect(updateCustomer(lokal.id, { phone: '040 000000' }).success).toBe(true);
    cloud.releasePull();
    await run;

    expect(getCustomerById(lokal.id)?.phone).toBe('040 000000');
    expect(getCustomerById(fremd.id)).toMatchObject({ city: 'Neue Stadt' });
    expect(getCustomerById(fremd.id)?.sync?.version).toBe(2);
  });

  it('ohne Save im Lauf-Fenster bleibt der bisherige Weg unverändert', async () => {
    const customer = await syncedCustomer('Beispiel Ruhig GmbH');
    expect(updateCustomer(customer.id, { name: 'Beispiel Ruhig GmbH – neu' }).success).toBe(true);
    await runSyncFromUi();
    expect(getCustomerById(customer.id)?.sync?.version).toBe(2);
    expect(customerOutbox(customer.id).every((entry) => entry.status === 'completed')).toBe(true);
  });
});
