import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentDetailPreview } from './components/documents/DocumentDetailPreview';
import { DocumentOriginalFilePanel } from './components/documents/DocumentOriginalFilePanel';
import { useDocumentFileRepresentationObjectUrl } from './hooks/useDocumentFileRepresentationObjectUrl';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests } from './services/documentFileRepresentationBindingStoreService';
import * as representationReadService from './services/documentFileRepresentationReadService';
import * as documentFileStoreService from './services/documentFileStoreService';
import {
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload } from './services/documentFileStoreService';
import type { DocumentFileObjectUrlState } from './hooks/useDocumentFileObjectUrl';
import type { TranslationKey } from './i18n';

const DOC_A = 'doc-ui-preview-a';
const DOC_B = 'doc-ui-preview-b';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a]);

function translate(key: TranslationKey): string {
  return key;
}

async function storeCommitted(
  bytes: Uint8Array,
  mimeType: string,
  fileName: string,
) {
  return storeDocumentFileFromCachedPayload(
    {
      fileName,
      mimeType,
      fileSize: bytes.byteLength,
      bytes },
    { lifecycleIntent: 'committed' },
  );
}

function DetailPreviewHarness({
  documentId,
  fileRefId }: {
  documentId: string;
  fileRefId: string;
}) {
  return createElement(
    'div',
    { 'data-testid': 'detail-preview-harness' },
    createElement(DocumentDetailPreview, { documentId }),
    createElement(DocumentOriginalFilePanel, {
      fileRefId,
      translate }),
  );
}

function HookProbe({
  documentId,
  onState }: {
  documentId: string | undefined;
  onState: (state: DocumentFileObjectUrlState) => void;
}) {
  const state = useDocumentFileRepresentationObjectUrl(documentId, 'preview');
  useEffect(() => {
    onState(state);
  }, [state, onState]);
  return null;
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

useDocumentBlobDatabaseReset();

afterEach(async () => {
  vi.restoreAllMocks();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-REPRESENTATION-UI-PREVIEW-01', () => {
  it('ready zeigt Preview und Original-Panel', async () => {
    const original = await storeCommitted(PDF_BYTES, 'application/pdf', 'original.pdf');
    const preview = await storeCommitted(JPEG_BYTES, 'image/jpeg', 'preview.jpg');
    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'preview',
        fileRefId: preview.fileRef.id }),
    ]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(DetailPreviewHarness, {
          documentId: DOC_A,
          fileRefId: original.fileRef.id }),
      );
    });
    await flushUi();

    await vi.waitFor(() => {
      expect(
        container.querySelector(`[data-testid="document-detail-preview-image-${DOC_A}"]`),
      ).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('.document-original-file-panel')).not.toBeNull();
    });

    const img = container.querySelector(
      `[data-testid="document-detail-preview-image-${DOC_A}"]`,
    ) as HTMLImageElement;
    expect(img.src).toMatch(/^blob:/);
    expect(container.querySelector('.document-original-file-panel')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('missing zeigt nur Original-Panel', async () => {
    const original = await storeCommitted(PDF_BYTES, 'application/pdf', 'original-only.pdf');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(DetailPreviewHarness, {
          documentId: DOC_A,
          fileRefId: original.fileRef.id }),
      );
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(container.querySelector('.document-original-file-panel')).not.toBeNull();
    });

    expect(container.querySelector(`[data-testid="document-detail-preview-${DOC_A}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="document-detail-preview-image-${DOC_A}"]`)).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Fehler zeigt nur Original-Panel', async () => {
    const original = await storeCommitted(PDF_BYTES, 'application/pdf', 'original-error.pdf');
    vi.spyOn(representationReadService, 'resolveDocumentFileRepresentation').mockRejectedValue(
      new Error('resolve boom'),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(DetailPreviewHarness, {
          documentId: DOC_A,
          fileRefId: original.fileRef.id }),
      );
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(container.querySelector('.document-original-file-panel')).not.toBeNull();
    });

    expect(container.querySelector(`[data-testid="document-detail-preview-image-${DOC_A}"]`)).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Object-URL wird bei Unmount freigegeben', async () => {
    const preview = await storeCommitted(JPEG_BYTES, 'image/jpeg', 'revoke-preview.jpg');
    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'preview',
        fileRefId: preview.fileRef.id }),
    ]);

    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(DocumentDetailPreview, { documentId: DOC_A }));
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector(`[data-testid="document-detail-preview-image-${DOC_A}"]`),
      ).not.toBeNull();
    });

    const img = container.querySelector(
      `[data-testid="document-detail-preview-image-${DOC_A}"]`,
    ) as HTMLImageElement;
    const objectUrl = img.src;

    await act(async () => {
      root.unmount();
    });
    container.remove();

    expect(revokeSpy).toHaveBeenCalledWith(objectUrl);
  });

  it('Object-URL wird bei Document-Wechsel freigegeben; Race verwirft altes Resolve', async () => {
    let releaseSlow: (() => void) | undefined;
    const slowReady = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const createSpy = vi.spyOn(URL, 'createObjectURL');

    vi.spyOn(representationReadService, 'resolveDocumentFileRepresentation').mockImplementation(
      async (input) => {
        if (input.documentId === DOC_A) {
          await slowReady;
          return Object.freeze({
            kind: 'ready' as const,
            binding: createDocumentFileRepresentationBinding({
              documentId: DOC_A,
              kind: 'preview',
              fileRefId: 'file-a' }),
            fileRef: {
              id: 'file-a',
              originalFileName: 'a.jpg',
              mimeType: 'image/jpeg',
              fileSize: 1,
              contentHash: 'hash-a',
              storageType: 'indexeddb' as const,
              localDataKey: 'file-a',
              createdAt: '2026-07-20T00:00:00.000Z',
              lifecycleStatus: 'committed' as const,
              committedAt: '2026-07-20T00:00:01.000Z' },
            blob: new Blob([JPEG_BYTES], { type: 'image/jpeg' }) });
        }
        return Object.freeze({ kind: 'missing_binding' as const });
      },
    );

    const states: DocumentFileObjectUrlState[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(HookProbe, {
          documentId: DOC_A,
          onState: (state) => {
            states.push(state);
          } }),
      );
    });
    await flushUi();

    await act(async () => {
      root.render(
        createElement(HookProbe, {
          documentId: DOC_B,
          onState: (state) => {
            states.push(state);
          } }),
      );
    });
    await flushUi();

    await act(async () => {
      releaseSlow?.();
      await slowReady;
      await Promise.resolve();
    });
    await flushUi();

    const last = states[states.length - 1];
    expect(last?.status).toBe('missing');
    expect(last?.objectUrl).toBeUndefined();
    if (createSpy.mock.calls.length > 0) {
      expect(revokeSpy).toHaveBeenCalled();
    }
    expect(states.some((entry) => entry.status === 'ready' && entry.objectUrl)).toBe(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('lädt bei Missing nicht das Original als Preview', async () => {
    const original = await storeCommitted(PDF_BYTES, 'application/pdf', 'no-preview-original.pdf');
    const blobSpy = vi.spyOn(documentFileStoreService, 'getDocumentFileBlob');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(DocumentDetailPreview, { documentId: DOC_A }));
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(container.querySelector(`[data-testid="document-detail-preview-${DOC_A}"]`)).toBeNull();
    });

    // Preview-Komponente allein: kein Binding → resolve endet vor Blob; Original nie geladen.
    expect(blobSpy).not.toHaveBeenCalled();
    expect(blobSpy.mock.calls.every((call) => {
      const ref = call[0];
      if (typeof ref === 'string') return ref !== original.fileRef.id;
      return ref?.id !== original.fileRef.id;
    })).toBe(true);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
