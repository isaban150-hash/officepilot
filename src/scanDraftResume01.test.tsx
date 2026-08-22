/**
 * UPLOAD-DRAFT-RESUME-01D2 — Foto, Galerie und Scan sind ebenso wiederaufnehmbar
 * wie der PDF-Upload: eine sichtbare Analyse ist bereits gesichert.
 */
import { act, Fragment, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { ScanPage } from './pages/ScanPage';
import { UiSessionRecoveryHost } from './components/system/UiSessionRecoveryHost';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import {
  getDocumentFileRefById,
  getDocumentFileRefStoreSnapshot,
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
import { setOcrImageRecognizerForTests } from './services/tesseractOcrService';
import * as aiRequestRunner from './services/ai/aiRequestRunner';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import * as pendingDocumentIntakeService from './services/pendingDocumentIntakeService';
import * as persistenceService from './services/persistenceService';
import * as uploadDraftDb from './services/storage/uploadDraftIndexedDbService';
import {
  listUploadDraftRecordsForActiveScope,
  resetUploadDraftStoreForTests,
} from './services/storage/uploadDraftIndexedDbService';
import {
  discardPendingDocumentIntakeDraft,
  loadPendingDocumentIntakeDraft,
  savePendingDocumentIntakeDraft,
} from './services/upload/uploadDraftService';
import { intakeCachedDocumentFile } from './services/documentIntakeService';
import {
  clearUiSessionSnapshot,
  loadUiSessionSnapshot,
} from './services/uiSession/uiSessionStore';
import { resetUiSessionLiveState } from './services/uiSession/uiSessionLiveState';
import { resetStorageScopeForTests } from './services/storage/storageScopeService';
import { loginAsDefaultAdmin, resetAuthForTests } from './test/authFixtures';
import type { CachedDocumentFilePayload } from './services/cachedDocumentFileService';
import type { CompanyDocument } from './types/models';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

useDocumentBlobDatabaseReset();

function fileOf(marker: string): File {
  return new File([new TextEncoder().encode(marker)], `${marker}.jpg`, { type: 'image/jpeg' });
}

function payloadOf(marker: string): CachedDocumentFilePayload {
  const bytes = new TextEncoder().encode(marker);
  return { fileName: `${marker}.jpg`, mimeType: 'image/jpeg', fileSize: bytes.byteLength, bytes };
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

function renderScan(initialEntry = '/scan', options: { strict?: boolean } = {}): Mount {
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
                  <Route path="/scan" element={<ScanPage />} />
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

function cameraInput(container: ParentNode): HTMLInputElement {
  return container.querySelector('[data-testid="scan-camera-input"]') as HTMLInputElement;
}

function galleryInput(container: ParentNode): HTMLInputElement {
  return container.querySelector('[data-testid="scan-gallery-input"]') as HTMLInputElement;
}

function analysisVisible(container: ParentNode): boolean {
  return container.querySelector('[data-testid="ocr-preview-panel"]') !== null;
}

function decisionButtons(container: ParentNode): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter((node) =>
    /dauerhaft|nicht speichern|vorübergehend/i.test(node.textContent ?? ''),
  ) as HTMLButtonElement[];
}

function card(container: ParentNode): HTMLElement | null {
  return container.querySelector('[data-testid="continue-working-card"]');
}

function setMainScroll(container: ParentNode, top: number): void {
  const main = container.querySelector('.app-shell__main') as HTMLElement | null;
  if (!main) return;
  Object.defineProperty(main, 'scrollTop', { value: top, configurable: true, writable: true });
}

function expectNoDomainObjects(): void {
  expect(getInboxStoreSnapshot()).toHaveLength(0);
  expect(getDocumentStoreSnapshot()).toHaveLength(0);
  expect(getVorgangStoreSnapshot()).toHaveLength(0);
  expect(getCustomerStoreSnapshot()).toHaveLength(0);
}

/** Datei über eines der echten Scan-Inputs übergeben, ohne auf den Draft zu warten. */
async function startScan(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await settle(4);
}

/** Vollständiger Scan bis zur sichtbaren Analyse. */
async function scanUntilVisible(mount: Mount, marker: string, camera = false): Promise<void> {
  const input = camera ? cameraInput(mount.container) : galleryInput(mount.container);
  expect(input, 'Scan-Input fehlt').toBeTruthy();
  Object.defineProperty(input, 'files', { value: [fileOf(marker)], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await waitFor(() => analysisVisible(mount.container), `analysis visible for ${marker}`);
}

/** Gate auf den Blob-Write. */
function gateBlobWrite() {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realSave = blobDbService.saveDocumentBlob;
  vi.spyOn(blobDbService, 'saveDocumentBlob').mockImplementation(async (input) => {
    await gate;
    return realSave(input);
  });
  return { release: () => release!() };
}

describe('UPLOAD-DRAFT-RESUME-01D2 Scan', () => {
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
    setOcrImageRecognizerForTests(null);
    vi.restoreAllMocks();
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
    resetDocumentFileStoreForTests();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('A — /scan?input=camera öffnet ohne Entwurf genau einmal die Kamera', async () => {
    const clicks: string[] = [];
    const original = HTMLInputElement.prototype.click;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicks.push(this.getAttribute('data-testid') ?? 'unknown');
      return original.call(this);
    });

    mounted = renderScan('/scan?input=camera', { strict: true });
    await settle(6);

    expect(clicks.filter((id) => id === 'scan-camera-input')).toHaveLength(1);
    expect(clicks.filter((id) => id === 'scan-gallery-input')).toHaveLength(0);
  });

  it('B — /scan?input=gallery öffnet ohne Entwurf genau einmal die Galerie', async () => {
    const clicks: string[] = [];
    const original = HTMLInputElement.prototype.click;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicks.push(this.getAttribute('data-testid') ?? 'unknown');
      return original.call(this);
    });

    mounted = renderScan('/scan?input=gallery', { strict: true });
    await settle(6);

    expect(clicks.filter((id) => id === 'scan-gallery-input')).toHaveLength(1);
    expect(clicks.filter((id) => id === 'scan-camera-input')).toHaveLength(0);
  });

  it('C — während des Writes bleibt die Analyse verborgen und erscheint danach bedienbar', async () => {
    const gate = gateBlobWrite();
    mounted = renderScan('/scan?input=gallery');
    await settle();
    await startScan(galleryInput(mounted.container), fileOf('SCAN-C'));

    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    expect(analysisVisible(mounted.container)).toBe(false);
    expect(decisionButtons(mounted.container)).toHaveLength(0);
    expect(mounted.container.textContent).not.toContain('SCAN-C.jpg');
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBeNull();
    expect(loadUiSessionSnapshot()?.drafts.values.pendingUploadDraftId).toBeUndefined();
    expectNoDomainObjects();

    gate.release();
    await waitFor(() => analysisVisible(mounted!.container), 'analysis after durable write');
    await settle(2);

    expect(mounted.container.textContent).toContain('SCAN-C.jpg');
    const records = await listUploadDraftRecordsForActiveScope();
    expect(records).toHaveLength(1);
    const params = new URLSearchParams(mounted.location().search);
    expect(params.get('draft')).toBe(records[0]!.id);
    expect(params.get('input')).toBe('gallery');
    expect(decisionButtons(mounted.container).some((node) => !node.disabled)).toBe(true);
  });

  it('D — sichtbare Analyse, sofortiger Wechsel zum Schreibtisch, ehrliche Karte', async () => {
    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-D');

    // Kein Warten auf den Entwurfsspeicher: sichtbar heißt wiederaufnehmbar.
    setMainScroll(mounted.container, 240);
    mounted.navigate('/');
    await settle(4);

    await waitFor(() => card(mounted!.container) !== null, 'continue working card');
    expect(card(mounted.container)!.textContent).toContain('SCAN-D.jpg');
  });

  it('E — Weiterarbeiten öffnet exakt den Scanentwurf ohne zweites OCR', async () => {
    mounted = renderScan('/scan?input=camera');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-E', true);
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;

    setMainScroll(mounted.container, 240);
    mounted.navigate('/');
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
    await waitFor(() => analysisVisible(mounted!.container), 'scan analysis restored');
    await settle(2);

    expect(mounted.location().pathname).toBe('/scan');
    const params = new URLSearchParams(mounted.location().search);
    expect(params.get('draft')).toBe(record.id);
    expect(params.get('input')).toBe('camera');
    expect(mounted.container.textContent).toContain('SCAN-E.jpg');
    expect(previewSpy).not.toHaveBeenCalled();
    expect(ocrSpy).not.toHaveBeenCalled();
  });

  it('F — Reload mit gültigem Kamera-Entwurf öffnet keinen Picker', async () => {
    mounted = renderScan('/scan?input=camera');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-F', true);
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;

    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    const clicks: string[] = [];
    const original = HTMLInputElement.prototype.click;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicks.push(this.getAttribute('data-testid') ?? 'unknown');
      return original.call(this);
    });

    mounted = renderScan(`/scan?input=camera&draft=${record.id}`, { strict: true });
    await waitFor(() => analysisVisible(mounted!.container), 'restored without picker');
    await settle(4);

    expect(clicks).toHaveLength(0);
    expect(mounted.container.textContent).toContain('SCAN-F.jpg');
    expect(card(mounted.container)).toBeNull();
  });

  it('G — ungültiger Entwurf: Parameter entfernt, Picker öffnet genau einmal', async () => {
    const clicks: string[] = [];
    const original = HTMLInputElement.prototype.click;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicks.push(this.getAttribute('data-testid') ?? 'unknown');
      return original.call(this);
    });

    mounted = renderScan('/scan?input=gallery&draft=updr-unknown', { strict: true });
    await waitFor(
      () => new URLSearchParams(mounted!.location().search).get('draft') === null,
      'stale draft param removed',
    );
    await settle(6);

    expect(new URLSearchParams(mounted.location().search).get('input')).toBe('gallery');
    expect(clicks.filter((id) => id === 'scan-gallery-input')).toHaveLength(1);
    expect(analysisVisible(mounted.container)).toBe(false);
  });

  it('H — abgebrochene Dateiauswahl lässt den Entwurf unverändert', async () => {
    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-H');
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;
    const searchBefore = mounted.location().search;

    // Ein retryfähiger Persistenzfehler bringt die echten Panel-Aktionen hervor.
    const persistSpy = vi
      .spyOn(persistenceService, 'persistAll')
      .mockReturnValue({ success: false, error: 'quota_exceeded' });
    const save = decisionButtons(mounted.container).find((node) =>
      /dauerhaft/i.test(node.textContent ?? ''),
    );
    await act(async () => {
      save!.click();
      await Promise.resolve();
    });
    await settle(4);
    persistSpy.mockRestore();

    const selectFile = mounted.container.querySelector(
      '[data-testid="ocr-confirm-select-file"]',
    ) as HTMLButtonElement | null;
    const newPhoto = mounted.container.querySelector(
      '[data-testid="ocr-confirm-new-photo"]',
    ) as HTMLButtonElement | null;
    expect(selectFile ?? newPhoto, 'echte Panel-Aktion fehlt').toBeTruthy();

    // Genau den Click des zugehörigen versteckten Inputs beobachten.
    const targetInput = selectFile
      ? galleryInput(mounted.container)
      : cameraInput(mounted.container);
    const clickSpy = vi.spyOn(targetInput, 'click');
    const ocrSpy = vi.spyOn(ocrDocumentService, 'extractDocumentTextFromCache');

    act(() => (selectFile ?? newPhoto)!.click());
    await settle(4);

    // openFilePicker lief wirklich durch — und der Picker wurde abgebrochen.
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(ocrSpy).not.toHaveBeenCalled();

    expect(analysisVisible(mounted.container)).toBe(true);
    expect(mounted.container.textContent).toContain('SCAN-H.jpg');
    expect(mounted.location().search).toBe(searchBefore);
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBe(record.id);
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(1);
    expect(getDocumentFileRefById(record.fileRefId)).toBeDefined();
    expect(await hasDocumentBlob(record.fileRefId)).toBe(true);
    expectNoDomainObjects();
  });

  it('P — geteilter temp-Ref überlebt das Verwerfen eines von zwei Entwürfen', async () => {
    // Erster Entwurf mit identischen Bytes, unabhängig von der Seite.
    const preview = await pendingDocumentIntakeService.processDocumentFileForPreview(
      fileOf('SCAN-P'),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) return;
    const first = await savePendingDocumentIntakeDraft(preview.pending);
    expect(first.success).toBe(true);
    if (!first.success) return;

    // Zweiter Entwurf über die echte ScanPage — gleicher Hash, gleicher FileRef.
    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-P');
    const records = await listUploadDraftRecordsForActiveScope();
    expect(records).toHaveLength(2);
    const second = records.find((entry) => entry.id !== first.draftId)!;
    expect(second.fileRefId).toBe(first.fileRefId);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);

    // „Nicht speichern“ über die echte Aktion der Seite.
    const discard = decisionButtons(mounted.container).find((node) =>
      /nicht speichern/i.test(node.textContent ?? ''),
    );
    await act(async () => {
      discard!.click();
      await Promise.resolve();
    });
    await waitFor(
      async () => (await listUploadDraftRecordsForActiveScope()).length === 1,
      'second draft discarded',
    );
    await settle(2);

    // Nur die Metadaten des verworfenen Entwurfs sind weg.
    const remaining = await listUploadDraftRecordsForActiveScope();
    expect(remaining[0]!.id).toBe(first.draftId);
    expect(getDocumentFileRefById(first.fileRefId)?.lifecycleStatus).toBe('temp');
    expect(await hasDocumentBlob(first.fileRefId)).toBe(true);
    const reload = await loadPendingDocumentIntakeDraft(first.draftId);
    expect(reload.success).toBe(true);
    expectNoDomainObjects();

    // Erst der letzte Entwurf gibt die temporäre Datei frei.
    await discardPendingDocumentIntakeDraft(first.draftId);
    expect(getDocumentFileRefById(first.fileRefId)).toBeUndefined();
    expect(await hasDocumentBlob(first.fileRefId)).toBe(false);
  });

  it('Q — Duplikat zu einem dauerhaften Dokument öffnet das bestehende Objekt', async () => {
    // Ein echtes, dauerhaft gespeichertes Objekt mit committed FileRef …
    const intake = await intakeCachedDocumentFile(payloadOf('SCAN-Q'), {
      userDecision: 'save_permanently',
      importSource: 'upload',
      recognizedText: 'Baustellenfoto Rohbau',
    });
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) throw new Error('setup intake failed');
    const committedRefId = intake.fileRef.id;
    expect(getDocumentFileRefById(committedRefId)?.lifecycleStatus).toBe('committed');
    expect(getInboxStoreSnapshot()).toHaveLength(1);

    // … das zusätzlich archiviert ist: nur ein Archivtreffer bietet use_existing an.
    hydrateDocumentStore([
      {
        id: 'doc-scan-q',
        title: 'Bestehendes Baustellenfoto',
        category: 'sonstiges',
        issuer: 'Muster GmbH',
        recognizedText: 'Baustellenfoto Rohbau',
        issueDate: '2026-01-01',
        validUntil: null,
        digitalFolder: { id: 'd1', name: 'Fotos', path: '/Firma/Fotos/' },
        paperFolder: { folderId: 'f1', register: 'A', label: 'Fotos' },
        tags: [],
        linkedCompany: 'Test GmbH',
        linkedVorgang: null,
        archived: true,
        createdAt: '2026-03-01T10:00:00.000Z',
        sourceFileHash: intake.fileRef.contentHash,
        fileRefId: committedRefId,
        sourceInboxItemId: intake.inboxItem.id,
      } as CompanyDocument,
    ]);

    const writeSpy = vi.spyOn(blobDbService, 'saveDocumentBlob');
    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-Q');

    // Der Entwurf verwendet denselben committed Ref, ohne zweiten Blob-Write.
    const draft = (await listUploadDraftRecordsForActiveScope())[0]!;
    expect(draft.fileRefId).toBe(committedRefId);
    expect(writeSpy).not.toHaveBeenCalled();

    // Entscheidung über den echten Duplikat-Button der Seite.
    const duplicateAction =
      (mounted.container.querySelector(
        '[data-testid="storage-decision-use-existing"]',
      ) as HTMLButtonElement | null) ??
      (mounted.container.querySelector(
        '[data-testid="storage-decision-save-duplicate-anyway"]',
      ) as HTMLButtonElement | null);
    expect(duplicateAction, 'Duplikat-Aktion fehlt').toBeTruthy();
    await act(async () => {
      duplicateAction!.click();
      await Promise.resolve();
    });
    await waitFor(
      () => mounted!.container.querySelector('[data-testid="document-detail"]') !== null,
      'navigated to existing document',
    );
    await settle(2);

    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    expect(getDocumentFileRefById(committedRefId)?.lifecycleStatus).toBe('committed');
    expect(await hasDocumentBlob(committedRefId)).toBe(true);
    // Kein zusätzliches Objekt entstanden.
    expect(getInboxStoreSnapshot()).toHaveLength(1);
    expect(getDocumentStoreSnapshot()).toHaveLength(1);
    expect(getVorgangStoreSnapshot()).toHaveLength(0);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });

  it('I — neue Datei ersetzt den Entwurf sicher', async () => {
    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-I-A');
    const first = (await listUploadDraftRecordsForActiveScope())[0]!;

    await scanUntilVisible(mounted, 'SCAN-I-B');
    await waitFor(async () => {
      const records = await listUploadDraftRecordsForActiveScope();
      return records.length === 1 && records[0]!.id !== first.id;
    }, 'second draft replaces first');

    const records = await listUploadDraftRecordsForActiveScope();
    expect(records[0]!.fileName).toBe('SCAN-I-B.jpg');
    expect(mounted.container.textContent).toContain('SCAN-I-B.jpg');
    expect(mounted.container.textContent).not.toContain('SCAN-I-A.jpg');
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBe(records[0]!.id);
    expect(getDocumentFileRefById(first.fileRefId)).toBeUndefined();
    expect(await hasDocumentBlob(first.fileRefId)).toBe(false);
  });

  it('J — Schreibfehler: Analyse nutzbar, kein Pointer, keine Karte', async () => {
    mounted = renderScan('/scan');
    await settle();
    const persistSpy = vi
      .spyOn(persistenceService, 'persistAll')
      .mockReturnValue({ success: false, error: 'quota_exceeded' });

    await scanUntilVisible(mounted, 'SCAN-J');
    await settle(2);
    persistSpy.mockRestore();

    expect(mounted.container.textContent).toContain('SCAN-J.jpg');
    expect(decisionButtons(mounted.container).some((node) => !node.disabled)).toBe(true);
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBeNull();
    expect(loadUiSessionSnapshot()?.drafts.values.pendingUploadDraftId).toBeUndefined();

    setMainScroll(mounted.container, 240);
    mounted.navigate('/');
    await settle(6);
    expect(card(mounted.container)).toBeNull();
    expectNoDomainObjects();
  });

  it('K — Unmount während des Writes lässt keinen Waisen-Entwurf zurück', async () => {
    const gate = gateBlobWrite();
    mounted = renderScan('/scan');
    await settle();
    await startScan(galleryInput(mounted.container), fileOf('SCAN-K'));

    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    gate.release();
    await settle(12);

    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    expectNoDomainObjects();
  });

  it('K2 — Unmount während des Writes löscht keinen geteilten committed Ref', async () => {
    const committed = await storeDocumentFileFromCachedPayload(payloadOf('SCAN-K2'), {
      lifecycleIntent: 'committed',
    });

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSaveRecord = uploadDraftDb.saveUploadDraftRecord;
    vi.spyOn(uploadDraftDb, 'saveUploadDraftRecord').mockImplementation(async (record) => {
      await gate;
      return realSaveRecord(record);
    });

    mounted = renderScan('/scan');
    await settle();
    await startScan(galleryInput(mounted.container), fileOf('SCAN-K2'));

    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    release!();
    await settle(12);

    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    expect(getDocumentFileRefById(committed.fileRef.id)?.lifecycleStatus).toBe('committed');
    expect(await hasDocumentBlob(committed.fileRef.id)).toBe(true);
  });

  it('L — Nicht speichern entfernt Entwurf, temp-Ref und Blob', async () => {
    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-L');
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;

    const discard = decisionButtons(mounted.container).find((node) =>
      /nicht speichern/i.test(node.textContent ?? ''),
    );
    expect(discard).toBeTruthy();
    await act(async () => {
      discard!.click();
      await Promise.resolve();
    });
    await waitFor(
      async () => (await listUploadDraftRecordsForActiveScope()).length === 0,
      'draft discarded',
    );
    await settle(2);

    expect(analysisVisible(mounted.container)).toBe(false);
    expect(getDocumentFileRefById(record.fileRefId)).toBeUndefined();
    expect(await hasDocumentBlob(record.fileRefId)).toBe(false);
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBeNull();
    expectNoDomainObjects();
  });

  it('M — dauerhaft speichern: Metadaten weg, Datei committed, ein InboxItem', async () => {
    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-M');
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;

    const writeSpy = vi.spyOn(blobDbService, 'saveDocumentBlob');
    const save = decisionButtons(mounted.container).find((node) =>
      /dauerhaft/i.test(node.textContent ?? ''),
    );
    await act(async () => {
      save!.click();
      await Promise.resolve();
    });
    await waitFor(() => getInboxStoreSnapshot().length === 1, 'inbox item created');
    await settle(4);

    expect(getInboxStoreSnapshot()[0]?.fileRefId).toBe(record.fileRefId);
    expect(getDocumentFileRefById(record.fileRefId)?.lifecycleStatus).toBe('committed');
    expect(getDocumentFileRefById(record.fileRefId)?.expiresAt).toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
  });

  it('N — UiSession trägt ausschließlich die Draft-ID', async () => {
    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-N');
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;

    await waitFor(
      () => loadUiSessionSnapshot()?.drafts.values.pendingUploadDraftId === record.id,
      'ui session carries draft id',
    );
    const snapshot = loadUiSessionSnapshot()!;
    expect(Object.keys(snapshot.drafts.values)).toEqual(['pendingUploadDraftId']);
    expect(snapshot.drafts.dirty).toBe(true);
    expect(snapshot.route.pathname).toBe('/scan');
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('Baustellenfoto Rohbau');
    expect(serialized).not.toContain('pageTexts');
    expect(serialized).not.toContain('data:');
    expect(serialized).not.toContain('storageRecommendation');
  });

  it('R — Layout, Fakten und Zuordnungen überstehen Reload ohne OCR und ohne KI', async () => {
    // Bild-OCR mit Layout; ein fremdes Label erzwingt genau einen KI-Aufruf.
    const layoutPage = {
      version: 1,
      pageNumber: 1,
      width: 1200,
      height: 1700,
      truncated: false,
      tokens: [
        ...['Auftraggeber', 'NordWest', 'Dachbau', 'GmbH'].map((text, index) => ({
          id: `p1-t${index}`,
          text,
          x0: index === 0 ? 0.08 : 0.45 + (index - 1) * 0.1,
          y0: 0.2,
          x1: (index === 0 ? 0.08 : 0.45 + (index - 1) * 0.1) + text.length * 0.012,
          y1: 0.22,
          confidence: 93,
          blockId: index === 0 ? 'b0' : 'b1',
          lineId: index === 0 ? 'b0-l0' : 'b1-l0',
        })),
        ...['Vertragspartner', 'Cirmak', 'Haustechnik'].map((text, index) => ({
          id: `p1-t${index + 4}`,
          text,
          x0: index === 0 ? 0.08 : 0.45 + (index - 1) * 0.1,
          y0: 0.26,
          x1: (index === 0 ? 0.08 : 0.45 + (index - 1) * 0.1) + text.length * 0.012,
          y1: 0.28,
          confidence: 93,
          blockId: index === 0 ? 'b0' : 'b1',
          lineId: index === 0 ? 'b0-l1' : 'b1-l1',
        })),
      ],
    };
    // Der textbasierte Stub aus beforeEach hat Vorrang — hier wird der
    // layoutfähige Recognizer gebraucht.
    setImageOcrExtractorForTests(null);
    setOcrImageRecognizerForTests(async () => ({
      text: 'Werkvertrag Auftraggeber Vertragspartner',
      confidence: 90,
      layout: layoutPage,
    }));
    vi.spyOn(aiRequestRunner, 'isAiProviderConfigured').mockReturnValue(true);
    const aiSpy = vi
      .spyOn(aiRequestRunner, 'runAiRequest')
      .mockResolvedValue({ success: true, source: 'ai', text: '{"assignments":[]}' });

    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-R');
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;

    // Alles Belegte liegt im Entwurf.
    expect(record.extraction.layout?.tokens.length).toBeGreaterThan(0);
    expect(record.extraction.visibleFacts?.length).toBeGreaterThan(0);
    expect(record.extraction.semanticFactAssignments?.length).toBeGreaterThan(0);
    expect(aiSpy).toHaveBeenCalledTimes(1);

    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    // Ab hier darf weder OCR noch das Modell erneut laufen.
    const ocrSpy = vi.spyOn(ocrDocumentService, 'extractDocumentTextFromCache');
    const previewSpy = vi.spyOn(pendingDocumentIntakeService, 'processDocumentFileForPreview');
    aiSpy.mockClear();
    const clicks: string[] = [];
    const originalClick = HTMLInputElement.prototype.click;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicks.push(this.getAttribute('data-testid') ?? '');
      return originalClick.call(this);
    });

    mounted = renderScan(`/scan?draft=${record.id}`, { strict: true });
    await waitFor(() => analysisVisible(mounted!.container), 'restored');
    await settle(4);

    expect(ocrSpy).not.toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
    expect(aiSpy).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(0);

    const restored = await loadPendingDocumentIntakeDraft(record.id);
    expect(restored.success).toBe(true);
    if (!restored.success) return;
    expect(restored.pending.extraction.visibleFacts).toEqual(record.extraction.visibleFacts);
    expect(restored.pending.extraction.semanticFactAssignments).toEqual(
      record.extraction.semanticFactAssignments,
    );
    expectNoDomainObjects();
  });

  it('S — ohne konfigurierte KI bleiben die lokalen Fakten vollständig', async () => {
    setImageOcrExtractorForTests(null);
    setOcrImageRecognizerForTests(async () => ({
      text: 'Werkvertrag Auftraggeber',
      confidence: 90,
      layout: {
        version: 1,
        pageNumber: 1,
        width: 1200,
        height: 1700,
        truncated: false,
        tokens: ['Auftraggeber', 'NordWest', 'Dachbau', 'GmbH'].map((text, index) => ({
          id: `p1-t${index}`,
          text,
          x0: index === 0 ? 0.08 : 0.45 + (index - 1) * 0.1,
          y0: 0.2,
          x1: (index === 0 ? 0.08 : 0.45 + (index - 1) * 0.1) + text.length * 0.012,
          y1: 0.22,
          confidence: 93,
          blockId: index === 0 ? 'b0' : 'b1',
          lineId: index === 0 ? 'b0-l0' : 'b1-l0',
        })),
      },
    }));
    vi.spyOn(aiRequestRunner, 'isAiProviderConfigured').mockReturnValue(false);
    const aiSpy = vi.spyOn(aiRequestRunner, 'runAiRequest');

    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-S');

    expect(aiSpy).not.toHaveBeenCalled();
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;
    expect(record.extraction.semanticFactAssignments).toBeDefined();
  });

  it('O — StrictMode-Restore hängt nicht', async () => {
    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-O');
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;

    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    mounted = renderScan(`/scan?draft=${record.id}`, { strict: true });
    await waitFor(() => analysisVisible(mounted!.container), 'restored under StrictMode');
    await settle(4);

    expect(mounted.container.textContent).toContain('SCAN-O.jpg');
    expect(decisionButtons(mounted.container).some((node) => !node.disabled)).toBe(true);
    const restored = await loadPendingDocumentIntakeDraft(record.id);
    expect(restored.success).toBe(true);
  });

  /*
   * MOBILE-SAFE-RESUME-01B — Safari verwirft die Seite; der Query-Zeiger geht
   * dabei verloren, der UiSession-Schnappschuss bleibt. Der Entwurf muss auch
   * dann wiederkommen — und die Dateiauswahl darf sich nicht öffnen.
   */
  it('P — /scan ohne ?draft= übernimmt den Zeiger aus dem UiSession-Schnappschuss', async () => {
    mounted = renderScan('/scan');
    await settle();
    await scanUntilVisible(mounted, 'SCAN-P');
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;

    // Der Schnappschuss trägt den Zeiger — die Adresse gleich nicht mehr.
    const snapshot = loadUiSessionSnapshot();
    expect(snapshot?.drafts.values.pendingUploadDraftId, JSON.stringify(snapshot)).toBe(
      record.id,
    );

    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    const clicks: string[] = [];
    const original = HTMLInputElement.prototype.click;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicks.push(this.getAttribute('data-testid') ?? 'unknown');
      return original.call(this);
    });

    // Nackte Scan-Adresse mit Auto-Picker-Wunsch — der Entwurf hat Vorrang.
    mounted = renderScan('/scan?input=camera', { strict: true });
    await waitFor(
      () => analysisVisible(mounted!.container),
      'restored from ui session pointer',
    );
    await settle(4);

    // Kein leerer Scan-Zustand, kein Auto-Picker, kein zweites Dokument.
    expect(mounted.container.textContent).toContain('SCAN-P.jpg');
    expect(clicks).toHaveLength(0);
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    // Der Zeiger steht wieder in der Adresse.
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBe(record.id);
  });

  it('Q — ohne passenden Schnappschuss bleibt der normale leere Zustand', async () => {
    clearUiSessionSnapshot();

    const clicks: string[] = [];
    const original = HTMLInputElement.prototype.click;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicks.push(this.getAttribute('data-testid') ?? 'unknown');
      return original.call(this);
    });

    mounted = renderScan('/scan?input=gallery', { strict: true });
    await settle(6);

    expect(analysisVisible(mounted.container)).toBe(false);
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBeNull();
    expect(clicks.filter((id) => id === 'scan-gallery-input')).toHaveLength(1);
  });
});
