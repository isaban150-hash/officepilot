import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  createSeedState,
} from './services/persistenceService';
import {
  getDocumentFileDerivativeRecoveryContext,
  getDocumentFileTransformPlanForDerivativeRetry,
  upsertDocumentFileDerivativeRecoveryContext,
} from './services/documentFileDerivativeRecoveryContextService';
import {
  getDocumentFileDerivativeRecoveryContextStoreSnapshot,
  resetDocumentFileDerivativeRecoveryContextStoreForTests,
} from './services/documentFileDerivativeRecoveryContextStoreService';
import { DOCUMENT_FILE_DERIVATIVE_RECOVERY_CONTEXT_SCHEMA_VERSION } from './types/documentFileDerivativeRecoveryContext';
import { deleteDocument, importInboxDocument } from './services/documentService';
import { resetDocumentFileStoreForTests } from './services/documentFileStoreService';
import { hydrateInboxStore } from './services/inboxService';
import { createAuftragInboxItem } from './test/fixtures';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';

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
        targetKind: 'archive',
        intent: 'create_archive',
        executionIntent: 'preferred',
      },
      {
        targetKind: 'preview',
        intent: 'create_preview',
        executionIntent: 'preferred',
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetDocumentFileStoreForTests();
  resetDocumentFileDerivativeRecoveryContextStoreForTests();
});

describe('STORAGE-DERIVATIVE-RECOVERY-CONTEXT-01', () => {
  it('persistiert Context mit exaktem Plan und hydratisiert ihn', () => {
    const plan = samplePlan();
    upsertDocumentFileDerivativeRecoveryContext({
      documentId: 'doc-recovery-a',
      transformPlan: plan,
      origin: {
        policyId: 'business_document',
        decision: 'save_permanently',
        mediaProfile: 'raster_image',
      },
    });

    const snapshot = buildPersistedStateSnapshot();
    expect(snapshot.documentFileDerivativeRecoveryContexts).toHaveLength(1);

    resetDocumentFileDerivativeRecoveryContextStoreForTests();
    expect(getDocumentFileDerivativeRecoveryContextStoreSnapshot()).toEqual([]);

    applyStateToStores(snapshot);
    const restored = getDocumentFileDerivativeRecoveryContext('doc-recovery-a');
    expect(restored).toMatchObject({
      documentId: 'doc-recovery-a',
      schemaVersion: DOCUMENT_FILE_DERIVATIVE_RECOVERY_CONTEXT_SCHEMA_VERSION,
      origin: {
        policyId: 'business_document',
        decision: 'save_permanently',
        mediaProfile: 'raster_image',
      },
    });
    expect(restored?.transformPlan).toEqual(plan);
    expect(typeof restored?.capturedAt).toBe('string');
  });

  it('defensive Kopien verhindern externe Mutation', () => {
    const plan = samplePlan();
    upsertDocumentFileDerivativeRecoveryContext({
      documentId: 'doc-recovery-mutate',
      transformPlan: plan,
    });

    plan.policyId = 'receipt';
    plan.hints.metadataHandling = 'preserve';
    plan.intents.push({
      targetKind: 'thumbnail',
      intent: 'create_thumbnail',
      executionIntent: 'preferred',
    });

    const stored = getDocumentFileDerivativeRecoveryContext('doc-recovery-mutate');
    expect(stored?.transformPlan.policyId).toBe('business_document');
    expect(stored?.transformPlan.hints.metadataHandling).toBe('strip_nonessential');
    expect(stored?.transformPlan.intents).toHaveLength(2);

    const forRetry = getDocumentFileTransformPlanForDerivativeRetry('doc-recovery-mutate');
    const again = getDocumentFileTransformPlanForDerivativeRetry('doc-recovery-mutate');
    expect(forRetry).toEqual(again);
    expect(forRetry).not.toBe(again);
    expect(Object.isFrozen(forRetry)).toBe(true);
    expect(Object.isFrozen(forRetry?.hints)).toBe(true);
  });

  it('erneutes Schreiben aktualisiert statt zu duplizieren', () => {
    upsertDocumentFileDerivativeRecoveryContext({
      documentId: 'doc-recovery-upsert',
      transformPlan: samplePlan(),
    });
    const secondPlan: DocumentFileTransformPlan = {
      ...samplePlan(),
      policyId: 'receipt',
      mediaProfile: 'raster_image',
      hints: {
        metadataHandling: 'preserve',
        colorHandling: 'preserve',
        preferredOutputKind: 'pdf_preferred',
      },
    };
    upsertDocumentFileDerivativeRecoveryContext({
      documentId: 'doc-recovery-upsert',
      transformPlan: secondPlan,
    });

    const all = getDocumentFileDerivativeRecoveryContextStoreSnapshot();
    expect(all).toHaveLength(1);
    expect(all[0]?.transformPlan.policyId).toBe('receipt');
    expect(all[0]?.transformPlan.hints.preferredOutputKind).toBe('pdf_preferred');
  });

  it('Import ohne TransformPlan erzeugt keinen Context', () => {
    const item = createAuftragInboxItem({ id: 'inbox-recovery-no-plan' });
    hydrateInboxStore([item]);
    const imported = importInboxDocumentForTests(item, 'Test GmbH');
    expect(imported.success).toBe(true);
    expect(getDocumentFileDerivativeRecoveryContextStoreSnapshot()).toEqual([]);
    expect(
      getDocumentFileTransformPlanForDerivativeRetry(imported.document!.id),
    ).toBeNull();
  });

  it('Import mit TransformPlan schreibt Context vor Derived-Coordinator', () => {
    const item = createAuftragInboxItem({ id: 'inbox-recovery-with-plan' });
    hydrateInboxStore([item]);
    const plan = samplePlan();
    const imported = importInboxDocumentForTests(item, 'Test GmbH', {
      transformPlan: plan,
      transformPlanOrigin: {
        policyId: 'business_document',
        decision: 'save_permanently',
        mediaProfile: 'raster_image',
      },
    });
    expect(imported.success).toBe(true);

    const context = getDocumentFileDerivativeRecoveryContext(imported.document!.id);
    expect(context?.transformPlan).toEqual(plan);
    expect(context?.origin?.decision).toBe('save_permanently');
    expect(getDocumentFileTransformPlanForDerivativeRetry(imported.document!.id)).toEqual(
      plan,
    );
  });

  it('alter Persistenzstand ohne Context-Feld bleibt kompatibel', () => {
    const seed = createSeedState();
    const { documentFileDerivativeRecoveryContexts: _omit, ...legacy } = seed;
    applyStateToStores(legacy as typeof seed);
    expect(getDocumentFileDerivativeRecoveryContextStoreSnapshot()).toEqual([]);
    expect(buildPersistedStateSnapshot().documentFileDerivativeRecoveryContexts).toEqual([]);
  });

  it('Dokumentlöschung entfernt Context', () => {
    const item = createAuftragInboxItem({ id: 'inbox-recovery-delete' });
    hydrateInboxStore([item]);
    const imported = importInboxDocumentForTests(item, 'Test GmbH', {
      transformPlan: samplePlan(),
    });
    expect(imported.success).toBe(true);
    const documentId = imported.document!.id;
    expect(getDocumentFileDerivativeRecoveryContext(documentId)).not.toBeNull();

    expect(deleteDocument(documentId).success).toBe(true);
    expect(getDocumentFileDerivativeRecoveryContext(documentId)).toBeNull();
  });

  it('Reset leert den Store', () => {
    upsertDocumentFileDerivativeRecoveryContext({
      documentId: 'doc-recovery-reset',
      transformPlan: samplePlan(),
    });
    resetDocumentFileDerivativeRecoveryContextStoreForTests();
    expect(getDocumentFileDerivativeRecoveryContextStoreSnapshot()).toEqual([]);
  });

  it('enthält keine sensitiven Daten im Context', () => {
    upsertDocumentFileDerivativeRecoveryContext({
      documentId: 'doc-recovery-safe',
      transformPlan: samplePlan(),
    });
    const serialized = JSON.stringify(getDocumentFileDerivativeRecoveryContextStoreSnapshot());
    expect(serialized).not.toMatch(/filename|\.pdf|\.jpg|bytes|stack|Error:/i);
    expect(serialized).toContain('transformPlan');
    expect(serialized).toContain('schemaVersion');
  });
});
