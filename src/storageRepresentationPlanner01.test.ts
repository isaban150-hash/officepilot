import { describe, expect, it } from 'vitest';
import { DOCUMENT_FILE_REPRESENTATION_KINDS } from './types/documentFileRepresentation';
import type { DocumentFileRepresentationPlan } from './types/documentFileRepresentationPlan';
import { DOCUMENT_FILE_REPRESENTATION_DISPOSITIONS } from './types/documentFileRepresentationPlan';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import type { StoragePolicyId } from './types/storagePolicy';
import type { PersistingUserStorageDecision } from './types/userStorageDecision';
import type { UserStorageDecision } from './types/userStorageDecision';

function dispositionOf(
  plan: DocumentFileRepresentationPlan,
  kind: (typeof DOCUMENT_FILE_REPRESENTATION_KINDS)[number],
) {
  const entry = plan.entries.find((e) => e.kind === kind);
  expect(entry).toBeDefined();
  return entry!.disposition;
}

function expectCompletePlan(plan: DocumentFileRepresentationPlan): void {
  expect(plan.entries).toHaveLength(DOCUMENT_FILE_REPRESENTATION_KINDS.length);
  expect(plan.entries.map((e) => e.kind)).toEqual([...DOCUMENT_FILE_REPRESENTATION_KINDS]);
  const kinds = plan.entries.map((e) => e.kind);
  expect(new Set(kinds).size).toBe(kinds.length);
}

describe('STORAGE-REPRESENTATION-PLANNER-01', () => {
  describe('Disposition-Typen', () => {
    it('definiert genau required, preferred, allowed, excluded', () => {
      expect([...DOCUMENT_FILE_REPRESENTATION_DISPOSITIONS]).toEqual([
        'required',
        'preferred',
        'allowed',
        'excluded',
      ]);
    });
  });

  describe('Nicht-persistierende Decisions → null', () => {
    it.each(['discard', 'use_existing'] as const)('%s liefert null', (decision) => {
      expect(
        buildDocumentFileRepresentationPlan({
          policyId: 'receipt',
          decision,
        }),
      ).toBeNull();
    });
  });

  describe('keep_temporarily', () => {
    it.each([
      'receipt',
      'legal_document',
      'construction_photo',
      'temporary_unknown',
    ] as StoragePolicyId[])('%s: nur original required, Rest excluded', (policyId) => {
      const plan = buildDocumentFileRepresentationPlan({
        policyId,
        decision: 'keep_temporarily',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expectCompletePlan(plan);
      expect(plan.policyId).toBe(policyId);
      expect(plan.decision).toBe('keep_temporarily');
      expect(dispositionOf(plan, 'original')).toBe('required');
      expect(dispositionOf(plan, 'archive')).toBe('excluded');
      expect(dispositionOf(plan, 'preview')).toBe('excluded');
      expect(dispositionOf(plan, 'thumbnail')).toBe('excluded');
    });
  });

  describe('save_permanently — fachliche Policy-Unterschiede', () => {
    it('legal_document: original required, archive preferred, preview/thumb preferred', () => {
      const plan = buildDocumentFileRepresentationPlan({
        policyId: 'legal_document',
        decision: 'save_permanently',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expectCompletePlan(plan);
      expect(dispositionOf(plan, 'original')).toBe('required');
      expect(dispositionOf(plan, 'archive')).toBe('preferred');
      expect(dispositionOf(plan, 'preview')).toBe('preferred');
      expect(dispositionOf(plan, 'thumbnail')).toBe('preferred');
    });

    it('receipt: original required, archive allowed (nicht preferred), preview/thumb preferred', () => {
      const plan = buildDocumentFileRepresentationPlan({
        policyId: 'receipt',
        decision: 'save_permanently',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expectCompletePlan(plan);
      expect(dispositionOf(plan, 'original')).toBe('required');
      expect(dispositionOf(plan, 'archive')).toBe('allowed');
      expect(dispositionOf(plan, 'archive')).not.toBe('preferred');
      expect(dispositionOf(plan, 'preview')).toBe('preferred');
      expect(dispositionOf(plan, 'thumbnail')).toBe('preferred');
    });

    it('construction_photo: archive allowed, preview/thumb preferred', () => {
      const plan = buildDocumentFileRepresentationPlan({
        policyId: 'construction_photo',
        decision: 'save_permanently',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expectCompletePlan(plan);
      expect(dispositionOf(plan, 'original')).toBe('required');
      expect(dispositionOf(plan, 'archive')).toBe('allowed');
      expect(dispositionOf(plan, 'preview')).toBe('preferred');
      expect(dispositionOf(plan, 'thumbnail')).toBe('preferred');
    });

    it('temporary_unknown: archive/preview/thumb excluded', () => {
      const plan = buildDocumentFileRepresentationPlan({
        policyId: 'temporary_unknown',
        decision: 'save_permanently',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expectCompletePlan(plan);
      expect(dispositionOf(plan, 'original')).toBe('required');
      expect(dispositionOf(plan, 'archive')).toBe('excluded');
      expect(dispositionOf(plan, 'preview')).toBe('excluded');
      expect(dispositionOf(plan, 'thumbnail')).toBe('excluded');
    });

    it('business_document: archive preferred (original_and_optimized)', () => {
      const plan = buildDocumentFileRepresentationPlan({
        policyId: 'business_document',
        decision: 'save_permanently',
      });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expect(dispositionOf(plan, 'archive')).toBe('preferred');
    });
  });

  describe('save_duplicate_anyway', () => {
    it('entspricht fachlich dem permanenten Persist-Plan derselben Policy', () => {
      const permanent = buildDocumentFileRepresentationPlan({
        policyId: 'receipt',
        decision: 'save_permanently',
      });
      const duplicate = buildDocumentFileRepresentationPlan({
        policyId: 'receipt',
        decision: 'save_duplicate_anyway',
      });
      expect(permanent).not.toBeNull();
      expect(duplicate).not.toBeNull();
      if (!permanent || !duplicate) return;
      expect(duplicate.entries).toEqual(permanent.entries);
      expect(duplicate.decision).toBe('save_duplicate_anyway');
    });
  });

  describe('Determinismus und Reinheit', () => {
    it('liefert bei gleicher Eingabe denselben Plan', () => {
      const input = {
        policyId: 'legal_document' as const,
        decision: 'save_permanently' as PersistingUserStorageDecision,
      };
      const first = buildDocumentFileRepresentationPlan(input);
      const second = buildDocumentFileRepresentationPlan(input);
      expect(first).toEqual(second);
    });

    it('mutiert die Eingabe nicht', () => {
      const input: { policyId: StoragePolicyId; decision: UserStorageDecision } = {
        policyId: 'receipt',
        decision: 'save_permanently',
      };
      const before = structuredClone(input);
      buildDocumentFileRepresentationPlan(input);
      expect(input).toEqual(before);
    });
  });
});
