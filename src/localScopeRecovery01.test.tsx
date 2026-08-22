/**
 * OFFICEPILOT-LOCAL-SCOPE-RECOVERY-01B — rein lesende Notfallansicht.
 *
 * Die Route /local-recovery muss vor jedem Business-Bootstrap greifen: kein
 * AuthProvider, kein BusinessStateGate, kein Cloud-Zugriff, kein Schreibvorgang.
 * Alle Prüfungen laufen ohne Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import JSZip from 'jszip';
import { RootShell, isLocalRecoveryPath } from './RootShell';
import { readLocalScopeInventory } from './services/storage/localScopeInventoryService';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { resetTestStores } from './test/resetStores';

const CIRMAK_KEY = 'officepilot-state:user:recovery-user';
const CLOUD_TEST_KEY = 'officepilot-state:workspace:recovery-ws';
const BROKEN_KEY = 'officepilot-state:workspace:kaputt';
const LEGACY_SETUP_KEY_NAME = 'officepilot-setup';
/** Altformat: direkt ein CompanySetup, kein AppPersistedState. */
const LEGACY_SETUP_RAW = JSON.stringify({
  companyName: 'Cirmak Haustechnik GmbH',
  industry: 'Sanitär',
  taxStatus: 'standard_19',
  materialStandard: 'betrieb',
  language: 'de',
  setupComplete: true,
  setupVersion: 1,
});

const rpcCalls: string[] = [];

function buildCopy(options: {
  companyName: string;
  setupComplete: boolean;
  savedAt: string;
  serverWorkspaceId?: string;
  vorgaenge?: number;
  documents?: number;
}): string {
  return JSON.stringify({
    version: 5,
    setup: {
      companyName: options.companyName,
      setupComplete: options.setupComplete,
      setupVersion: options.setupComplete ? 1 : 0,
      language: 'de',
    },
    companyProfile: {
      companyName: options.companyName,
      street: 'Hauptstraße 1',
      iban: 'DE89370400440532013000',
      taxNumber: '123/456/78901',
    },
    syncClient: {
      deviceId: 'device-1',
      workspaceId: 'local-uuid',
      serverWorkspaceId: options.serverWorkspaceId,
      syncPolicy: 'cloud_ready',
    },
    vorgaenge: Array.from({ length: options.vorgaenge ?? 0 }, (_, index) => ({ id: `v-${index}` })),
    documents: Array.from({ length: options.documents ?? 0 }, (_, index) => ({ id: `d-${index}` })),
    savedAt: options.savedAt,
  });
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function snapshotStorage(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) entries[key] = localStorage.getItem(key) ?? '';
  }
  return entries;
}

async function renderRoot(pathname: string): Promise<HTMLDivElement> {
  window.history.pushState({}, '', pathname);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<RootShell />);
  });
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return host;
}

describe('OFFICEPILOT-LOCAL-SCOPE-RECOVERY-01B', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    rpcCalls.length = 0;
    clearMockRpcHandlers();
    for (const name of [
      'ensure_personal_workspace',
      'pull_workspace_sync_state',
      'upsert_workspace_sync_entity',
      'pull_workspace_invoices',
      'pull_workspace_order_amendments',
    ]) {
      registerMockRpcHandler(name, () => {
        rpcCalls.push(name);
        return null;
      });
    }
    localStorage.setItem(
      CIRMAK_KEY,
      buildCopy({
        companyName: 'Cirmak Haustechnik GmbH',
        setupComplete: true,
        savedAt: '2026-08-13T18:00:00.000Z',
        vorgaenge: 3,
        documents: 2,
      }),
    );
    localStorage.setItem(
      CLOUD_TEST_KEY,
      buildCopy({
        companyName: 'OfficePilot Cloud Test',
        setupComplete: true,
        savedAt: '2026-08-15T09:00:00.000Z',
        serverWorkspaceId: 'recovery-ws',
      }),
    );
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    host?.remove();
    host = null;
    root = null;
    clearMockRpcHandlers();
    resetTestStores();
    localStorage.clear();
    window.history.pushState({}, '', '/');
  });

  it('R1: /local-recovery rendert ohne BusinessStateGate und ohne AppProvider', async () => {
    const container = await renderRoot('/local-recovery');

    expect(isLocalRecoveryPath('/local-recovery')).toBe(true);
    expect(container.querySelector('[data-testid="local-recovery-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="bootstrap-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull();
    expect(container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
    expect(container.querySelector('[data-testid="login-submit"]')).toBeNull();
  });

  it('R2: kein Workspace-RPC, kein Pull, kein Upsert', async () => {
    await renderRoot('/local-recovery');

    expect(rpcCalls).toEqual([]);
  });

  it('R3: kein Schreibvorgang im localStorage', async () => {
    const before = snapshotStorage();

    const container = await renderRoot('/local-recovery');
    expect(container.querySelector('[data-testid="local-recovery-page"]')).not.toBeNull();
    await act(async () => {
      root?.unmount();
    });

    expect(snapshotStorage()).toEqual(before);
  });

  it('R4: beide Kopien werden gleichzeitig angezeigt', async () => {
    const container = await renderRoot('/local-recovery');

    const text = container.textContent ?? '';
    expect(text).toContain('Cirmak Haustechnik GmbH');
    expect(text).toContain('OfficePilot Cloud Test');
    expect(text).toContain(CIRMAK_KEY);
    expect(text).toContain(CLOUD_TEST_KEY);
    expect(container.querySelectorAll('[data-testid^="local-recovery-copy-"]').length).toBe(2);
  });

  it('R5: die aktuelle Origin wird exakt angezeigt', async () => {
    const container = await renderRoot('/local-recovery');

    const origin = container.querySelector('[data-testid="local-recovery-origin"]');
    expect(origin?.textContent).toContain(window.location.origin);
  });

  it('R6: eine beschädigte Kopie stürzt die Seite nicht ab', async () => {
    localStorage.setItem(BROKEN_KEY, '{ das ist kein json');

    const container = await renderRoot('/local-recovery');

    expect(container.querySelector('[data-testid="local-recovery-page"]')).not.toBeNull();
    expect(container.textContent).toContain('Cirmak Haustechnik GmbH');
    const broken = container.querySelector(`[data-testid="local-recovery-copy-${BROKEN_KEY}"]`);
    expect(broken, 'beschädigte Kopie fehlt').not.toBeNull();
    expect(broken?.textContent).toContain('beschädigt');
  });

  it('R8: Hinweise zu anderen Origins und zu IndexedDB sind sichtbar', async () => {
    const container = await renderRoot('/local-recovery');

    const text = container.textContent ?? '';
    expect(text).toContain('nur Daten dieser Adresse');
    expect(text).toContain('IndexedDB');
  });

  it('R9: keine Schaltfläche zum Übernehmen, Zusammenführen oder Synchronisieren', async () => {
    const container = await renderRoot('/local-recovery');

    const labels = Array.from(container.querySelectorAll('button, a'))
      .map((element) => (element.textContent ?? '').toLowerCase())
      .join(' | ');
    expect(labels).not.toContain('verwenden');
    expect(labels).not.toContain('übernehmen');
    expect(labels).not.toContain('zusammenführen');
    expect(labels).not.toContain('synchronisieren');
    expect(labels).not.toContain('wiederherstellen');
  });

  it('R10: der Inventarservice liest nur und meldet die Kennzahlen', () => {
    const before = snapshotStorage();

    const inventory = readLocalScopeInventory();

    expect(snapshotStorage()).toEqual(before);
    const cirmak = inventory.copies.find((copy) => copy.storageKey === CIRMAK_KEY);
    expect(cirmak?.scopeType).toBe('user');
    expect(cirmak?.setupCompanyName).toBe('Cirmak Haustechnik GmbH');
    expect(cirmak?.setupComplete).toBe(true);
    expect(cirmak?.savedAt).toBe('2026-08-13T18:00:00.000Z');
    expect(cirmak?.vorgangCount).toBe(3);
    expect(cirmak?.documentCount).toBe(2);
    expect(cirmak?.valid).toBe(true);
    const cloud = inventory.copies.find((copy) => copy.storageKey === CLOUD_TEST_KEY);
    expect(cloud?.scopeType).toBe('workspace');
    expect(cloud?.serverWorkspaceId).toBe('recovery-ws');
    expect(inventory.origin).toBe(window.location.origin);
  });

  it('R11: vertrauliche Detailfelder erscheinen nicht auf der Seite', async () => {
    const container = await renderRoot('/local-recovery');

    const text = container.textContent ?? '';
    expect(text).not.toContain('DE89370400440532013000');
    expect(text).not.toContain('123/456/78901');
    expect(text).not.toContain('Hauptstraße 1');
  });
  it('R12: officepilot-setup mit Cirmak wird als Altformat erkannt', async () => {
    localStorage.setItem(LEGACY_SETUP_KEY_NAME, LEGACY_SETUP_RAW);

    const container = await renderRoot('/local-recovery');

    const entry = container.querySelector(
      `[data-testid="local-recovery-copy-${LEGACY_SETUP_KEY_NAME}"]`,
    );
    expect(entry, 'Legacy-Setup fehlt in der Liste').not.toBeNull();
    expect(entry?.textContent).toContain('Cirmak Haustechnik GmbH');
    expect(entry?.textContent).toContain('legacy_setup');
    expect(entry?.textContent).toContain('Altes Format');

    const inventory = readLocalScopeInventory();
    const legacy = inventory.copies.find((copy) => copy.storageKey === LEGACY_SETUP_KEY_NAME);
    expect(legacy?.scopeType).toBe('legacy_setup');
    expect(legacy?.setupCompanyName).toBe('Cirmak Haustechnik GmbH');
    expect(legacy?.setupComplete).toBe(true);
    expect(legacy?.language).toBe('de');
    expect(legacy?.industry).toBe('Sanitär');
    expect(legacy?.taxStatus).toBe('standard_19');
    expect(legacy?.rawLength).toBe(LEGACY_SETUP_RAW.length);
    // Keine Behauptung über Bestände im Altformat.
    expect(legacy?.vorgangCount).toBe(0);
    expect(legacy?.documentCount).toBe(0);
  });

  it('R13: fehlender officepilot-setup-Schlüssel erzeugt keinen Eintrag', async () => {
    const container = await renderRoot('/local-recovery');

    expect(
      container.querySelector(`[data-testid="local-recovery-copy-${LEGACY_SETUP_KEY_NAME}"]`),
    ).toBeNull();
    expect(
      readLocalScopeInventory().copies.some((copy) => copy.scopeType === 'legacy_setup'),
    ).toBe(false);
  });

  it('R14: beschädigtes Legacy-Setup stürzt nicht ab', async () => {
    localStorage.setItem(LEGACY_SETUP_KEY_NAME, '{ kaputt');

    const container = await renderRoot('/local-recovery');

    const entry = container.querySelector(
      `[data-testid="local-recovery-copy-${LEGACY_SETUP_KEY_NAME}"]`,
    );
    expect(entry, 'beschädigtes Altformat fehlt').not.toBeNull();
    expect(entry?.textContent).toContain('beschädigt');
    expect(container.textContent).toContain('Cirmak Haustechnik GmbH');
  });

  it('R15: globaler Zustand und Quarantäne werden weiterhin erkannt, Fremdschlüssel nicht', async () => {
    localStorage.setItem('officepilot-state', buildCopy({
      companyName: 'Global Alt GmbH',
      setupComplete: true,
      savedAt: '2026-07-01T08:00:00.000Z',
    }));
    localStorage.setItem('officepilot-legacy-state:1750000000000', buildCopy({
      companyName: 'Quarantäne GmbH',
      setupComplete: true,
      savedAt: '2026-07-02T08:00:00.000Z',
    }));
    localStorage.setItem('sb-abcdef-auth-token', '{"access_token":"geheim"}');
    localStorage.setItem('officepilot-ui-session-ttl', '{"a":1}');
    localStorage.setItem('officepilot_home_hint_dismissals', '{"a":1}');
    localStorage.setItem('officepilot-company-session', '{"a":1}');
    localStorage.setItem(`${CLOUD_TEST_KEY}:invoice-finalize-intents`, '{"a":1}');
    localStorage.setItem('irgendwas-fremdes', 'x');

    const container = await renderRoot('/local-recovery');
    const text = container.textContent ?? '';

    expect(text).toContain('Global Alt GmbH');
    expect(text).toContain('Quarantäne GmbH');
    expect(text).not.toContain('sb-abcdef-auth-token');
    expect(text).not.toContain('geheim');
    expect(text).not.toContain('ui-session');
    expect(text).not.toContain('home_hint');
    expect(text).not.toContain('company-session');
    expect(text).not.toContain('invoice-finalize-intents');
    expect(text).not.toContain('irgendwas-fremdes');
  });

  it('R16: die Sicherung ist eine ZIP mit genau einer unveränderten JSON-Datei', async () => {
    const raw = localStorage.getItem(CIRMAK_KEY);
    const storageBefore = snapshotStorage();
    const container = await renderRoot('/local-recovery');
    const locationBefore = window.location.href;

    const blobs: Blob[] = [];
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      blobs.push(blob);
      return 'blob:mock-zip';
    }) as typeof URL.createObjectURL;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    let anchorInBody = false;
    let anchorDownload = '';
    let anchorRel = '';
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) {
      anchorInBody = document.body.contains(this);
      anchorDownload = this.download;
      anchorRel = this.rel;
    };

    try {
      const button = container.querySelector(
        `[data-testid="local-recovery-download-${CIRMAK_KEY}"]`,
      ) as HTMLButtonElement | null;
      expect(button, 'ZIP-Schaltfläche fehlt').not.toBeNull();
      expect(button?.textContent).toContain('ZIP');
      await act(async () => {
        button!.click();
      });
      for (let i = 0; i < 20; i += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    } finally {
      URL.createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
    }

    expect(blobs.length, 'keine ZIP erzeugt').toBe(1);
    expect(blobs[0]!.type).toBe('application/zip');
    expect(anchorInBody, 'Anchor war nicht im Dokument').toBe(true);
    expect(anchorDownload.endsWith('.zip')).toBe(true);
    expect(anchorDownload).not.toContain('recovery-user');
    expect(anchorRel).toContain('noopener');
    expect(document.querySelectorAll('a[download]').length, 'Anchor nicht entfernt').toBe(0);

    const zip = await JSZip.loadAsync(await blobs[0]!.arrayBuffer());
    const files = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
    expect(files.length, 'nicht genau eine Datei').toBe(1);
    expect(files[0]!.endsWith('.json')).toBe(true);
    expect(await zip.files[files[0]!]!.async('string')).toBe(raw);

    // Kein Verlassen der Seite, kein Schreibzugriff.
    expect(window.location.href).toBe(locationBefore);
    expect(snapshotStorage()).toEqual(storageBefore);
    expect(rpcCalls).toEqual([]);
    expect(container.querySelector('[data-testid="local-recovery-page"]')).not.toBeNull();
  });

});
