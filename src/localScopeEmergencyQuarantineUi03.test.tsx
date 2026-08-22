/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P3 — providerfreie Oberfläche für
 * Zielsicherung und lokale Quarantäne.
 *
 * Alle Fixtures sind neutral, synthetisch und vollständig typisiert. Keine
 * reale Firma, keine reale Workspace-ID, keine echte Sicherungsdatei.
 *
 * Der Testaufbau importiert bewusst nur RootShell und bereits vorhandene
 * Dienste, damit die Datei auch vor der Implementierung vollständig gesammelt
 * und tatsächlich rot ausgeführt wird.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { RootShell, isLocalRecoveryPath } from './RootShell';
import { saveDocumentBlob, resetDocumentBlobDatabaseForTests } from './services/storage/documentBlobIndexedDbService';
import * as QuarantineService from './services/storage/localScopeEmergencyQuarantineService';
import { listQuarantineMarkers } from './services/storage/localScopeEmergencyQuarantineService';
import { readScopeBlobRecord } from './services/storage/localScopeBlobInventoryService';
import { readLocalRecoveryCheckpoint } from './services/storage/localRecoveryCheckpointService';
import { computeBufferContentHash } from './services/documentFileHashService';
import { STORAGE_VERSION } from './services/sync/syncMigrationService';
import { getActiveStorageScope, resetStorageScopeForTests } from './services/storage/storageScopeService';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { resetTestStores } from './test/resetStores';
import {
  QUARANTINE_MARKER_PREFIX,
  buildQuarantineMarkerKey,
  type QuarantineMarker,
} from './types/emergencyBackupQuarantine';
import type { DocumentFileRef } from './types/documentFileRef';
import type { CompanyProfile, CompanySetup } from './types/models';

/**
 * OFFICEPILOT-…-02P3B — die echten Kernfunktionen bleiben aktiv, werden aber
 * zählbar und kontrolliert verzögerbar. Keine Produktions-Testhaken.
 */
vi.mock('./services/storage/localScopeEmergencyQuarantineService', async () => {
  const actual = await vi.importActual<
    typeof import('./services/storage/localScopeEmergencyQuarantineService')
  >('./services/storage/localScopeEmergencyQuarantineService');
  return {
    ...actual,
    prepareTargetBackupSession: vi.fn(actual.prepareTargetBackupSession),
    verifyReselectedTargetBackup: vi.fn(actual.verifyReselectedTargetBackup),
    createTargetQuarantine: vi.fn(actual.createTargetQuarantine),
  };
});

const spiedPrepare = () => vi.mocked(QuarantineService.prepareTargetBackupSession);
const spiedVerify = () => vi.mocked(QuarantineService.verifyReselectedTargetBackup);
const spiedQuarantine = () => vi.mocked(QuarantineService.createTargetQuarantine);

/** Kontrolliert auflösbare Verzögerung ohne Zeitgeber. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const WS_ONE = 'ws-ui-eins';
const WS_TWO = 'ws-ui-zwei';
const KEY_ONE = `officepilot-state:workspace:${WS_ONE}`;
const KEY_TWO = `officepilot-state:workspace:${WS_TWO}`;
const GUEST_KEY = 'officepilot-state:guest';
const USER_KEY = 'officepilot-state:user:user-ui';
const LEGACY_KEY = 'officepilot-state';
const LEGACY_SETUP_KEY = 'officepilot-setup';
const COMPANY_ONE = 'Beispiel Erstbetrieb GmbH';
const COMPANY_TWO = 'Beispiel Zweitbetrieb GmbH';
const NOW = '2026-08-20T09:00:00.000Z';
/** Rein synthetisch — dient nur dem Nachweis, dass Bankdaten nie im Bericht stehen. */
const SYNTH_IBAN = 'DE00000000000000000000';

const BYTES_ONE = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
const BYTES_TWO = new Uint8Array([0x66, 0x77, 0x88]);

const rpcCalls: string[] = [];

interface SeedFile {
  id: string;
  localDataKey: string;
  mimeType: string;
  bytes: Uint8Array;
  hash: string;
}

async function buildSeedFiles(): Promise<SeedFile[]> {
  return [
    {
      id: 'ui-ref-a',
      localDataKey: 'ui-key-a',
      mimeType: 'application/pdf',
      bytes: BYTES_ONE,
      hash: await computeBufferContentHash(BYTES_ONE),
    },
    {
      id: 'ui-ref-b',
      localDataKey: 'ui-key-b',
      mimeType: 'image/png',
      bytes: BYTES_TWO,
      hash: await computeBufferContentHash(BYTES_TWO),
    },
  ];
}

function toFileRef(file: SeedFile): DocumentFileRef {
  return {
    id: file.id,
    originalFileName: `${file.id}.bin`,
    mimeType: file.mimeType,
    fileSize: file.bytes.byteLength,
    contentHash: file.hash,
    storageType: 'indexeddb',
    localDataKey: file.localDataKey,
    createdAt: '2026-08-19T08:00:00.000Z',
    lifecycleStatus: 'committed',
    committedAt: '2026-08-19T08:05:00.000Z',
  };
}

function buildRawState(
  workspaceId: string,
  company: string,
  files: SeedFile[],
  overrides: Record<string, unknown> = {},
): string {
  const setup: CompanySetup = {
    ...DEFAULT_SETUP,
    companyName: company,
    setupComplete: true,
    setupVersion: 1,
  };
  const companyProfile: CompanyProfile = {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: company,
    iban: SYNTH_IBAN,
    street: 'Musterweg 1',
  };
  return JSON.stringify({
    version: STORAGE_VERSION,
    setup,
    companyProfile,
    workspace: { id: workspaceId, name: company, ownerUserId: 'user-ui' },
    syncClient: {
      deviceId: 'device-ui',
      workspaceId,
      serverWorkspaceId: workspaceId,
      syncPolicy: 'cloud',
    },
    setupSync: { version: 1, updatedAt: NOW, deleted: false, deviceId: 'device-ui', workspaceId },
    companyProfileSync: {
      version: 1,
      updatedAt: NOW,
      deleted: false,
      deviceId: 'device-ui',
      workspaceId,
    },
    inboxItems: [],
    vorgaenge: [{ id: 'v-1' }],
    tasks: [],
    documents: [{ id: 'd-1' }],
    expenses: [],
    documentWorkResults: [],
    documentFileRefs: files.map(toFileRef),
    syncOutbox: [],
    savedAt: '2026-08-19T09:00:00.000Z',
    ...overrides,
  });
}

async function seedWorkspace(
  workspaceId: string,
  storageKey: string,
  company: string,
  files: SeedFile[],
): Promise<string> {
  const raw = buildRawState(workspaceId, company, files);
  localStorage.setItem(storageKey, raw);
  for (const file of files) {
    await saveDocumentBlob({
      fileRefId: file.id,
      blob: new Blob([file.bytes], { type: file.mimeType }),
      mimeType: file.mimeType,
      fileSize: file.bytes.byteLength,
      contentHash: file.hash,
      createdAt: '2026-08-19T08:00:00.000Z',
      scope: { type: 'workspace', workspaceId },
    });
  }
  return raw;
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

/** Mikro- UND Makrotasks leeren: IndexedDB antwortet über Timer. */
async function settle(rounds = 25): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderRoot(pathname: string): Promise<HTMLDivElement> {
  window.history.pushState({}, '', pathname);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <BrowserRouter>
        <RootShell />
      </BrowserRouter>,
    );
  });
  await settle();
  return host;
}

function byTestId(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

async function click(container: HTMLElement, id: string): Promise<void> {
  const element = byTestId(container, id);
  expect(element, `Element fehlt: ${id}`).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** Zwei Klicks im selben Tick — der synchrone Riegel muss greifen. */
async function doubleClick(container: HTMLElement, id: string): Promise<void> {
  const element = byTestId(container, id);
  expect(element, `Element fehlt: ${id}`).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function chooseFile(container: HTMLElement, file: File): Promise<void> {
  const input = byTestId(container, 'import-file-input') as HTMLInputElement | null;
  expect(input, 'Dateifeld fehlt').not.toBeNull();
  Object.defineProperty(input!, 'files', { value: [file], configurable: true });
  await act(async () => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

/** Der heruntergeladene Blob wird aus dem Anker-Klick abgefangen. */
function captureDownload(): { blobs: Blob[]; names: string[]; restore: () => void } {
  const blobs: Blob[] = [];
  const names: string[] = [];
  const urlByBlob = new Map<string, Blob>();
  const createObjectUrl = vi
    .spyOn(URL, 'createObjectURL')
    .mockImplementation((blob: Blob | MediaSource) => {
      const url = `blob:ui-test-${urlByBlob.size}`;
      urlByBlob.set(url, blob as Blob);
      return url;
    });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const anchorClick = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      const blob = urlByBlob.get(this.href);
      if (blob) blobs.push(blob);
      names.push(this.download);
    });
  return {
    blobs,
    names,
    restore: () => {
      createObjectUrl.mockRestore();
      anchorClick.mockRestore();
    },
  };
}

async function preparedAndDownloaded(): Promise<{
  container: HTMLElement;
  download: ReturnType<typeof captureDownload>;
}> {
  const container = await renderRoot('/local-recovery/import');
  await click(container, `import-target-option-${KEY_ONE}`);
  await click(container, 'import-prepare');
  const download = captureDownload();
  await click(container, 'import-download');
  return { container, download };
}

/** Echte Implementierungen — die Spies rufen sie durch. */
let actualService: typeof import('./services/storage/localScopeEmergencyQuarantineService');

beforeEach(async () => {
  actualService = await vi.importActual<
    typeof import('./services/storage/localScopeEmergencyQuarantineService')
  >('./services/storage/localScopeEmergencyQuarantineService');
  spiedPrepare().mockReset().mockImplementation(actualService.prepareTargetBackupSession);
  spiedVerify().mockReset().mockImplementation(actualService.verifyReselectedTargetBackup);
  spiedQuarantine().mockReset().mockImplementation(actualService.createTargetQuarantine);

  localStorage.clear();
  sessionStorage.clear();
  rpcCalls.length = 0;
  resetStorageScopeForTests();
  resetTestStores();
  await resetDocumentBlobDatabaseForTests();
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
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
  vi.restoreAllMocks();
  clearMockRpcHandlers();
  resetTestStores();
  localStorage.clear();
  window.history.pushState({}, '', '/');
});

/* ========================================================================== */
describe('02P3/Route — exakte providerfreie Erkennung', () => {
  it('U1: /local-recovery zeigt weiterhin die bisherige Seite', async () => {
    const container = await renderRoot('/local-recovery');
    expect(byTestId(container, 'local-recovery-page')).not.toBeNull();
    expect(byTestId(container, 'local-recovery-import-page')).toBeNull();
  });

  it('U2: /local-recovery/import zeigt die Importvorbereitungsseite', async () => {
    const container = await renderRoot('/local-recovery/import');
    expect(byTestId(container, 'local-recovery-import-page')).not.toBeNull();
    expect(byTestId(container, 'local-recovery-page')).toBeNull();
  });

  it('U3: ein abschließender Schrägstrich ist zulässig', async () => {
    const container = await renderRoot('/local-recovery/import/');
    expect(byTestId(container, 'local-recovery-import-page')).not.toBeNull();
  });

  it('U4: ähnliche Pfade sind keine Recovery-Routen', async () => {
    expect(isLocalRecoveryPath('/local-recovery-x')).toBe(false);
    expect(isLocalRecoveryPath('/local-recovery/import-extra')).toBe(false);

    const container = await renderRoot('/local-recovery/import-extra');
    expect(byTestId(container, 'local-recovery-import-page')).toBeNull();
    expect(byTestId(container, 'local-recovery-page')).toBeNull();
  });

  it('U5: kein Gate, kein Provider, kein RPC, kein Schreibzugriff beim Mount', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const before = snapshotStorage();

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const open = vi.spyOn(indexedDB, 'open');

    const container = await renderRoot('/local-recovery/import');

    expect(byTestId(container, 'local-recovery-import-page')).not.toBeNull();
    expect(byTestId(container, 'bootstrap-loading')).toBeNull();
    expect(byTestId(container, 'app-shell')).toBeNull();
    expect(byTestId(container, 'login-submit')).toBeNull();
    expect(rpcCalls).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(snapshotStorage()).toEqual(before);
    expect(getActiveStorageScope()).toEqual({ type: 'guest' });
  });

  it('U6: /local-recovery enthält einen ausdrücklichen Link, aber keine Umleitung', async () => {
    const container = await renderRoot('/local-recovery');
    const link = byTestId(container, 'local-recovery-import-link') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/local-recovery/import');
    // Der Link führt nichts von selbst aus.
    expect(window.location.pathname).toBe('/local-recovery');
    expect(byTestId(container, 'local-recovery-import-page')).toBeNull();
  });
});

/* ========================================================================== */
describe('02P3/Auswahl — ausdrückliche Workspace-Wahl', () => {
  it('U7: nur gültige Workspace-Kopien sind auswählbar', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    localStorage.setItem(GUEST_KEY, buildRawState('guest-ws', 'Gast', []));
    localStorage.setItem(USER_KEY, buildRawState('user-ws', 'Nutzer', []));
    localStorage.setItem(LEGACY_KEY, buildRawState('legacy-ws', 'Alt', []));
    localStorage.setItem(LEGACY_SETUP_KEY, JSON.stringify({ companyName: 'Alt', setupComplete: true }));
    localStorage.setItem(
      buildQuarantineMarkerKey('q-1111111111111111-2222222222222222'),
      JSON.stringify({ kind: 'x' }),
    );

    const container = await renderRoot('/local-recovery/import');

    expect(byTestId(container, `import-target-option-${KEY_ONE}`)).not.toBeNull();
    for (const key of [GUEST_KEY, USER_KEY, LEGACY_KEY, LEGACY_SETUP_KEY]) {
      expect(byTestId(container, `import-target-option-${key}`), key).toBeNull();
    }
  });

  it('U8: auch ein einzelner Workspace wird nicht automatisch ausgewählt', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');

    expect(byTestId(container, 'import-selected-target')).toBeNull();
    expect(byTestId(container, 'import-prepare')).toBeNull();
    expect(byTestId(container, 'import-download')).toBeNull();
  });

  it('U9: bei mehreren Workspaces entscheidet der Klick, nicht Name oder Datum', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    await seedWorkspace(WS_TWO, KEY_TWO, COMPANY_TWO, files);

    const container = await renderRoot('/local-recovery/import');
    expect(byTestId(container, 'import-selected-target')).toBeNull();

    await click(container, `import-target-option-${KEY_TWO}`);
    expect(byTestId(container, 'import-selected-target')?.textContent).toContain(KEY_TWO);
    expect(byTestId(container, 'import-selected-target')?.textContent).not.toContain(KEY_ONE);
  });

  it('U10: die Inventurzeile nennt die Unterscheidungsmerkmale', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    const text = byTestId(container, `import-target-option-${KEY_ONE}`)?.textContent ?? '';

    expect(text).toContain(KEY_ONE);
    expect(text).toContain(WS_ONE);
    expect(text).toContain(COMPANY_ONE);
    expect(text).toContain('2026-08-19T09:00:00.000Z');
  });
});

/* ========================================================================== */
describe('02P3/Vorbereitung und Download', () => {
  it('U11: die Vorbereitung schreibt nichts und verwendet genau den gewählten Schlüssel', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    await seedWorkspace(WS_TWO, KEY_TWO, COMPANY_TWO, files);
    const before = snapshotStorage();

    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await click(container, 'import-prepare');

    expect(byTestId(container, 'import-prepare-result')?.textContent).toContain(KEY_ONE);
    expect(byTestId(container, 'import-prepare-result')?.textContent).toContain(WS_ONE);
    expect(setItem).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(snapshotStorage()).toEqual(before);
  });

  it('U12: kein automatischer Download und Dateiauswahl erst danach', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const download = captureDownload();

    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);
    await click(container, 'import-prepare');

    expect(download.blobs.length).toBe(0);
    expect(byTestId(container, 'import-choose-file')).toBeNull();
    expect(byTestId(container, 'import-download')).not.toBeNull();

    await click(container, 'import-download');
    expect(download.blobs.length).toBe(1);
    expect(byTestId(container, 'import-choose-file')).not.toBeNull();
    download.restore();
  });

  it('U13: zwei Download-Klicks im selben Tick lösen nur einen Vorgang aus', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const download = captureDownload();

    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);
    await click(container, 'import-prepare');
    await doubleClick(container, 'import-download');

    expect(download.blobs.length).toBe(1);
    expect(download.names[0]).toMatch(/^officepilot-notfall-workspace-\d+\.zip$/);
    download.restore();
  });

  it('U14: zwei Vorbereitungs-Klicks im selben Tick erzeugen nur eine Sitzung', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);
    await doubleClick(container, 'import-prepare');

    expect(container.querySelectorAll('[data-testid="import-prepare-result"]').length).toBe(1);
    expect(container.querySelectorAll('[data-testid="import-download"]').length).toBe(1);
  });
});

/* ========================================================================== */
describe('02P3/Wiederauswahl', () => {
  it('U15: ohne Datei bleibt die Quarantäne gesperrt', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();

    expect(byTestId(container, 'import-start-quarantine')).toBeNull();
    download.restore();
  });

  it('U16: gleicher Dateiname mit anderen Bytes wird abgelehnt', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();

    const bytes = new Uint8Array(await download.blobs[0]!.arrayBuffer());
    bytes[bytes.byteLength - 6] = (bytes[bytes.byteLength - 6]! ^ 0xff) & 0xff;
    await chooseFile(container, new File([bytes], download.names[0]!, { type: 'application/zip' }));

    expect(byTestId(container, 'import-reselect-mismatch')).not.toBeNull();
    expect(byTestId(container, 'import-start-quarantine')).toBeNull();
    // Der Ablauf beginnt wieder vor der Vorbereitung.
    expect(byTestId(container, 'import-download')).toBeNull();
    expect((byTestId(container, 'import-file-input') as HTMLInputElement | null)?.value).toBe('');
    download.restore();
  });

  it('U17: eine andere synthetische Notfall-ZIP wird abgelehnt und niemals importiert', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    await seedWorkspace(WS_TWO, KEY_TWO, COMPANY_TWO, files);

    // Sicherung des ZWEITEN Ziels erzeugen — sie steht für die spätere Import-ZIP.
    const first = await renderRoot('/local-recovery/import');
    await click(first, `import-target-option-${KEY_TWO}`);
    await click(first, 'import-prepare');
    const foreignDownload = captureDownload();
    await click(first, 'import-download');
    const foreignBytes = new Uint8Array(await foreignDownload.blobs[0]!.arrayBuffer());
    foreignDownload.restore();

    await act(async () => {
      root?.unmount();
    });
    host?.remove();

    const before = snapshotStorage();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(
      container,
      new File([foreignBytes], download.names[0]!, { type: 'application/zip' }),
    );

    expect(byTestId(container, 'import-reselect-mismatch')).not.toBeNull();
    expect(byTestId(container, 'import-start-quarantine')).toBeNull();
    expect(byTestId(container, 'import-report')).toBeNull();
    // Nichts wurde übernommen: die Schlüsselmenge ist unverändert.
    expect(Object.keys(snapshotStorage()).sort()).toEqual(Object.keys(before).sort());
    download.restore();
  });

  it('U18: exakt die heruntergeladene Zielsicherung wird angenommen', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();

    await chooseFile(
      container,
      new File([download.blobs[0]!], 'irgendein-anderer-name.zip', { type: 'application/zip' }),
    );

    expect(byTestId(container, 'import-verify-result')).not.toBeNull();
    expect(byTestId(container, 'import-start-quarantine')).not.toBeNull();
    download.restore();
  });

  it('U19: zwei change-Ereignisse lösen nur eine Prüfung aus', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();

    const input = byTestId(container, 'import-file-input') as HTMLInputElement;
    const file = new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();

    expect(container.querySelectorAll('[data-testid="import-verify-result"]').length).toBe(1);
    expect(container.querySelectorAll('[data-testid="import-start-quarantine"]').length).toBe(1);
    download.restore();
  });
});

/* ========================================================================== */
describe('02P3/Generationsschutz', () => {
  it('U20: ein storage-Ereignis entwertet die vorbereitete Sitzung', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY_ONE, newValue: '{}' }));
    });
    await settle();

    expect(byTestId(container, 'import-download')).toBeNull();
    expect(byTestId(container, 'import-choose-file')).toBeNull();
    expect(byTestId(container, 'import-session-lost')).not.toBeNull();
    download.restore();
  });

  it('U21: ein Zielwechsel entwertet die vorbereitete Sitzung', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    await seedWorkspace(WS_TWO, KEY_TWO, COMPANY_TWO, files);
    const { container, download } = await preparedAndDownloaded();

    await click(container, `import-target-option-${KEY_TWO}`);
    expect(byTestId(container, 'import-download')).toBeNull();
    expect(byTestId(container, 'import-choose-file')).toBeNull();
    download.restore();
  });

  it('U22: nach einem Remount existiert keine alte Sitzung', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { download } = await preparedAndDownloaded();

    await act(async () => {
      root?.unmount();
    });
    host?.remove();

    const container = await renderRoot('/local-recovery/import');
    expect(byTestId(container, 'import-download')).toBeNull();
    expect(byTestId(container, 'import-choose-file')).toBeNull();
    expect(byTestId(container, 'import-start-quarantine')).toBeNull();
    download.restore();
  });
});

/* ========================================================================== */
describe('02P3/Quarantäne', () => {
  it('U23: vor dem Startklick null Quarantäneschreibzugriffe', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));

    expect(
      Object.keys(snapshotStorage()).filter((key) => key.startsWith(QUARANTINE_MARKER_PREFIX)),
    ).toEqual([]);
    expect(listQuarantineMarkers()).toEqual([]);
    download.restore();
  });

  it('U24: die Quarantäne läuft nur nach eigenem Startklick und nur einmal', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));

    await doubleClick(container, 'import-start-quarantine');

    const markers = listQuarantineMarkers();
    expect(markers.length).toBe(1);
    expect(markers[0]?.status).toBe('complete');
    download.restore();
  });

  it('U25: der Bericht zeigt alle gebundenen Prüfdaten', async () => {
    const files = await buildSeedFiles();
    const raw = await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));
    await click(container, 'import-start-quarantine');

    const report = byTestId(container, 'import-report');
    expect(report).not.toBeNull();
    const text = report!.textContent ?? '';
    const marker = listQuarantineMarkers()[0] as QuarantineMarker;

    expect(text).toContain(KEY_ONE);
    expect(text).toContain(`workspace:${WS_ONE}`);
    expect(text).toContain(WS_ONE);
    expect(text).toContain('2026-08-19T09:00:00.000Z');
    expect(text).toContain(marker.archiveSha256);
    expect(text).toContain(marker.sourceRawTextSha256);
    expect(text).toContain(marker.token);
    expect(text).toContain(buildQuarantineMarkerKey(marker.token));
    expect(text).toContain(`officepilot-emergency-quarantine-state:${marker.token}`);
    expect(text).toContain(`quarantine:${marker.token}`);
    expect(text).toContain('complete');
    for (const file of files) {
      expect(text).toContain(file.id);
      expect(text).toContain(file.localDataKey);
      expect(text).toContain(file.mimeType);
      expect(text).toContain(file.hash);
      expect(text).toContain(String(file.bytes.byteLength));
    }
    expect(text).toContain('nichts importiert');

    // Keine Rohtexte oder Binärinhalte.
    expect(text).not.toContain(raw);
    expect(text).not.toContain(SYNTH_IBAN);
    expect(text).not.toContain('Musterweg 1');
    download.restore();
  });

  it('U26: ein staging-Marker desselben Ziels blockiert und bietet keine Bereinigung an', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const token = 'q-abcdefabcdefabcd-1234567890abcdef';
    const marker: QuarantineMarker = {
      kind: 'officepilot-emergency-quarantine',
      formatVersion: 1,
      token,
      status: 'staging',
      sourceStorageKey: KEY_ONE,
      sourceScopeKey: `workspace:${WS_ONE}`,
      workspaceId: WS_ONE,
      archiveSha256: 'a'.repeat(64),
      sourceRawTextSha256: 'b'.repeat(64),
      files: [],
      createdAt: NOW,
    };
    localStorage.setItem(buildQuarantineMarkerKey(token), JSON.stringify(marker));

    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);

    const blocked = byTestId(container, 'import-staging-blocked');
    expect(blocked).not.toBeNull();
    const text = blocked!.textContent ?? '';
    expect(text).toContain(token);
    expect(text).toContain(WS_ONE);
    expect(text).toContain(NOW);
    expect(text).toContain('a'.repeat(64));

    expect(byTestId(container, 'import-prepare')).toBeNull();
    expect(byTestId(container, 'import-cleanup-staging')).toBeNull();
    expect(container.textContent).not.toContain('bereinigen');
    // Der fremde Marker bleibt unverändert.
    expect(localStorage.getItem(buildQuarantineMarkerKey(token))).toBe(JSON.stringify(marker));
  });

  it('U27: ein complete-Marker löst weder Import noch App-Start aus', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const token = 'q-1111111111111111-2222222222222222';
    localStorage.setItem(
      buildQuarantineMarkerKey(token),
      JSON.stringify({
        kind: 'officepilot-emergency-quarantine',
        formatVersion: 1,
        token,
        status: 'complete',
        sourceStorageKey: KEY_ONE,
        sourceScopeKey: `workspace:${WS_ONE}`,
        workspaceId: WS_ONE,
        archiveSha256: 'c'.repeat(64),
        sourceRawTextSha256: 'd'.repeat(64),
        files: [],
        createdAt: NOW,
        completedAt: NOW,
      }),
    );

    const container = await renderRoot('/local-recovery/import');
    expect(byTestId(container, 'local-recovery-import-page')).not.toBeNull();
    expect(byTestId(container, 'app-shell')).toBeNull();
    expect(byTestId(container, 'bootstrap-loading')).toBeNull();
    expect(rpcCalls).toEqual([]);
    expect(byTestId(container, 'import-cleanup-staging')).toBeNull();
    expect(window.location.pathname).toBe('/local-recovery/import');
  });
});

/* ========================================================================== */
describe('02P3/storage-Ereignis während der Quarantäne', () => {
  it('U28: eine erkannte Zieländerung führt zum blockierten Abschlussbericht', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));

    const button = byTestId(container, 'import-start-quarantine')!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Fremdes Ereignis ohne tatsächliche Änderung — der Kern läuft durch.
      window.dispatchEvent(new StorageEvent('storage', { key: KEY_ONE, newValue: '{}' }));
    });
    await settle(30);

    expect(byTestId(container, 'import-report')).not.toBeNull();
    expect(byTestId(container, 'import-report-target-change')).not.toBeNull();
    expect(byTestId(container, 'import-report-target-change')?.textContent).toContain(
      'für keinen weiteren Schritt freigegeben',
    );
    expect(byTestId(container, 'import-cleanup-staging')).toBeNull();
    expect(window.location.pathname).toBe('/local-recovery/import');
    expect(rpcCalls).toEqual([]);
    download.restore();
  });

  it('U29: eine echte Zieländerung während der Quarantäne verhindert complete', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));

    const button = byTestId(container, 'import-start-quarantine')!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      localStorage.setItem(
        KEY_ONE,
        buildRawState(WS_ONE, COMPANY_ONE, files, { savedAt: '2026-08-20T23:00:00.000Z' }),
      );
    });
    await settle(30);

    expect(byTestId(container, 'import-report')).toBeNull();
    expect(byTestId(container, 'import-error')).not.toBeNull();
    expect(listQuarantineMarkers()).toEqual([]);
    download.restore();
  });
});

/* ========================================================================== *
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P3B — Sitzungsgrenzen und Beweise
 * ========================================================================== */

describe('02P3B/A — kein Wiederauswahlweg vor dem Download', () => {
  it('V1: ein change-Ereignis vor dem Download löst keine Prüfung aus', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);
    await click(container, 'import-prepare');

    const before = snapshotStorage();
    await chooseFile(
      container,
      new File([new Uint8Array([1, 2, 3])], 'beliebig.zip', { type: 'application/zip' }),
    );

    expect(spiedVerify()).not.toHaveBeenCalled();
    expect(byTestId(container, 'import-verify-result')).toBeNull();
    expect(byTestId(container, 'import-start-quarantine')).toBeNull();
    expect(snapshotStorage()).toEqual(before);
  });
});

describe('02P3B/B — verspätete Promise-Ergebnisse', () => {
  it('V2: ein storage-Ereignis während prepare verwirft dessen spätes ok', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const gate = deferred();
    spiedPrepare().mockImplementationOnce(async (key: string) => {
      const outcome = await actualService.prepareTargetBackupSession(key);
      await gate.promise;
      return outcome;
    });

    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);
    const button = byTestId(container, 'import-prepare')!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY_ONE, newValue: '{}' }));
    });
    await act(async () => {
      gate.resolve();
    });
    await settle();

    expect(spiedPrepare()).toHaveBeenCalledTimes(1);
    expect(byTestId(container, 'import-download')).toBeNull();
    expect(byTestId(container, 'import-prepare-result')).toBeNull();
    expect(byTestId(container, 'import-session-lost')).not.toBeNull();
  });

  it('V3: ein storage-Ereignis während verify verwirft dessen spätes ok', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();

    const gate = deferred();
    spiedVerify().mockImplementationOnce(async (session, file) => {
      const outcome = await actualService.verifyReselectedTargetBackup(session, file);
      await gate.promise;
      return outcome;
    });

    const input = byTestId(container, 'import-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' })],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY_ONE, newValue: '{}' }));
    });
    await act(async () => {
      gate.resolve();
    });
    await settle();

    expect(spiedVerify()).toHaveBeenCalledTimes(1);
    expect(byTestId(container, 'import-start-quarantine')).toBeNull();
    expect(byTestId(container, 'import-verify-result')).toBeNull();
    download.restore();
  });

  it('V4: ein Zielwechsel während prepare verwirft dessen spätes Ergebnis', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    await seedWorkspace(WS_TWO, KEY_TWO, COMPANY_TWO, files);

    const gate = deferred();
    spiedPrepare().mockImplementationOnce(async (key: string) => {
      const outcome = await actualService.prepareTargetBackupSession(key);
      await gate.promise;
      return outcome;
    });

    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);
    await act(async () => {
      byTestId(container, 'import-prepare')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await act(async () => {
      byTestId(container, `import-target-option-${KEY_TWO}`)!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await act(async () => {
      gate.resolve();
    });
    await settle();

    expect(byTestId(container, 'import-download')).toBeNull();
    expect(byTestId(container, 'import-selected-target')?.textContent).toContain(KEY_TWO);
  });

  it('V5: ein Unmount während verify verwirft dessen spätes Ergebnis', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();

    const gate = deferred();
    let late = false;
    spiedVerify().mockImplementationOnce(async (session, file) => {
      const outcome = await actualService.verifyReselectedTargetBackup(session, file);
      await gate.promise;
      late = true;
      return outcome;
    });

    const input = byTestId(container, 'import-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' })],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      root?.unmount();
    });
    await act(async () => {
      gate.resolve();
    });
    await settle();

    expect(late).toBe(true);
    // Nach dem Unmount existiert kein Startknopf mehr — nichts wurde gesetzt.
    expect(host?.querySelector('[data-testid="import-start-quarantine"]') ?? null).toBeNull();
    expect(listQuarantineMarkers()).toEqual([]);
    download.restore();
  });
});

describe('02P3B/C — tatsächliche Dienstaufrufzahlen', () => {
  it('V6: doppelter Prepare-Klick ruft den Dienst genau einmal', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);
    await doubleClick(container, 'import-prepare');

    expect(spiedPrepare()).toHaveBeenCalledTimes(1);
    expect(spiedPrepare()).toHaveBeenCalledWith(KEY_ONE);
  });

  it('V7: zwei change-Ereignisse rufen die Prüfung genau einmal', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();

    const input = byTestId(container, 'import-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' })],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();

    expect(spiedVerify()).toHaveBeenCalledTimes(1);
    download.restore();
  });

  it('V8: doppelter Quarantäneklick ruft den Kern genau einmal', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));

    await doubleClick(container, 'import-start-quarantine');

    expect(spiedQuarantine()).toHaveBeenCalledTimes(1);
    download.restore();
  });
});

describe('02P3B/D — Auswahl während laufender Quarantäne', () => {
  it('V9: ein Zielwechsel während der Quarantäne bleibt wirkungslos', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    await seedWorkspace(WS_TWO, KEY_TWO, COMPANY_TWO, files);
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));

    const gate = deferred();
    spiedQuarantine().mockImplementationOnce(async (session) => {
      const outcome = await actualService.createTargetQuarantine(session);
      await gate.promise;
      return outcome;
    });

    await act(async () => {
      byTestId(container, 'import-start-quarantine')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await settle(5);

    const otherButton = byTestId(container, `import-target-option-${KEY_TWO}`) as
      | HTMLButtonElement
      | null;
    expect(otherButton?.disabled).toBe(true);
    await act(async () => {
      otherButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle(5);

    expect(byTestId(container, 'import-selected-target')?.textContent).toContain(KEY_ONE);
    expect(spiedPrepare()).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve();
    });
    await settle(30);

    expect(byTestId(container, 'import-report')?.textContent).toContain(KEY_ONE);
    expect(byTestId(container, 'import-report')?.textContent).not.toContain(KEY_TWO);
    download.restore();
  });
});

describe('02P3B/E — complete ist ein Endzustand', () => {
  it('V10: nach complete gibt es keine Auswahl und keinen neuen Ablauf', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    await seedWorkspace(WS_TWO, KEY_TWO, COMPANY_TWO, files);
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));
    await click(container, 'import-start-quarantine');

    const reportBefore = byTestId(container, 'import-report')!.textContent;
    expect(byTestId(container, `import-target-option-${KEY_ONE}`)).toBeNull();
    expect(byTestId(container, `import-target-option-${KEY_TWO}`)).toBeNull();
    expect(byTestId(container, 'import-prepare')).toBeNull();
    expect(byTestId(container, 'import-download')).toBeNull();
    expect(byTestId(container, 'import-choose-file')).toBeNull();
    expect(byTestId(container, 'import-start-quarantine')).toBeNull();

    // Auch ein erneutes change-Ereignis auf dem Feld ändert nichts.
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));
    expect(byTestId(container, 'import-report')!.textContent).toBe(reportBefore);
    expect(spiedQuarantine()).toHaveBeenCalledTimes(1);
    download.restore();
  });
});

describe('02P3B/F — storage-Ereignis nach complete', () => {
  it('V11: der Bericht bleibt vollständig und erhält eine Warnung', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));
    await click(container, 'import-start-quarantine');

    const marker = listQuarantineMarkers()[0]!;
    expect(byTestId(container, 'import-report-target-change')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY_ONE, newValue: '{}' }));
    });
    await settle();

    const text = byTestId(container, 'import-report')?.textContent ?? '';
    expect(text).toContain(marker.archiveSha256);
    expect(text).toContain(marker.sourceRawTextSha256);
    expect(text).toContain(marker.token);
    expect(text).toContain('2026-08-19T09:00:00.000Z');
    expect(text).toContain('complete');
    expect(byTestId(container, 'import-report-target-change')?.textContent).toContain(
      'für keinen weiteren Schritt freigegeben',
    );
    expect(byTestId(container, 'import-cleanup-staging')).toBeNull();
    expect(byTestId(container, `import-target-option-${KEY_ONE}`)).toBeNull();
    expect(window.location.pathname).toBe('/local-recovery/import');
    download.restore();
  });
});

describe('02P3B/G — storage-Ereignis vor dem Quarantänestart', () => {
  it('V12: der Bereich muss danach erneut ausdrücklich gewählt werden', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));
    expect(byTestId(container, 'import-start-quarantine')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY_ONE, newValue: '{}' }));
    });
    await settle();

    expect(byTestId(container, 'import-selected-target')).toBeNull();
    expect(byTestId(container, 'import-prepare')).toBeNull();
    expect(byTestId(container, 'import-download')).toBeNull();
    expect(byTestId(container, 'import-start-quarantine')).toBeNull();
    expect(byTestId(container, 'import-session-lost')).not.toBeNull();

    // Erst der erneute ausdrückliche Klick öffnet den Ablauf wieder.
    await click(container, `import-target-option-${KEY_ONE}`);
    expect(byTestId(container, 'import-prepare')).not.toBeNull();
    expect(byTestId(container, 'import-download')).toBeNull();
    download.restore();
  });
});

describe('02P3B/H — Downloadfehler', () => {
  it('V13: ein fehlgeschlagener Download bleibt wiederholbar', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);
    await click(container, 'import-prepare');

    const failing = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('kein Objekt-Verweis');
    });
    await click(container, 'import-download');

    expect(byTestId(container, 'import-download-error')).not.toBeNull();
    expect(byTestId(container, 'import-choose-file')).toBeNull();
    expect(byTestId(container, 'import-download')).not.toBeNull();
    failing.mockRestore();

    const download = captureDownload();
    await click(container, 'import-download');
    expect(download.blobs.length).toBe(1);
    expect(byTestId(container, 'import-choose-file')).not.toBeNull();

    // Der zweite Klick derselben Sitzung bleibt blockiert.
    await click(container, 'import-choose-file');
    expect(download.blobs.length).toBe(1);
    download.restore();
  });
});

describe('02P3B/I — gebundene Resultatschlüssel', () => {
  it('V14: der Bericht verwendet markerKey, stateKey und Blob-Bereich der Rückgabe', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));

    spiedQuarantine().mockImplementationOnce(async (session) => {
      const outcome = await actualService.createTargetQuarantine(session);
      if (!outcome.ok) return outcome;
      return {
        ...outcome,
        markerKey: 'MARKER-SCHLUESSEL-AUS-RUECKGABE',
        stateKey: 'HUELLEN-SCHLUESSEL-AUS-RUECKGABE',
        quarantineScopeKey: outcome.quarantineScopeKey,
      };
    });

    await click(container, 'import-start-quarantine');

    const text = byTestId(container, 'import-report')?.textContent ?? '';
    expect(text).toContain('MARKER-SCHLUESSEL-AUS-RUECKGABE');
    expect(text).toContain('HUELLEN-SCHLUESSEL-AUS-RUECKGABE');
    expect(text).not.toContain(`officepilot-emergency-quarantine-marker:${listQuarantineMarkers()[0]!.token}`);
    download.restore();
  });
});

describe('02P3B/J — Markeränderung eines anderen Tabs', () => {
  it('V15: ein neuer staging-Marker blockiert das vorbereitete Ziel ohne Bereinigung', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();

    const token = 'q-9999999999999999-8888888888888888';
    const marker: QuarantineMarker = {
      kind: 'officepilot-emergency-quarantine',
      formatVersion: 1,
      token,
      status: 'staging',
      sourceStorageKey: KEY_ONE,
      sourceScopeKey: `workspace:${WS_ONE}`,
      workspaceId: WS_ONE,
      archiveSha256: 'e'.repeat(64),
      sourceRawTextSha256: 'f'.repeat(64),
      files: [],
      createdAt: NOW,
    };
    const markerKey = buildQuarantineMarkerKey(token);
    localStorage.setItem(markerKey, JSON.stringify(marker));

    const open = vi.spyOn(indexedDB, 'open');
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: markerKey, newValue: JSON.stringify(marker) }),
      );
    });
    await settle();

    expect(byTestId(container, `import-marker-${token}`)).not.toBeNull();
    expect(byTestId(container, 'import-staging-blocked')).not.toBeNull();
    expect(byTestId(container, 'import-download')).toBeNull();
    expect(byTestId(container, 'import-choose-file')).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(localStorage.getItem(markerKey)).toBe(JSON.stringify(marker));
    download.restore();
  });
});

/* ========================================================================== *
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P3C — terminaler Dateipfad
 * ========================================================================== */

/** Ein echtes change-Ereignis mit echter File-Instanz auf dem versteckten Feld. */
async function fireFileEvent(container: HTMLElement, file: File): Promise<void> {
  const input = byTestId(container, 'import-file-input') as HTMLInputElement | null;
  expect(input, 'Dateifeld fehlt').not.toBeNull();
  Object.defineProperty(input!, 'files', { value: [file], configurable: true });
  await act(async () => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

describe('02P3C/A — Dateiereignis nach Verifikation und nach complete', () => {
  it('W1: nach erfolgreicher Wiederauswahl gibt es keinen Auswahlknopf und keine zweite Prüfung', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    const file = new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' });
    await chooseFile(container, file);

    expect(spiedVerify()).toHaveBeenCalledTimes(1);
    expect(byTestId(container, 'import-choose-file')).toBeNull();

    await fireFileEvent(container, file);

    expect(spiedVerify()).toHaveBeenCalledTimes(1);
    expect(byTestId(container, 'import-start-quarantine')).not.toBeNull();
    download.restore();
  });

  it('W2: nach complete bleibt ein Dateiereignis vollständig wirkungslos', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    const file = new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' });
    await chooseFile(container, file);
    await click(container, 'import-start-quarantine');

    const reportBefore = byTestId(container, 'import-report')!.textContent;
    const verifyCalls = spiedVerify().mock.calls.length;

    await fireFileEvent(container, file);

    expect(spiedVerify()).toHaveBeenCalledTimes(verifyCalls);
    expect(byTestId(container, 'import-report')!.textContent).toBe(reportBefore);
    expect(byTestId(container, 'import-report')!.textContent).toContain(
      '2026-08-19T09:00:00.000Z',
    );
    expect(byTestId(container, 'import-verify-result')).toBeNull();
    expect(byTestId(container, 'import-start-quarantine')).toBeNull();
    expect(spiedQuarantine()).toHaveBeenCalledTimes(1);
    download.restore();
  });
});

describe('02P3C/B — Dateiereignis während der Quarantäne', () => {
  it('W3: ein Dateiereignis während quarantining verändert nichts', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    await seedWorkspace(WS_TWO, KEY_TWO, COMPANY_TWO, files);
    const { container, download } = await preparedAndDownloaded();
    const file = new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' });
    await chooseFile(container, file);

    const verifyCalls = spiedVerify().mock.calls.length;
    const gate = deferred();
    spiedQuarantine().mockImplementationOnce(async (session) => {
      const outcome = await actualService.createTargetQuarantine(session);
      await gate.promise;
      return outcome;
    });

    await act(async () => {
      byTestId(container, 'import-start-quarantine')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await settle(5);

    await fireFileEvent(container, file);

    expect(spiedVerify()).toHaveBeenCalledTimes(verifyCalls);
    expect(byTestId(container, 'import-quarantine-busy')).not.toBeNull();
    expect(byTestId(container, 'import-report')).toBeNull();
    expect(byTestId(container, 'import-selected-target')?.textContent).toContain(KEY_ONE);

    await act(async () => {
      gate.resolve();
    });
    await settle(30);

    expect(byTestId(container, 'import-report')?.textContent).toContain(KEY_ONE);
    expect(byTestId(container, 'import-report')?.textContent).not.toContain(KEY_TWO);
    download.restore();
  });
});

describe('02P3C/C — Markerereignis nach complete', () => {
  it('W4: ein fremder staging-Marker beschädigt den Abschlussbericht nicht', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));
    await click(container, 'import-start-quarantine');

    const ownMarker = listQuarantineMarkers()[0]!;
    const reportBefore = byTestId(container, 'import-report')!.textContent ?? '';

    const token = 'q-7777777777777777-6666666666666666';
    const foreign: QuarantineMarker = {
      kind: 'officepilot-emergency-quarantine',
      formatVersion: 1,
      token,
      status: 'staging',
      sourceStorageKey: KEY_ONE,
      sourceScopeKey: `workspace:${WS_ONE}`,
      workspaceId: WS_ONE,
      archiveSha256: '1'.repeat(64),
      sourceRawTextSha256: '2'.repeat(64),
      files: [],
      createdAt: NOW,
    };
    const markerKey = buildQuarantineMarkerKey(token);
    localStorage.setItem(markerKey, JSON.stringify(foreign));

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: markerKey, newValue: JSON.stringify(foreign) }),
      );
    });
    await settle();

    const text = byTestId(container, 'import-report')?.textContent ?? '';
    expect(text).toBe(reportBefore);
    expect(text).toContain('2026-08-19T09:00:00.000Z');
    expect(text).toContain(ownMarker.archiveSha256);
    expect(text).toContain(ownMarker.sourceRawTextSha256);
    expect(text).toContain('complete');
    // Der fremde Marker erscheint rein lesend in der Liste.
    expect(byTestId(container, `import-marker-${token}`)).not.toBeNull();
    expect(byTestId(container, 'import-staging-blocked')).toBeNull();
    expect(byTestId(container, `import-target-option-${KEY_ONE}`)).toBeNull();
    expect(localStorage.getItem(markerKey)).toBe(JSON.stringify(foreign));
    download.restore();
  });
});

/* ========================================================================== *
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P3E — mobil lesbare Zielauswahl
 *
 * Vitest wertet kein CSS aus. Geprüft werden deshalb die semantische Struktur
 * und — als Textprüfung der Stylesheet-Datei — der eng begrenzte CSS-Vertrag.
 * Es wird keine Layoutmessung vorgetäuscht.
 * ========================================================================== */

const TARGET_CLASS = 'local-recovery-import-target';
const ROW_CLASS = `${TARGET_CLASS}__row`;
const VALUE_CLASS = `${TARGET_CLASS}__value`;
const TECHNICAL_CLASS = `${VALUE_CLASS}--technical`;

const EXPECTED_FIELDS = [
  'storageKey',
  'workspaceId',
  'setupCompany',
  'profileCompany',
  'savedAt',
  'counts',
] as const;

function targetButton(container: HTMLElement, storageKey: string): HTMLButtonElement {
  const button = byTestId(container, `import-target-option-${storageKey}`);
  expect(button, `Zielknopf fehlt: ${storageKey}`).not.toBeNull();
  return button as HTMLButtonElement;
}

/** Zeile ausschließlich innerhalb des jeweiligen Zielknopfs — keine globale ID. */
function rowOf(button: HTMLButtonElement, field: string): HTMLElement {
  const row = button.querySelector(`[data-field="${field}"]`);
  expect(row, `Zeile fehlt: ${field}`).not.toBeNull();
  return row as HTMLElement;
}

function labelOf(button: HTMLButtonElement, field: string): string {
  return (
    rowOf(button, field).querySelector(`.${VALUE_CLASS}`)?.previousElementSibling?.textContent ?? ''
  );
}

function valueOf(button: HTMLButtonElement, field: string): string {
  return rowOf(button, field).querySelector(`.${VALUE_CLASS}`)?.textContent ?? '';
}

/** Reine Textprüfung der Stylesheet-Datei — keine Layoutmessung. */
function readSystemCss(): string {
  return readFileSync('src/styles/system.css', 'utf8');
}

/** Regelblock eines Selektors als Text — reine Vertragsprüfung. */
function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return open < 0 || close < 0 ? '' : css.slice(open + 1, close);
}

describe('02P3E — mobil lesbare Zielauswahl', () => {
  it('X1: der Zielknopf trägt die eigene Klasse und behält alle Bindungen', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    const button = targetButton(container, KEY_ONE);

    for (const className of ['btn', 'btn--outline', 'btn--full', TARGET_CLASS]) {
      expect(button.classList.contains(className), className).toBe(true);
    }
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.disabled).toBe(false);

    // Die Auswahlbindung ist unverändert wirksam.
    await click(container, `import-target-option-${KEY_ONE}`);
    expect(byTestId(container, 'import-selected-target')?.textContent).toContain(KEY_ONE);
  });

  it('X2: der Knopf enthält genau sechs fachliche Zeilen', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    const button = targetButton(container, KEY_ONE);

    expect(button.querySelectorAll(`.${ROW_CLASS}`).length).toBe(6);
    for (const field of EXPECTED_FIELDS) {
      expect(button.querySelectorAll(`[data-field="${field}"]`).length, field).toBe(1);
    }
  });

  it('X3: jede Zeile trägt die richtige Beschriftung und den richtigen Wert', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    await seedWorkspace(WS_TWO, KEY_TWO, COMPANY_TWO, files);
    const container = await renderRoot('/local-recovery/import');

    const cases: [string, string, string][] = [
      [KEY_ONE, WS_ONE, COMPANY_ONE],
      [KEY_TWO, WS_TWO, COMPANY_TWO],
    ];
    for (const [storageKey, workspaceId, company] of cases) {
      const button = targetButton(container, storageKey);
      expect(labelOf(button, 'storageKey')).toContain('Speicherschlüssel');
      expect(valueOf(button, 'storageKey')).toBe(storageKey);
      expect(labelOf(button, 'workspaceId')).toContain('Arbeitsbereich');
      expect(valueOf(button, 'workspaceId')).toBe(workspaceId);
      expect(labelOf(button, 'setupCompany')).toContain('Einrichtung');
      expect(valueOf(button, 'setupCompany')).toBe(company);
      expect(labelOf(button, 'profileCompany')).toContain('Profil');
      expect(valueOf(button, 'profileCompany')).toBe(company);
      expect(labelOf(button, 'savedAt')).toContain('Gespeichert am');
      expect(valueOf(button, 'savedAt')).toBe('2026-08-19T09:00:00.000Z');
      expect(labelOf(button, 'counts')).toContain('Vorgänge');
      expect(valueOf(button, 'counts')).toBe('1 / 1');
    }
  });

  it('X4: keine Verkettung, keine führenden Gedankenstriche, Schlüssel nur in seiner Zeile', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    const button = targetButton(container, KEY_ONE);

    for (const field of EXPECTED_FIELDS) {
      const text = (rowOf(button, field).textContent ?? '').trim();
      expect(text.startsWith('—'), `${field} beginnt mit Gedankenstrich`).toBe(false);
      expect(text.includes('—'), `${field} verkettet Angaben`).toBe(false);
    }
    for (const field of EXPECTED_FIELDS) {
      const text = rowOf(button, field).textContent ?? '';
      expect(text.includes(KEY_ONE), `${field} enthält den vollen Schlüssel`).toBe(
        field === 'storageKey',
      );
    }
  });

  it('X5: technische Werte tragen die Monospace-Klasse und bleiben vollständig', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    const button = targetButton(container, KEY_ONE);

    for (const field of ['storageKey', 'workspaceId']) {
      const value = rowOf(button, field).querySelector(`.${VALUE_CLASS}`) as HTMLElement;
      expect(value.classList.contains(TECHNICAL_CLASS), field).toBe(true);
    }
    for (const field of ['setupCompany', 'profileCompany', 'savedAt', 'counts']) {
      const value = rowOf(button, field).querySelector(`.${VALUE_CLASS}`) as HTMLElement;
      expect(value.classList.contains(TECHNICAL_CLASS), field).toBe(false);
    }
    // Vollständig im DOM, nichts gekürzt.
    expect(valueOf(button, 'storageKey').endsWith(WS_ONE)).toBe(true);
    expect(valueOf(button, 'storageKey').includes('…')).toBe(false);
  });

  it('X6: je Workspace genau ein Knopf ohne verschachtelte Bedienelemente', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    await seedWorkspace(WS_TWO, KEY_TWO, COMPANY_TWO, files);
    const container = await renderRoot('/local-recovery/import');

    for (const storageKey of [KEY_ONE, KEY_TWO]) {
      expect(
        container.querySelectorAll(`[data-testid="import-target-option-${storageKey}"]`).length,
      ).toBe(1);
      const button = targetButton(container, storageKey);
      expect(button.querySelectorAll('button, a, input, select, textarea').length).toBe(0);
    }
    // Weiterhin keine automatische Auswahl.
    expect(byTestId(container, 'import-selected-target')).toBeNull();
    expect(byTestId(container, 'import-prepare')).toBeNull();
  });

  it('X7: system.css erfüllt den eng begrenzten Darstellungsvertrag', () => {
    const css = readSystemCss();
    const block = cssBlock(css, `.btn.${TARGET_CLASS}`);
    expect(block, 'Regel .btn.local-recovery-import-target fehlt').not.toBe('');

    for (const rule of [
      'display: grid',
      'width: 100%',
      'max-width: 100%',
      'min-width: 0',
      'box-sizing: border-box',
      'white-space: normal',
      'text-align: left',
    ]) {
      expect(block.includes(rule), rule).toBe(true);
    }
    expect(block.includes('justify-content: center')).toBe(false);
    expect(block.includes('align-items: center')).toBe(false);

    const valueBlock = cssBlock(css, `.${VALUE_CLASS}`);
    expect(valueBlock, 'Werteregel fehlt').not.toBe('');
    expect(valueBlock.includes('min-width: 0')).toBe(true);
    expect(valueBlock.includes('overflow-wrap: anywhere')).toBe(true);

    // Die globale Buttonregel wird hier nicht angefasst …
    expect(cssBlock(css, '.btn {')).toBe('');
    // … und die neuen Regeln erzwingen nichts.
    expect(block.includes('!important')).toBe(false);
    expect(valueBlock.includes('!important')).toBe(false);
    expect(cssBlock(css, `.${ROW_CLASS}`).includes('!important')).toBe(false);
  });
});

/* ========================================================================== *
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P3F — alle technischen Prüfwerte
 * mobil sicher darstellen. Geprüft werden Struktur, Klassenabdeckung und der
 * Stylesheet-Text; eine Layoutmessung wird nicht vorgetäuscht.
 * ========================================================================== */

const PAGE_CLASS = 'local-recovery-import-page';
const DETAILS_CLASS = 'local-recovery-import-details';
const DETAIL_ROW_CLASS = 'local-recovery-import-detail-row';
const DETAIL_LABEL_CLASS = 'local-recovery-import-detail-label';
const TECHNICAL_VALUE_CLASS = 'local-recovery-import-technical-value';

function detailRow(scope: HTMLElement, field: string): HTMLElement {
  const row = scope.querySelector(`.${DETAIL_ROW_CLASS}[data-field="${field}"]`);
  expect(row, `Detailzeile fehlt: ${field}`).not.toBeNull();
  return row as HTMLElement;
}

function detailLabel(scope: HTMLElement, field: string): string {
  return detailRow(scope, field).querySelector(`.${DETAIL_LABEL_CLASS}`)?.textContent ?? '';
}

function detailValueNode(scope: HTMLElement, field: string): HTMLElement {
  const row = detailRow(scope, field);
  const value = row.querySelector('dd');
  expect(value, `Wertelement fehlt: ${field}`).not.toBeNull();
  return value as HTMLElement;
}

function detailValue(scope: HTMLElement, field: string): string {
  return detailValueNode(scope, field).textContent ?? '';
}

function expectTechnical(scope: HTMLElement, field: string): void {
  expect(
    detailValueNode(scope, field).classList.contains(TECHNICAL_VALUE_CLASS),
    `${field} ohne Umbruchklasse`,
  ).toBe(true);
}

/** Kein Wert darf gekürzt oder mit Auslassungspunkten versehen sein. */
function expectComplete(text: string, expected: string): void {
  expect(text).toBe(expected);
  expect(text.includes('…')).toBe(false);
  expect(text.includes('...')).toBe(false);
}

describe('02P3F — technische Prüfwerte mobil sicher darstellen', () => {
  it('Y1: das Vorbereitungsergebnis besteht aus beschrifteten Zeilen', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);
    await click(container, 'import-prepare');

    const scope = byTestId(container, 'import-prepare-result')!;
    expect(scope).not.toBeNull();
    expect(scope.querySelector(`.${DETAILS_CLASS}`) ?? scope.closest(`.${DETAILS_CLASS}`)).not.toBeNull();

    for (const [field, label] of [
      ['storageKey', 'Speicherschlüssel'],
      ['workspaceId', 'Arbeitsbereich'],
      ['fileCount', 'Dateien'],
      ['archiveSha256', 'Archiv-SHA-256'],
    ] as const) {
      expect(detailLabel(scope, field)).toContain(label);
    }
    // Der verkettete Absatz mit Gedankenstrichen existiert nicht mehr.
    for (const field of ['storageKey', 'workspaceId', 'fileCount', 'archiveSha256']) {
      expect(detailValue(scope, field).includes('—'), field).toBe(false);
    }
  });

  it('Y2: die vollständigen Werte bleiben unverändert im DOM', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);
    await click(container, 'import-prepare');

    const scope = byTestId(container, 'import-prepare-result')!;
    expectComplete(detailValue(scope, 'storageKey'), KEY_ONE);
    expectComplete(detailValue(scope, 'workspaceId'), WS_ONE);
    expect(detailValue(scope, 'fileCount')).toBe('2');

    const hash = detailValue(scope, 'archiveSha256');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    for (const field of ['storageKey', 'workspaceId', 'archiveSha256']) {
      expectTechnical(scope, field);
    }
  });

  it('Y3: gewählter Bereich und Markerliste tragen die Umbruchklasse', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const stagingToken = 'q-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb';
    const completeToken = 'q-cccccccccccccccc-dddddddddddddddd';
    for (const [token, status] of [
      [stagingToken, 'staging'],
      [completeToken, 'complete'],
    ] as const) {
      localStorage.setItem(
        buildQuarantineMarkerKey(token),
        JSON.stringify({
          kind: 'officepilot-emergency-quarantine',
          formatVersion: 1,
          token,
          status,
          sourceStorageKey: status === 'staging' ? KEY_TWO : KEY_ONE,
          sourceScopeKey: `workspace:${WS_TWO}`,
          workspaceId: WS_TWO,
          archiveSha256: '9'.repeat(64),
          sourceRawTextSha256: '8'.repeat(64),
          files: [],
          createdAt: NOW,
        }),
      );
    }

    const container = await renderRoot('/local-recovery/import');

    for (const [token, status, storageKey] of [
      [stagingToken, 'staging', KEY_TWO],
      [completeToken, 'complete', KEY_ONE],
    ] as const) {
      const scope = byTestId(container, `import-marker-${token}`)!;
      expect(scope, token).not.toBeNull();
      expect(detailValue(scope, 'status')).toBe(status);
      expectComplete(detailValue(scope, 'token'), token);
      expectComplete(detailValue(scope, 'sourceStorageKey'), storageKey);
      expectTechnical(scope, 'token');
      expectTechnical(scope, 'sourceStorageKey');
    }

    await click(container, `import-target-option-${KEY_ONE}`);
    const selected = byTestId(container, 'import-selected-target')!;
    expectComplete(detailValue(selected, 'storageKey'), KEY_ONE);
    expectTechnical(selected, 'storageKey');
  });

  it('Y4: der blockierende staging-Marker ist strukturiert', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const token = 'q-eeeeeeeeeeeeeeee-ffffffffffffffff';
    const archive = '7'.repeat(64);
    localStorage.setItem(
      buildQuarantineMarkerKey(token),
      JSON.stringify({
        kind: 'officepilot-emergency-quarantine',
        formatVersion: 1,
        token,
        status: 'staging',
        sourceStorageKey: KEY_ONE,
        sourceScopeKey: `workspace:${WS_ONE}`,
        workspaceId: WS_ONE,
        archiveSha256: archive,
        sourceRawTextSha256: '6'.repeat(64),
        files: [],
        createdAt: NOW,
      }),
    );

    const container = await renderRoot('/local-recovery/import');
    await click(container, `import-target-option-${KEY_ONE}`);

    const scope = byTestId(container, 'import-staging-blocked')!;
    expect(scope).not.toBeNull();
    expect(scope.getAttribute('role')).toBe('alert');
    expectComplete(detailValue(scope, 'token'), token);
    expectComplete(detailValue(scope, 'workspaceId'), WS_ONE);
    expect(detailValue(scope, 'createdAt')).toBe(NOW);
    expectComplete(detailValue(scope, 'archiveSha256'), archive);
    expect(detailValue(scope, 'fileCount')).toBe('0');
    for (const field of ['token', 'workspaceId', 'archiveSha256']) {
      expectTechnical(scope, field);
    }
    // Die Blockierung selbst bleibt unverändert.
    expect(byTestId(container, 'import-prepare')).toBeNull();
    expect(byTestId(container, 'import-cleanup-staging')).toBeNull();
  });

  it('Y5: der Abschlussbericht verwendet die Umbruchklasse lückenlos', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));

    spiedQuarantine().mockImplementationOnce(async (session) => {
      const outcome = await actualService.createTargetQuarantine(session);
      if (!outcome.ok) return outcome;
      return {
        ...outcome,
        markerKey: 'MARKER-SCHLUESSEL-AUS-RUECKGABE',
        stateKey: 'HUELLEN-SCHLUESSEL-AUS-RUECKGABE',
      };
    });
    await click(container, 'import-start-quarantine');

    const scope = byTestId(container, 'import-report')!;
    const marker = listQuarantineMarkers().find((entry) => entry.status === 'complete')!;

    expectComplete(detailValue(scope, 'sourceStorageKey'), KEY_ONE);
    expectComplete(detailValue(scope, 'sourceScopeKey'), `workspace:${WS_ONE}`);
    expectComplete(detailValue(scope, 'workspaceId'), WS_ONE);
    expectComplete(detailValue(scope, 'savedAt'), '2026-08-19T09:00:00.000Z');
    expectComplete(detailValue(scope, 'archiveSha256'), marker.archiveSha256);
    expectComplete(detailValue(scope, 'sourceRawTextSha256'), marker.sourceRawTextSha256);
    expectComplete(detailValue(scope, 'token'), marker.token);
    // Direkt aus QuarantineSuccess, nicht aus dem Token nachgerechnet.
    expectComplete(detailValue(scope, 'markerKey'), 'MARKER-SCHLUESSEL-AUS-RUECKGABE');
    expectComplete(detailValue(scope, 'stateKey'), 'HUELLEN-SCHLUESSEL-AUS-RUECKGABE');
    expectComplete(detailValue(scope, 'quarantineScopeKey'), `quarantine:${marker.token}`);
    expect(detailValue(scope, 'completedAt')).toBe(marker.completedAt);
    expect(detailValue(scope, 'status')).toBe('complete');

    for (const field of [
      'sourceStorageKey',
      'sourceScopeKey',
      'workspaceId',
      'savedAt',
      'archiveSha256',
      'sourceRawTextSha256',
      'token',
      'markerKey',
      'stateKey',
      'quarantineScopeKey',
      'completedAt',
    ]) {
      expectTechnical(scope, field);
    }
    download.restore();
  });

  it('Y6: jeder Dateieintrag zeigt getrennte, vollständige Werte', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));
    await click(container, 'import-start-quarantine');

    const report = byTestId(container, 'import-report')!;
    for (const file of files) {
      const scope = report.querySelector(`[data-file="${file.id}"]`) as HTMLElement | null;
      expect(scope, `Dateieintrag fehlt: ${file.id}`).not.toBeNull();
      expectComplete(detailValue(scope!, 'fileRefId'), file.id);
      expectComplete(detailValue(scope!, 'localDataKey'), file.localDataKey);
      expectComplete(detailValue(scope!, 'mimeType'), file.mimeType);
      expect(detailValue(scope!, 'fileSize')).toContain(String(file.bytes.byteLength));
      expectComplete(detailValue(scope!, 'sha256'), file.hash);
      for (const field of ['fileRefId', 'localDataKey', 'mimeType', 'sha256']) {
        expectTechnical(scope!, field);
      }
    }
    download.restore();
  });

  it('Y7: system.css erfüllt den scoped Umbruchvertrag', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const container = await renderRoot('/local-recovery/import');

    // Die Wurzelklasse ist der einzige Anker der neuen Regeln.
    const page = byTestId(container, 'local-recovery-import-page')!;
    expect(page.classList.contains('auth-page')).toBe(true);
    expect(page.classList.contains(PAGE_CLASS)).toBe(true);
    // Auch die Adresse trägt die Umbruchklasse.
    expect(
      byTestId(container, 'import-origin')?.querySelector(`.${TECHNICAL_VALUE_CLASS}`),
    ).not.toBeNull();

    const css = readSystemCss();
    const valueBlock = cssBlock(css, `.${PAGE_CLASS} .${TECHNICAL_VALUE_CLASS}`);
    expect(valueBlock, 'scoped Werteregel fehlt').not.toBe('');
    for (const rule of [
      'display: block',
      'width: 100%',
      'min-width: 0',
      'max-width: 100%',
      'box-sizing: border-box',
      'white-space: normal',
      'overflow-wrap: anywhere',
      'word-break: break-word',
    ]) {
      expect(valueBlock.includes(rule), rule).toBe(true);
    }

    const rowBlock = cssBlock(css, `.${PAGE_CLASS} .${DETAIL_ROW_CLASS}`);
    expect(rowBlock, 'scoped Zeilenregel fehlt').not.toBe('');
    expect(rowBlock.includes('min-width: 0')).toBe(true);
    expect(rowBlock.includes('max-width: 100%')).toBe(true);

    const detailsBlock = cssBlock(css, `.${PAGE_CLASS} .${DETAILS_CLASS}`);
    expect(detailsBlock.includes('min-width: 0')).toBe(true);

    // Die Zielkarte aus 02P3E und die globalen Regeln bleiben unangetastet.
    expect(cssBlock(css, '.btn {')).toBe('');
    expect(cssBlock(css, `.btn.${TARGET_CLASS}`).includes('display: grid')).toBe(true);
    expect(valueBlock.includes('!important')).toBe(false);
    expect(valueBlock.includes('overflow: hidden')).toBe(false);
    expect(valueBlock.includes('text-overflow')).toBe(false);
  });
});

describe('02P3D/W5 — Markerereignis während laufender Quarantäne', () => {
  it('W5: ein fremder staging-Marker entwertet die laufende Quarantäne nicht', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const { container, download } = await preparedAndDownloaded();
    await chooseFile(container, new File([download.blobs[0]!], 'a.zip', { type: 'application/zip' }));

    const gate = deferred();
    spiedQuarantine().mockImplementationOnce(async (session) => {
      const outcome = await actualService.createTargetQuarantine(session);
      await gate.promise;
      return outcome;
    });

    await act(async () => {
      byTestId(container, 'import-start-quarantine')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await settle(5);
    expect(byTestId(container, 'import-quarantine-busy')).not.toBeNull();

    const token = 'q-5555555555555555-4444444444444444';
    const foreign: QuarantineMarker = {
      kind: 'officepilot-emergency-quarantine',
      formatVersion: 1,
      token,
      status: 'staging',
      sourceStorageKey: KEY_ONE,
      sourceScopeKey: `workspace:${WS_ONE}`,
      workspaceId: WS_ONE,
      archiveSha256: '3'.repeat(64),
      sourceRawTextSha256: '4'.repeat(64),
      files: [],
      createdAt: NOW,
    };
    const markerKey = buildQuarantineMarkerKey(token);
    const markerRaw = JSON.stringify(foreign);
    localStorage.setItem(markerKey, markerRaw);

    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const del = vi.spyOn(IDBObjectStore.prototype, 'delete');

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: markerKey, newValue: markerRaw }));
    });
    await settle(5);

    // --- vor der Auflösung -------------------------------------------------
    expect(byTestId(container, 'import-quarantine-busy')).not.toBeNull();
    expect(byTestId(container, 'import-staging-blocked')).toBeNull();
    expect(byTestId(container, 'import-session-lost')).toBeNull();
    expect(byTestId(container, 'import-selected-target')?.textContent).toContain(KEY_ONE);
    expect(spiedQuarantine()).toHaveBeenCalledTimes(1);
    expect(byTestId(container, `import-marker-${token}`)).not.toBeNull();
    expect(removeItem).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();

    // --- Auflösung ---------------------------------------------------------
    await act(async () => {
      gate.resolve();
    });
    await settle(30);

    const own = listQuarantineMarkers().find((marker) => marker.status === 'complete')!;
    const text = byTestId(container, 'import-report')?.textContent ?? '';
    expect(text).toContain('2026-08-19T09:00:00.000Z');
    expect(text).toContain(own.archiveSha256);
    expect(text).toContain(own.sourceRawTextSha256);
    expect(text).toContain(own.token);
    expect(text).toContain(KEY_ONE);
    expect(text).toContain('complete');

    const warning = byTestId(container, 'import-report-target-change');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('Quarantänevorgang');
    expect(warning?.textContent).toContain('für keinen weiteren Schritt freigegeben');

    expect(localStorage.getItem(markerKey)).toBe(markerRaw);
    expect(removeItem).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(byTestId(container, `import-target-option-${KEY_ONE}`)).toBeNull();
    expect(window.location.pathname).toBe('/local-recovery/import');
    download.restore();
  });
});

describe('02P3B/K — fremde ZIP verändert wirklich nichts', () => {
  it('V16: localStorage und Zielblobs bleiben byteidentisch', async () => {
    const files = await buildSeedFiles();
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, files);
    const { container, download } = await preparedAndDownloaded();

    const storageBefore = snapshotStorage();
    const blobsBefore: Record<string, string> = {};
    for (const file of files) {
      const read = await readScopeBlobRecord(`workspace:${WS_ONE}`, file.id);
      blobsBefore[file.id] = Array.from(read.bytes ?? []).join(',');
    }

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const del = vi.spyOn(IDBObjectStore.prototype, 'delete');

    // Eine fremde, aber formal gültige ZIP: die Sicherung eines anderen Ziels.
    const foreign = new Uint8Array(await download.blobs[0]!.arrayBuffer());
    foreign[foreign.byteLength - 10] = (foreign[foreign.byteLength - 10]! ^ 0xff) & 0xff;
    await chooseFile(container, new File([foreign], 'a.zip', { type: 'application/zip' }));

    expect(byTestId(container, 'import-reselect-mismatch')).not.toBeNull();
    expect(byTestId(container, 'import-report')).toBeNull();
    expect(listQuarantineMarkers()).toEqual([]);
    expect(snapshotStorage()).toEqual(storageBefore);
    for (const file of files) {
      const read = await readScopeBlobRecord(`workspace:${WS_ONE}`, file.id);
      expect(Array.from(read.bytes ?? []).join(',')).toBe(blobsBefore[file.id]);
    }
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    download.restore();
  });

  /*
   * MOBILE-SAFE-RESUME-01B — Safari verwirft die Seite nach dem Download. Der
   * Ablauf muss auf einer **sicheren** Stufe zurückkehren: Zielbereich und
   * erwartete Prüfsumme bekannt, aber keine Quarantäne und keine gültige
   * Bestätigung.
   */
  it('U-Resume: nach Download und Remount kehrt der Ablauf sicher zurück', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const download = captureDownload();

    const first = await renderRoot('/local-recovery/import');
    await click(first, `import-target-option-${KEY_ONE}`);
    await click(first, 'import-prepare');
    await click(first, 'import-download');
    expect(download.blobs.length).toBe(1);

    const checkpoint = readLocalRecoveryCheckpoint();
    expect(checkpoint, 'kein Wiederaufsetzpunkt geschrieben').not.toBeNull();
    expect(checkpoint?.stage).toBe('download_triggered');
    expect(checkpoint?.sourceStorageKey).toBe(KEY_ONE);
    expect(checkpoint?.workspaceId).toBe(WS_ONE);
    expect(checkpoint?.archiveSha256).toMatch(/^[0-9a-f]{64}$/);

    // Seite verworfen und neu montiert.
    act(() => root!.unmount());
    host!.remove();
    root = null;
    host = null;

    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const second = await renderRoot('/local-recovery/import');

    // Sichere Folgestufe: Ziel und Prüfsumme bekannt.
    const resumed = byTestId(second, 'import-resumed');
    expect(resumed, second.innerHTML.slice(0, 400)).not.toBeNull();
    expect(resumed?.textContent).toContain(KEY_ONE);
    expect(resumed?.textContent).toContain(checkpoint!.archiveSha256);

    // Keine Quarantäne, keine Bestätigung, kein Schreibvorgang.
    expect(listQuarantineMarkers()).toHaveLength(0);
    expect(byTestId(second, 'import-start-quarantine')).toBeNull();
    expect(byTestId(second, 'import-choose-file')).toBeNull();
    expect(put).not.toHaveBeenCalled();
    // Die Sicherung muss erneut vorbereitet werden — der Blob wurde nie gespeichert.
    expect(byTestId(second, 'import-prepare')).not.toBeNull();

    download.restore();
  });

  it('U-Resume-Changed: ein veränderter Zielbestand verwirft den Wiederaufsetzpunkt', async () => {
    await seedWorkspace(WS_ONE, KEY_ONE, COMPANY_ONE, await buildSeedFiles());
    const download = captureDownload();

    const first = await renderRoot('/local-recovery/import');
    await click(first, `import-target-option-${KEY_ONE}`);
    await click(first, 'import-prepare');
    await click(first, 'import-download');
    expect(readLocalRecoveryCheckpoint()).not.toBeNull();

    act(() => root!.unmount());
    host!.remove();
    root = null;
    host = null;

    // Der lokale Zielbestand ändert sich zwischen Download und Rückkehr.
    const raw = localStorage.getItem(KEY_ONE)!;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.savedAt = '2099-01-01T00:00:00.000Z';
    localStorage.setItem(KEY_ONE, JSON.stringify(parsed));

    const second = await renderRoot('/local-recovery/import');

    expect(byTestId(second, 'import-resumed')).toBeNull();
    expect(readLocalRecoveryCheckpoint()).toBeNull();
    expect(listQuarantineMarkers()).toHaveLength(0);

    download.restore();
  });
});
