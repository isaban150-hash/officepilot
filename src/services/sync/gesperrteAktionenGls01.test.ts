/**
 * GO-LIVE-SECURITY-01 / KONTOSPERRE — gesperrte Aktionen werden nicht nachgeholt.
 *
 * Befund (sichtbare Prüfung): Eine während der Kontosperre abgewiesene Archivlöschung blieb
 * als `error` in der Warteschlange. Die Push-Schleife sendet `pending` UND `error` bei jedem
 * automatischen Lauf (Start, Änderung, Fokus, alle 90 s) — nach dem Entsperren nahm der Server
 * die alte Löschung an.
 *
 * Geprüft am echten Sendeweg (SupabaseSyncAdapter, RPC gemockt) und am echten Abzug
 * (mergeRemoteWorkspacePullIntoState) mit Papierregister-Einträgen:
 *
 *   G1 Aktion während der Sperre abgewiesen → Endstatus `failed`, kein weiterer Versand;
 *      Konto entsperrt → der Abzug holt den Cloud-Stand zurück, die alte Löschung bleibt aus;
 *      eine neue, bewusst ausgelöste Löschung geht durch.
 *   G2 Ein vorübergehender Netzwerkfehler bleibt `error` und wird erneut gesendet.
 *   G3 Eine abgewiesene Neuanlage lädt kein Backfill nach dem Entsperren hoch; eine neue
 *      bewusste Änderung schon.
 *   G4 Finanzmeldung der Sperre (ohne 42501) ist endgültig; abgelaufene Lizenz bleibt wie bisher
 *      wiederholbar.
 *   G5 „Erneut versuchen" belebt keinen endgültig abgewiesenen Auftrag; die Zusammenführung nach
 *      dem Abzug ebenfalls nicht.
 *   G6 Einstufung, Anzeige und Zahlungsweg.
 *
 * Kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyDocument } from '../../types/models';
import type { PaperRegisterEntry } from '../../types/memory';
import type { SyncMeta, SyncOutboxEntry } from '../../types/sync';
import { stripPaperRegisterEntryForCloud, type WorkspacePaperRegisterEntryRow } from '../memory/paperRegisterCloudService';
import { getPaperRegisterEntryForDocument, hydrateMemory, resetMemory } from '../officePilotMemoryService';
import { hydrateDocumentStore } from '../documentService';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { enqueueSyncOutbox, getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { resetSyncChangeTrackerForTests, resetSyncChangeTrackerFromState } from './syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { SupabaseSyncAdapter } from './supabaseSyncAdapter';
import { retryFailedOutboxEntries, wrapStateAsVirtualDevice } from './syncSimulatorService';
import { mergeOutboxAfterPull } from './syncOutboxMergeService';
import { describeSyncOutboxEntry } from './syncOutboxDescriptionService';
import { isFinalPermissionDenialMessage, isRoleDenialFailure } from './syncRoleDenial';
import * as workspaceCloudService from '../workspace/workspaceCloudService';
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { addInvoicePaymentToCloud } from '../invoice/workspaceInvoicePaymentCloudService';
import * as supabaseLib from '../../lib/supabase';

const WORKSPACE = 'ws-sperre-gls01';
const DEVICE = 'device-sperre-gls01';
const UPDATED_AT = '2026-10-11T09:00:00.000Z';
const EINTRAG = 'paper-reg-doc-1';

const GESPERRT = 'Kein Zugriff auf Workspace';

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return { updatedAt: UPDATED_AT, version, deleted: false, deviceId: DEVICE, workspaceId: WORKSPACE, ...overrides };
}

function eintrag(overrides: Partial<PaperRegisterEntry> = {}): PaperRegisterEntry {
  return {
    id: EINTRAG,
    documentId: 'doc-1',
    documentTitle: 'Steuerbescheid 2025',
    folderId: 'ordner-steuern',
    register: 'Bescheide',
    physicalFiled: true,
    createdAt: '2026-10-05T08:00:00.000Z',
    updatedAt: '2026-10-05T08:00:00.000Z',
    ...overrides,
  };
}

function zeile(base: PaperRegisterEntry, rowVersion: number, deleted = false): WorkspacePaperRegisterEntryRow {
  return {
    workspace_id: WORKSPACE,
    client_entry_id: base.id,
    client_document_id: base.documentId,
    payload: stripPaperRegisterEntryForCloud(base) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted,
    deleted_at: deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
  };
}

function dokument(): CompanyDocument {
  return {
    id: 'doc-1',
    title: 'Steuerbescheid 2025',
    category: 'steuer',
    issuer: 'Finanzamt Musterstadt',
    recognizedText: '',
    issueDate: '2026-09-30',
    validUntil: null,
    digitalFolder: { id: 'dig-steuern', name: 'Steuern', path: '/Steuern/' },
    paperFolder: { folderId: 'ordner-steuern', register: 'Bescheide', label: 'Ordner Steuern' },
    tags: [],
    linkedCompany: 'Muster GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-10-05T08:00:00.000Z',
  };
}

function speicher(entries: PaperRegisterEntry[]): void {
  hydrateMemory({ documentMemories: [], proofMemories: [], relations: [], paperRegisterEntries: entries });
}

function pullMit(rows: WorkspacePaperRegisterEntryRow[]) {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: [],
    customers: [],
    paperRegisterEntries: rows,
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

/**
 * Einen Abzug übernehmen wie die App (applySyncPullCandidateSafely): Speicher setzen und die
 * Vergleichsbasis des Änderungsverfolgers neu legen — sonst hielte der nächste persistAll() den
 * zurückgeholten Cloud-Stand für eine lokale Änderung (Echo).
 */
function abzugUebernehmen(rows: WorkspacePaperRegisterEntryRow[]): void {
  const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit(rows));
  hydrateMemory(merged.state.officePilotMemory!);
  resetSyncChangeTrackerFromState(buildPersistedStateSnapshot());
}

function papierAuftraege(): SyncOutboxEntry[] {
  return getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'paper_register_entry');
}

/** Der Server: gesperrt (Abweisung), frei (Annahme) oder nicht erreichbar. */
function server() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  const upsert = vi.spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity');
  const adapter = new SupabaseSyncAdapter(null);
  vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue({});
  const papier = () => upsert.mock.calls.filter((call) => call[1] === 'paper_register_entry');
  return {
    upsert,
    papier,
    gesperrt(meldung = GESPERRT, code: workspaceCloudService.WorkspaceCloudErrorCode = 'rls', retryable = false) {
      upsert.mockRejectedValue(new WorkspaceCloudError(meldung, code, retryable));
    },
    frei(rowVersion: number) {
      upsert.mockResolvedValue({ rowVersion, payload: {}, entityId: null, deduped: false });
    },
    netzweg() {
      upsert.mockRejectedValue(new TypeError('Failed to fetch'));
    },
    /** Ein automatischer Lauf: sendet, was die Warteschlange zum Senden freigibt. */
    async lauf() {
      persistAll();
      return adapter.pushChanges({
        deviceId: DEVICE,
        workspaceId: WORKSPACE,
        state: buildPersistedStateSnapshot(),
        outbox: getSyncOutboxSnapshot(),
      });
    },
  };
}

/** Lokale Löschung, wie sie der Löschweg erzeugt: Grabstein mit Serverversion und Löschauftrag. */
function lokalLoeschen(version: number): SyncOutboxEntry {
  speicher([{ ...eintrag(), sync: syncMeta(version, { deleted: true, deletedAt: UPDATED_AT }) }]);
  return enqueueSyncOutbox({ entityType: 'paper_register_entry', entityId: EINTRAG, operation: 'delete', version });
}

beforeEach(() => {
  localStorage.clear();
  resetMemory();
  hydrateDocumentStore([dokument()]);
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE, serverWorkspaceId: WORKSPACE });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KONTOSPERRE — abgewiesene Aktionen werden nach dem Entsperren nicht nachgeholt', () => {
  it('G1: Löschung während der Sperre abgewiesen → entsperrt → nicht nachgeholt → neue Löschung geht durch', async () => {
    const s = server();
    const alt = lokalLoeschen(3);

    // 1. Während der Sperre: der Server weist ab.
    s.gesperrt();
    const gesperrt = await s.lauf();
    expect(gesperrt.failedOutbox).toEqual([{ outboxId: alt.id, message: GESPERRT, retryable: false }]);
    expect(papierAuftraege()).toEqual([
      expect.objectContaining({ id: alt.id, status: 'failed', lastErrorMessage: GESPERRT, lastErrorRetryable: false }),
    ]);
    expect(s.upsert).toHaveBeenCalledTimes(1);
    // Der Koordinator zieht trotzdem ab (endgültige Abweisung, kein Übertragungsfehler).
    expect(isRoleDenialFailure(gesperrt.failedOutbox[0]!)).toBe(true);

    // 2. Konto entsperrt: weitere automatische Läufe senden die alte Löschung NICHT.
    s.frei(4);
    await s.lauf();
    await s.lauf();
    expect(s.upsert).toHaveBeenCalledTimes(1);
    expect(papierAuftraege()[0]).toMatchObject({ id: alt.id, status: 'failed' });

    // 3. Der erste erfolgreiche Abzug holt den lebenden Cloud-Stand zurück und erledigt den Auftrag.
    abzugUebernehmen([zeile(eintrag(), 3)]);
    expect(getPaperRegisterEntryForDocument('doc-1')).toMatchObject({ id: EINTRAG, physicalFiled: true });
    expect(getPaperRegisterEntryForDocument('doc-1')?.sync?.deleted).toBe(false);
    expect(papierAuftraege()).toEqual([expect.objectContaining({ id: alt.id, status: 'completed' })]);
    await s.lauf();
    expect(s.papier(), 'auch nach dem Abzug kein Nachholen').toHaveLength(1);

    // 4. Eine neue, bewusst ausgelöste Löschung ist ein neuer Auftrag und geht durch.
    const neu = lokalLoeschen(3);
    expect(neu.id).not.toBe(alt.id);
    expect(neu.status).toBe('pending');
    const ergebnis = await s.lauf();
    expect(ergebnis.completedOutboxIds).toContain(neu.id);
    expect(s.papier()).toHaveLength(2);
    expect(s.papier()[1]![2]).toMatchObject({ entry_id: EINTRAG, deleted: true });
  });

  it('G2: ein vorübergehender Netzwerkfehler bleibt wiederholbar und geht beim nächsten Lauf hinaus', async () => {
    const s = server();
    speicher([{ ...eintrag({ physicalFiled: false }), sync: syncMeta(2) }]);
    const auftrag = enqueueSyncOutbox({ entityType: 'paper_register_entry', entityId: EINTRAG, operation: 'update', version: 2 });

    s.netzweg();
    const offline = await s.lauf();
    expect(offline.failedOutbox).toEqual([{ outboxId: auftrag.id, message: 'Failed to fetch', retryable: true }]);
    expect(papierAuftraege()[0]).toMatchObject({ status: 'error', lastErrorRetryable: true });
    expect(isRoleDenialFailure(offline.failedOutbox[0]!)).toBe(false);

    s.frei(3);
    const wieder = await s.lauf();
    expect(wieder.completedOutboxIds).toEqual([auftrag.id]);
    expect(s.upsert).toHaveBeenCalledTimes(2);
  });

  it('G3: eine während der Sperre abgewiesene Neuanlage lädt kein Backfill nach; eine neue Änderung schon', async () => {
    const s = server();
    speicher([eintrag()]); // nie gesendet: keine Serverversion
    const anlage = enqueueSyncOutbox({ entityType: 'paper_register_entry', entityId: EINTRAG, operation: 'create', version: 0 });

    s.gesperrt();
    await s.lauf();
    expect(papierAuftraege()).toEqual([expect.objectContaining({ id: anlage.id, status: 'failed' })]);

    // Entsperrt, erster Abzug: Die Cloud kennt den Eintrag nicht — der Backfill reiht ihn NICHT neu ein.
    s.frei(1);
    abzugUebernehmen([]);
    expect(papierAuftraege().filter((entry) => entry.status === 'pending')).toEqual([]);
    await s.lauf();
    expect(s.papier()).toHaveLength(1);
    // Lokal bleibt der Eintrag stehen (nichts geht verloren).
    expect(getPaperRegisterEntryForDocument('doc-1')?.id).toBe(EINTRAG);

    // Gegenprobe ohne Abweisung: ein Altbestand ohne Auftrag wird wie bisher nachgetragen.
    resetSyncOutboxForTests([]);
    mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([]));
    expect(papierAuftraege()).toEqual([expect.objectContaining({ operation: 'create', status: 'pending' })]);

    // Neue bewusste Änderung nach dem Entsperren: neuer Auftrag, er geht durch.
    resetSyncOutboxForTests([{ ...anlage, status: 'failed', lastErrorMessage: GESPERRT, lastErrorRetryable: false }]);
    const neu = enqueueSyncOutbox({ entityType: 'paper_register_entry', entityId: EINTRAG, operation: 'create', version: 0 });
    expect(neu.id).not.toBe(anlage.id);
    const ergebnis = await s.lauf();
    expect(ergebnis.completedOutboxIds).toContain(neu.id);
    expect(s.papier()).toHaveLength(2);
  });

  it('G4: finance_account_blocked ist endgültig, auch ohne 42501; abgelaufene Lizenz bleibt wiederholbar', async () => {
    const s = server();
    lokalLoeschen(3);
    // Der generische Schreibweg stuft finance_* als 'unknown'/wiederholbar ein — entscheidend ist die Meldung.
    s.gesperrt('finance_account_blocked: Konto ist gesperrt', 'unknown', true);
    await s.lauf();
    expect(papierAuftraege()[0]).toMatchObject({ status: 'failed', lastErrorRetryable: false });

    resetSyncOutboxForTests([]);
    lokalLoeschen(3);
    s.gesperrt('finance_license_expired: Lizenz ist abgelaufen', 'unknown', true);
    await s.lauf();
    expect(papierAuftraege()[0]).toMatchObject({ status: 'error' });
  });

  it('G5: „Erneut versuchen" und die Zusammenführung nach dem Abzug beleben keine endgültige Abweisung', () => {
    const basis: SyncOutboxEntry = {
      id: 'out-1',
      entityType: 'document',
      entityId: 'doc-1',
      operation: 'delete',
      version: 3,
      queuedAt: UPDATED_AT,
      retryCount: 1,
      status: 'failed',
      lastErrorMessage: GESPERRT,
      lastErrorRetryable: false,
    };
    const netz: SyncOutboxEntry = { ...basis, id: 'out-2', status: 'error', lastErrorMessage: 'Failed to fetch', lastErrorRetryable: true };
    const zustand = { ...buildPersistedStateSnapshot(), syncOutbox: [basis, netz] };
    const nachher = retryFailedOutboxEntries(wrapStateAsVirtualDevice(zustand)).state.syncOutbox!;
    expect(nachher.find((entry) => entry.id === 'out-1')?.status).toBe('failed');
    expect(nachher.find((entry) => entry.id === 'out-2')?.status).toBe('pending');

    const offen = { ...basis, status: 'error' as const };
    expect(mergeOutboxAfterPull({ prePull: [offen], afterPush: [basis], afterPull: [{ ...offen, status: 'pending' }] })[0]!.status).toBe('failed');
    expect(mergeOutboxAfterPull({ prePull: [offen], afterPush: [basis], afterPull: [{ ...offen, status: 'completed' }] })[0]!.status).toBe('completed');
  });
});

describe('KONTOSPERRE — Einstufung, Anzeige, Zahlungsweg', () => {
  it('G6a: endgültig sind Sperre, fehlende Mitgliedschaft und Rolle — nicht Lizenz, Netz oder Konflikt', () => {
    for (const meldung of [
      'Kein Zugriff auf Workspace',
      'Keine Schreibberechtigung',
      'account_blocked: Konto ist gesperrt',
      'finance_account_blocked: Konto ist gesperrt',
      'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht',
      'finance_account_not_approved: Konto ist nicht freigegeben',
    ]) {
      expect(isFinalPermissionDenialMessage(meldung), meldung).toBe(true);
    }
    for (const meldung of ['finance_license_expired: Lizenz ist abgelaufen', 'Failed to fetch', 'Versionskonflikt', '', undefined]) {
      expect(isFinalPermissionDenialMessage(meldung), String(meldung)).toBe(false);
    }
  });

  it('G6b: die Sync-Seite nennt die Abweisung „keine Berechtigung", nicht „unbekannt"', () => {
    const eintragFuer = (meldung: string): SyncOutboxEntry => ({
      id: 'out-x',
      entityType: 'document',
      entityId: 'doc-1',
      operation: 'delete',
      version: 1,
      queuedAt: UPDATED_AT,
      retryCount: 1,
      status: 'failed',
      lastErrorMessage: meldung,
      lastErrorRetryable: false,
    });
    for (const meldung of ['Kein Zugriff auf Workspace', 'Keine Schreibberechtigung', 'account_blocked: Konto ist gesperrt']) {
      expect(describeSyncOutboxEntry(eintragFuer(meldung)).reasonKey, meldung).toBe('sync.failure.reason.permission');
    }
  });

  it('G6c: Zahlung — „Kein Zugriff" und account_blocked sind eine endgültige Abweisung (das Formular nimmt zurück)', async () => {
    for (const meldung of ['Kein Zugriff auf Workspace', 'account_blocked: Konto ist gesperrt', 'finance_account_blocked: Konto ist gesperrt']) {
      const client = { rpc: vi.fn(async () => ({ data: null, error: { message: meldung } })) };
      const result = await addInvoicePaymentToCloud(
        { clientInvoiceId: 'inv-1', clientPaymentId: 'pay-1', amount: 10, paidOn: '2026-10-11' },
        { client: client as never, workspaceId: WORKSPACE },
      );
      expect(result.outcome, meldung).toBe('denied');
    }
    const netz = { rpc: vi.fn(async () => ({ data: null, error: { message: 'Failed to fetch' } })) };
    const result = await addInvoicePaymentToCloud(
      { clientInvoiceId: 'inv-1', clientPaymentId: 'pay-1', amount: 10, paidOn: '2026-10-11' },
      { client: netz as never, workspaceId: WORKSPACE },
    );
    expect(result.outcome).toBe('failed');
  });
});
