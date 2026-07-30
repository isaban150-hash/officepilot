import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  createSeedState,
} from './services/persistenceService';
import {
  buildTransformPlanImportBundleFromIntakeCarry,
  getDocumentFileIntakeTransformPlanCarryContext,
  persistDocumentFileIntakeTransformPlanCarryContextAfterConfirm,
  resolveImportInboxDocumentOptionsFromIntakeCarry,
  upsertDocumentFileIntakeTransformPlanCarryContext,
} from './services/documentFileIntakeTransformPlanCarryContextService';
import {
  getDocumentFileIntakeTransformPlanCarryContextStoreSnapshot,
  resetDocumentFileIntakeTransformPlanCarryContextStoreForTests,
} from './services/documentFileIntakeTransformPlanCarryContextStoreService';
import { DOCUMENT_FILE_INTAKE_TRANSFORM_PLAN_CARRY_SCHEMA_VERSION } from './types/documentFileIntakeTransformPlanCarryContext';
import * as representationPlanService from './services/documentFileRepresentationPlanService';
import * as transformPlanService from './services/documentFileTransformPlanService';
import {
  confirmPendingDocumentIntake,
  discardPendingDocumentIntake,
  processDocumentFileForPreview,
} from './services/pendingDocumentIntakeService';
import {
  confirmDispose,
  hydrateInboxStore,
  removeStagedInboxItemById,
} from './services/inboxService';
import { importInboxDocument } from './services/documentService';
import { executeSmartIntake } from './services/intakeExecutionService';
import { archiveMailInboxItem } from './services/mailImportService';
import { getDocumentFileDerivativeRecoveryContext } from './services/documentFileDerivativeRecoveryContextService';
import * as postImportOrch from './services/documentFilePostImportDerivativeOrchestrationService';
import * as documentService from './services/documentService';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import {
  resetDocumentFileStoreForTests,
} from './services/documentFileStoreService';
import { setPdfTextExtractorForTests } from './services/uploadTextExtractionService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { confirmFilingDecisionForTests, importInboxDocumentForTests, archiveMailInboxItemForTests } from './test/confirmFilingDecisionForTests';
import { withNewEntitySync } from './services/sync/syncMetaService';
import type { WorkflowResult } from './types/models';

afterEach(async () => {
  vi.restoreAllMocks();
  setPdfTextExtractorForTests(null);
  setImageOcrExtractorForTests(null);
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileIntakeTransformPlanCarryContextStoreForTests();
});

describe('STORAGE-DERIVATIVE-INTAKE-PLAN-CONTEXT-CARRY-01', () => {
  it('bestätigter Upload/Scan trägt exakten Context', async () => {
    setPdfTextExtractorForTests(() => 'Rechnung Muster GmbH 1.250,00 EUR netto');
    const file = new File(
      [new TextEncoder().encode('%PDF-1.4\nrechnung\n%%EOF')],
      'rechnung.pdf',
      { type: 'application/pdf' },
    );
    const preview = await processDocumentFileForPreview(file);
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const confirmed = await confirmPendingDocumentIntake(preview.pending, {
      userDecision: 'save_permanently',
    });
    expect(confirmed.success).toBe(true);
    if (!confirmed.success || confirmed.duplicate) return;

    const carry = getDocumentFileIntakeTransformPlanCarryContext(confirmed.inboxItem.id);
    expect(carry).toMatchObject({
      inboxItemId: confirmed.inboxItem.id,
      policyId: preview.pending.storagePolicy.policyId,
      userDecision: 'save_permanently',
      mediaProfile: preview.pending.storagePolicy.mediaProfile,
      schemaVersion: DOCUMENT_FILE_INTAKE_TRANSFORM_PLAN_CARRY_SCHEMA_VERSION,
    });
    expect(typeof carry?.capturedAt).toBe('string');

    discardPendingDocumentIntake(preview.pending);
  });

  it('zentraler Helper nutzt ausschließlich bestehende Builder', () => {
    upsertDocumentFileIntakeTransformPlanCarryContext({
      inboxItemId: 'inbox-carry-builder',
      policyId: 'business_document',
      userDecision: 'save_permanently',
      mediaProfile: 'native_pdf',
    });

    const repSpy = vi.spyOn(representationPlanService, 'buildDocumentFileRepresentationPlan');
    const transformSpy = vi.spyOn(transformPlanService, 'buildDocumentFileTransformPlan');

    const bundle = buildTransformPlanImportBundleFromIntakeCarry('inbox-carry-builder');
    expect(bundle).not.toBeNull();
    expect(repSpy).toHaveBeenCalledTimes(1);
    expect(repSpy).toHaveBeenCalledWith({
      policyId: 'business_document',
      decision: 'save_permanently',
    });
    expect(transformSpy).toHaveBeenCalledTimes(1);
    expect(transformSpy.mock.calls[0]?.[0]).toMatchObject({
      mediaProfile: 'native_pdf',
    });
    expect(bundle?.transformPlanOrigin).toEqual({
      policyId: 'business_document',
      decision: 'save_permanently',
      mediaProfile: 'native_pdf',
    });
  });

  it('manueller Import übergibt Plan + Origin wenn Context vorhanden', () => {
    const item = createAuftragInboxItem({ id: 'inbox-carry-manual' });
    hydrateInboxStore([item]);
    upsertDocumentFileIntakeTransformPlanCarryContext({
      inboxItemId: item.id,
      policyId: 'business_document',
      userDecision: 'save_permanently',
      mediaProfile: 'raster_image',
    });

    const orchSpy = vi
      .spyOn(postImportOrch, 'orchestratePostImportDerivativesAfterImport')
      .mockResolvedValue({ kind: 'completed', steps: [] });

    const imported = importInboxDocumentForTests(
      item,
      'Test GmbH',
      resolveImportInboxDocumentOptionsFromIntakeCarry(item.id),
    );
    expect(imported.success).toBe(true);
    expect(orchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: imported.document!.id,
        transformPlan: expect.objectContaining({
          policyId: 'business_document',
          mediaProfile: 'raster_image',
        }),
      }),
    );
    expect(
      getDocumentFileDerivativeRecoveryContext(imported.document!.id)?.origin,
    ).toEqual({
      policyId: 'business_document',
      decision: 'save_permanently',
      mediaProfile: 'raster_image',
    });
  });

  it('Smart-Intake-Import übergibt Plan + Origin wenn Context vorhanden', () => {
    hydrateCompanyProfileStore({
      companyName: 'Test GmbH',
      legalForm: 'GmbH',
      street: 'Test',
      zip: '10115',
      city: 'Berlin',
      country: 'Deutschland',
      contactPerson: 'Test',
      phone: '030',
      email: 'test@test.de',
      website: '',
      taxNumber: '',
      vatId: '',
      bankName: '',
      iban: '',
      bic: '',
      defaultPaymentDays: 14,
      defaultPaymentTerms: '14 Tage',
      defaultSkonto: '',
      invoiceFooterNotes: '',
    });

    const item = createAuftragInboxItem({
      id: 'inbox-carry-smart',
      title: 'Angebot Test GmbH Sanierung',
      classifiedKind: 'angebot',
    });
    hydrateInboxStore([item]);
    upsertDocumentFileIntakeTransformPlanCarryContext({
      inboxItemId: item.id,
      policyId: 'business_document',
      userDecision: 'save_permanently',
      mediaProfile: 'native_pdf',
    });

    vi.spyOn(postImportOrch, 'orchestratePostImportDerivativesAfterImport').mockResolvedValue({
      kind: 'completed',
      steps: [],
    });
    const importSpy = vi.spyOn(documentService, 'importInboxDocument');

    const workflow = {
      inboxItemId: item.id,
      companyRelevant: true,
      companyRelevance: {
        isRelevant: true,
        reasons: [],
        matchedHints: [],
      },
      classifiedKind: 'angebot',
      classificationConfidence: 'high',
      classification: null,
      documentExplanation: null,
      documentUnderstanding: null,
      documentAiActions: [],
      contractAnalysis: null,
      contractIntelligence: null,
      contractOrderProposal: null,
      suggestedVorgang: null,
      similarVorgaenge: [],
      suggestedOrderPositions: [],
      suggestedTasks: [],
      suggestedArchiveFolder: { id: 'angebote', name: 'Angebote', path: '/angebote' },
      requiredDocuments: [],
      pendingSummary: null,
      warnings: [],
      nextActions: [],
    } as WorkflowResult;

    confirmFilingDecisionForTests(item.id);
    const result = executeSmartIntake(workflow, {
      companyName: 'Test GmbH',
    });
    expect(result.successSteps).toContain('archive_document');
    expect(importSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: item.id }),
      'Test GmbH',
      expect.objectContaining({
        transformPlan: expect.objectContaining({
          policyId: 'business_document',
          mediaProfile: 'native_pdf',
        }),
        transformPlanOrigin: expect.objectContaining({
          policyId: 'business_document',
          decision: 'save_permanently',
          mediaProfile: 'native_pdf',
        }),
      }),
    );
  });

  it('Import mit Context erzeugt Recovery-Context', () => {
    const item = createAuftragInboxItem({ id: 'inbox-carry-recovery' });
    hydrateInboxStore([item]);
    const options = (() => {
      upsertDocumentFileIntakeTransformPlanCarryContext({
        inboxItemId: item.id,
        policyId: 'receipt',
        userDecision: 'save_permanently',
        mediaProfile: 'raster_image',
      });
      return resolveImportInboxDocumentOptionsFromIntakeCarry(item.id);
    })();

    vi.spyOn(postImportOrch, 'orchestratePostImportDerivativesAfterImport').mockResolvedValue({
      kind: 'completed',
      steps: [],
    });

    const imported = importInboxDocumentForTests(item, 'Test GmbH', options);
    expect(imported.success).toBe(true);
    const recovery = getDocumentFileDerivativeRecoveryContext(imported.document!.id);
    expect(recovery?.transformPlan.policyId).toBe('receipt');
    expect(recovery?.origin).toEqual({
      policyId: 'receipt',
      decision: 'save_permanently',
      mediaProfile: 'raster_image',
    });
  });

  it('Import ohne Context bleibt planlos', () => {
    const item = createAuftragInboxItem({ id: 'inbox-carry-none' });
    hydrateInboxStore([item]);
    const orchSpy = vi
      .spyOn(postImportOrch, 'orchestratePostImportDerivativesAfterImport')
      .mockResolvedValue({ kind: 'completed', steps: [] });

    const imported = importInboxDocumentForTests(
      item,
      'Test GmbH',
      resolveImportInboxDocumentOptionsFromIntakeCarry(item.id),
    );
    expect(imported.success).toBe(true);
    expect(orchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        transformPlan: undefined,
      }),
    );
    expect(getDocumentFileDerivativeRecoveryContext(imported.document!.id)).toBeNull();
  });

  it('Mail ohne Context wird nicht geraten', () => {
    const item = createAuftragInboxItem({ id: 'inbox-carry-mail' });
    hydrateInboxStore([item]);
    const orchSpy = vi
      .spyOn(postImportOrch, 'orchestratePostImportDerivativesAfterImport')
      .mockResolvedValue({ kind: 'completed', steps: [] });

    const documentId = archiveMailInboxItemForTests(item, 'Test GmbH');
    expect(documentId).toBeTruthy();
    expect(orchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        transformPlan: undefined,
      }),
    );
  });

  it('alter Persistenzstand ohne Carry-Feld bleibt kompatibel', () => {
    const seed = createSeedState();
    const { documentFileIntakeTransformPlanCarryContexts: _omit, ...legacy } = seed;
    applyStateToStores(legacy as typeof seed);
    expect(getDocumentFileIntakeTransformPlanCarryContextStoreSnapshot()).toEqual([]);
    expect(buildPersistedStateSnapshot().documentFileIntakeTransformPlanCarryContexts).toEqual(
      [],
    );
  });

  it('Cleanup bei Inbox-Löschung und Verwerfung', () => {
    const removable = createAuftragInboxItem({ id: 'inbox-carry-remove' });
    hydrateInboxStore([removable]);
    upsertDocumentFileIntakeTransformPlanCarryContext({
      inboxItemId: removable.id,
      policyId: 'business_document',
      userDecision: 'save_permanently',
      mediaProfile: 'native_pdf',
    });
    expect(removeStagedInboxItemById(removable.id)).toBe(true);
    expect(getDocumentFileIntakeTransformPlanCarryContext(removable.id)).toBeNull();

    const ad = withNewEntitySync(
      {
        ...createAuftragInboxItem({ id: 'inbox-carry-dispose' }),
        isAdvertisement: true,
        recommendedAction: 'entsorgen' as const,
      },
      'inbox_item',
    );
    hydrateInboxStore([ad]);
    persistDocumentFileIntakeTransformPlanCarryContextAfterConfirm({
      inboxItemId: ad.id,
      policyId: 'temporary_unknown',
      userDecision: 'save_permanently',
      mediaProfile: 'raster_image',
    });
    expect(confirmDispose(ad.id)?.success).toBe(true);
    expect(getDocumentFileIntakeTransformPlanCarryContext(ad.id)).toBeNull();
  });

  it('defensive Kopien verhindern Mutation', () => {
    const created = upsertDocumentFileIntakeTransformPlanCarryContext({
      inboxItemId: 'inbox-carry-mutate',
      policyId: 'business_document',
      userDecision: 'save_permanently',
      mediaProfile: 'native_pdf',
    });
    expect(Object.isFrozen(created)).toBe(true);

    const again = getDocumentFileIntakeTransformPlanCarryContext('inbox-carry-mutate');
    const third = getDocumentFileIntakeTransformPlanCarryContext('inbox-carry-mutate');
    expect(again).toEqual(third);
    expect(again).not.toBe(third);

    const bundleA = buildTransformPlanImportBundleFromIntakeCarry('inbox-carry-mutate');
    const bundleB = buildTransformPlanImportBundleFromIntakeCarry('inbox-carry-mutate');
    expect(bundleA?.transformPlan).toEqual(bundleB?.transformPlan);
    expect(bundleA?.transformPlan).not.toBe(bundleB?.transformPlan);
  });
});
