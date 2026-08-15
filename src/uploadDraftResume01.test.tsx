/**
 * UPLOAD-DRAFT-RESUME-01B1 — eine fertige, noch unbestätigte Uploadanalyse
 * übersteht Reload, Tab-Kill und Neumount, ohne erneut zu analysieren.
 *
 * Confirm-first: vor der Nutzerentscheidung entsteht kein InboxItem, kein
 * Document, kein Kunde, kein Vorgang und kein Auftrag.
 */
import { act, Fragment, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DocumentUploadPage } from './pages/DocumentUploadPage';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import {
  getDocumentFileRefById,
  getDocumentFileRefStoreSnapshot,
  hydrateDocumentFileStore,
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
import * as uploadDraftDb from './services/storage/uploadDraftIndexedDbService';
import {
  listUploadDraftRecordsForActiveScope,
  resetUploadDraftStoreForTests,
  UPLOAD_DRAFT_TTL_MS,
  saveUploadDraftRecord,
  getUploadDraftRecordById,
} from './services/storage/uploadDraftIndexedDbService';
import {
  cleanupExpiredUploadDrafts,
  discardPendingDocumentIntakeDraft,
  forgetUploadDraftMetadata,
  loadPendingDocumentIntakeDraft,
  savePendingDocumentIntakeDraft,
} from './services/upload/uploadDraftService';
import { setActiveStorageScope, resetStorageScopeForTests } from './services/storage/storageScopeService';
import type { CachedDocumentFilePayload } from './services/cachedDocumentFileService';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

useDocumentBlobDatabaseReset();

function payloadOf(marker: string): CachedDocumentFilePayload {
  const bytes = new TextEncoder().encode(marker);
  return {
    fileName: `${marker}.jpg`,
    mimeType: 'image/jpeg',
    fileSize: bytes.byteLength,
    bytes,
  };
}

function fileOf(marker: string): File {
  return new File([new TextEncoder().encode(marker)], `${marker}.jpg`, { type: 'image/jpeg' });
}

async function previewOf(marker: string) {
  const result = await processDocumentFileForPreview(fileOf(marker));
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('preview failed');
  return result.pending;
}

type RouterLocation = { pathname: string; search: string };
type Mount = { container: HTMLDivElement; root: Root; location: () => RouterLocation };

/** MemoryRouter verändert document.location nicht — die echte Route wird beobachtet. */
function LocationObserver({ onChange }: { onChange: (value: RouterLocation) => void }) {
  const location = useLocation();
  useEffect(() => {
    onChange({ pathname: location.pathname, search: location.search });
  }, [location.pathname, location.search, onChange]);
  return null;
}

function renderUploadPage(
  initialEntry = '/dokumente/upload',
  options: { strict?: boolean } = {},
): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let current: RouterLocation = { pathname: '', search: '' };
  let root!: Root;
  const Wrapper = options.strict ? StrictMode : Fragment;
  act(() => {
    root = createRoot(container);
    root.render(
      <Wrapper>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationObserver
          onChange={(value) => {
            current = value;
          }}
        />
        <AppProvider initialSetup={completeSetup}>
          <Routes>
            <Route path="/dokumente/upload" element={<DocumentUploadPage />} />
            <Route path="/dokumente" element={<div data-testid="documents-page" />} />
            <Route path="/ablage/:id" element={<div data-testid="inbox-detail" />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>
      </Wrapper>,
    );
  });
  return { container, root, location: () => current };
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
      // IndexedDB resolves on macrotasks — microtask flushing alone is not enough.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Wartet, bis eine Bedingung erfüllt ist — für die asynchrone Entwurfskette. */
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

/** Datei über das echte Uploadfeld übergeben. */
async function uploadThroughInput(container: ParentNode, file: File): Promise<void> {
  const input = container.querySelector('[data-testid="document-upload-input"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  // Warten bis Vorschau steht UND der Entwurf geschrieben wurde.
  await waitFor(
    async () =>
      container.querySelector('[data-testid="document-upload-dropzone"]') === null &&
      (await listUploadDraftRecordsForActiveScope()).length > 0,
    'preview + draft stored',
  );
}

/** Die im Test sichtbare Draft-ID stammt ausschließlich aus dem Store. */
async function onlyDraftId(): Promise<string> {
  const records = await listUploadDraftRecordsForActiveScope();
  expect(records).toHaveLength(1);
  return records[0]!.id;
}

function expectNoDomainObjects(): void {
  expect(getInboxStoreSnapshot()).toHaveLength(0);
  expect(getDocumentStoreSnapshot()).toHaveLength(0);
  expect(getVorgangStoreSnapshot()).toHaveLength(0);
  expect(getCustomerStoreSnapshot()).toHaveLength(0);
}

describe('UPLOAD-DRAFT-RESUME-01B1', () => {
  let mounted: Mount | undefined;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    resetStorageScopeForTests();
    resetDocumentFileStoreForTests();
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
    hydrateCustomerStore([]);
    await resetUploadDraftStoreForTests();
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
    resetDocumentFileStoreForTests();
    localStorage.clear();
  });

  it('A — Vorschau wird als Entwurf gesichert, ohne Domänenobjekte anzulegen', async () => {
    mounted = renderUploadPage();
    await settle();
    await uploadThroughInput(mounted.container, fileOf('DRAFT-A'));

    // Vorschau sichtbar
    expect(mounted.container.querySelector('[data-testid="document-upload-dropzone"]')).toBeNull();
    expect(mounted.container.textContent).toContain('DRAFT-A.jpg');

    const records = await listUploadDraftRecordsForActiveScope();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.source).toBe('upload');
    expect(record.fileName).toBe('DRAFT-A.jpg');

    // Neuer Ref ist temp mit expiresAt — kein committed Ref durch die Vorschau.
    const ref = getDocumentFileRefById(record.fileRefId);
    expect(ref?.lifecycleStatus).toBe('temp');
    expect(ref?.expiresAt).toBeDefined();
    expect(await hasDocumentBlob(record.fileRefId)).toBe(true);

    expectNoDomainObjects();
  });

  it('B — nach Reload erscheint dieselbe Vorschau ohne zweite Analyse', async () => {
    mounted = renderUploadPage();
    await settle();
    await uploadThroughInput(mounted.container, fileOf('DRAFT-B'));
    const draftId = await onlyDraftId();

    // Reload: Komponente weg, Stores über den echten Ladeweg aus localStorage.
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;
    resetDocumentFileStoreForTests();
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    persistenceService.hydrateStoresFromStorage();
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);

    const previewSpy = vi.spyOn(pendingDocumentIntakeService, 'processDocumentFileForPreview');
    const ocrSpy = vi.spyOn(ocrDocumentService, 'extractDocumentTextFromCache');

    mounted = renderUploadPage(`/dokumente/upload?draft=${draftId}`);
    await settle();

    expect(mounted.container.querySelector('[data-testid="document-upload-dropzone"]')).toBeNull();
    expect(mounted.container.textContent).toContain('DRAFT-B.jpg');
    expect(previewSpy).not.toHaveBeenCalled();
    expect(ocrSpy).not.toHaveBeenCalled();

    // Klassifikation und Empfehlung stammen unverändert aus dem Entwurf.
    const restored = await loadPendingDocumentIntakeDraft(draftId);
    expect(restored.success).toBe(true);
    if (!restored.success) return;
    const record = (await getUploadDraftRecordById(draftId))!;
    expect(restored.pending.previewClassification).toEqual(record.previewClassification);
    expect(restored.pending.storageRecommendation).toEqual(record.storageRecommendation);
    expect(restored.pending.storagePolicy).toEqual(record.storagePolicy);
    expect(restored.pending.extraction.recognizedText).toBe(record.extraction.recognizedText);
  });

  it('C — Dauerhaft speichern nach Wiederherstellung erzeugt genau ein InboxItem', async () => {
    const pending = await previewOf('DRAFT-C');
    const saved = await savePendingDocumentIntakeDraft(pending);
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    mounted = renderUploadPage(`/dokumente/upload?draft=${saved.draftId}`);
    await settle();
    expect(mounted.container.textContent).toContain('DRAFT-C.jpg');

    const writeSpy = vi.spyOn(blobDbService, 'saveDocumentBlob');
    const saveButton = [...mounted.container.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').toLowerCase().includes('dauerhaft'),
    );
    expect(saveButton, 'Dauerhaft-speichern-Aktion fehlt').toBeTruthy();
    await act(async () => {
      saveButton!.click();
      await Promise.resolve();
    });
    await settle(12);

    expect(getInboxStoreSnapshot()).toHaveLength(1);
    expect(getInboxStoreSnapshot()[0]?.fileRefId).toBe(saved.fileRefId);

    const ref = getDocumentFileRefById(saved.fileRefId);
    expect(ref?.lifecycleStatus).toBe('committed');
    expect(ref?.expiresAt).toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
  });

  it('D — Nicht speichern entfernt Entwurf, temp-Ref und Blob', async () => {
    const pending = await previewOf('DRAFT-D');
    const saved = await savePendingDocumentIntakeDraft(pending);
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    await discardPendingDocumentIntakeDraft(saved.draftId);

    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    expect(getDocumentFileRefById(saved.fileRefId)).toBeUndefined();
    expect(await hasDocumentBlob(saved.fileRefId)).toBe(false);
    expectNoDomainObjects();
  });

  it('E — vorhandener committed Ref wird wiederverwendet und nie gelöscht', async () => {
    const payload = payloadOf('DRAFT-E');
    const committed = await storeDocumentFileFromCachedPayload(payload, {
      lifecycleIntent: 'committed',
    });
    expect(committed.fileRef.lifecycleStatus).toBe('committed');

    const pending = await previewOf('DRAFT-E');
    const saved = await savePendingDocumentIntakeDraft(pending);
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    // Gleiche Datei, kein Demote.
    expect(saved.fileRefId).toBe(committed.fileRef.id);
    expect(getDocumentFileRefById(saved.fileRefId)?.lifecycleStatus).toBe('committed');

    await discardPendingDocumentIntakeDraft(saved.draftId);

    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    expect(getDocumentFileRefById(committed.fileRef.id)?.lifecycleStatus).toBe('committed');
    expect(await hasDocumentBlob(committed.fileRef.id)).toBe(true);
  });

  it('F — zwei Entwürfe mit gleichem Hash teilen sich eine Datei', async () => {
    const first = await savePendingDocumentIntakeDraft(await previewOf('DRAFT-F'));
    const second = await savePendingDocumentIntakeDraft(await previewOf('DRAFT-F'));
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;

    expect(second.fileRefId).toBe(first.fileRefId);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);

    await discardPendingDocumentIntakeDraft(first.draftId);

    // Der zweite Entwurf bleibt vollständig ladbar.
    expect(getDocumentFileRefById(second.fileRefId)).toBeDefined();
    expect(await hasDocumentBlob(second.fileRefId)).toBe(true);
    const reloaded = await loadPendingDocumentIntakeDraft(second.draftId);
    expect(reloaded.success).toBe(true);

    await discardPendingDocumentIntakeDraft(second.draftId);
    expect(getDocumentFileRefById(second.fileRefId)).toBeUndefined();
  });

  it('G — Persistenzfehler beim Bestätigen lässt den Entwurf bestehen', async () => {
    const pending = await previewOf('DRAFT-G');
    const saved = await savePendingDocumentIntakeDraft(pending);
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    const persistSpy = vi
      .spyOn(persistenceService, 'persistAll')
      .mockReturnValue({ success: false, error: 'quota_exceeded' });

    const restored = await loadPendingDocumentIntakeDraft(saved.draftId);
    expect(restored.success).toBe(true);
    if (!restored.success) return;
    const intake = await pendingDocumentIntakeService.confirmPendingDocumentIntake(
      restored.pending,
      { userDecision: 'save_permanently', importSource: 'upload' },
    );
    expect(intake.success).toBe(false);
    persistSpy.mockRestore();

    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(getDocumentFileRefById(saved.fileRefId)?.lifecycleStatus).toBe('temp');
    const again = await loadPendingDocumentIntakeDraft(saved.draftId);
    expect(again.success).toBe(true);
  });

  it('H — abgelaufener und fremder Entwurf werden nicht wiederhergestellt', async () => {
    const pending = await previewOf('DRAFT-H');
    const saved = await savePendingDocumentIntakeDraft(pending);
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    // Abgelaufen: Laden verweigert, Aufräumen entfernt ihn.
    const future = Date.now() + UPLOAD_DRAFT_TTL_MS + 60_000;
    const expiredLoad = await loadPendingDocumentIntakeDraft(saved.draftId, { nowMs: future });
    expect(expiredLoad.success).toBe(false);
    if (!expiredLoad.success) expect(expiredLoad.reason).toBe('expired');

    mounted = renderUploadPage(`/dokumente/upload?draft=${saved.draftId}`);
    await settle();
    // Vor Ablauf lädt er noch — jetzt kontrolliert prüfen wir den fremden Scope.
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    setActiveStorageScope({ type: 'workspace', workspaceId: 'other-workspace' });
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    const foreign = await loadPendingDocumentIntakeDraft(saved.draftId);
    expect(foreign.success).toBe(false);
    if (!foreign.success) expect(foreign.reason).toBe('missing');

    // Fremder Scope räumt nichts des ursprünglichen Scopes ab.
    await cleanupExpiredUploadDrafts({ nowMs: future });
    resetStorageScopeForTests();
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(1);

    await cleanupExpiredUploadDrafts({ nowMs: future });
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);

    // Unbekannte ID: kontrollierter Rückfall zur Dropzone, kein Absturz.
    mounted = renderUploadPage('/dokumente/upload?draft=updr-does-not-exist');
    await settle();
    expect(
      mounted.container.querySelector('[data-testid="document-upload-dropzone"]'),
    ).not.toBeNull();
  });

  it('I — Entwurfsdaten enthalten weder Bytes noch landen sie in URL oder localStorage', async () => {
    mounted = renderUploadPage();
    await settle();
    await uploadThroughInput(mounted.container, fileOf('DRAFT-I'));
    const draftId = await onlyDraftId();
    const record = (await getUploadDraftRecordById(draftId))!;

    // Der Datensatz selbst trägt keine Bytes.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('data:');
    expect((record as unknown as { bytes?: unknown }).bytes).toBeUndefined();
    expect((record as unknown as { blob?: unknown }).blob).toBeUndefined();
    expect((record as unknown as { dataUrl?: unknown }).dataUrl).toBeUndefined();

    // Die URL trägt nur die undurchsichtige ID.
    const link = mounted.container.ownerDocument.location;
    void link;
    expect(draftId.startsWith('updr-')).toBe(true);
    expect(draftId).not.toContain(record.extraction.recognizedText.slice(0, 8));

    // localStorage enthält keinen OCR-Text, keine pageTexts, keine Bytes.
    const local = Object.keys(localStorage)
      .map((key) => localStorage.getItem(key) ?? '')
      .join('\n');
    expect(local).not.toContain('Baustellenfoto Rohbau');
    expect(local).not.toContain('_pageTexts');
    expect(local).not.toContain('data:image');
  });

  it('J — fremder Scope kann einen Entwurf weder verwerfen noch vergessen', async () => {
    const saved = await savePendingDocumentIntakeDraft(await previewOf('DRAFT-J'));
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    setActiveStorageScope({ type: 'workspace', workspaceId: 'foreign-workspace' });
    expect(await discardPendingDocumentIntakeDraft(saved.draftId)).toBe(false);
    expect(await forgetUploadDraftMetadata(saved.draftId)).toBe(false);

    resetStorageScopeForTests();
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(1);
    expect(getDocumentFileRefById(saved.fileRefId)?.lifecycleStatus).toBe('temp');
    expect(await hasDocumentBlob(saved.fileRefId)).toBe(true);
    const stillLoadable = await loadPendingDocumentIntakeDraft(saved.draftId);
    expect(stillLoadable.success).toBe(true);
  });

  it('K — gleiche Bytelänge mit anderem Inhalt wird abgelehnt', async () => {
    const saved = await savePendingDocumentIntakeDraft(await previewOf('DRAFT-K'));
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    const ref = getDocumentFileRefById(saved.fileRefId)!;
    const tampered = new TextEncoder().encode('X'.repeat(ref.fileSize));
    expect(tampered.byteLength).toBe(ref.fileSize);
    await blobDbService.saveDocumentBlob({
      fileRefId: ref.id,
      blob: new Blob([tampered], { type: ref.mimeType }),
      mimeType: ref.mimeType,
      fileSize: ref.fileSize,
      contentHash: ref.contentHash,
      createdAt: ref.createdAt,
    });

    const previewSpy = vi.spyOn(pendingDocumentIntakeService, 'processDocumentFileForPreview');
    const ocrSpy = vi.spyOn(ocrDocumentService, 'extractDocumentTextFromCache');

    const result = await loadPendingDocumentIntakeDraft(saved.draftId);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('mismatch');
    expect(previewSpy).not.toHaveBeenCalled();
    expect(ocrSpy).not.toHaveBeenCalled();
  });

  it('L — echte Router-URL trägt die Draft-ID und erhält type=pdf', async () => {
    mounted = renderUploadPage('/dokumente/upload?type=pdf');
    await settle();
    expect(mounted.location().search).toBe('?type=pdf');

    await uploadThroughInput(mounted.container, fileOf('DRAFT-L'));
    const draftId = await onlyDraftId();
    await waitFor(() => mounted!.location().search.includes('draft='), 'draft in url');

    const params = new URLSearchParams(mounted.location().search);
    expect(params.get('draft')).toBe(draftId);
    expect(params.get('type')).toBe('pdf');
    expect(draftId.startsWith('updr-')).toBe(true);

    const url = `${mounted.location().pathname}${mounted.location().search}`;
    expect(url).not.toContain('Baustellenfoto');
    expect(url).not.toContain('pageTexts');
    expect(url).not.toContain('data:');
  });

  it('M — Nicht speichern über den Button räumt Entwurf, Ref und URL auf', async () => {
    mounted = renderUploadPage('/dokumente/upload?type=pdf');
    await settle();
    await uploadThroughInput(mounted.container, fileOf('DRAFT-M'));
    const record = (await listUploadDraftRecordsForActiveScope())[0]!;

    const discardButton = [...mounted.container.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').toLowerCase().includes('nicht speichern'),
    );
    expect(discardButton, 'Nicht-speichern-Aktion fehlt').toBeTruthy();
    await act(async () => {
      discardButton!.click();
      await Promise.resolve();
    });
    await waitFor(
      async () => (await listUploadDraftRecordsForActiveScope()).length === 0,
      'draft removed',
    );
    await settle();

    expect(
      mounted.container.querySelector('[data-testid="document-upload-dropzone"]'),
    ).not.toBeNull();
    expect(getDocumentFileRefById(record.fileRefId)).toBeUndefined();
    expect(await hasDocumentBlob(record.fileRefId)).toBe(false);

    const params = new URLSearchParams(mounted.location().search);
    expect(params.get('draft')).toBeNull();
    expect(params.get('type')).toBe('pdf');
    expectNoDomainObjects();
  });

  it('N — während der Sicherung bleibt die Analyse verborgen und erscheint danach bedienbar', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSave = blobDbService.saveDocumentBlob;
    vi.spyOn(blobDbService, 'saveDocumentBlob').mockImplementation(async (input) => {
      await gate;
      return realSave(input);
    });

    mounted = renderUploadPage();
    await settle();
    const input = mounted.container.querySelector(
      '[data-testid="document-upload-input"]',
    ) as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [fileOf('DRAFT-N')], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await settle(4);

    // Sicherung läuft noch: die Analyse bleibt verborgen, es gibt nichts zu entscheiden.
    const decisionButtons = [...mounted.container.querySelectorAll('button')].filter((node) =>
      /dauerhaft|nicht speichern|vorübergehend/i.test(node.textContent ?? ''),
    );
    expect(decisionButtons).toHaveLength(0);
    expect(
      mounted.container.querySelector('[data-testid="document-upload-dropzone"]'),
    ).not.toBeNull();
    expect(getInboxStoreSnapshot()).toHaveLength(0);

    release!();
    await waitFor(
      async () => (await listUploadDraftRecordsForActiveScope()).length === 1,
      'draft stored after release',
    );
    await settle();
    const enabled = [...mounted.container.querySelectorAll('button')].filter((node) =>
      /dauerhaft/i.test(node.textContent ?? ''),
    );
    expect(enabled.some((node) => !(node as HTMLButtonElement).disabled)).toBe(true);
  });

  it('O — ein verspäteter älterer Upload überschreibt den neueren Entwurf nicht', async () => {
    // Die Vorschau des ersten Uploads hängt, bis der zweite fertig ist.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realExtract = ocrDocumentService.extractDocumentTextFromCache;
    let call = 0;
    vi.spyOn(ocrDocumentService, 'extractDocumentTextFromCache').mockImplementation(
      async (payload) => {
        call += 1;
        if (call === 1) await gate;
        return realExtract(payload);
      },
    );

    mounted = renderUploadPage();
    await settle();
    const input = mounted.container.querySelector(
      '[data-testid="document-upload-input"]',
    ) as HTMLInputElement;

    // Erster Upload startet und bleibt in der Vorschau stehen.
    Object.defineProperty(input, 'files', {
      value: [fileOf('DRAFT-O-FIRST')],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    // Zweiter Upload überholt ihn vollständig.
    Object.defineProperty(input, 'files', {
      value: [fileOf('DRAFT-O-SECOND')],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await waitFor(
      async () => (await listUploadDraftRecordsForActiveScope()).length === 1,
      'second draft stored',
    );
    const secondId = (await listUploadDraftRecordsForActiveScope())[0]!.id;

    // Erst jetzt läuft der überholte erste Vorgang weiter.
    release!();
    await settle(10);

    const records = await listUploadDraftRecordsForActiveScope();
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(secondId);
    expect(records[0]!.fileName).toBe('DRAFT-O-SECOND.jpg');
    const params = new URLSearchParams(mounted.location().search);
    expect(params.get('draft')).toBe(secondId);
    expect(mounted.container.textContent).toContain('DRAFT-O-SECOND.jpg');
    expect(mounted.container.textContent).not.toContain('DRAFT-O-FIRST.jpg');
  });

  it('P — echter Dateiwechsel A → B über die sichtbare Oberfläche', async () => {
    mounted = renderUploadPage();
    await settle();
    await uploadThroughInput(mounted.container, fileOf('DRAFT-P-A'));
    const draftA = (await listUploadDraftRecordsForActiveScope())[0]!;
    expect(mounted.container.textContent).toContain('DRAFT-P-A.jpg');

    // In der Vorschau existiert dasselbe echte Input, und die Auswahlaktion klickt es.
    const previewInput = mounted.container.querySelector(
      '[data-testid="document-upload-input"]',
    ) as HTMLInputElement;
    expect(previewInput, 'Datei-Input fehlt in der Vorschau').not.toBeNull();
    const clickSpy = vi.spyOn(previewInput, 'click');

    // Die vorhandene Auswahlaktion der Vorschau erscheint nach einem
    // Bestätigungsfehler — ein realer Weg, um die Datei zu wechseln.
    const persistSpy = vi
      .spyOn(persistenceService, 'persistAll')
      .mockReturnValue({ success: false, error: 'quota_exceeded' });
    const saveButton = [...mounted.container.querySelectorAll('button')].find((node) =>
      /dauerhaft/i.test(node.textContent ?? ''),
    );
    await act(async () => {
      saveButton!.click();
      await Promise.resolve();
    });
    await settle();
    persistSpy.mockRestore();

    const selectAction = mounted.container.querySelector(
      '[data-testid="ocr-confirm-select-file"]',
    ) as HTMLButtonElement | null;
    expect(selectAction, 'Auswahlaktion fehlt in der Vorschau').toBeTruthy();
    act(() => {
      selectAction!.click();
    });
    // Das in der Vorschau gerenderte Input wird tatsächlich geklickt.
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(getInboxStoreSnapshot()).toHaveLength(0);

    // Über genau dieses Input kommt Datei B.
    Object.defineProperty(previewInput, 'files', {
      value: [fileOf('DRAFT-P-B')],
      configurable: true,
    });
    await act(async () => {
      previewInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await waitFor(async () => {
      const records = await listUploadDraftRecordsForActiveScope();
      return records.length === 1 && records[0]!.id !== draftA.id;
    }, 'draft B replaces draft A');
    await settle();

    const records = await listUploadDraftRecordsForActiveScope();
    expect(records).toHaveLength(1);
    const draftB = records[0]!;
    expect(draftB.fileName).toBe('DRAFT-P-B.jpg');
    expect(mounted.container.textContent).toContain('DRAFT-P-B.jpg');
    expect(mounted.container.textContent).not.toContain('DRAFT-P-A.jpg');
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBe(draftB.id);

    // A ist vollständig weg, B vollständig da.
    expect(getDocumentFileRefById(draftA.fileRefId)).toBeUndefined();
    expect(await hasDocumentBlob(draftA.fileRefId)).toBe(false);
    expect(getDocumentFileRefById(draftB.fileRefId)?.lifecycleStatus).toBe('temp');
    expect(await hasDocumentBlob(draftB.fileRefId)).toBe(true);
    expectNoDomainObjects();
  });

  it('Q — Cleanup-Retry nach fehlgeschlagener Persistenz, ohne Reload', async () => {
    const saved = await savePendingDocumentIntakeDraft(await previewOf('DRAFT-Q'));
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    // Genau der Persistenzaufruf nach der Dateilöschung schlägt fehl.
    const persistSpy = vi
      .spyOn(persistenceService, 'persistAll')
      .mockReturnValue({ success: false, error: 'quota_exceeded' });

    expect(await discardPendingDocumentIntakeDraft(saved.draftId)).toBe(false);
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(1);
    // Im aktuellen Speicher sind Ref und Blob bereits entfernt.
    expect(getDocumentFileRefById(saved.fileRefId)).toBeUndefined();
    expect(await hasDocumentBlob(saved.fileRefId)).toBe(false);

    persistSpy.mockRestore();

    // Zweiter Versuch ohne Reload.
    expect(await discardPendingDocumentIntakeDraft(saved.draftId)).toBe(true);
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);

    // Der alte FileRef darf aus der Persistenz nicht zurückkehren.
    resetDocumentFileStoreForTests();
    persistenceService.hydrateStoresFromStorage();
    expect(getDocumentFileRefById(saved.fileRefId)).toBeUndefined();
    expect(
      getDocumentFileRefStoreSnapshot().some((ref) => ref.id === saved.fileRefId),
    ).toBe(false);
  });

  it('R — StrictMode-Doppelmount stellt den Entwurf her, ohne Dauerspinner', async () => {
    const saved = await savePendingDocumentIntakeDraft(await previewOf('DRAFT-R'));
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    const previewSpy = vi.spyOn(pendingDocumentIntakeService, 'processDocumentFileForPreview');
    const ocrSpy = vi.spyOn(ocrDocumentService, 'extractDocumentTextFromCache');

    mounted = renderUploadPage(`/dokumente/upload?draft=${saved.draftId}`, { strict: true });
    await waitFor(
      () => mounted!.container.querySelector('[data-testid="document-upload-dropzone"]') === null,
      'preview restored under StrictMode',
    );
    await settle();

    // Vorschau da, Dropzone weg.
    expect(mounted.container.textContent).toContain('DRAFT-R.jpg');
    expect(mounted.container.querySelector('[data-testid="document-upload-dropzone"]')).toBeNull();

    // Kein hängender Ladezustand: verstecktes Input und Entscheidungen bedienbar.
    const input = mounted.container.querySelector(
      '[data-testid="document-upload-input"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.disabled).toBe(false);

    const decisionButtons = [...mounted.container.querySelectorAll('button')].filter((node) =>
      /dauerhaft|nicht speichern|vorübergehend/i.test(node.textContent ?? ''),
    );
    expect(decisionButtons.length).toBeGreaterThan(0);
    for (const button of decisionButtons) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }

    // Entwurf und Datei bleiben, nichts wurde angelegt, keine zweite Analyse.
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(1);
    expect(getDocumentFileRefById(saved.fileRefId)?.lifecycleStatus).toBe('temp');
    expect(await hasDocumentBlob(saved.fileRefId)).toBe(true);
    expectNoDomainObjects();
    expect(previewSpy).not.toHaveBeenCalled();
    expect(ocrSpy).not.toHaveBeenCalled();
  });

  it('S — StrictMode-Mount ohne Draft zeigt eine bedienbare Dropzone', async () => {
    mounted = renderUploadPage('/dokumente/upload', { strict: true });
    await settle();

    expect(
      mounted.container.querySelector('[data-testid="document-upload-dropzone"]'),
    ).not.toBeNull();
    const input = mounted.container.querySelector(
      '[data-testid="document-upload-input"]',
    ) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    const selectButton = mounted.container.querySelector(
      '[data-testid="document-upload-select"]',
    ) as HTMLButtonElement;
    expect(selectButton.disabled).toBe(false);
    expect(selectButton.getAttribute('aria-busy')).not.toBe('true');
  });

  /** Gate auf den Blob-Write: der Entwurf bleibt kontrolliert unfertig. */
  function gateDraftWrite() {
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

  /** Datei auswählen, ohne auf den Entwurf zu warten. */
  async function startUpload(container: ParentNode, file: File): Promise<void> {
    const input = container.querySelector(
      '[data-testid="document-upload-input"]',
    ) as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await settle(4);
  }

  it('T — die Analyse bleibt verborgen, solange der Entwurf nicht gesichert ist', async () => {
    const gate = gateDraftWrite();
    mounted = renderUploadPage();
    await settle();
    await startUpload(mounted.container, fileOf('DRAFT-T'));

    // Die Vorschau ist fertig berechnet, der Entwurf aber noch nicht geschrieben.
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);

    // Nichts davon darf sichtbar sein.
    expect(mounted.container.querySelector('[data-testid="ocr-preview-panel"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain('DRAFT-T.jpg');
    const decisionButtons = [...mounted.container.querySelectorAll('button')].filter((node) =>
      /dauerhaft|nicht speichern|vorübergehend/i.test(node.textContent ?? ''),
    );
    expect(decisionButtons).toHaveLength(0);

    // Verarbeitungszustand bleibt stehen.
    expect(
      mounted.container.querySelector('[data-testid="document-upload-dropzone"]'),
    ).not.toBeNull();
    const select = mounted.container.querySelector(
      '[data-testid="document-upload-select"]',
    ) as HTMLButtonElement;
    expect(select.disabled).toBe(true);

    // Kein Wiederaufnahme-Pointer.
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBeNull();
    expectNoDomainObjects();

    // Nach Freigabe erscheint die Analyse bedienbar.
    gate.release();
    await waitFor(
      () => mounted!.container.querySelector('[data-testid="document-upload-dropzone"]') === null,
      'analysis visible after durable write',
    );
    await settle(2);
    expect(mounted.container.textContent).toContain('DRAFT-T.jpg');
    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(1);
    const draftId = (await listUploadDraftRecordsForActiveScope())[0]!.id;
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBe(draftId);
    const enabled = [...mounted.container.querySelectorAll('button')].filter((node) =>
      /dauerhaft/i.test(node.textContent ?? ''),
    );
    expect(enabled.some((node) => !(node as HTMLButtonElement).disabled)).toBe(true);
  });

  it('U — Unmount während des Writes lässt keinen unsichtbaren Entwurf zurück', async () => {
    const gate = gateDraftWrite();
    mounted = renderUploadPage();
    await settle();
    await startUpload(mounted.container, fileOf('DRAFT-U'));

    // Seite verlassen, während der Write noch offen ist.
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    gate.release();
    await settle(12);

    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    expectNoDomainObjects();
  });

  it('V — Unmount während des Writes löscht keinen geteilten committed Ref', async () => {
    const payload = payloadOf('DRAFT-V');
    const committed = await storeDocumentFileFromCachedPayload(payload, {
      lifecycleIntent: 'committed',
    });
    expect(committed.fileRef.lifecycleStatus).toBe('committed');

    // Bei bereits committed Hash entfällt der Blob-Write — hier hängt der
    // Metadaten-Write, damit der Unmount wirklich mitten hinein fällt.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSaveRecord = uploadDraftDb.saveUploadDraftRecord;
    vi.spyOn(uploadDraftDb, 'saveUploadDraftRecord').mockImplementation(async (record) => {
      await gate;
      return realSaveRecord(record);
    });

    mounted = renderUploadPage();
    await settle();
    await startUpload(mounted.container, fileOf('DRAFT-V'));

    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;

    release!();
    await settle(12);

    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    expect(getDocumentFileRefById(committed.fileRef.id)?.lifecycleStatus).toBe('committed');
    expect(await hasDocumentBlob(committed.fileRef.id)).toBe(true);
  });

  it('W — fehlgeschlagene Sicherung zeigt die Analyse trotzdem, ohne Pointer', async () => {
    mounted = renderUploadPage();
    await settle();
    const persistSpy = vi
      .spyOn(persistenceService, 'persistAll')
      .mockReturnValue({ success: false, error: 'quota_exceeded' });

    await startUpload(mounted.container, fileOf('DRAFT-W'));
    await waitFor(
      () => mounted!.container.querySelector('[data-testid="document-upload-dropzone"]') === null,
      'analysis visible after failed draft write',
    );
    await settle(2);
    persistSpy.mockRestore();

    expect(mounted.container.textContent).toContain('DRAFT-W.jpg');
    const enabled = [...mounted.container.querySelectorAll('button')].filter((node) =>
      /dauerhaft/i.test(node.textContent ?? ''),
    );
    expect(enabled.some((node) => !(node as HTMLButtonElement).disabled)).toBe(true);

    expect(await listUploadDraftRecordsForActiveScope()).toHaveLength(0);
    expect(new URLSearchParams(mounted.location().search).get('draft')).toBeNull();
    expectNoDomainObjects();
  });

  it('Aufräumen entfernt nur abgelaufene Uploadentwürfe', async () => {
    const fresh = await savePendingDocumentIntakeDraft(await previewOf('KEEP-FRESH'));
    const stale = await savePendingDocumentIntakeDraft(await previewOf('STALE-ONE'));
    expect(fresh.success && stale.success).toBe(true);
    if (!fresh.success || !stale.success) return;

    const staleRecord = (await getUploadDraftRecordById(stale.draftId))!;
    await saveUploadDraftRecord({
      ...staleRecord,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const removed = await cleanupExpiredUploadDrafts();
    expect(removed).toBe(1);

    const rest = await listUploadDraftRecordsForActiveScope();
    expect(rest.map((entry) => entry.id)).toEqual([fresh.draftId]);
    expect(getDocumentFileRefById(fresh.fileRefId)?.lifecycleStatus).toBe('temp');
    expect(getDocumentFileRefById(stale.fileRefId)).toBeUndefined();
  });
});
