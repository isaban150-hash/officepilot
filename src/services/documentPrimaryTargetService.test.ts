import { describe, expect, it } from 'vitest';
import { CLASSIFIED_DOCUMENT_KINDS } from './documentClassificationCatalog';
import {
  resolvePrimaryTargetObjectForDocumentType,
  resolvePrimaryTargetObjectForKind,
  type PrimaryTargetObjectType,
} from './documentPrimaryTargetService';

describe('documentPrimaryTargetService', () => {
  it('maps every classified kind to exactly one canonical target object', () => {
    const allowed: PrimaryTargetObjectType[] = [
      'vorgang',
      'expense',
      'vorgangInvoice',
      'proofMemory',
      'companyDocument',
    ];

    for (const kind of CLASSIFIED_DOCUMENT_KINDS) {
      const target = resolvePrimaryTargetObjectForKind(kind);
      expect(allowed).toContain(target);
    }
  });

  it('keeps the canonical examples stable', () => {
    expect(resolvePrimaryTargetObjectForKind('werkvertrag')).toBe('vorgang');
    expect(resolvePrimaryTargetObjectForKind('eingangsrechnung')).toBe('expense');
    expect(resolvePrimaryTargetObjectForKind('ausgangsrechnung')).toBe('vorgangInvoice');
    expect(resolvePrimaryTargetObjectForKind('freistellungsbescheinigung')).toBe('proofMemory');
    expect(resolvePrimaryTargetObjectForKind('sonstiges')).toBe('companyDocument');
  });

  it('provides deterministic fallback mapping by coarse document type', () => {
    expect(resolvePrimaryTargetObjectForDocumentType('kundenauftrag')).toBe('vorgang');
    expect(resolvePrimaryTargetObjectForDocumentType('eingangsrechnung')).toBe('expense');
    expect(resolvePrimaryTargetObjectForDocumentType('ausgangsrechnung')).toBe('vorgangInvoice');
    expect(resolvePrimaryTargetObjectForDocumentType('behoerde')).toBe('companyDocument');
    expect(resolvePrimaryTargetObjectForDocumentType('brief')).toBe('companyDocument');
  });
});
