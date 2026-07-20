import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentCardThumbnail } from './components/documents/DocumentCardThumbnail';
import { useDocumentFileRepresentationObjectUrl } from './hooks/useDocumentFileRepresentationObjectUrl';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import * as representationReadService from './services/documentFileRepresentationReadService';
import {
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { resetDocumentBlobDatabaseForTests } from './services/storage/documentBlobIndexedDbService';
import { resetTestStores } from './test/resetStores';
import type { DocumentFileObjectUrlState } from './hooks/useDocumentFileObjectUrl';

const DOC_A = 'doc-ui-thumb-a';
const DOC_B = 'doc-ui-thumb-b';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const PLACEHOLDER = '📄';

async function storeCommittedJpeg(fileName: string) {
  return storeDocumentFileFromCachedPayload(
    {
      fileName,
      mimeType: 'image/jpeg',
      fileSize: JPEG_BYTES.byteLength,
      bytes: JPEG_BYTES,
    },
    { lifecycleIntent: 'committed' },
  );
}

function HookProbe({
  documentId,
  onState,
}: {
  documentId: string | undefined;
  onState: (state: DocumentFileObjectUrlState) => void;
}) {
  const state = useDocumentFileRepresentationObjectUrl(documentId, 'thumbnail');
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

afterEach(async () => {
  vi.restoreAllMocks();
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
  await resetDocumentBlobDatabaseForTests();
});

describe('STORAGE-REPRESENTATION-UI-THUMBNAIL-01', () => {
  it('zeigt Thumbnail-Bild wenn Binding ready ist', async () => {
    const stored = await storeCommittedJpeg('thumb.jpg');
    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'thumbnail',
        fileRefId: stored.fileRef.id,
      }),
    ]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(DocumentCardThumbnail, {
          documentId: DOC_A,
          placeholder: PLACEHOLDER,
        }),
      );
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(container.querySelector(`[data-testid="document-card-thumbnail-${DOC_A}"]`)).not.toBeNull();
    });

    const img = container.querySelector(
      `[data-testid="document-card-thumbnail-${DOC_A}"]`,
    ) as HTMLImageElement;
    expect(img.src).toMatch(/^blob:/);
    expect(container.textContent).not.toContain(PLACEHOLDER);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Missing zeigt Platzhalter und kein Original-Fallback', async () => {
    // Original-ähnliche Datei existiert, aber kein thumbnail-Binding.
    await storeCommittedJpeg('original-only.jpg');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(DocumentCardThumbnail, {
          documentId: DOC_A,
          placeholder: PLACEHOLDER,
        }),
      );
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(container.querySelector(`[data-testid="document-card-preview-${DOC_A}"]`)?.textContent).toBe(
        PLACEHOLDER,
      );
    });

    expect(container.querySelector(`[data-testid="document-card-thumbnail-${DOC_A}"]`)).toBeNull();
    expect(container.querySelector('img')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Object-URL wird bei Unmount widerrufen', async () => {
    const stored = await storeCommittedJpeg('revoke.jpg');
    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'thumbnail',
        fileRefId: stored.fileRef.id,
      }),
    ]);

    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(DocumentCardThumbnail, {
          documentId: DOC_A,
          placeholder: PLACEHOLDER,
        }),
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector(`[data-testid="document-card-thumbnail-${DOC_A}"]`)).not.toBeNull();
    });

    const img = container.querySelector(
      `[data-testid="document-card-thumbnail-${DOC_A}"]`,
    ) as HTMLImageElement;
    const objectUrl = img.src;
    expect(objectUrl).toMatch(/^blob:/);

    await act(async () => {
      root.unmount();
    });
    container.remove();

    expect(revokeSpy).toHaveBeenCalledWith(objectUrl);
  });

  it('Race: späteres Resolve nach Document-Wechsel wird verworfen und URL freigegeben', async () => {
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
              kind: 'thumbnail',
              fileRefId: 'file-a',
            }),
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
              committedAt: '2026-07-20T00:00:01.000Z',
            },
            blob: new Blob([JPEG_BYTES], { type: 'image/jpeg' }),
          });
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
          },
        }),
      );
    });
    await flushUi();

    await act(async () => {
      root.render(
        createElement(HookProbe, {
          documentId: DOC_B,
          onState: (state) => {
            states.push(state);
          },
        }),
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

    // DOC_A finished after cancel → create + immediate revoke, never exposed as ready.
    if (createSpy.mock.calls.length > 0) {
      expect(revokeSpy).toHaveBeenCalled();
    }
    expect(states.some((entry) => entry.status === 'ready' && entry.objectUrl)).toBe(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
