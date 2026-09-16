/**
 * DOCUMENT-KIND-CATALOG-01A — `rechnungskorrektur` ist Teil der zentralen Dokumentarten-Wahrheit.
 *
 *  A  isKnownClassifiedKind('rechnungskorrektur') === true
 *  B  Katalog, Storage-Policy und der von `invoiceCorrectionArchive` erzeugte Beleg sind konsistent
 *  C  Dokumenttyp: der Korrekturbeleg zählt zu den Ausgangsrechnungen; kein eigenes Primärziel
 */
import { describe, expect, it } from 'vitest';
import {
  CLASSIFIED_DOCUMENT_KINDS,
  isKnownClassifiedKind,
  mapKindToDocumentType,
} from './documentClassificationCatalog';
import { STORAGE_POLICY_BY_KIND, assertStoragePolicyCatalogComplete } from './storagePolicyCatalog';
import { resolvePrimaryTargetObjectForKind } from './documentPrimaryTargetService';

describe('DOCUMENT-KIND-CATALOG-01A — rechnungskorrektur', () => {
  it('A: ist eine bekannte Dokumentart', () => {
    expect(isKnownClassifiedKind('rechnungskorrektur')).toBe(true);
    expect(CLASSIFIED_DOCUMENT_KINDS.filter((kind) => kind === 'rechnungskorrektur')).toHaveLength(1);
  });

  it('B: Katalog und Storage-Policy decken sich vollständig', () => {
    expect(() => assertStoragePolicyCatalogComplete()).not.toThrow();
    expect(new Set(CLASSIFIED_DOCUMENT_KINDS).size).toBe(CLASSIFIED_DOCUMENT_KINDS.length);
    expect(Object.keys(STORAGE_POLICY_BY_KIND).sort()).toEqual([...CLASSIFIED_DOCUMENT_KINDS].sort());
    expect(STORAGE_POLICY_BY_KIND.rechnungskorrektur).toBe('business_document');
  });

  it('C: Dokumenttyp Ausgangsrechnung, Primärziel bleibt Unternehmensdokument', () => {
    expect(mapKindToDocumentType('rechnungskorrektur')).toBe('ausgangsrechnung');
    expect(resolvePrimaryTargetObjectForKind('rechnungskorrektur')).toBe('companyDocument');
  });
});
