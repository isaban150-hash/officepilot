import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentDetailPreview } from './components/documents/DocumentDetailPreview';
import { DocumentDerivativeRecoveryStatusPanel } from './components/documents/DocumentDerivativeRecoveryStatusPanel';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import { createDocumentFileDerivativeStepOutcome } from './services/documentFileDerivativeStepOutcomeService';
import {
  hydrateDocumentFileDerivativeStepOutcomeStore,
  resetDocumentFileDerivativeStepOutcomeStoreForTests,
} from './services/documentFileDerivativeStepOutcomeStoreService';
import { upsertDocumentFileDerivativeRecoveryContext } from './services/documentFileDerivativeRecoveryContextService';
import { resetDocumentFileDerivativeRecoveryContextStoreForTests } from './services/documentFileDerivativeRecoveryContextStoreService';
import * as recoveryContextService from './services/documentFileDerivativeRecoveryContextService';
import * as manualRetryService from './services/documentFileDerivativeStepManualRetryService';
import { executeDocumentFileDerivativeRecoveryDetailRetry } from './services/documentFileDerivativeRecoveryDetailRetryService';
import {
  resetDocumentFileDerivativeStepInFlightLocksForTests,
  tryAcquireDocumentFileDerivativeStepInFlightLock,
  releaseDocumentFileDerivativeStepInFlightLock,
} from './services/documentFileDerivativeStepInFlightLockService';
import { setPostImportDerivativeStepRunnersForTests } from './services/documentFilePostImportDerivativeOrchestrationService';
import { hydrateDocumentStore } from './services/documentService';
import {
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { resetDocumentBlobDatabaseForTests } from './services/storage/documentBlobIndexedDbService';
import { withNewEntitySync } from './services/sync/syncMetaService';
import { resetTestStores } from './test/resetStores';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';
import type { PostImportDerivativeStepId } from './types/documentFileDerivativeStepOutcome';
import type { DocumentFileRepresentationBindingKind } from './types/documentFileRepresentationBinding';
import type { DocumentFileDerivativeStepOutcomeKind } from './types/documentFileDerivativeStepOutcome';

const DOC = 'doc-recovery-detail-retry';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x54]);

function samplePlan(): DocumentFileTransformPlan {
  return {
    policyId: 'business_document',
    mediaProfile: 'raster_image',
    hints: {
      metadataHandling: 'strip_nonessential',
      colorHandling: 'preserve',
      preferredOutputKind: 'preserve_source',
    },
    intents: [
      {
        targetKind: 'preview',
        intent: 'create_preview',
        executionIntent: 'preferred',
      },
      {
        targetKind: 'thumbnail',
        intent: 'create_thumbnail',
        executionIntent: 'preferred',
      },
      {
        targetKind: 'archive',
        intent: 'create_archive',
        executionIntent: 'preferred',
      },
    ],
  };
}

function sampleDocument(id: string, fileRefId: string): CompanyDocument {
  return withNewEntitySync(
    {
      id,
      title: `Document ${id}`,
      category: 'beleg',
      issuer: 'Test',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'belege', name: 'Belege', path: '/belege' },
      paperFolder: { folderId: 'belege', register: 'A', label: 'Belege' },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-07-20T00:00:00.000Z',
      fileRefId,
      mimeType: 'image/jpeg',
    },
    '2026-07-20T00:00:00.000Z',
  );
}

function putOutcome(input: {
  stepId: PostImportDerivativeStepId;
  kind: DocumentFileRepresentationBindingKind;
  outcome: DocumentFileDerivativeStepOutcomeKind;
  attempt?: number;
}): void {
  hydrateDocumentFileDerivativeStepOutcomeStore([
    createDocumentFileDerivativeStepOutcome({
      documentId: DOC,
      stepId: input.stepId,
      representationKind: input.kind,
      outcome: input.outcome,
      errorCode: input.outcome === 'error' ? 'orchestrator_error' : undefined,
      noopReason: input.outcome === 'noop' ? 'no_preview_intent' : undefined,
      registrationStatus: input.outcome === 'persisted' ? 'created' : undefined,
      resultFileRefId: input.outcome === 'persisted' ? 'file-missing' : undefined,
      sourceFileRefId: 'file-src',
      sourceMimeType: 'image/jpeg',
      createdFileRef: input.outcome === 'persisted',
      attempt: input.attempt ?? 1,
      updatedAt: '2026-07-20T18:00:00.000Z',
    }),
  ]);
}

function seedRecoveryPlan(): void {
  upsertDocumentFileDerivativeRecoveryContext({
    documentId: DOC,
    transformPlan: samplePlan(),
  });
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPanel(onRecovered?: () => void): Promise<{
  container: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(DocumentDerivativeRecoveryStatusPanel, {
        documentId: DOC,
        onRecovered,
      }),
    );
  });
  await flushUi();
  await vi.waitFor(() => {
    expect(
      container.querySelector(`[data-testid="document-derivative-recovery-status-${DOC}"]`),
    ).not.toBeNull();
  });
  return { container, root };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setPostImportDerivativeStepRunnersForTests(null);
  resetDocumentFileDerivativeStepInFlightLocksForTests();
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
  resetDocumentFileDerivativeStepOutcomeStoreForTests();
  resetDocumentFileDerivativeRecoveryContextStoreForTests();
  await resetDocumentBlobDatabaseForTests();
});

describe('STORAGE-DERIVATIVE-RECOVERY-DETAIL-RETRY-01', () => {
  it('retrybarer Fehler zeigt Button', async () => {
    putOutcome({ stepId: 'raster_preview', kind: 'preview', outcome: 'error' });
    seedRecoveryPlan();

    const { container, root } = await renderPanel();
    const button = container.querySelector(
      '[data-testid="document-derivative-recovery-retry-preview"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe('Erneut erstellen');
    expect(button.disabled).toBe(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Happy Path startet exakt den ausgewählten Step', async () => {
    putOutcome({ stepId: 'raster_preview', kind: 'preview', outcome: 'error' });
    seedRecoveryPlan();
    hydrateDocumentStore([sampleDocument(DOC, 'file-src')]);

    const planSpy = vi.spyOn(
      recoveryContextService,
      'getDocumentFileTransformPlanForDerivativeRetry',
    );
    const retrySpy = vi
      .spyOn(manualRetryService, 'retryDocumentFileDerivativeStep')
      .mockResolvedValue({
        kind: 'retried',
        outcome: createDocumentFileDerivativeStepOutcome({
          documentId: DOC,
          stepId: 'raster_preview',
          representationKind: 'preview',
          outcome: 'persisted',
          registrationStatus: 'created',
          resultFileRefId: 'file-preview-ok',
          sourceFileRefId: 'file-src',
          sourceMimeType: 'image/jpeg',
          createdFileRef: true,
          attempt: 2,
          updatedAt: '2026-07-20T19:00:00.000Z',
        }),
        orchestrationResult: { kind: 'persisted' },
      });

    const { container, root } = await renderPanel();
    const button = container.querySelector(
      '[data-testid="document-derivative-recovery-retry-preview"]',
    ) as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(retrySpy).toHaveBeenCalledTimes(1);
    });

    expect(planSpy).toHaveBeenCalledWith(DOC);
    expect(retrySpy.mock.calls[0]?.[0]).toMatchObject({
      documentId: DOC,
      stepId: 'raster_preview',
    });
    expect(retrySpy.mock.calls[0]?.[0]?.transformPlan).toEqual(samplePlan());

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('TransformPlan kommt ausschließlich aus dem Recovery-Context', async () => {
    const plan = samplePlan();
    const getPlan = vi
      .spyOn(recoveryContextService, 'getDocumentFileTransformPlanForDerivativeRetry')
      .mockReturnValue(plan);
    const retrySpy = vi
      .spyOn(manualRetryService, 'retryDocumentFileDerivativeStep')
      .mockResolvedValue({
        kind: 'retried',
        outcome: null,
        orchestrationResult: null,
      });

    await executeDocumentFileDerivativeRecoveryDetailRetry({
      documentId: DOC,
      selectedStepId: 'raster_preview',
    });

    expect(getPlan).toHaveBeenCalledTimes(1);
    expect(getPlan).toHaveBeenCalledWith(DOC);
    expect(retrySpy).toHaveBeenCalledWith({
      documentId: DOC,
      stepId: 'raster_preview',
      transformPlan: plan,
    });
  });

  it('fehlender Plan startet keinen Retry', async () => {
    vi.spyOn(
      recoveryContextService,
      'getDocumentFileTransformPlanForDerivativeRetry',
    ).mockReturnValue(null);
    const retrySpy = vi.spyOn(manualRetryService, 'retryDocumentFileDerivativeStep');

    const result = await executeDocumentFileDerivativeRecoveryDetailRetry({
      documentId: DOC,
      selectedStepId: 'raster_preview',
    });

    expect(result).toEqual({ feedback: 'missing_plan', shouldRefreshPreview: false });
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it('Doppelklick startet nur einen Aufruf', async () => {
    putOutcome({ stepId: 'raster_preview', kind: 'preview', outcome: 'error' });
    seedRecoveryPlan();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retrySpy = vi
      .spyOn(manualRetryService, 'retryDocumentFileDerivativeStep')
      .mockImplementation(async () => {
        await gate;
        return {
          kind: 'retried',
          outcome: createDocumentFileDerivativeStepOutcome({
            documentId: DOC,
            stepId: 'raster_preview',
            representationKind: 'preview',
            outcome: 'error',
            errorCode: 'orchestrator_error',
            sourceFileRefId: 'file-src',
            sourceMimeType: 'image/jpeg',
            createdFileRef: false,
            attempt: 2,
            updatedAt: '2026-07-20T19:00:00.000Z',
          }),
          orchestrationResult: null,
        };
      });

    const { container, root } = await renderPanel();
    const button = container.querySelector(
      '[data-testid="document-derivative-recovery-retry-preview"]',
    ) as HTMLButtonElement;

    await act(async () => {
      button.click();
      button.click();
      button.click();
    });
    await flushUi();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Wird erstellt…');

    await act(async () => {
      release();
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(button.textContent).toBe('Erneut fehlgeschlagen');
    });

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('in_flight wird verständlich dargestellt', async () => {
    putOutcome({ stepId: 'raster_preview', kind: 'preview', outcome: 'error' });
    seedRecoveryPlan();
    vi.spyOn(manualRetryService, 'retryDocumentFileDerivativeStep').mockResolvedValue({
      kind: 'rejected',
      reason: 'in_flight',
    });

    const { container, root } = await renderPanel();
    const button = container.querySelector(
      '[data-testid="document-derivative-recovery-retry-preview"]',
    ) as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(button.textContent).toBe('Wird bereits ausgeführt');
    });
    expect(button.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('erfolgreicher Retry entfernt die Problemzeile', async () => {
    const preview = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'preview.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG.byteLength,
        bytes: JPEG,
      },
      { lifecycleIntent: 'committed' },
    );
    putOutcome({ stepId: 'raster_preview', kind: 'preview', outcome: 'error' });
    seedRecoveryPlan();
    hydrateDocumentStore([sampleDocument(DOC, 'file-src')]);

    vi.spyOn(manualRetryService, 'retryDocumentFileDerivativeStep').mockImplementation(
      async () => {
        hydrateDocumentFileRepresentationBindingStore([
          createDocumentFileRepresentationBinding({
            documentId: DOC,
            kind: 'preview',
            fileRefId: preview.fileRef.id,
          }),
        ]);
        hydrateDocumentFileDerivativeStepOutcomeStore([
          createDocumentFileDerivativeStepOutcome({
            documentId: DOC,
            stepId: 'raster_preview',
            representationKind: 'preview',
            outcome: 'persisted',
            registrationStatus: 'created',
            resultFileRefId: preview.fileRef.id,
            sourceFileRefId: 'file-src',
            sourceMimeType: 'image/jpeg',
            createdFileRef: true,
            attempt: 2,
            updatedAt: '2026-07-20T19:00:00.000Z',
          }),
        ]);
        return {
          kind: 'retried',
          outcome: createDocumentFileDerivativeStepOutcome({
            documentId: DOC,
            stepId: 'raster_preview',
            representationKind: 'preview',
            outcome: 'persisted',
            registrationStatus: 'created',
            resultFileRefId: preview.fileRef.id,
            sourceFileRefId: 'file-src',
            sourceMimeType: 'image/jpeg',
            createdFileRef: true,
            attempt: 2,
            updatedAt: '2026-07-20T19:00:00.000Z',
          }),
          orchestrationResult: { kind: 'persisted' },
        };
      },
    );

    const { container, root } = await renderPanel();
    const button = container.querySelector(
      '[data-testid="document-derivative-recovery-retry-preview"]',
    ) as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="document-derivative-recovery-status-${DOC}"]`,
        ),
      ).toBeNull();
    });

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Preview wird nach Erfolg neu geladen', async () => {
    const first = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'preview-a.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG.byteLength,
        bytes: JPEG,
      },
      { lifecycleIntent: 'committed' },
    );
    const second = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'preview-b.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG.byteLength,
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x55]),
      },
      { lifecycleIntent: 'committed' },
    );
    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: DOC,
        kind: 'preview',
        fileRefId: first.fileRef.id,
      }),
    ]);

    function PreviewHarness() {
      const [revision, setRevision] = useState(0);
      return createElement(
        'div',
        null,
        createElement(DocumentDetailPreview, { documentId: DOC, revision }),
        createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'bump-preview-revision',
            onClick: () => {
              hydrateDocumentFileRepresentationBindingStore([
                createDocumentFileRepresentationBinding({
                  documentId: DOC,
                  kind: 'preview',
                  fileRefId: second.fileRef.id,
                }),
              ]);
              setRevision((value) => value + 1);
            },
          },
          'bump',
        ),
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(PreviewHarness));
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(
        container.querySelector(`[data-testid="document-detail-preview-image-${DOC}"]`),
      ).not.toBeNull();
    });
    const imgBefore = container.querySelector(
      `[data-testid="document-detail-preview-image-${DOC}"]`,
    ) as HTMLImageElement;
    const urlBefore = imgBefore.src;

    await act(async () => {
      (
        container.querySelector('[data-testid="bump-preview-revision"]') as HTMLButtonElement
      ).click();
    });
    await flushUi();
    await vi.waitFor(() => {
      const img = container.querySelector(
        `[data-testid="document-detail-preview-image-${DOC}"]`,
      ) as HTMLImageElement;
      expect(img.src).not.toBe(urlBefore);
    });

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('fehlgeschlagener Retry bleibt sichtbar und zeigt Fehlstatus', async () => {
    putOutcome({ stepId: 'raster_preview', kind: 'preview', outcome: 'error', attempt: 1 });
    seedRecoveryPlan();
    hydrateDocumentStore([sampleDocument(DOC, 'file-src')]);
    setPostImportDerivativeStepRunnersForTests({
      raster_preview: async () => ({
        kind: 'error',
        errorCode: 'orchestrator_error',
      }),
    });

    const { container, root } = await renderPanel();
    const button = container.querySelector(
      '[data-testid="document-derivative-recovery-retry-preview"]',
    ) as HTMLButtonElement;

    await act(async () => {
      button.click();
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(button.textContent).toBe('Erneut fehlgeschlagen');
    });

    const row = container.querySelector(
      '[data-testid="document-derivative-recovery-problem-preview"]',
    );
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-status')).toBe('error');
    expect(container.textContent).not.toMatch(/raster_preview|orchestrator_error/);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('exhausted/conflict/noop zeigen keinen Button', async () => {
    const cases: Array<{
      stepId: PostImportDerivativeStepId;
      kind: DocumentFileRepresentationBindingKind;
      outcome: DocumentFileDerivativeStepOutcomeKind;
      attempt?: number;
      expectPanel: boolean;
    }> = [
      {
        stepId: 'raster_preview',
        kind: 'preview',
        outcome: 'error',
        attempt: 5,
        expectPanel: true,
      },
      {
        stepId: 'raster_preview',
        kind: 'preview',
        outcome: 'conflict',
        expectPanel: true,
      },
      {
        stepId: 'raster_preview',
        kind: 'preview',
        outcome: 'noop',
        expectPanel: false,
      },
    ];

    for (const entry of cases) {
      resetDocumentFileDerivativeStepOutcomeStoreForTests();
      resetDocumentFileDerivativeRecoveryContextStoreForTests();
      putOutcome({
        stepId: entry.stepId,
        kind: entry.kind,
        outcome: entry.outcome,
        attempt: entry.attempt,
      });
      seedRecoveryPlan();

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          createElement(DocumentDerivativeRecoveryStatusPanel, { documentId: DOC }),
        );
      });
      await flushUi();

      if (entry.expectPanel) {
        await vi.waitFor(() => {
          expect(
            container.querySelector(
              `[data-testid="document-derivative-recovery-status-${DOC}"]`,
            ),
          ).not.toBeNull();
        });
        expect(
          container.querySelector(
            '[data-testid="document-derivative-recovery-retry-preview"]',
          ),
        ).toBeNull();
      } else {
        expect(
          container.querySelector(
            `[data-testid="document-derivative-recovery-status-${DOC}"]`,
          ),
        ).toBeNull();
      }

      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('Service-Lock ist zweite Absicherung (in_flight)', async () => {
    putOutcome({ stepId: 'raster_preview', kind: 'preview', outcome: 'error' });
    seedRecoveryPlan();
    tryAcquireDocumentFileDerivativeStepInFlightLock(DOC, 'raster_preview');

    const result = await executeDocumentFileDerivativeRecoveryDetailRetry({
      documentId: DOC,
      selectedStepId: 'raster_preview',
    });

    expect(result.feedback).toBe('in_flight');
    releaseDocumentFileDerivativeStepInFlightLock(DOC, 'raster_preview');
  });

  it('onRecovered wird nach Erfolg aufgerufen', async () => {
    putOutcome({ stepId: 'raster_preview', kind: 'preview', outcome: 'error' });
    seedRecoveryPlan();
    const onRecovered = vi.fn();
    vi.spyOn(manualRetryService, 'retryDocumentFileDerivativeStep').mockResolvedValue({
      kind: 'skipped',
      reason: 'already_ready',
    });

    const { container, root } = await renderPanel(onRecovered);
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-derivative-recovery-retry-preview"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    await vi.waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
