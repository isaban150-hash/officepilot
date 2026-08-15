/**
 * UPLOAD-DRAFT-RESUME-01C2 — die Karte „Du hast zuletzt hier gearbeitet“ darf nur
 * erscheinen, wenn ein echter, vollständig ladbarer Uploadentwurf existiert.
 *
 * Confirm-first: Weiterarbeiten legt nichts an, Verwerfen entfernt ausschließlich
 * den klar bezeichneten Entwurf samt sicher löschbarer temporärer Datei.
 */
import { act, StrictMode, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { loginAsDefaultAdmin, resetAuthForTests } from './test/authFixtures';
import { DEFAULT_SETUP } from './data/mockData';
import { DocumentUploadPage } from './pages/DocumentUploadPage';
import { UiSessionRecoveryHost } from './components/system/UiSessionRecoveryHost';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import {
  getDocumentFileRefById,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { getDocumentStoreSnapshot, hydrateDocumentStore } from './services/documentService';
import { getInboxStoreSnapshot, hydrateInboxStore } from './services/inboxService';
import { getVorgangStoreSnapshot, hydrateVorgangStore } from './services/vorgangService';
import { getCustomerStoreSnapshot, hydrateCustomerStore } from './services/customerStoreService';
import * as blobDbService from './services/storage/documentBlobIndexedDbService';
import { hasDocumentBlob } from './services/storage/documentBlobIndexedDbService';
import * as ocrDocumentService from './services/ocrDocumentService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import * as pendingDocumentIntakeService from './services/pendingDocumentIntakeService';
import { processDocumentFileForPreview } from './services/pendingDocumentIntakeService';
import * as persistenceService from './services/persistenceService';
import {
  listUploadDraftRecordsForActiveScope,
  resetUploadDraftStoreForTests,
  saveUploadDraftRecord,
  getUploadDraftRecordById,
} from './services/storage/uploadDraftIndexedDbService';
import {
  loadPendingDocumentIntakeDraft,
  savePendingDocumentIntakeDraft,
} from './services/upload/uploadDraftService';
import {
  patchUiSessionLiveChrome,
  resetUiSessionLiveState,
} from './services/uiSession/uiSessionLiveState';
import {
  clearUiSessionSnapshot,
  loadUiSessionSnapshot,
  saveUiSessionSnapshot,
} from './services/uiSession/uiSessionStore';
import { buildUiSessionSnapshot } from './services/uiSession/uiSessionCapture';
import type { UiSessionSnapshot } from './types/uiSessionSnapshot';
import {
  resetStorageScopeForTests,
  setActiveStorageScope,
} from './services/storage/storageScopeService';
import type { CachedDocumentFilePayload } from './services/cachedDocumentFileService';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

useDocumentBlobDatabaseReset();

function fileOf(marker: string): File {
  return new File([new TextEncoder().encode(marker)], `${marker}.jpg`, { type: 'image/jpeg' });
}

function payloadOf(marker: string): CachedDocumentFilePayload {
  const bytes = new TextEncoder().encode(marker);
  return { fileName: `${marker}.jpg`, mimeType: 'image/jpeg', fileSize: bytes.byteLength, bytes };
}

async function previewOf(marker: string) {
  const result = await processDocumentFileForPreview(fileOf(marker));
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('preview failed');
  return result.pending;
}

type RouterLocation = { pathname: string; search: string };
type Mount = {
  container: HTMLDivElement;
  root: Root;
  location: () => RouterLocation;
  navigate: (to: string) => void;
};

function LocationObserver({
  onChange,
  onReady,
}: {
  onChange: (value: RouterLocation) => void;
  onReady: (navigate: (to: string) => void) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    onChange({ pathname: location.pathname, search: location.search });
    onReady((to: string) => navigate(to));
  }, [location.pathname, location.search, navigate, onChange, onReady]);
  return null;
}

/** Eine AppShell-ähnliche Hülle: Host bleibt bei Navigation montiert. */
function renderShell(initialEntry: string, options: { strict?: boolean } = {}): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let current: RouterLocation = { pathname: '', search: '' };
  let navigateFn: (to: string) => void = () => {};
  const Wrapper = options.strict ? StrictMode : Fragment;
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <Wrapper>
        <MemoryRouter initialEntries={[initialEntry]}>
          <AuthProvider>
          <AppProvider initialSetup={completeSetup}>
            <LocationObserver
              onChange={(value) => {
                current = value;
              }}
              onReady={(fn) => {
                navigateFn = fn;
              }}
            />
            <UiSessionRecoveryHost />
            <div className="app-shell__main">
              <Routes>
                <Route path="/dokumente/upload" element={<DocumentUploadPage />} />
                <Route path="/" element={<div data-testid="desk-page">Schreibtisch</div>} />
                <Route path="/ablage/:id" element={<div data-testid="inbox-detail" />} />
                <Route path="/dokumente/:id" element={<div data-testid="document-detail" />} />
              </Routes>
            </div>
          </AppProvider>
          </AuthProvider>
        </MemoryRouter>
      </Wrapper>,
    );
  });
  return {
    container,
    root,
    location: () => current,
    navigate: (to) => {
      act(() => {
        navigateFn(to);
      });
    },
  };
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label = 'condition',
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await predicate()) return;
    await settle(1);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

async function uploadThroughInput(container: ParentNode, file: File): Promise<void> {
  const input = container.querySelector('[data-testid="document-upload-input"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await waitFor(
    async () =>
      container.querySelector('[data-testid="document-upload-dropzone"]') === null &&
      (await listUploadDraftRecordsForActiveScope()).length > 0,
    'preview + draft stored',
  );
  await settle(2);
}

function card(container: ParentNode): HTMLElement | null {
  return container.querySelector('[data-testid="continue-working-card"]');
}

/** Scrollwert setzen, damit der triviale Capture nicht zufällig greift. */
function setMainScroll(container: ParentNode, top: number): void {
  const main = container.querySelector('.app-shell__main') as HTMLElement | null;
  if (!main) return;
  Object.defineProperty(main, 'scrollTop', { value: top, configurable: true });
}

function expectNoDomainObjects(): void {
  expect(getInboxStoreSnapshot()).toHaveLength(0);
  expect(getDocumentStoreSnapshot()).toHaveLength(0);
  expect(getVorgangStoreSnapshot()).toHaveLength(0);
  expect(getCustomerStoreSnapshot()).toHaveLength(0);
}

/**
 * Upload durchführen und danach zum Schreibtisch wechseln.
 *
 * UPLOAD-DRAFT-RESUME-01C4 — hier wird ausschließlich darauf gewartet, dass die
 * Analyse erstmals sichtbar ist. Es gibt keine Abfrage des Entwurfsspeichers und
 * keine Zeitreserve für den Write: sichtbar heißt wiederaufnehmbar.
 */
async function uploadThenGoToDesk(marker: string, mount: Mount) {
  const input = mount.container.querySelector(
    '[data-testid="document-upload-input"]',
  ) as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [fileOf(marker)], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await waitFor(
    () => mount.container.querySelector('[data-testid="document-upload-dropzone"]') === null,
    'analysis visible',
  );

  setMainScroll(mount.container, 240);
  mount.navigate('/');
  await settle(4);
  return (await listUploadDraftRecordsForActiveScope())[0]!;
}

/**
 * Echter Bootpfad: ein UiSessionSnapshot der Uploadroute liegt bereits im Store,
 * bevor die App zum ersten Mal auf / gemountet wird.
 */
function seedUploadUiSession(draftId: string, fileName: string): UiSessionSnapshot {
  const base = buildUiSessionSnapshot({
    pathname: '/dokumente/upload',
    search: `?draft=${draftId}`,
    userId: null,
  });
  const snapshot: UiSessionSnapshot = {
    ...base,
    savedAt: new Date().toISOString(),
    workspaceType: 'document_review',
    drafts: { values: { pendingUploadDraftId: draftId }, dirty: true },
    resumeLabel: { titleText: 'Baustellenfoto', subtitleText: fileName, entityHint: '' },
  };
  saveUiSessionSnapshot(snapshot);
  return snapshot;
}

describe('UPLOAD-DRAFT-RESUME-01C2', () => {
  let mounted: Mount | undefined;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    resetStorageScopeForTests();
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
    resetDocumentFileStoreForTests();
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
    hydrateCustomerStore([]);
    await resetUploadDraftStoreForTests();
    resetAuthForTests();
    await loginAsDefaultAdmin();
    setImageOcrExtractorForTests(async () => ({ text: 'Baustellenfoto Rohbau', confidence: 80 }));
  });

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = undefined;
    }
    setImageOcrExtractorForTests(null);
    vi.restoreAllMocks();
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
    resetDocumentFileStoreForTests();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('A/B — UiSession trägt nur die Draft-ID und die echte Draft-Route', async () => {
    mounted = renderShell('/dokumente/upload?type=pdf');
    await settle();
    await uploadThroughInput(mounted.container, fileOf('CW-A'));
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;

    await waitFor(() => {
      const snap = loadUiSessionSnapshot();
      return snap?.drafts.values.pendingUploadDraftId === record.id;
    }, 'ui session carries draft id');

    const snapshot = loadUiSessionSnapshot()!;
    expect(snapshot.drafts.dirty).toBe(true);
    expect(Object.keys(snapshot.drafts.values)).toEqual(['pendingUploadDraftId']);

    // Route trägt die echte Draft-Query und erhält type=pdf.
    expect(snapshot.route.pathname).toBe('/dokumente/upload');
    const params = new URLSearchParams(snapshot.route.search);
    expect(params.get('draft')).toBe(record.id);
    expect(params.get('type')).toBe('pdf');

    // Keine Analyseinhalte im Snapshot.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('Baustellenfoto Rohbau');
    expect(serialized).not.toContain('pageTexts');
    expect(serialized).not.toContain('data:');
    expect(serialized).not.toContain('storageRecommendation');
    expect(serialized).not.toContain('previewClassification');
  });

  it('C/D — Wechsel zum Schreibtisch zeigt die Karte mit Dokumentart und Dateiname', async () => {
    mounted = renderShell('/dokumente/upload');
    await settle();
    await uploadThenGoToDesk('CW-C', mounted);

    await waitFor(() => card(mounted!.container) !== null, 'continue working card');
    const node = card(mounted.container)!;
    expect(node.textContent).toContain('Du hast zuletzt hier gearbeitet');
    expect(node.textContent).toContain('CW-C.jpg');
    const headline = node.querySelector('[data-testid="continue-working-headline"]');
    expect(headline?.textContent?.trim()).toBeTruthy();
    expect(headline?.textContent).not.toContain('/dokumente/upload');
    expectNoDomainObjects();
  });

  it('E — Weiterarbeiten führt exakt zum Entwurf, ohne zweite Analyse', async () => {
    mounted = renderShell('/dokumente/upload');
    await settle();
    const record = await uploadThenGoToDesk('CW-E', mounted);
    await waitFor(() => card(mounted!.container) !== null, 'card');

    const previewSpy = vi.spyOn(pendingDocumentIntakeService, 'processDocumentFileForPreview');
    const ocrSpy = vi.spyOn(ocrDocumentService, 'extractDocumentTextFromCache');

    const accept = mounted.container.querySelector(
      '[data-testid="continue-working-accept"]',
    ) as HTMLButtonElement;
    await act(async () => {
      accept.click();
      await Promise.resolve();
    });
    await waitFor(
      () => mounted!.container.querySelector('[data-testid="document-upload-dropzone"]') === null,
      'preview restored',
    );
    await settle(2);

    expect(mounted.location().pathname).toBe('/dokumente/upload');
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBe(record.id);
    expect(mounted.container.textContent).toContain('CW-E.jpg');
    expect(card(mounted.container)).toBeNull();
    expect(previewSpy).not.toHaveBeenCalled();
    expect(ocrSpy).not.toHaveBeenCalled();
    expectNoDomainObjects();
  });

  it('F — Verwerfen entfernt Entwurf, temp-Ref und Blob', async () => {
    mounted = renderShell('/dokumente/upload');
    await settle();
    const record = await uploadThenGoToDesk('CW-F', mounted);
    await waitFor(() => card(mounted!.container) !== null, 'card');

    const discard = mounted.container.querySelector(
      '[data-testid="continue-working-discard"]',
    ) as HTMLButtonElement;
    await act(async () => {
      discard.click();
      await Promise.resolve();
    });
    await waitFor(
      async () => (await listUploadDraftRecordsForActiveScope()).length === 0,
      'draft discarded',
    );
    await settle(2);

    expect(card(mounted.container)).toBeNull();
    expect(getDocumentFileRefById(record.fileRefId)).toBeUndefined();
    expect(await hasDocumentBlob(record.fileRefId)).toBe(false);
    expect(loadUiSessionSnapshot()?.drafts.values.pendingUploadDraftId).toBeUndefined();
    expectNoDomainObjects();
  });

  it('G — Persistenzfehler beim Verwerfen lässt Karte und Entwurf bestehen', async () => {
    mounted = renderShell('/dokumente/upload');
    await settle();
    const record = await uploadThenGoToDesk('CW-G', mounted);
    await waitFor(() => card(mounted!.container) !== null, 'card');

    const persistSpy = vi
      .spyOn(persistenceService, 'persistAll')
      .mockReturnValue({ success: false, error: 'quota_exceeded' });

    const discard = mounted.container.querySelector(
      '[data-testid="continue-working-discard"]',
    ) as HTMLButtonElement;
    await act(async () => {
      discard.click();
      await Promise.resolve();
    });
    await settle(6);
    persistSpy.mockRestore();

    expect(card(mounted.container)).not.toBeNull();
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(1);
    expect((await getUploadDraftRecordById(record.id))?.id).toBe(record.id);
  });

  it('H — bereits fehlender Entwurf schließt die stale Karte kontrolliert', async () => {
    mounted = renderShell('/dokumente/upload');
    await settle();
    const record = await uploadThenGoToDesk('CW-H', mounted);
    await waitFor(() => card(mounted!.container) !== null, 'card');

    // Entwurf verschwindet außerhalb der Karte.
    await resetUploadDraftStoreForTests();

    const discard = mounted.container.querySelector(
      '[data-testid="continue-working-discard"]',
    ) as HTMLButtonElement;
    await act(async () => {
      discard.click();
      await Promise.resolve();
    });
    await waitFor(() => card(mounted!.container) === null, 'stale card closed');
    expect(getDocumentFileRefById(record.fileRefId)).toBeDefined();
  });

  it('I — abgelaufener, beschädigter und fremder Entwurf erzeugen keine Karte', async () => {
    // 1) abgelaufen
    mounted = renderShell('/dokumente/upload');
    await settle();
    const expired = await uploadThenGoToDesk('CW-I-EXPIRED', mounted);
    const record = (await getUploadDraftRecordById(expired.id))!;
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;
    await saveUploadDraftRecord({
      ...record,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    mounted = renderShell('/');
    await settle(6);
    expect(card(mounted.container)).toBeNull();
    expect(mounted.location().pathname).toBe('/');
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    // 2) beschädigt: gleiche Länge, anderer Inhalt
    clearUiSessionSnapshot();
    resetUiSessionLiveState();
    await resetUploadDraftStoreForTests();
    mounted = renderShell('/dokumente/upload');
    await settle();
    const broken = await uploadThenGoToDesk('CW-I-BROKEN', mounted);
    const ref = getDocumentFileRefById(broken.fileRefId)!;
    const tampered = new TextEncoder().encode('X'.repeat(ref.fileSize));
    await blobDbService.saveDocumentBlob({
      fileRefId: ref.id,
      blob: new Blob([tampered], { type: ref.mimeType }),
      mimeType: ref.mimeType,
      fileSize: ref.fileSize,
      contentHash: ref.contentHash,
      createdAt: ref.createdAt,
    });
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    mounted = renderShell('/');
    await settle(6);
    expect(card(mounted.container)).toBeNull();
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    // 3) fremder Scope: keine Karte, nichts gelöscht
    const foreignDrafts = await listUploadDraftRecordsForActiveScope();
    expect(foreignDrafts).toHaveLength(1);
    setActiveStorageScope({ type: 'workspace', workspaceId: 'foreign-ws' });
    mounted = renderShell('/');
    await settle(6);
    expect(card(mounted.container)).toBeNull();
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;
    resetStorageScopeForTests();
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(1);
    expect(getDocumentFileRefById(broken.fileRefId)).toBeDefined();
  });

  it('J — committed oder geteilter FileRef bleibt beim Verwerfen erhalten', async () => {
    const payload = payloadOf('CW-J');
    const committed = await storeDocumentFileFromCachedPayload(payload, {
      lifecycleIntent: 'committed',
    });
    expect(committed.fileRef.lifecycleStatus).toBe('committed');

    mounted = renderShell('/dokumente/upload');
    await settle();
    const record = await uploadThenGoToDesk('CW-J', mounted);
    expect(record.fileRefId).toBe(committed.fileRef.id);
    await waitFor(() => card(mounted!.container) !== null, 'card');

    const discard = mounted.container.querySelector(
      '[data-testid="continue-working-discard"]',
    ) as HTMLButtonElement;
    await act(async () => {
      discard.click();
      await Promise.resolve();
    });
    await waitFor(
      async () => (await listUploadDraftRecordsForActiveScope()).length === 0,
      'draft discarded',
    );

    expect(getDocumentFileRefById(committed.fileRef.id)?.lifecycleStatus).toBe('committed');
    expect(await hasDocumentBlob(committed.fileRef.id)).toBe(true);
  });

  it('K — alte Deep-Work-Werte einer Detailseite erzeugen keine falsche Karte', async () => {
    // Start auf einer anderen Route, dort hinterlässt eine Detailseite ihr Chrome.
    mounted = renderShell('/');
    await settle(2);
    patchUiSessionLiveChrome({
      workspaceType: 'document_review',
      panelState: {
        deepWorkspaceOpen: true,
        moreOptionsExpanded: true,
        detailsOpen: true,
        assistOpen: false,
      },
      drafts: { values: { sender: 'Alt GmbH' }, dirty: true },
      resumeLabel: { titleText: 'Alter Vorgang', subtitleText: 'Alt GmbH', entityHint: '' },
    });
    await settle(2);

    // Wechsel auf die leere Uploadroute: das fremde Chrome darf nicht mitwandern.
    mounted.navigate('/dokumente/upload');
    await settle(4);

    // Leere Uploadroute: kein Entwurf, also darf nichts Tiefes gespeichert werden.
    const snapshot = loadUiSessionSnapshot();
    expect(snapshot?.drafts.dirty ?? false).toBe(false);
    expect(snapshot?.drafts.values.sender).toBeUndefined();
    expect(snapshot?.panelState.deepWorkspaceOpen ?? false).toBe(false);

    setMainScroll(mounted.container, 200);
    mounted.navigate('/');
    await settle(6);
    expect(card(mounted.container)).toBeNull();
  });

  it('L — Reload direkt auf die Draft-Route bleibt silent', async () => {
    const saved = await savePendingDocumentIntakeDraft(await previewOf('CW-L'));
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    mounted = renderShell(`/dokumente/upload?draft=${saved.draftId}`);
    await waitFor(
      () => mounted!.container.querySelector('[data-testid="document-upload-dropzone"]') === null,
      'preview restored silently',
    );
    await settle(4);

    expect(card(mounted.container)).toBeNull();
    expect(mounted.container.textContent).toContain('CW-L.jpg');
  });

  describe('Bootpfad: UiSession existiert bereits beim ersten App-Mount', () => {
    it('BOOT-A — gültiger Entwurf: Karte erst nach vollständiger Prüfung', async () => {
      const saved = await savePendingDocumentIntakeDraft(await previewOf('BOOT-A'));
      expect(saved.success).toBe(true);
      if (!saved.success) return;
      seedUploadUiSession(saved.draftId, 'BOOT-A.jpg');

      mounted = renderShell('/', { strict: true });
      // Kein sofortiges, ungeprüftes Angebot.
      expect(card(mounted.container)).toBeNull();

      await waitFor(() => card(mounted!.container) !== null, 'validated card');
      const node = card(mounted.container)!;
      expect(node.querySelector('[data-testid="continue-working-headline"]')?.textContent).toContain(
        'Baustellenfoto',
      );
      expect(node.textContent).toContain('BOOT-A.jpg');
      expect(mounted.location().pathname).toBe('/');
    });

    it('BOOT-B — fehlender Entwurf: keine Karte, Marke entfernt', async () => {
      seedUploadUiSession('updr-does-not-exist', 'Weg.jpg');

      mounted = renderShell('/');
      expect(card(mounted.container)).toBeNull();
      await settle(8);

      expect(card(mounted.container)).toBeNull();
      expect(loadUiSessionSnapshot()?.drafts.values.pendingUploadDraftId).toBeUndefined();
      expect(mounted.location().pathname).toBe('/');
    });

    it('BOOT-C — abgelaufener Entwurf: keine Karte, Datei bleibt', async () => {
      const saved = await savePendingDocumentIntakeDraft(await previewOf('BOOT-C'));
      expect(saved.success).toBe(true);
      if (!saved.success) return;
      const record = (await getUploadDraftRecordById(saved.draftId))!;
      await saveUploadDraftRecord({
        ...record,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      seedUploadUiSession(saved.draftId, 'BOOT-C.jpg');

      mounted = renderShell('/');
      await settle(8);

      expect(card(mounted.container)).toBeNull();
      expect(loadUiSessionSnapshot()?.drafts.values.pendingUploadDraftId).toBeUndefined();
      // Diese Validierung löscht weder Entwurf noch Datei.
      expect(await getUploadDraftRecordById(saved.draftId)).not.toBeNull();
      expect(getDocumentFileRefById(saved.fileRefId)).toBeDefined();
    });

    it('BOOT-D — beschädigter Blob gleicher Länge: keine Karte, kein OCR', async () => {
      const saved = await savePendingDocumentIntakeDraft(await previewOf('BOOT-D'));
      expect(saved.success).toBe(true);
      if (!saved.success) return;
      const ref = getDocumentFileRefById(saved.fileRefId)!;
      await blobDbService.saveDocumentBlob({
        fileRefId: ref.id,
        blob: new Blob([new TextEncoder().encode('X'.repeat(ref.fileSize))], {
          type: ref.mimeType,
        }),
        mimeType: ref.mimeType,
        fileSize: ref.fileSize,
        contentHash: ref.contentHash,
        createdAt: ref.createdAt,
      });
      seedUploadUiSession(saved.draftId, 'BOOT-D.jpg');

      const previewSpy = vi.spyOn(pendingDocumentIntakeService, 'processDocumentFileForPreview');
      const ocrSpy = vi.spyOn(ocrDocumentService, 'extractDocumentTextFromCache');

      mounted = renderShell('/');
      await settle(8);

      expect(card(mounted.container)).toBeNull();
      expect(loadUiSessionSnapshot()?.drafts.values.pendingUploadDraftId).toBeUndefined();
      expect(previewSpy).not.toHaveBeenCalled();
      expect(ocrSpy).not.toHaveBeenCalled();
    });

    it('BOOT-E — fremder Entwurf bleibt unangetastet, lokale Marke geht', async () => {
      const saved = await savePendingDocumentIntakeDraft(await previewOf('BOOT-E'));
      expect(saved.success).toBe(true);
      if (!saved.success) return;

      // Aus Sicht eines anderen Workspace ist der Entwurf unsichtbar.
      setActiveStorageScope({ type: 'workspace', workspaceId: 'foreign-ws' });
      seedUploadUiSession(saved.draftId, 'BOOT-E.jpg');

      mounted = renderShell('/');
      await settle(8);
      expect(card(mounted.container)).toBeNull();
      expect(loadUiSessionSnapshot()?.drafts.values.pendingUploadDraftId).toBeUndefined();

      resetStorageScopeForTests();
      expect(await getUploadDraftRecordById(saved.draftId)).not.toBeNull();
      expect(getDocumentFileRefById(saved.fileRefId)).toBeDefined();
      expect(await hasDocumentBlob(saved.fileRefId)).toBe(true);
    });

    it('BOOT-F — nach technischer Bereinigung erscheint ein neuer gültiger Entwurf', async () => {
      seedUploadUiSession('updr-missing-boot', 'Weg.jpg');
      mounted = renderShell('/');
      await settle(8);
      expect(card(mounted.container)).toBeNull();

      // Kein Dismiss-Latch: derselbe App-Lauf bietet einen echten Entwurf an.
      mounted.navigate('/dokumente/upload');
      await settle(4);
      await uploadThenGoToDesk('BOOT-F', mounted);
      await waitFor(() => card(mounted!.container) !== null, 'new valid card appears');
      expect(card(mounted.container)!.textContent).toContain('BOOT-F.jpg');
    });

    it('BOOT-G — fremder Scope-Kontext erzeugt keinen Kandidaten', async () => {
      const saved = await savePendingDocumentIntakeDraft(await previewOf('BOOT-G'));
      expect(saved.success).toBe(true);
      if (!saved.success) return;
      const snapshot = seedUploadUiSession(saved.draftId, 'BOOT-G.jpg');
      // decideUiSessionRestore lehnt einen fremden scopeKey ab, bevor geprüft wird.
      saveUiSessionSnapshot({
        ...snapshot,
        scopeKey: 'officepilot-state:workspace:foreign-ws',
      });

      mounted = renderShell('/');
      await settle(8);

      expect(card(mounted.container)).toBeNull();
      expect(await getUploadDraftRecordById(saved.draftId)).not.toBeNull();
    });
  });

  it('N — geteilter temp-Ref überlebt das Verwerfen des ersten Entwurfs', async () => {
    const first = await savePendingDocumentIntakeDraft(await previewOf('CW-N'));
    const second = await savePendingDocumentIntakeDraft(await previewOf('CW-N'));
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(second.fileRefId).toBe(first.fileRefId);

    seedUploadUiSession(first.draftId, 'CW-N.jpg');
    mounted = renderShell('/');
    await waitFor(() => card(mounted!.container) !== null, 'card');

    const discard = mounted.container.querySelector(
      '[data-testid="continue-working-discard"]',
    ) as HTMLButtonElement;
    await act(async () => {
      discard.click();
      await Promise.resolve();
    });
    await waitFor(async () => (await getUploadDraftRecordById(first.draftId)) === null, 'first gone');
    await settle(2);

    // Nur die Metadaten des ersten verschwinden.
    expect(await getUploadDraftRecordById(second.draftId)).not.toBeNull();
    expect(getDocumentFileRefById(second.fileRefId)?.lifecycleStatus).toBe('temp');
    expect(await hasDocumentBlob(second.fileRefId)).toBe(true);
    const reload = await loadPendingDocumentIntakeDraft(second.draftId);
    expect(reload.success).toBe(true);
  });

  it('O — verspätetes Prüfergebnis nach Routenwechsel öffnet keine Karte', async () => {
    const saved = await savePendingDocumentIntakeDraft(await previewOf('CW-O'));
    expect(saved.success).toBe(true);
    if (!saved.success) return;
    seedUploadUiSession(saved.draftId, 'CW-O.jpg');

    // Die vollständige Prüfung hängt, bis der Test sie freigibt.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realRead = blobDbService.readDocumentBlob;
    vi.spyOn(blobDbService, 'readDocumentBlob').mockImplementation(async (id, scope) => {
      await gate;
      return realRead(id, scope);
    });

    mounted = renderShell('/');
    await settle(3);
    expect(card(mounted.container)).toBeNull();

    // Während die Prüfung offen ist, woanders hin navigieren.
    mounted.navigate('/dokumente/upload');
    await settle(4);
    const snapshotBefore = loadUiSessionSnapshot();

    release!();
    await settle(10);

    expect(card(mounted.container)).toBeNull();
    expect(mounted.location().pathname).toBe('/dokumente/upload');
    expect(await getUploadDraftRecordById(saved.draftId)).not.toBeNull();
    expect(getDocumentFileRefById(saved.fileRefId)).toBeDefined();
    expect(loadUiSessionSnapshot()?.id).toBe(snapshotBefore?.id);
  });

  it('M — StrictMode: Validierung hängt nicht und öffnet keine verspätete Karte', async () => {
    mounted = renderShell('/dokumente/upload', { strict: true });
    await settle();
    const record = await uploadThenGoToDesk('CW-M', mounted);
    await waitFor(() => card(mounted!.container) !== null, 'card under StrictMode');

    // Zurück zur Draft-Route: die Karte darf dort nicht erneut auftauchen.
    mounted.navigate(`/dokumente/upload?draft=${record.id}`);
    await settle(8);
    expect(card(mounted.container)).toBeNull();
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(1);
  });
});
