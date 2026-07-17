import { describe, expect, it } from 'vitest';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import { getStoragePolicyRequirements } from './services/storagePolicyRequirements';
import { STORAGE_POLICY_REQUIREMENTS_BY_ID } from './services/storagePolicyRequirements';
import type { DocumentFileRepresentationPlan } from './types/documentFileRepresentationPlan';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import {
  DOCUMENT_FILE_TRANSFORM_EXECUTION_INTENTS,
  DOCUMENT_FILE_TRANSFORM_INTENTS,
} from './types/documentFileTransformPlan';
import type { StorageMediaProfile, StoragePolicyId } from './types/storagePolicy';

function requireRepresentationPlan(
  policyId: StoragePolicyId,
  decision: 'save_permanently' | 'keep_temporarily' | 'save_duplicate_anyway',
): DocumentFileRepresentationPlan {
  const plan = buildDocumentFileRepresentationPlan({ policyId, decision });
  expect(plan).not.toBeNull();
  return plan!;
}

function intentOf(plan: DocumentFileTransformPlan, targetKind: 'archive' | 'preview' | 'thumbnail') {
  return plan.intents.find((entry) => entry.targetKind === targetKind);
}

describe('STORAGE-TRANSFORM-INTENT-PLANNER-01', () => {
  describe('Typen', () => {
    it('definiert genau create_archive, create_preview, create_thumbnail', () => {
      expect([...DOCUMENT_FILE_TRANSFORM_INTENTS]).toEqual([
        'create_archive',
        'create_preview',
        'create_thumbnail',
      ]);
    });

    it('definiert Execution Intent genau als required und preferred', () => {
      expect([...DOCUMENT_FILE_TRANSFORM_EXECUTION_INTENTS]).toEqual(['required', 'preferred']);
    });
  });

  describe('Fall A: vollständiges Intent-Mapping', () => {
    it('mappt nur aktive Derivate; original erzeugt keinen Intent', () => {
      const representationPlan: DocumentFileRepresentationPlan = {
        policyId: 'legal_document',
        decision: 'save_permanently',
        entries: [
          { kind: 'original', disposition: 'required' },
          { kind: 'archive', disposition: 'required' },
          { kind: 'preview', disposition: 'preferred' },
          { kind: 'thumbnail', disposition: 'required' },
        ],
      };

      const plan = buildDocumentFileTransformPlan({
        representationPlan,
        mediaProfile: 'native_pdf',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;

      expect(plan.intents).toHaveLength(3);
      expect(plan.intents.map((i) => i.targetKind)).toEqual(['archive', 'preview', 'thumbnail']);
      expect(plan.intents.every((i) => i.targetKind !== 'original')).toBe(true);

      expect(intentOf(plan, 'archive')).toEqual({
        targetKind: 'archive',
        intent: 'create_archive',
        executionIntent: 'required',
      });
      expect(intentOf(plan, 'preview')).toEqual({
        targetKind: 'preview',
        intent: 'create_preview',
        executionIntent: 'preferred',
      });
      expect(intentOf(plan, 'thumbnail')).toEqual({
        targetKind: 'thumbnail',
        intent: 'create_thumbnail',
        executionIntent: 'required',
      });
    });
  });

  describe('Fall B–E: produktive Representation Plans', () => {
    it('receipt + save_permanently: kein archive, preview/thumb preferred', () => {
      const representationPlan = requireRepresentationPlan('receipt', 'save_permanently');
      const requirements = getStoragePolicyRequirements('receipt');
      const plan = buildDocumentFileTransformPlan({
        representationPlan,
        mediaProfile: 'raster_image',
      });

      expect(plan).not.toBeNull();
      if (!plan) return;
      expect(plan.policyId).toBe('receipt');
      expect(plan.mediaProfile).toBe('raster_image');
      expect(intentOf(plan, 'archive')).toBeUndefined();
      expect(intentOf(plan, 'preview')).toEqual({
        targetKind: 'preview',
        intent: 'create_preview',
        executionIntent: 'preferred',
      });
      expect(intentOf(plan, 'thumbnail')).toEqual({
        targetKind: 'thumbnail',
        intent: 'create_thumbnail',
        executionIntent: 'preferred',
      });
      expect(plan.hints).toEqual({
        metadataHandling: requirements.metadataHandling,
        colorHandling: requirements.colorHandling,
        preferredOutputKind: requirements.preferredOutputKind,
      });
      expect(plan.intents).toHaveLength(2);
    });

    it('legal_document + save_permanently: archive preferred (im Gegensatz zu receipt)', () => {
      const representationPlan = requireRepresentationPlan('legal_document', 'save_permanently');
      const plan = buildDocumentFileTransformPlan({
        representationPlan,
        mediaProfile: 'native_pdf',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expect(intentOf(plan, 'archive')).toEqual({
        targetKind: 'archive',
        intent: 'create_archive',
        executionIntent: 'preferred',
      });
      expect(intentOf(plan, 'preview')?.executionIntent).toBe('preferred');
      expect(intentOf(plan, 'thumbnail')?.executionIntent).toBe('preferred');
      expect(plan.intents).toHaveLength(3);

      const receiptPlan = buildDocumentFileTransformPlan({
        representationPlan: requireRepresentationPlan('receipt', 'save_permanently'),
        mediaProfile: 'native_pdf',
      });
      expect(intentOf(receiptPlan!, 'archive')).toBeUndefined();
    });

    it('business_document + save_permanently: archive preferred + preview/thumb laut Plan', () => {
      const representationPlan = requireRepresentationPlan('business_document', 'save_permanently');
      const plan = buildDocumentFileTransformPlan({
        representationPlan,
        mediaProfile: 'scanned_pdf',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expect(intentOf(plan, 'archive')).toEqual({
        targetKind: 'archive',
        intent: 'create_archive',
        executionIntent: 'preferred',
      });
      expect(intentOf(plan, 'preview')?.intent).toBe('create_preview');
      expect(intentOf(plan, 'thumbnail')?.intent).toBe('create_thumbnail');
    });

    it('construction_photo + save_permanently: kein archive-Intent', () => {
      const representationPlan = requireRepresentationPlan('construction_photo', 'save_permanently');
      const plan = buildDocumentFileTransformPlan({
        representationPlan,
        mediaProfile: 'raster_image',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expect(intentOf(plan, 'archive')).toBeUndefined();
      expect(intentOf(plan, 'preview')?.executionIntent).toBe('preferred');
      expect(intentOf(plan, 'thumbnail')?.executionIntent).toBe('preferred');
      expect(JSON.stringify(plan)).not.toMatch(/application\/pdf|image\/jpeg|targetMimeType/);
    });
  });

  describe('Fall F–G: Null-Semantik', () => {
    it('temporary_unknown + save_permanently → null', () => {
      const representationPlan = requireRepresentationPlan('temporary_unknown', 'save_permanently');
      expect(
        buildDocumentFileTransformPlan({
          representationPlan,
          mediaProfile: 'native_pdf',
        }),
      ).toBeNull();
    });

    it.each(['receipt', 'legal_document'] as StoragePolicyId[])(
      'keep_temporarily (%s) → null',
      (policyId) => {
        const representationPlan = requireRepresentationPlan(policyId, 'keep_temporarily');
        expect(
          buildDocumentFileTransformPlan({
            representationPlan,
            mediaProfile: 'raster_image',
          }),
        ).toBeNull();
      },
    );
  });

  describe('Fall H: allowed und excluded', () => {
    it('erzeugt keinen Intent und liefert null ohne aktive Derivate', () => {
      const representationPlan: DocumentFileRepresentationPlan = {
        policyId: 'receipt',
        decision: 'save_permanently',
        entries: [
          { kind: 'original', disposition: 'required' },
          { kind: 'archive', disposition: 'allowed' },
          { kind: 'preview', disposition: 'excluded' },
          { kind: 'thumbnail', disposition: 'excluded' },
        ],
      };
      expect(
        buildDocumentFileTransformPlan({
          representationPlan,
          mediaProfile: 'raster_image',
        }),
      ).toBeNull();
    });
  });

  describe('Fall I: required vs preferred', () => {
    it('bewahrt executionIntent ohne Upgrade oder Downgrade', () => {
      const representationPlan: DocumentFileRepresentationPlan = {
        policyId: 'business_document',
        decision: 'save_permanently',
        entries: [
          { kind: 'original', disposition: 'required' },
          { kind: 'archive', disposition: 'preferred' },
          { kind: 'preview', disposition: 'required' },
          { kind: 'thumbnail', disposition: 'preferred' },
        ],
      };
      const plan = buildDocumentFileTransformPlan({
        representationPlan,
        mediaProfile: 'native_pdf',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expect(intentOf(plan, 'archive')?.executionIntent).toBe('preferred');
      expect(intentOf(plan, 'preview')?.executionIntent).toBe('required');
      expect(intentOf(plan, 'thumbnail')?.executionIntent).toBe('preferred');
    });
  });

  describe('Fall J: mediaProfile-Pass-through', () => {
    it('übernimmt mediaProfile unverändert und beeinflusst Intents nicht', () => {
      const representationPlan = requireRepresentationPlan('legal_document', 'save_permanently');
      const profiles: StorageMediaProfile[] = ['native_pdf', 'raster_image'];
      const plans = profiles.map((mediaProfile) =>
        buildDocumentFileTransformPlan({ representationPlan, mediaProfile }),
      );
      expect(plans[0]?.mediaProfile).toBe('native_pdf');
      expect(plans[1]?.mediaProfile).toBe('raster_image');
      expect(plans[0]?.intents).toEqual(plans[1]?.intents);
    });
  });

  describe('Fall K: Hints', () => {
    it('zieht Hints einmalig aus dem zentralen Requirements-Lookup', () => {
      const representationPlan = requireRepresentationPlan('receipt', 'save_permanently');
      const requirements = getStoragePolicyRequirements('receipt');
      const plan = buildDocumentFileTransformPlan({
        representationPlan,
        mediaProfile: 'raster_image',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expect(plan.hints.metadataHandling).toBe(requirements.metadataHandling);
      expect(plan.hints.colorHandling).toBe(requirements.colorHandling);
      expect(plan.hints.preferredOutputKind).toBe(requirements.preferredOutputKind);
      expect(Object.keys(plan.hints).sort()).toEqual([
        'colorHandling',
        'metadataHandling',
        'preferredOutputKind',
      ]);
      for (const intent of plan.intents) {
        expect(intent).not.toHaveProperty('hints');
        expect(intent).not.toHaveProperty('metadataHandling');
      }
    });
  });

  describe('Fall L–M: Determinismus und Reinheit', () => {
    it('ist deterministisch', () => {
      const representationPlan = requireRepresentationPlan('business_document', 'save_permanently');
      const input = { representationPlan, mediaProfile: 'scanned_pdf' as const };
      expect(buildDocumentFileTransformPlan(input)).toEqual(
        buildDocumentFileTransformPlan(input),
      );
    });

    it('mutiert Representation Plan, Entries, Requirements und mediaProfile nicht', () => {
      const representationPlan = requireRepresentationPlan('legal_document', 'save_permanently');
      const mediaProfile: StorageMediaProfile = 'native_pdf';
      const planBefore = structuredClone(representationPlan);
      const requirementsBefore = structuredClone(STORAGE_POLICY_REQUIREMENTS_BY_ID);
      const mediaBefore = mediaProfile;

      buildDocumentFileTransformPlan({ representationPlan, mediaProfile });

      expect(representationPlan).toEqual(planBefore);
      expect(STORAGE_POLICY_REQUIREMENTS_BY_ID).toEqual(requirementsBefore);
      expect(mediaProfile).toBe(mediaBefore);
    });
  });

  describe('Fall N: save_duplicate_anyway', () => {
    it('liefert dieselben Intents wie save_permanently für dieselbe Policy', () => {
      const permanent = buildDocumentFileTransformPlan({
        representationPlan: requireRepresentationPlan('receipt', 'save_permanently'),
        mediaProfile: 'raster_image',
      });
      const duplicate = buildDocumentFileTransformPlan({
        representationPlan: requireRepresentationPlan('receipt', 'save_duplicate_anyway'),
        mediaProfile: 'raster_image',
      });
      expect(permanent?.intents).toEqual(duplicate?.intents);
      expect(permanent?.hints).toEqual(duplicate?.hints);
    });
  });
});
