/**
 * REAL-PRODUCT-TEST-01D — Befund 1: Sync-Status muss sofort verständlich sein.
 *
 *  A  alles übertragen → „Synchronisiert", kein Wartehinweis
 *  B  Engine „synced", aber wartende/blockierte Änderungen → „Synchronisiert – 1 Änderung wartet"
 *     mit Grund am Eintrag, nicht schlicht grün
 *  C  fehlgeschlagene Änderungen → „{n} Änderungen nicht übertragen"
 *  D  automatisch behandelte Konflikte → verständlich benannt und mit Details, ohne Millisekunden
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { SyncPage } from './SyncPage';
import * as syncUiService from '../services/sync/syncUiService';
import { summarizeSyncStatus } from '../services/sync/syncUiService';
import type { SyncCoordinatorReport, SyncOutboxEntry } from '../types/sync';
import { describeSyncOutboxEntry } from '../services/sync/syncOutboxDescriptionService';

const setup = { ...DEFAULT_SETUP, setupComplete: true };

function report(overrides: Partial<SyncCoordinatorReport> = {}): SyncCoordinatorReport {
  return {
    startedAt: '2026-09-16T10:00:00.000Z',
    finishedAt: '2026-09-16T10:00:00.012Z',
    durationMs: 12,
    pushCount: 1,
    pullCount: 1,
    mergedEntityCount: 0,
    conflictCount: 0,
    errorCount: 0,
    completedOutboxCount: 0,
    retryAttempts: 0,
    uploadCount: 1,
    downloadCount: 0,
    syncedEntities: [],
    conflicts: [],
    errors: [],
    ...overrides,
  } as SyncCoordinatorReport;
}

function entry(overrides: Partial<SyncOutboxEntry>): SyncOutboxEntry {
  return {
    id: 'ob-1',
    entityType: 'company_profile',
    entityId: 'cp-1',
    operation: 'update',
    version: 2,
    queuedAt: '2026-09-16T09:00:00.000Z',
    retryCount: 0,
    status: 'pending',
    ...overrides,
  } as SyncOutboxEntry;
}

function snapshot(overrides: Partial<syncUiService.SyncUiSnapshot>): syncUiService.SyncUiSnapshot {
  const outbox = overrides.outbox ?? [];
  return {
    deviceId: 'device-1234567890',
    workspaceId: 'workspace-1234567890',
    syncPolicy: 'cloud_ready',
    status: { syncState: 'synced', pendingChanges: 0, lastSyncedAt: '2026-09-16T10:00:00.000Z' },
    lastReport: report(),
    outbox,
    outboxCounts: {
      pending: outbox.filter((e) => e.status === 'pending').length,
      completed: outbox.filter((e) => e.status === 'completed').length,
      error: outbox.filter((e) => e.status === 'error' || e.status === 'failed').length,
    },
    pendingOutboxEntries: outbox.filter((e) => e.status === 'pending' || e.status === 'blocked'),
    failedOutboxEntries: outbox
      .filter((e) => e.status === 'error' || e.status === 'failed' || e.status === 'blocked')
      .map(describeSyncOutboxEntry),
    settingsConflict: null,
    isOffline: false,
    hasRetryableErrors: outbox.some((e) => e.status === 'error' || e.status === 'failed'),
    ...overrides,
  };
}

function render(snap: syncUiService.SyncUiSnapshot): string {
  vi.spyOn(syncUiService, 'getSyncUiSnapshot').mockReturnValue(snap);
  return renderToStaticMarkup(
    <MemoryRouter>
      <AppProvider initialSetup={setup}>
        <SyncPage />
      </AppProvider>
    </MemoryRouter>,
  );
}

describe('REAL-PRODUCT-TEST-01D — Sync-Status', () => {
  it('A: alles übertragen', () => {
    const snap = snapshot({});
    expect(summarizeSyncStatus(snap)).toEqual({
      kind: 'synced',
      waitingCount: 0,
      failedCount: 0,
      mergedCount: 0,
      /* 01G — eigener Zähler für Konflikte, die der Nutzer entscheiden kann. */
      conflictCount: 0,
    });
    const html = render(snap);
    expect(html).toContain('Synchronisiert');
    expect(html).not.toContain('wartet');
    expect(html).not.toContain('data-testid="sync-waiting-notice"');
  });

  it('B: wartende und blockierte Änderungen sind sichtbar, mit Grund', () => {
    const snap = snapshot({
      outbox: [entry({ status: 'blocked' }), entry({ id: 'ob-2', entityType: 'document', status: 'pending' })],
    });
    expect(summarizeSyncStatus(snap).kind).toBe('waiting');
    expect(summarizeSyncStatus(snap).waitingCount).toBe(2);
    const html = render(snap);
    expect(html).toContain('Synchronisiert – 2 Änderungen warten');
    expect(html).toContain('data-testid="sync-waiting-notice"');
    expect(html).toContain('Cloud-Stand war neuer');

    const single = snapshot({ outbox: [entry({ status: 'blocked', blockedReason: 'beta_mode' })] });
    const singleHtml = render(single);
    expect(singleHtml).toContain('Synchronisiert – 1 Änderung wartet');
    expect(singleHtml).toContain('Im Testmodus wird nichts übertragen');
  });

  it('C: fehlgeschlagene Änderungen', () => {
    const snap = snapshot({
      status: { syncState: 'error', pendingChanges: 2, lastSyncedAt: undefined, lastError: 'boom' },
      outbox: [entry({ status: 'error' }), entry({ id: 'ob-2', status: 'error' })],
    });
    expect(summarizeSyncStatus(snap)).toMatchObject({ kind: 'failed', failedCount: 2 });
    const html = render(snap);
    expect(html).toContain('2 Änderungen nicht übertragen');
    expect(html).not.toContain('Synchronisiert –');
  });

  it('D: automatisch behandelte Konflikte werden verständlich benannt', () => {
    const snap = snapshot({
      lastReport: report({
        conflictCount: 2,
        conflicts: [
          { entityType: 'vorgang', entityId: 'v-1', resolution: 'remote_wins' },
          { entityType: 'customer', entityId: 'c-1', resolution: 'union' },
        ],
      }),
    });
    expect(summarizeSyncStatus(snap).mergedCount).toBe(2);
    const html = render(snap);
    expect(html).toContain('2 Änderungen wurden automatisch zusammengeführt.');
    expect(html).toContain('data-testid="sync-report-conflicts"');
    expect(html).toContain('Cloud-Stand übernommen');
    expect(html).toContain('Beide Stände zusammengeführt');
    expect(html).toContain('Automatisch zusammengeführt');
    expect(html).not.toContain('Konflikte</');
    expect(html).not.toContain('12 ms');
  });
});
