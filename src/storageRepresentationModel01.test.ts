import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_FILE_REPRESENTATION_KINDS,
  STORAGE_REQUIREMENT_TO_REPRESENTATION_KIND,
} from './types/documentFileRepresentation';
import { toOriginalDocumentFileRepresentation } from './services/documentFileRepresentationService';
import type { DocumentFileRef } from './types/documentFileRef';

function sampleFileRef(overrides: Partial<DocumentFileRef> = {}): DocumentFileRef {
  return {
    id: 'file-ref-rep-01',
    originalFileName: 'vertrag.pdf',
    mimeType: 'application/pdf',
    fileSize: 4096,
    contentHash: 'abc123def456originalhash',
    storageType: 'indexeddb',
    localDataKey: 'file-ref-rep-01',
    createdAt: '2026-07-17T10:00:00.000Z',
    lifecycleStatus: 'committed',
    committedAt: '2026-07-17T10:00:01.000Z',
    ...overrides,
  };
}

describe('STORAGE-REPRESENTATION-MODEL-01', () => {
  describe('Fall A: zentrale Kind-Vollständigkeit', () => {
    it('definiert genau original, archive, preview, thumbnail', () => {
      expect([...DOCUMENT_FILE_REPRESENTATION_KINDS]).toEqual([
        'original',
        'archive',
        'preview',
        'thumbnail',
      ]);
    });
  });

  describe('Fall B–E: implizite Originalrepräsentation', () => {
    it('bildet DocumentFileRef als kind original mit identischen Meta-Feldern ab', () => {
      const fileRef = sampleFileRef();
      const representation = toOriginalDocumentFileRepresentation(fileRef);

      expect(representation.kind).toBe('original');
      expect(representation.fileRefId).toBe(fileRef.id);
      expect(representation.mimeType).toBe(fileRef.mimeType);
      expect(representation.fileSize).toBe(fileRef.fileSize);
      expect(representation.contentHash).toBe(fileRef.contentHash);
      expect(representation.storageType).toBe(fileRef.storageType);
      expect(representation.localDataKey).toBe(fileRef.localDataKey);
      expect(representation.createdAt).toBe(fileRef.createdAt);
    });

    it('übernimmt exakt den bestehenden Original-contentHash (Fall C)', () => {
      const fileRef = sampleFileRef({ contentHash: 'hash-must-not-change' });
      const representation = toOriginalDocumentFileRepresentation(fileRef);

      expect(representation.contentHash).toBe('hash-must-not-change');
      expect(representation.contentHash).toBe(fileRef.contentHash);
    });

    it('ist deterministisch bei mehrfacher Projektion (Fall D)', () => {
      const fileRef = sampleFileRef();
      const first = toOriginalDocumentFileRepresentation(fileRef);
      const second = toOriginalDocumentFileRepresentation(fileRef);

      expect(first.id).toBe(second.id);
      expect(first.id).toBe(`${fileRef.id}:original`);
      expect(first).toEqual(second);
    });

    it('mutiert die Eingabe-DocumentFileRef nicht (Fall E)', () => {
      const fileRef = sampleFileRef();
      const before = structuredClone(fileRef);

      toOriginalDocumentFileRepresentation(fileRef);

      expect(fileRef).toEqual(before);
    });
  });

  describe('Fall F: Requirements-Kompatibilität', () => {
    it('ordnet Requirement-Bereiche eindeutig den Representation-Kinds zu', () => {
      expect(STORAGE_REQUIREMENT_TO_REPRESENTATION_KIND.retainOriginal).toBe('original');
      expect(STORAGE_REQUIREMENT_TO_REPRESENTATION_KIND.archiveRepresentation).toBe('archive');
      expect(STORAGE_REQUIREMENT_TO_REPRESENTATION_KIND.previewRequirement).toBe('preview');
      expect(STORAGE_REQUIREMENT_TO_REPRESENTATION_KIND.thumbnailRequirement).toBe('thumbnail');

      const mappedKinds = Object.values(STORAGE_REQUIREMENT_TO_REPRESENTATION_KIND);
      expect(new Set(mappedKinds).size).toBe(4);
      for (const kind of mappedKinds) {
        expect(DOCUMENT_FILE_REPRESENTATION_KINDS).toContain(kind);
      }
    });
  });
});
