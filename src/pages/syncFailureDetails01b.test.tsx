/**
 * FINANZ-SYNC-BLOCKER-01B — die Sync-Seite sagt jetzt, **was** nicht durchkam.
 *
 * Die Gesamtabnahme hatte nur „3 Änderungen nicht übertragen" gezeigt. Für den
 * Betrieb ist das zu wenig: Es sagt weder, welcher Beleg betroffen ist, noch ob
 * Warten hilft oder ob jemand etwas entscheiden muss.
 *
 * Geprüft wird ausserdem, was **nicht** dasteht: keine Enum-Werte, keine
 * Rohtexte aus der Datenbank.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { SyncPage } from './SyncPage';
import * as syncUiService from '../services/sync/syncUiService';
import type { SyncOutboxDescription } from '../services/sync/syncOutboxDescriptionService';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

function failure(overrides: Partial<SyncOutboxDescription> = {}): SyncOutboxDescription {
  return {
    id: 'ob-1',
    entityType: 'accounting_assignment',
    entityId: 'k-1',
    kind: 'error',
    label: 'RE-2026-0024 · 3400',
    reasonKey: 'sync.failure.reason.notDeployed',
    retryable: true,
    attempts: 4,
    ...overrides,
  };
}

function snapshot(overrides: Partial<syncUiService.SyncUiSnapshot> = {}): syncUiService.SyncUiSnapshot {
  return {
    deviceId: 'device-1234567890',
    workspaceId: 'workspace-1234567890',
    syncPolicy: 'cloud_ready',
    status: { syncState: 'error', pendingChanges: 3, lastSyncedAt: '2026-09-16T10:00:00.000Z' },
    lastReport: null,
    outbox: [],
    outboxCounts: { pending: 0, completed: 0, error: 3 },
    pendingOutboxEntries: [],
    failedOutboxEntries: [],
    settingsConflict: null,
    isOffline: false,
    hasRetryableErrors: true,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function zeige(value: syncUiService.SyncUiSnapshot): void {
  vi.spyOn(syncUiService, 'getSyncUiSnapshot').mockReturnValue(value);
  act(() => {
    root.render(
      <MemoryRouter>
        <AppProvider initialSetup={completeSetup}>
          <SyncPage />
        </AppProvider>
      </MemoryRouter>,
    );
  });
}

const text = () => container.textContent ?? '';
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('N — Fehlerdetails auf der Sync-Seite', () => {
  it('N5: Datentyp, Bezeichnung, Grund und Wiederholbarkeit stehen da', () => {
    zeige(snapshot({ failedOutboxEntries: [failure()] }));

    expect(q('sync-failures'), 'der Abschnitt fehlt').not.toBeNull();
    expect(text()).toContain('Kontierung');
    expect(text()).toContain('RE-2026-0024 · 3400');
    expect(text()).toContain('Die Cloud kennt diesen Datentyp noch nicht.');
    expect(text()).toContain('Erneuter Versuch möglich');
  });

  it('N6: ein Konflikt wird als Konflikt ausgewiesen, nicht als Fehler', () => {
    zeige(
      snapshot({
        failedOutboxEntries: [
          failure({
            entityType: 'workspace_settings',
            kind: 'conflict',
            label: 'chartOfAccounts',
            reasonKey: 'sync.failure.reason.conflict',
            retryable: false,
          }),
        ],
      }),
    );

    expect(text()).toContain('Konflikt');
    expect(text()).toContain('Betriebseinstellungen');
    expect(text()).toContain('Erneuter Versuch ändert nichts');
  });

  it('N7: kein Enum-Wert und kein Rohtext im sichtbaren Bereich', () => {
    zeige(
      snapshot({
        failedOutboxEntries: [failure(), failure({ id: 'ob-2', entityType: 'accounting_period_closure', label: '2026-07 · Revision 1' })],
      }),
    );

    const sichtbar = q('sync-failures')!.textContent ?? '';
    expect(sichtbar).not.toMatch(/accounting_assignment|accounting_period_closure/);
    expect(sichtbar).not.toMatch(/sync\.failure\./);
    expect(sichtbar).not.toMatch(/Unbekannter Entity-Typ|PGRST/);
  });

  /*
   * FINANZ-SYNC-BLOCKER-01F — der Hinweis sagte „Verloren geht nichts.", auch
   * neben einem Konflikt, in dem gerade eine lokale Einstellung verschwunden
   * war. Er sagt jetzt nur noch, was nachweislich stimmt.
   */
  it('N8: der Hinweis nennt den Zustand, ohne eine Zusage zu machen', () => {
    zeige(snapshot({ failedOutboxEntries: [failure()] }));
    expect(text()).toContain('nicht übertragen und liegen weiterhin auf diesem Gerät');
    expect(text()).not.toContain('Verloren geht nichts');
  });

  it('N9: ohne Fehlschläge erscheint der Abschnitt nicht', () => {
    zeige(snapshot());
    expect(q('sync-failures')).toBeNull();
  });
});

describe('M — die offene Entscheidung zu den Einstellungen', () => {
  it('M3: der Konflikt wird benannt und bietet beide Wege an', () => {
    zeige(
      snapshot({
        settingsConflict: [{ key: 'chartOfAccounts', localValue: 'SKR03', cloudValue: 'SKR04' }],
      }),
    );

    expect(q('sync-settings-conflict')).not.toBeNull();
    expect(text()).toContain('chartOfAccounts: hier „SKR03“, in der Cloud „SKR04“');
    expect(q('sync-settings-keep-local')).not.toBeNull();
    expect(q('sync-settings-take-cloud')).not.toBeNull();
  });

  it('M4: eine Entscheidung wird an den Dienst weitergereicht', () => {
    const resolve = vi
      .spyOn(syncUiService, 'resolveSettingsConflictFromUi')
      .mockReturnValue(true);
    zeige(
      snapshot({
        settingsConflict: [{ key: 'chartOfAccounts', localValue: 'SKR03', cloudValue: 'SKR04' }],
      }),
    );

    act(() => {
      (q('sync-settings-keep-local') as HTMLButtonElement).click();
    });

    expect(resolve).toHaveBeenCalledWith('keep_local');
  });

  it('M5: ohne offenen Konflikt erscheint der Abschnitt nicht', () => {
    zeige(snapshot());
    expect(q('sync-settings-conflict')).toBeNull();
  });
});
