import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OcrPreviewPanel } from './components/scan/OcrPreviewPanel';
import { t, type TranslationKey } from './i18n';
import { SAMPLE_WERKVERTRAG_TEXT } from './services/contractAnalysisService';
import {
  hydrateCompanyProfileStore,
  resetCompanyProfile,
} from './services/companyProfileService';
import {
  buildPendingDocumentDecisionActions,
  isOcrStorageFastPathAllowedForPending,
} from './services/pendingDocumentDecisionService';
import type { PendingDocumentIntake } from './services/pendingDocumentIntakeService';
import {
  applyOcrFastPathPrimaryLabels,
  buildStorageDecisionActionSpecs,
  isOcrStorageFastPathLevel,
  resolveOcrFastPathPrimaryLabelKey,
} from './services/userStorageDecisionPresentationService';
import {
  resolveAvailableUserStorageDecisions,
  resolvePrimarySuggestedUserStorageDecision,
} from './services/userStorageDecisionService';
import type { DocumentClassificationResult } from './types/models';
import type { StorageRecommendation, StorageRecommendationLevel } from './types/storageRecommendation';
import type { UserStorageDecision } from './types/userStorageDecision';

const COMPANY_NAME = 'Mustermann Sanitär GmbH';

function createRecommendation(
  level: StorageRecommendationLevel,
  extras: Partial<StorageRecommendation> = {},
): StorageRecommendation {
  return {
    level,
    reasonKeys: ['storageRecommendation.reason.businessDocument'],
    evidenceRefs: [],
    requiresUserConfirmation: true,
    confidence: 0.42,
    computedAt: '2026-07-26T12:00:00.000Z',
    ...extras,
  };
}

function createPreviewClassification(
  overrides: Partial<DocumentClassificationResult> = {},
): DocumentClassificationResult {
  return {
    classifiedKind: 'rechnung',
    documentType: 'eingangsrechnung',
    processType: 'record_expense',
    detectionReasonKey: 'classification.detect.invoice',
    title: 'Rechnung',
    sender: 'Lieferant',
    explanation: 'Preview',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'archivieren',
    digitalFolder: { id: 'dig-1', name: 'Rechnungen', path: '/rechnungen/' },
    paperFiling: { folderId: 'folder-1', register: 'R', label: 'Rechnung' },
    recognizedData: { Dokumentart: 'rechnung' },
    officePilotSuggestion: 'Preview',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Test',
    actions: [],
    ...overrides,
  };
}

function createPending(
  level: StorageRecommendationLevel,
  options: {
    recognizedText?: string;
    classification?: Partial<DocumentClassificationResult>;
  } = {},
): PendingDocumentIntake {
  const recognizedText =
    options.recognizedText ?? `Rechnung an ${COMPANY_NAME}\nBetrag: 120,00 EUR`;

  return {
    cachedFile: {
      fileName: 'rechnung.pdf',
      mimeType: 'application/pdf',
      fileSize: 12,
      bytes: new Uint8Array([1, 2, 3]),
    },
    extraction: {
      recognizedText,
      displayText: recognizedText.slice(0, 80),
      confidence: 'high',
      sourceType: 'pdf',
      extractionMethod: 'pdf_direct',
    },
    preview: {
      documentTypeLabelKey: 'classifiedKind.rechnung',
      previewLines: [recognizedText.split('\n')[0] ?? 'Rechnung'],
      previewPartialHint: false,
    },
    previewClassification: createPreviewClassification(options.classification),
    storageRecommendation: createRecommendation(level, {
      duplicateMatch:
        level === 'duplicate_detected'
          ? { type: 'document', id: 'doc-existing', title: 'Bestehende Rechnung' }
          : undefined,
    }),
    storagePolicy: {
      policyId: 'receipt',
      catalogPolicyId: 'receipt',
      mediaProfile: 'native_pdf',
      classifiedKind: 'rechnung',
      policyOverrideApplied: false,
    },
  };
}

function translate(key: TranslationKey) {
  return t(key, 'de');
}

type Mount = { container: HTMLDivElement; root: Root; onDecision: ReturnType<typeof vi.fn> };

function mountPreview(
  level: StorageRecommendationLevel,
  pending = createPending(level),
  actions = buildPendingDocumentDecisionActions(pending),
): Mount {
  const onDecision = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <OcrPreviewPanel
        fileName={pending.cachedFile.fileName}
        extraction={pending.extraction}
        preview={pending.preview}
        storageRecommendation={pending.storageRecommendation}
        decisionActions={actions}
        documentTypeLabel="Art"
        senderLabel="Absender"
        previewTextLabel="Text"
        aiActionsLabel="Aktionen"
        translate={translate}
        onDecision={onDecision}
      />,
    );
  });
  return { container, root, onDecision };
}

function unmount(mount: Mount) {
  act(() => {
    mount.root.unmount();
  });
  mount.container.remove();
}

function primaryButtons(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll('[data-ocr-fast-path-primary="true"]'),
  ) as HTMLButtonElement[];
}

describe('DOC-WF-03B — OCR Fast Path', () => {
  beforeEach(() => {
    hydrateCompanyProfileStore({ companyName: COMPANY_NAME });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    resetCompanyProfile();
  });

  it('markiert nur eindeutige Storage-Levels als Fast-Path-Kandidaten', () => {
    expect(isOcrStorageFastPathLevel('archive_required')).toBe(true);
    expect(isOcrStorageFastPathLevel('archive_recommended')).toBe(true);
    expect(isOcrStorageFastPathLevel('duplicate_detected')).toBe(true);
    expect(isOcrStorageFastPathLevel('discard_recommended')).toBe(true);
    expect(isOcrStorageFastPathLevel('review_required')).toBe(false);
    expect(isOcrStorageFastPathLevel('temporary_only')).toBe(false);
  });

  it('archive_required: Primary „Empfehlung übernehmen“ führt save_permanently aus', () => {
    const pending = createPending('archive_required');
    const actions = buildPendingDocumentDecisionActions(pending);
    const primary = actions.find((action) => action.variant === 'primary');

    expect(isOcrStorageFastPathAllowedForPending(pending)).toBe(true);
    expect(primary?.decision).toBe('save_permanently');
    expect(primary?.labelKey).toBe('userStorageDecision.action.acceptRecommendation');
    expect(primary?.ocrFastPathPrimary).toBe(true);
    expect(actions.filter((action) => action.variant === 'primary')).toHaveLength(1);

    const mount = mountPreview('archive_required', pending, actions);
    expect(mount.container.querySelector('[data-ocr-fast-path="true"]')).not.toBeNull();
    expect(primaryButtons(mount.container)).toHaveLength(1);
    expect(primaryButtons(mount.container)[0]?.textContent).toBe(
      translate('userStorageDecision.action.acceptRecommendation'),
    );
    expect(mount.onDecision).not.toHaveBeenCalled();

    act(() => {
      primaryButtons(mount.container)[0]?.click();
    });
    expect(mount.onDecision).toHaveBeenCalledTimes(1);
    expect(mount.onDecision).toHaveBeenCalledWith('save_permanently');
    unmount(mount);
  });

  it('archive_recommended: Primary „Empfehlung übernehmen“ führt save_permanently aus', () => {
    const pending = createPending('archive_recommended');
    const actions = buildPendingDocumentDecisionActions(pending);
    const primary = actions.find((action) => action.variant === 'primary');
    expect(primary?.decision).toBe('save_permanently');
    expect(primary?.labelKey).toBe('userStorageDecision.action.acceptRecommendation');

    const mount = mountPreview('archive_recommended', pending, actions);
    act(() => {
      primaryButtons(mount.container)[0]?.click();
    });
    expect(mount.onDecision).toHaveBeenCalledWith('save_permanently');
    unmount(mount);
  });

  it('duplicate_detected: Primary „Vorhandenes Dokument verwenden“ führt use_existing aus', () => {
    const pending = createPending('duplicate_detected');
    const actions = buildPendingDocumentDecisionActions(pending);
    const primary = actions.find((action) => action.variant === 'primary');
    expect(primary?.decision).toBe('use_existing');
    expect(primary?.labelKey).toBe('userStorageDecision.action.useExistingDocument');
    expect(translate(primary!.labelKey)).toBe('Vorhandenes Dokument verwenden');

    const mount = mountPreview('duplicate_detected', pending, actions);
    act(() => {
      (
        mount.container.querySelector(
          '[data-testid="storage-decision-use-existing"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(mount.onDecision).toHaveBeenCalledWith('use_existing');
    unmount(mount);
  });

  it('discard_recommended: Primary „Nicht speichern“ führt discard aus', () => {
    const pending = createPending('discard_recommended');
    const actions = buildPendingDocumentDecisionActions(pending);
    const primary = actions.find((action) => action.variant === 'primary');
    expect(primary?.decision).toBe('discard');
    expect(primary?.labelKey).toBe('userStorageDecision.action.discard');
    expect(translate(primary!.labelKey)).toBe('Nicht speichern');

    const mount = mountPreview('discard_recommended', pending, actions);
    act(() => {
      (
        mount.container.querySelector(
          '[data-testid="storage-decision-discard"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(mount.onDecision).toHaveBeenCalledWith('discard');
    unmount(mount);
  });

  it('review_required: kein Fast Path, bestehendes Primary-Label bleibt', () => {
    const pending = createPending('review_required');
    const primaryDecision = resolvePrimarySuggestedUserStorageDecision(
      pending.storageRecommendation,
    );
    const available = resolveAvailableUserStorageDecisions(
      pending.storageRecommendation,
      pending.storagePolicy,
    );
    const baseline = buildStorageDecisionActionSpecs(available, primaryDecision);
    const actions = buildPendingDocumentDecisionActions(pending);

    expect(isOcrStorageFastPathAllowedForPending(pending)).toBe(false);
    expect(resolveOcrFastPathPrimaryLabelKey('review_required', primaryDecision)).toBeNull();
    expect(actions).toEqual(baseline);
    expect(actions.find((action) => action.variant === 'primary')?.labelKey).toBe(
      'userStorageDecision.action.savePermanently',
    );

    const mount = mountPreview('review_required', pending, actions);
    expect(mount.container.querySelector('[data-ocr-fast-path="false"]')).not.toBeNull();
    expect(primaryButtons(mount.container)).toHaveLength(0);
    expect(
      mount.container.querySelector('[data-testid="storage-decision-save-permanently"]')
        ?.textContent,
    ).toBe(translate('userStorageDecision.action.savePermanently'));
    expect(mount.onDecision).not.toHaveBeenCalled();
    unmount(mount);
  });

  it('companyRelevant == false: trotz archive_required kein Fast-Path-Label (Render)', () => {
    resetCompanyProfile();
    const pending = createPending('archive_required', {
      recognizedText: 'Rechnung Betrag 99,00 EUR ohne Firmenbezug',
    });

    expect(isOcrStorageFastPathAllowedForPending(pending)).toBe(false);
    const actions = buildPendingDocumentDecisionActions(pending);
    const primary = actions.find((action) => action.variant === 'primary');
    expect(primary?.decision).toBe('save_permanently');
    expect(primary?.labelKey).toBe('userStorageDecision.action.savePermanently');
    expect(primary?.ocrFastPathPrimary).toBeUndefined();

    const mount = mountPreview('archive_required', pending, actions);
    expect(mount.container.querySelector('[data-ocr-fast-path="false"]')).not.toBeNull();
    expect(primaryButtons(mount.container)).toHaveLength(0);
    expect(
      mount.container.querySelector('[data-testid="storage-decision-save-permanently"]')
        ?.textContent,
    ).toBe(translate('userStorageDecision.action.savePermanently'));
    unmount(mount);
  });

  it('Vertrag/LV: trotz archive_recommended kein Fast-Path-Label (Render)', () => {
    const pending = createPending('archive_recommended', {
      recognizedText: SAMPLE_WERKVERTRAG_TEXT,
      classification: {
        classifiedKind: 'werkvertrag',
        documentType: 'kundenauftrag',
        title: 'Werkvertrag',
        sender: 'Müller Bau GmbH',
        recognizedData: { Dokumentart: 'werkvertrag' },
      },
    });
    pending.storagePolicy = {
      ...pending.storagePolicy,
      policyId: 'business_document',
      catalogPolicyId: 'business_document',
      classifiedKind: 'werkvertrag',
    };

    expect(isOcrStorageFastPathAllowedForPending(pending)).toBe(false);
    const actions = buildPendingDocumentDecisionActions(pending);
    expect(actions.find((action) => action.variant === 'primary')).toMatchObject({
      decision: 'save_permanently',
      labelKey: 'userStorageDecision.action.savePermanently',
    });
    expect(actions.some((action) => action.ocrFastPathPrimary)).toBe(false);

    const mount = mountPreview('archive_recommended', pending, actions);
    expect(mount.container.querySelector('[data-ocr-fast-path="false"]')).not.toBeNull();
    expect(primaryButtons(mount.container)).toHaveLength(0);
    expect(
      mount.container.textContent,
    ).not.toContain(translate('userStorageDecision.action.acceptRecommendation'));
    unmount(mount);
  });

  it('Archive-Fast-Path braucht Level plus bestehende Safety-Gates; discard bleibt level-basiert', () => {
    const archivePending = createPending('archive_required');
    expect(isOcrStorageFastPathAllowedForPending(archivePending)).toBe(true);

    resetCompanyProfile();
    expect(isOcrStorageFastPathAllowedForPending(archivePending)).toBe(false);

    // Ads / discard must not be blocked by companyRelevant (often false).
    hydrateCompanyProfileStore({ companyName: COMPANY_NAME });
    const discardPending = createPending('discard_recommended', {
      recognizedText: 'Werbung Sonderangebot ohne Firmenbezug',
    });
    resetCompanyProfile();
    expect(isOcrStorageFastPathAllowedForPending(discardPending)).toBe(true);
    expect(
      buildPendingDocumentDecisionActions(discardPending).find(
        (action) => action.variant === 'primary',
      )?.ocrFastPathPrimary,
    ).toBe(true);
  });

  it('verwendet echtes Contract-Intelligence-Ergebnis im Upload-Preview für Werkverträge', () => {
    const pending = createPending('archive_recommended', {
      recognizedText: SAMPLE_WERKVERTRAG_TEXT,
      classification: {
        classifiedKind: 'werkvertrag',
        documentType: 'kundenauftrag',
        title: 'Werkvertrag',
        sender: 'Müller Bau GmbH',
        recognizedData: { Dokumentart: 'werkvertrag' },
      },
    });
    const mount = mountPreview('archive_recommended', pending, buildPendingDocumentDecisionActions(pending));

    act(() => {
      mount.root.render(
        <OcrPreviewPanel
          fileName={pending.cachedFile.fileName}
          extraction={pending.extraction}
          preview={pending.preview}
          contractProposal={{
            customer: 'Cirmak GmbH',
            contractor: 'Cirmak Haustechnik GmbH',
            constructionSite: 'BV Rüthen',
            contractDate: '01.01.2026',
            positionCount: 1,
            contractTotalNet: '36.029,05 €',
            paymentTermsSummary: '',
            reviewHints: [],
            positions: [
              {
                id: 'pos-1',
                description: 'Kellerabdichtung',
                quantity: 1,
                unitPrice: 1200,
                unit: 'Stk',
                reviewStatus: 'confirmed',
              },
            ],
            intelligence: {
              documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
              classifiedKind: 'werkvertrag',
              reviewRequired: false,
              segmentation: {
                pages: [],
                contractCorePages: [1],
                billOfQuantitiesPages: [2],
                technicalAttachmentPages: [],
                commercialAttachmentPages: [],
                unknownPages: [],
              },
              contractFields: {
                bauvorhaben: { value: 'BV Rüthen', status: 'confirmed', confidence: 'high' },
                auftraggeber: { value: 'Cirmak GmbH', status: 'confirmed', confidence: 'high' },
                auftragnehmer: { value: 'Cirmak Haustechnik GmbH', status: 'confirmed', confidence: 'high' },
              },
              parties: [
                { role: 'auftraggeber', name: 'Cirmak GmbH', status: 'confirmed', confidence: 'high' },
                { role: 'auftragnehmer', name: 'Cirmak Haustechnik GmbH', status: 'confirmed', confidence: 'high' },
              ],
              commonFields: {},
              typeSpecificFields: {},
              positions: [
                {
                  id: 'pos-1',
                  description: 'Kellerabdichtung',
                  quantity: 1,
                  unitPrice: 1200,
                  unit: 'Stk',
                  reviewStatus: 'confirmed',
                },
              ],
              contractTotalNet: {
                value: 36029.05,
                status: 'confirmed',
                confidence: 'high',
                sourceText: '36.029,05 €',
              },
              paymentTerms: [],
              clauses: [],
              progressBillingAllowed: false,
              finalInvoiceMentioned: false,
              technicalAttachmentCount: 0,
              openReviewHints: [],
            },
          }}
          storageRecommendation={pending.storageRecommendation}
          decisionActions={buildPendingDocumentDecisionActions(pending)}
          documentTypeLabel="Art"
          senderLabel="Absender"
          previewTextLabel="Text"
          aiActionsLabel="Aktionen"
          translate={translate}
          onDecision={mount.onDecision}
        />,
      );
    });

    expect(mount.container.querySelector('[data-testid="contract-workspace-summary"]')).not.toBeNull();
    expect(mount.container.textContent).toContain('Cirmak GmbH');
    expect(mount.container.textContent).toContain('Cirmak Haustechnik GmbH');
    expect(mount.container.textContent).toContain('BV Rüthen');
    expect(mount.container.textContent).toContain('36.029,05 €');
    expect(mount.container.textContent).toContain('1 Positionen');
    unmount(mount);
  });

  it('Regression: Secondary-Aktionen bleiben, keine Auto-Ausführung, keine doppelte Primary', () => {
    const levels: StorageRecommendationLevel[] = [
      'archive_required',
      'archive_recommended',
      'duplicate_detected',
      'discard_recommended',
      'review_required',
    ];

    for (const level of levels) {
      const pending = createPending(level);
      const actions = buildPendingDocumentDecisionActions(pending);
      expect(actions.filter((action) => action.variant === 'primary')).toHaveLength(1);
      expect(actions.length).toBeGreaterThan(1);

      const mount = mountPreview(level, pending, actions);
      expect(mount.onDecision).not.toHaveBeenCalled();

      const secondary = actions.find((action) => action.variant === 'outline');
      expect(secondary).toBeTruthy();
      act(() => {
        (
          mount.container.querySelector(`[data-testid="${secondary!.testId}"]`) as HTMLButtonElement
        ).click();
      });
      expect(mount.onDecision).toHaveBeenCalledWith(secondary!.decision);
      unmount(mount);
    }
  });

  it('wendet Fast-Path-Labels nur auf die bestehende Primary-Decision an', () => {
    const available: UserStorageDecision[] = ['save_permanently', 'discard'];
    const specs = buildStorageDecisionActionSpecs(available, 'save_permanently');
    const labeled = applyOcrFastPathPrimaryLabels(specs, 'archive_required');

    expect(labeled[0]).toMatchObject({
      decision: 'save_permanently',
      variant: 'primary',
      labelKey: 'userStorageDecision.action.acceptRecommendation',
      ocrFastPathPrimary: true,
    });
    expect(labeled[1]).toMatchObject({
      decision: 'discard',
      variant: 'outline',
      labelKey: 'userStorageDecision.action.discard',
    });
  });
});
