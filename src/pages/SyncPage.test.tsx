import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { SyncPage } from './SyncPage';
import { MehrPage } from './MehrPage';
import { resetSyncClientForTests, createSyncClient } from '../services/sync/syncClientService';
import { resetSyncOutboxForTests } from '../services/sync/syncOutboxService';
import { resetSyncCoordinatorForTests } from '../services/sync/syncCoordinator';
import { resetLocalSyncHubForTests } from '../services/sync/syncSimulatorService';
import { resetLocalSyncAdapterStoresForTests } from '../services/sync/localSyncAdapter';
import * as syncUiService from '../services/sync/syncUiService';
import type { SyncCoordinatorReport } from '../types/sync';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

const emptyReport: SyncCoordinatorReport = {
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
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
};

type Mount = { container: HTMLDivElement; root: Root };

function renderSyncPage(initialSetup = completeSetup): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <AppProvider initialSetup={initialSetup}>
          <SyncPage />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('SyncPage', () => {
  let mounted: Mount | undefined;

  beforeEach(() => {
    resetLocalSyncHubForTests();
    resetLocalSyncAdapterStoresForTests();
    resetSyncCoordinatorForTests();
    resetSyncOutboxForTests();
    resetSyncClientForTests(createSyncClient());
    vi.restoreAllMocks();
  });

  afterEach(() => {
    act(() => {
      mounted?.root.unmount();
    });
    mounted?.container.remove();
    mounted = undefined;
  });

  it('rendert Sync-Seite mit Status und Outbox', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={completeSetup}>
          <SyncPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="sync-page"');
    expect(html).toContain('data-testid="sync-status-badge"');
    expect(html).toContain('data-testid="sync-outbox-counts"');
    expect(html).toContain('Lokale Synchronisation vorbereitet.');
    expect(html).toContain('Jetzt synchronisieren');
  });

  it('zeigt gekürzte Geräte- und Workspace-IDs', () => {
    mounted = renderSyncPage();
    const device = mounted.container.querySelector('[data-testid="sync-device-id"]');
    const workspace = mounted.container.querySelector('[data-testid="sync-workspace-id"]');
    expect(device?.textContent).toMatch(/…/);
    expect(workspace?.textContent).toMatch(/…/);
  });

  it('zeigt Offline-Hinweis bei deaktivierter Sync-Policy', () => {
    resetSyncClientForTests({
      ...createSyncClient(),
      syncPolicy: 'disabled',
    });

    mounted = renderSyncPage();
    expect(mounted.container.querySelector('[data-testid="sync-offline-hint"]')?.textContent).toContain(
      'OfficePilot arbeitet lokal weiter.',
    );
  });

  it('zeigt Outbox-Anzahl und Retry-Button bei Fehlern', () => {
    resetSyncOutboxForTests([
      {
        id: 'outbox-1',
        entityType: 'document',
        entityId: 'doc-1',
        operation: 'update',
        version: 1,
        queuedAt: new Date().toISOString(),
        retryCount: 1,
        status: 'error',
      },
    ]);

    mounted = renderSyncPage();
    expect(mounted.container.querySelector('[data-testid="sync-outbox-counts"]')?.textContent).toContain('1');
    expect(mounted.container.querySelector('[data-testid="sync-retry-button"]')).not.toBeNull();
  });

  it('ruft beim Klick auf Jetzt synchronisieren den Coordinator auf', async () => {
    const runSpy = vi.spyOn(syncUiService, 'runSyncFromUi').mockResolvedValue(emptyReport);

    mounted = renderSyncPage();
    const button = mounted.container.querySelector('[data-testid="sync-run-button"]') as HTMLButtonElement;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('zeigt pending Outbox-Einträge', () => {
    vi.spyOn(syncUiService, 'getSyncUiSnapshot').mockReturnValue({
      deviceId: 'device-1234567890',
      workspaceId: 'workspace-1234567890',
      syncPolicy: 'cloud_ready',
      status: {
        syncState: 'idle',
        pendingChanges: 1,
      },
      lastReport: null,
      outbox: [
        {
          id: 'outbox-pending-1',
          entityType: 'document',
          entityId: 'doc-pending-1234567890',
          operation: 'update',
          version: 2,
          queuedAt: '2026-03-01T10:00:00.000Z',
          retryCount: 0,
          status: 'pending',
        },
      ],
      outboxCounts: { pending: 1, completed: 0, error: 0 },
      pendingOutboxEntries: [
        {
          id: 'outbox-pending-1',
          entityType: 'document',
          entityId: 'doc-pending-1234567890',
          operation: 'update',
          version: 2,
          queuedAt: '2026-03-01T10:00:00.000Z',
          retryCount: 0,
          status: 'pending',
        },
      ],
      isOffline: false,
      hasRetryableErrors: false,
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={completeSetup}>
          <SyncPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="sync-outbox-pending-list"');
    expect(html).toContain('Dokument');
    expect(html).toContain('Aktualisieren');
    expect(html).toContain('Ausstehend');
    expect(html).not.toContain('document');
    expect(html).not.toContain('update');
  });

  it('zeigt Report-Werte nach Sync', () => {
    vi.spyOn(syncUiService, 'getSyncUiSnapshot').mockReturnValue({
      deviceId: 'device-1234567890',
      workspaceId: 'workspace-1234567890',
      syncPolicy: 'cloud_ready',
      status: {
        syncState: 'synced',
        pendingChanges: 0,
        lastSyncedAt: '2026-03-01T12:00:00.000Z',
      },
      lastReport: emptyReport,
      outbox: [],
      outboxCounts: { pending: 0, completed: 2, error: 0 },
      pendingOutboxEntries: [],
      isOffline: false,
      hasRetryableErrors: false,
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={completeSetup}>
          <SyncPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('12 ms');
    expect(html).toContain('Wiederholungen');
  });
});

describe('MehrPage sync link', () => {
  it('zeigt Link zur Synchronisation', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AuthProvider>
          <AppProvider initialSetup={completeSetup}>
            <MehrPage />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('Synchronisation');
    expect(html).toContain('/synchronisation');
  });
});
