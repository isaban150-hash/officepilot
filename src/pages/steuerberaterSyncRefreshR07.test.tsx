/**
 * P1 A-04/A-02 — Abschluss-Rundgang R-07: Nach dem Monatsabschluss kommt die Serverbestätigung mit dem Sync-Lauf
 * (Antwort von `close_workspace_accounting_period`) und wird im Zustand gespeichert. Die Steuerberaterseite zeigte trotzdem
 * „wartet auf die Prüfung durch den Server“, bis sie neu geladen wurde. Jetzt leitet sie den Stand nach jedem beendeten
 * Sync-Lauf neu ab — ohne das Panel neu aufzubauen.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncSchedulerStatus } from '../services/sync/syncScheduler';

const beobachter = vi.hoisted(() => ({ liste: [] as Array<(status: SyncSchedulerStatus | null) => void> }));
vi.mock('../services/sync/syncSchedulerRuntime', async (original) => {
  const echt = await original<typeof import('../services/sync/syncSchedulerRuntime')>();
  return {
    ...echt,
    subscribeAutomaticSyncStatus: (listener: (status: SyncSchedulerStatus | null) => void) => {
      beobachter.liste.push(listener);
      return () => {
        beobachter.liste = beobachter.liste.filter((eintrag) => eintrag !== listener);
      };
    },
  };
});

import { AuthProvider } from '../context/AuthContext';
import { TestProviders } from '../test/testProviders';
import { DEFAULT_SETUP } from '../data/mockData';
import { SteuerberaterPage } from './SteuerberaterPage';
import { setExpenseStoreForTests } from '../services/expenseStore';
import { setAccountingStoreForTests } from '../services/accounting/accountingStore';
import { getAllAccountingPeriodClosures, setAccountingPeriodStoreForTests } from '../services/accounting/accountingPeriodStore';
import { closeAccountingPeriod } from '../services/accounting/accountingPeriodService';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import { resetTestStores } from '../test/resetStores';
import { alsInhaber } from '../test/workspaceRoleTestUtils';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  alsInhaber();
  resetTestStores();
  beobachter.liste = [];
  setExpenseStoreForTests([]);
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  hydrateWorkspaceStore({
    workspaceSettings: { workspaceId: '00000000-0000-0000-0000-0000000r0007', settings: { chartOfAccounts: 'SKR03' }, version: 1, updatedAt: '2026-09-01T10:00:00.000Z' },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetTestStores();
});

const periode = () => container.querySelector('[data-testid="steuerberater-period"]')?.textContent ?? '';

describe('R-07 — die Serverbestätigung erscheint ohne Neuladen', () => {
  it('nach dem beendeten Sync-Lauf zeigt die Seite „vom Server geprüft und angenommen“', async () => {
    const monat = new Date().toISOString().slice(0, 7);
    expect(closeAccountingPeriod(monat, { closedBy: 'nutzer-r07' }).success).toBe(true);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/steuerberater']}>
          <AuthProvider>
            <TestProviders initialSetup={completeSetup}>
              <SteuerberaterPage />
            </TestProviders>
          </AuthProvider>
        </MemoryRouter>,
      );
    });
    expect(periode()).toContain('wartet auf die Prüfung durch den Server');
    expect(beobachter.liste.length).toBeGreaterThan(0);

    // Der Sync-Lauf hat die Antwort gespeichert (wie applyAccountingPeriodPushResultToState) …
    const [abschluss] = getAllAccountingPeriodClosures();
    setAccountingPeriodStoreForTests([
      { ...abschluss!, server: { revision: 1, fingerprint: abschluss!.fingerprint, validiert: true, datenstand: 7, bestaetigtAm: '2026-10-27T00:10:00.000Z' } },
    ]);
    // … und meldet sein Ende.
    await act(async () => {
      for (const listener of beobachter.liste) listener({ running: false, changeQueued: false, retryScheduled: false, retriesExhausted: false, lastOutcome: null, lastFullSyncAt: Date.now() });
    });
    expect(periode()).toContain('vom Server geprüft und angenommen');
    expect(periode()).not.toContain('wartet auf die Prüfung durch den Server');
  });
});
