/**
 * SYNC-AUTOMATIK-01A — die dreiseitige Zusammenführung im Einzelnen.
 *
 * `base` = Stand beim Laufstart, `local` = Speicher beim Anwenden,
 * `candidate` = Ergebnis des Laufs. Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import type { AppPersistedState, CompanyDocument } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';
import { mergeOutboxWithLocalChanges, rebaseSyncCandidateOntoLocalChanges } from './syncLocalRebaseService';

function meta(version: number, extra: Record<string, unknown> = {}) {
  return { version, updatedAt: `2026-09-26T10:0${version}:00.000Z`, deleted: false, deviceId: 'dev', workspaceId: 'ws', ...extra };
}

function doc(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return { id: 'd-1', title: 'Brief an Beispiel GmbH', fileRefId: 'f-1', sync: meta(1), ...overrides } as CompanyDocument;
}

function state(overrides: Partial<AppPersistedState> = {}): AppPersistedState {
  return {
    version: 6,
    setup: { companyName: 'Beispiel Betrieb' },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    syncOutbox: [],
    savedAt: '2026-09-26T10:00:00.000Z',
    ...overrides,
  } as AppPersistedState;
}

function outbox(overrides: Partial<SyncOutboxEntry> = {}): SyncOutboxEntry {
  return {
    id: 'o-doc',
    entityType: 'document',
    entityId: 'd-1',
    operation: 'update',
    version: 1,
    queuedAt: '2026-09-26T10:00:00.000Z',
    retryCount: 0,
    status: 'pending',
    ...overrides,
  } as SyncOutboxEntry;
}

describe('SYNC-AUTOMATIK-01A — Rebase lokaler Änderungen aus dem Lauf-Fenster', () => {
  it('archiviertes Dokument: lokale Änderung bleibt, Serverversion des eigenen Pushs wird übernommen (07B-FIX2-Vertrag)', () => {
    const base = state({ documents: [doc()], syncOutbox: [outbox()] });
    // Lokal (FIX2): Inhalt geändert, `sync` unverändert behalten.
    const local = state({
      documents: [doc({ title: 'Brief an Beispiel GmbH – ergänzt' })],
      syncOutbox: [outbox({ queuedAt: '2026-09-26T10:00:05.000Z' })],
    });
    // Lauf: den älteren Inhalt gesendet → Version 2, Auftrag erledigt.
    const candidate = state({
      documents: [doc({ sync: meta(2) })],
      syncOutbox: [outbox({ status: 'completed', sentContentKey: 'alt' })],
    });

    const result = rebaseSyncCandidateOntoLocalChanges({ base, local, candidate });
    expect(result.state.documents[0]).toMatchObject({ title: 'Brief an Beispiel GmbH – ergänzt', sync: { version: 2 } });
    expect(result.state.syncOutbox?.[0]).toMatchObject({ status: 'pending', queuedAt: '2026-09-26T10:00:05.000Z' });
    expect(result.state.syncOutbox?.[0].sentContentKey).toBeUndefined();
    expect(result).toMatchObject({ preservedLocalChanges: 1, contentConflicts: 0, reopenedOutboxEntries: 1 });
  });

  it('lokaler Grabstein bleibt, Version kommt vom Server', () => {
    const base = state({ documents: [doc()] });
    const local = state({ documents: [doc({ sync: meta(1, { deleted: true, deletedAt: '2026-09-26T10:05:00.000Z' }) })] });
    const candidate = state({ documents: [doc({ sync: meta(2) })] });
    const merged = rebaseSyncCandidateOntoLocalChanges({ base, local, candidate }).state.documents[0];
    expect(merged.sync).toMatchObject({ version: 2, deleted: true, deletedAt: '2026-09-26T10:05:00.000Z' });
  });

  it('Inhaltskonflikt: lokal bleibt vollständig mit alter Version — kein Last-Write-Wins', () => {
    const base = state({ documents: [doc()] });
    const local = state({ documents: [doc({ title: 'Lokal' })] });
    const candidate = state({ documents: [doc({ title: 'Cloud', sync: meta(3) })] });
    const result = rebaseSyncCandidateOntoLocalChanges({ base, local, candidate });
    expect(result.state.documents[0]).toMatchObject({ title: 'Lokal', sync: { version: 1 } });
    expect(result.contentConflicts).toBe(1);
  });

  it('neu gezogene und neu angelegte Einträge bleiben beide; lokal gelöschte bleiben gelöscht', () => {
    const base = state({ documents: [doc(), doc({ id: 'd-alt' })] });
    const local = state({ documents: [doc(), doc({ id: 'd-lokal-neu' })] });
    const candidate = state({ documents: [doc(), doc({ id: 'd-alt' }), doc({ id: 'd-cloud-neu' })] });
    const ids = rebaseSyncCandidateOntoLocalChanges({ base, local, candidate }).state.documents.map((item) => item.id);
    expect(ids.sort()).toEqual(['d-1', 'd-cloud-neu', 'd-lokal-neu']);
  });

  it('Dateiinhalte: lokal neu hinzugekommene Blobs bleiben neben gezogenen', () => {
    const base = state({ documentFileBlobs: { a: 'A' } });
    const local = state({ documentFileBlobs: { a: 'A', lokal: 'L' } });
    const candidate = state({ documentFileBlobs: { a: 'A', cloud: 'C' } });
    expect(rebaseSyncCandidateOntoLocalChanges({ base, local, candidate }).state.documentFileBlobs).toEqual({ a: 'A', lokal: 'L', cloud: 'C' });
  });

  it('Einzelobjekte: lokale Firmenänderung bleibt, Sync-Metadaten des Laufs kommen dazu', () => {
    const base = state({ setup: { companyName: 'Alt' } as never, setupSync: meta(1) as never });
    const local = state({ setup: { companyName: 'Neu' } as never, setupSync: meta(1) as never });
    const candidate = state({ setup: { companyName: 'Alt' } as never, setupSync: meta(2) as never });
    const merged = rebaseSyncCandidateOntoLocalChanges({ base, local, candidate }).state;
    expect(merged.setup.companyName).toBe('Neu');
    expect(merged.setupSync?.version).toBe(2);
  });

  it('Outbox: im Fenster neu eingereihte Aufträge kommen dazu, unberührte folgen dem Push-Ergebnis', () => {
    const base = [outbox({ id: 'o-a' }), outbox({ id: 'o-b', entityId: 'd-2' })];
    const local = [...base, outbox({ id: 'o-neu', entityId: 'd-3', operation: 'create' })];
    const candidate = [outbox({ id: 'o-a', status: 'completed' }), outbox({ id: 'o-b', entityId: 'd-2', status: 'blocked' })];
    const merged = mergeOutboxWithLocalChanges(base, local, candidate);
    expect(merged.outbox.map((entry) => `${entry.id}:${entry.status}`)).toEqual(['o-a:completed', 'o-b:blocked', 'o-neu:pending']);
    expect(merged.reopened).toBe(0);
  });

  it('Outbox: im Testmodus blockiert bleibt blockiert', () => {
    const base = [outbox({ status: 'blocked', blockedReason: 'beta_mode' })];
    const local = [outbox({ status: 'blocked', blockedReason: 'beta_mode', queuedAt: '2026-09-26T10:09:00.000Z' })];
    const candidate = [outbox({ status: 'blocked', blockedReason: 'beta_mode' })];
    expect(mergeOutboxWithLocalChanges(base, local, candidate).outbox[0]).toMatchObject({ status: 'blocked', blockedReason: 'beta_mode' });
  });
});
