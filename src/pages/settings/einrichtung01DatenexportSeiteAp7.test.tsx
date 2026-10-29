/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.24) — Seite „Daten › Export“.
 *
 *   D-01.1  Mitglieder: kein Exportweg über die direkte Adresse (nur Hinweis)
 *   D-01.2  lokaler Betrieb bzw. Inhaber: erlaubt
 *   D-05.1  offene Änderung → Liste der Lücken mit Weg zur Synchronisation; nur „Export mit Lückenliste“ oder „Abbrechen“
 *   D-05.3  ohne Lücken → „Export erstellen“, Meldung „Download gestartet“ mit Dateinamen
 *   D-09.1/D-09.2  Fortschritt sichtbar; „Abbrechen“ während der Prüfung erzeugt keine Datei
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DataExportPage } from './DataExportPage';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { resetTestStores } from '../../test/resetStores';
import * as supabaseLib from '../../lib/supabase';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import type { DataExportDeps } from '../../services/export/dataExportService';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

const USER_ID = 'usr-admin';
const WORKSPACE_ID = '00000000-0000-4000-8000-0000000007a7';
const setup = { ...DEFAULT_SETUP, setupComplete: true };

let root: Root | null = null;
let host: HTMLDivElement;

function seedWorkspace(role: 'owner' | 'admin' | 'member'): void {
  hydrateWorkspaceStore({
    workspace: { id: WORKSPACE_ID, name: 'Beispielbetrieb', ownerUserId: 'usr-owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WORKSPACE_ID, userId: USER_ID, role, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
}

interface Fake {
  outbox: SyncOutboxEntry[];
  downloads: string[];
  datei?: Promise<Blob | null>;
}

function fakeDeps(f: Fake): DataExportDeps {
  return {
    now: () => new Date(2026, 9, 25, 9, 0),
    cloudConfigured: () => false,
    storageKey: () => 'scope:lokal',
    account: () => ({ userId: null, email: '' }),
    workspaceId: () => null,
    bind: async () => null,
    refreshRole: async () => null,
    currentRole: () => null,
    localExportAllowed: () => true,
    outbox: () => f.outbox,
    isHeld: () => false,
    cloudSyncAllowed: () => true,
    pull: async () => 'ok',
    snapshot: () =>
      ({
        version: 6, savedAt: '', setup: { companyName: 'Lokal KG' }, companyProfile: { companyName: 'Lokal KG' }, inboxItems: [], vorgaenge: [], tasks: [],
        documents: [{ id: 'd1', title: 'Beleg', category: 'sonstiges', fileRefId: 'f1', linkedVorgang: null, createdAt: '' }],
      }) as unknown as AppPersistedState,
    lastPersistOk: () => true,
    fileRefs: () => [{ id: 'f1', originalFileName: 'beleg.pdf', mimeType: 'application/pdf', fileSize: 4, contentHash: 'a', storageType: 'indexeddb' } as never],
    bindings: () => [],
    readLocalFile: () => f.datei ?? Promise.resolve(new Blob(['%PDF'])),
    downloadCloudFile: async () => new Uint8Array(),
    listSentEmails: async () => ({ ok: true, messages: [] }),
    downloadEmailAttachment: async () => ({ ok: false, error: 'missing' }),
    unconfirmedInvoicePayments: () => new Set(),
    unconfirmedFinance: () => [],
    invoiceNetCents: () => null,
    invoiceOpenAmount: () => 0,
    documentFolder: () => 'dateien/dokumente',
    download: (_blob, name) => {
      f.downloads.push(name);
      return { revoke: () => undefined };
    },
  };
}

async function settle(rounds = 8): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function render(deps?: DataExportDeps): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[SETTINGS_TARGET_PATHS.export]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            <Routes>
              <Route path={SETTINGS_TARGET_PATHS.export} element={<DataExportPage deps={deps} />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

/** Wartet, bis die Seite einen Endzustand zeigt (die ZIP-Erstellung braucht mehrere Runden der Ereignisschleife). */
async function bisZustand(...zustaende: string[]): Promise<void> {
  for (let runde = 0; runde < 200; runde += 1) {
    if (zustaende.includes(q('data-export-panel')?.getAttribute('data-state') ?? '')) return;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
  throw new Error(`Zustand nicht erreicht: ${zustaende.join(', ')} (ist ${q('data-export-panel')?.getAttribute('data-state')})`);
}

async function click(id: string): Promise<void> {
  const element = q(id);
  expect(element, id).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  localStorage.clear();
  setActiveStorageScope({ type: 'guest' });
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  await loginAsDefaultAdmin();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  resetTestStores();
});

describe('EINRICHTUNG-01 AP7 — Seite „Daten › Export“ (1.24)', { timeout: 30_000 }, () => {
  it('D-01.1: ein Mitglied sieht über die direkte Adresse nur den Hinweis, keinen Exportweg', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    seedWorkspace('member');
    const f: Fake = { outbox: [], downloads: [] };
    await render(fakeDeps(f));
    expect(q('data-export-not-allowed')).not.toBeNull();
    expect(q('data-export-prepare')).toBeNull();
    expect(q('data-export-panel')).toBeNull();
  });

  it('D-01.2/D-05.3: lokaler Betrieb — Prüfung ohne Lücken, Export erstellen, Meldung mit Dateinamen', async () => {
    const f: Fake = { outbox: [], downloads: [] };
    await render(fakeDeps(f));
    await click('data-export-prepare');
    expect(q('data-export-complete')).not.toBeNull();
    expect(q('data-export-local')).not.toBeNull();
    expect(q('data-export-create-with-gaps')).toBeNull();
    await click('data-export-create');
    await bisZustand('fertig', 'beendet');
    expect(f.downloads).toEqual(['OfficeTakt_Export_Lokal-KG_2026-10-25_09-00.zip']);
    expect(q('data-export-success')?.textContent).toContain('OfficeTakt_Export_Lokal-KG_2026-10-25_09-00.zip');
    expect(q('data-export-success')?.getAttribute('data-incomplete')).toBe('false');
  });

  it('D-05.1: offene Änderung → Liste der Lücken, Weg zur Synchronisation; „Abbrechen“ erzeugt keine Datei', async () => {
    const f: Fake = {
      outbox: [{ id: 'o1', entityType: 'customer', entityId: 'k1', operation: 'update', version: 1, queuedAt: '', retryCount: 0, status: 'pending', sequence: 1 } as SyncOutboxEntry],
      downloads: [],
    };
    await render(fakeDeps(f));
    await click('data-export-prepare');
    expect(q('data-export-gap-list')?.textContent).toContain('Offene Änderungen: 1');
    expect(q('data-export-create')).toBeNull();
    expect(q('data-export-create-with-gaps')).not.toBeNull();
    await click('data-export-cancel-result');
    expect(q('data-export-ended')?.getAttribute('data-reason')).toBe('cancelled');
    expect(f.downloads).toEqual([]);
    await click('data-export-prepare');
    await click('data-export-create-with-gaps');
    await bisZustand('fertig', 'beendet');
    expect(f.downloads).toEqual(['OfficeTakt_Export_Lokal-KG_2026-10-25_09-00_unvollstaendig.zip']);
    expect(q('data-export-success')?.getAttribute('data-incomplete')).toBe('true');
  });

  it('D-09.1/D-09.2: Fortschritt sichtbar; Abbrechen während der Prüfung — keine Datei, späte Antwort ohne Wirkung', async () => {
    let freigeben: (blob: Blob | null) => void = () => undefined;
    const f: Fake = { outbox: [], downloads: [], datei: new Promise((resolve) => { freigeben = resolve; }) };
    await render(fakeDeps(f));
    await click('data-export-prepare');
    expect(q('data-export-progress')).not.toBeNull();
    expect(q('data-export-progress-text')?.getAttribute('data-phase')).toBe('files');
    await click('data-export-cancel');
    expect(q('data-export-ended')?.getAttribute('data-reason')).toBe('cancelled');
    await act(async () => {
      freigeben(new Blob(['%PDF']));
    });
    await settle();
    expect(q('data-export-ended')?.getAttribute('data-reason')).toBe('cancelled');
    expect(q('data-export-result')).toBeNull();
    expect(f.downloads).toEqual([]);
  });
});
