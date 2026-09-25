/**
 * FINANZ-SYNC-BLOCKER-01F — die Konfliktaktionen müssen wirklich erscheinen.
 *
 * In der Abnahme 01E sagte die Sync-Seite „Bitte entscheiden, welcher Stand
 * gelten soll" und zeigte **keinen** Knopf. Der Satz stammte aus dem
 * blockierten Sendeauftrag, die Knöpfe aus einem Modulzustand — zwei Quellen
 * mit verschiedener Lebensdauer.
 *
 * Dieser Test geht deshalb bewusst **nicht** über einen gefälschten Snapshot:
 * Er füllt die echten Speicher und lässt `getSyncUiSnapshot` selbst arbeiten.
 * Nur so ist die Verdrahtung geprüft, die damals fehlte.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { SyncPage } from './SyncPage';
import type { SyncOutboxEntry } from '../types/sync';
import type { WorkspaceSettings } from '../types/workspace';
import { getSyncUiSnapshot } from '../services/sync/syncUiService';
import {
  getWorkspaceSettingsSnapshot,
  hydrateWorkspaceStore,
  resetWorkspaceStore,
} from '../services/workspace/workspaceStore';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../services/sync/syncOutboxService';
import { createSyncClient, resetSyncClientForTests } from '../services/sync/syncClientService';
import { ChartOfAccountsSetting } from '../components/accounting/ChartOfAccountsSetting';
import { de } from '../i18n';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const WORKSPACE = '00000000-0000-0000-0000-00000000f01f';
const AT = '2026-07-10T09:00:00.000Z';

function settingsMitKonflikt(): WorkspaceSettings {
  return {
    workspaceId: WORKSPACE,
    settings: { chartOfAccounts: 'SKR04', companySettingA: 1 },
    version: 5,
    updatedAt: AT,
    conflict: {
      fields: [{ key: 'chartOfAccounts', localValue: 'SKR03', cloudValue: 'SKR04' }],
      detectedAt: AT,
    },
  };
}

function blockierterAuftrag(): SyncOutboxEntry {
  return {
    id: 'ob-settings-01f',
    entityType: 'workspace_settings',
    entityId: WORKSPACE,
    operation: 'update',
    version: 2,
    queuedAt: AT,
    retryCount: 1,
    status: 'blocked',
    lastErrorMessage: 'Versionskonflikt',
  } as SyncOutboxEntry;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceStore();
  resetSyncOutboxForTests([]);
  resetSyncClientForTests(createSyncClient());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetWorkspaceStore();
  resetSyncOutboxForTests([]);
});

function zeige(): void {
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

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const text = () => container.textContent ?? '';

function konfliktLage(): void {
  hydrateWorkspaceStore({ workspaceSettings: settingsMitKonflikt() });
  resetSyncOutboxForTests([blockierterAuftrag()]);
}

describe('J — die Konfliktaktionen sind wirklich verdrahtet', () => {
  it('J1: der echte Snapshot trägt den Konflikt aus dem Einstellungsobjekt', () => {
    konfliktLage();
    const snapshot = getSyncUiSnapshot();

    expect(snapshot.settingsConflict, 'genau das war null, als die Knöpfe fehlten').not.toBeNull();
    expect(snapshot.settingsConflict?.[0]).toEqual({
      key: 'chartOfAccounts',
      localValue: 'SKR03',
      cloudValue: 'SKR04',
    });
  });

  it('J2: wo „bitte entscheiden" steht, stehen auch beide Aktionen', () => {
    konfliktLage();
    zeige();

    // Der Satz aus dem blockierten Auftrag.
    expect(text()).toContain('Bitte entscheiden, welcher Stand gelten soll.');
    // Und jetzt auch die Entscheidung dazu.
    expect(q('sync-settings-conflict'), 'der Abschnitt fehlte in 01E').not.toBeNull();
    expect(q('sync-settings-keep-local')).not.toBeNull();
    expect(q('sync-settings-take-cloud')).not.toBeNull();
    expect(text()).toContain('chartOfAccounts: hier „SKR03“, in der Cloud „SKR04“');
  });

  it('J3: der Knopf wirkt auf den echten Dienst', () => {
    konfliktLage();
    zeige();

    act(() => {
      (q('sync-settings-keep-local') as HTMLButtonElement).click();
    });

    expect(getWorkspaceSettingsSnapshot()?.settings.chartOfAccounts).toBe('SKR03');
    expect(getWorkspaceSettingsSnapshot()?.conflict).toBeUndefined();
    expect(getSyncOutboxSnapshot()[0].status).toBe('pending');
  });

  it('J4: „Cloud-Wert übernehmen" beendet den Auftrag statt ihn neu einzureihen', () => {
    konfliktLage();
    zeige();

    act(() => {
      (q('sync-settings-take-cloud') as HTMLButtonElement).click();
    });

    expect(getWorkspaceSettingsSnapshot()?.settings.chartOfAccounts).toBe('SKR04');
    expect(getSyncOutboxSnapshot()[0].status).toBe('completed');
  });

  it('J5: nach der Entscheidung verschwindet der Abschnitt', () => {
    konfliktLage();
    zeige();
    act(() => {
      (q('sync-settings-take-cloud') as HTMLButtonElement).click();
    });

    expect(q('sync-settings-conflict')).toBeNull();
  });

  it('J6: ohne Konflikt erscheinen auch keine Aktionen', () => {
    resetSyncOutboxForTests([blockierterAuftrag()]);
    hydrateWorkspaceStore({
      workspaceSettings: { workspaceId: WORKSPACE, settings: {}, version: 5, updatedAt: AT },
    });
    zeige();

    expect(q('sync-settings-conflict')).toBeNull();
  });
});

describe('K — die Oberfläche verspricht nichts, was sie nicht hält', () => {
  it('K1: der Satz „Verloren geht nichts." steht nirgends mehr', () => {
    konfliktLage();
    zeige();

    expect(text(), 'die Zusage war neben einem Datenverlust zu lesen').not.toContain(
      'Verloren geht nichts',
    );
  });

  it('K2: stattdessen die Zusage, die tatsächlich eingelöst wird', () => {
    konfliktLage();
    zeige();

    expect(text()).toContain('Beide Stände bleiben erhalten, bis Sie entscheiden.');
    // Und sie stimmt: beide Werte stehen wirklich im gespeicherten Stand.
    const felder = getWorkspaceSettingsSnapshot()?.conflict?.fields ?? [];
    expect(felder[0]?.localValue).toBe('SKR03');
    expect(felder[0]?.cloudValue).toBe('SKR04');
  });
});

/* ================================================================== */
/* 01G — Statuswort und Hinweis auf der Einstellungsseite              */
/* ================================================================== */

describe('E — Konflikt heisst nicht Fehler', () => {
  it('E5: der Kopf sagt „Entscheidung nötig", nicht „Fehler"', () => {
    konfliktLage();
    zeige();

    const kopf = q('sync-status-badge')?.textContent ?? '';
    expect(kopf).toContain('Entscheidung nötig');
    expect(kopf, 'der Widerspruch aus der Abnahme').not.toContain('Fehler');
  });
});

describe('I — die Einstellungsseite verschweigt den offenen Konflikt nicht', () => {
  it('I3: bei offenem Konflikt steht ein Hinweis am Kontenrahmen', () => {
    konfliktLage();
    act(() => {
      root.render(
        <MemoryRouter>
          <AppProvider initialSetup={completeSetup}>
            <ChartOfAccountsSetting translate={(key) => de[key] ?? key} />
          </AppProvider>
        </MemoryRouter>,
      );
    });

    expect(q('settings-chart-of-accounts-conflict')).not.toBeNull();
    expect(text()).toContain('Sync-Entscheidung offen');
    /* Entschieden wird weiterhin zentral — hier gibt es keine zweite Auflösung. */
    expect(q('sync-settings-keep-local')).toBeNull();
    expect(q('sync-settings-take-cloud')).toBeNull();
  });

  it('I4: ohne Konflikt steht dort kein Hinweis', () => {
    hydrateWorkspaceStore({
      workspaceSettings: { workspaceId: WORKSPACE, settings: { chartOfAccounts: 'SKR03' }, version: 5, updatedAt: AT },
    });
    act(() => {
      root.render(
        <MemoryRouter>
          <AppProvider initialSetup={completeSetup}>
            <ChartOfAccountsSetting translate={(key) => de[key] ?? key} />
          </AppProvider>
        </MemoryRouter>,
      );
    });

    expect(q('settings-chart-of-accounts-conflict')).toBeNull();
  });
});
