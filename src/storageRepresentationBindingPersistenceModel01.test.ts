import { describe, expect, it } from 'vitest';
import {
  createDocumentFileRepresentationBinding,
  toDocumentFileRepresentationBindingNaturalKey,
} from './services/documentFileRepresentationBindingService';
import { planDocumentFileRepresentationSourceReuseBinding } from './services/documentFileRepresentationSourceReuseBindingPlanService';
import { DOCUMENT_FILE_REPRESENTATION_KINDS } from './types/documentFileRepresentation';
import {
  DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS,
  type DocumentFileRepresentationBinding,
} from './types/documentFileRepresentationBinding';

const DOCUMENT_ID = 'doc-binding-persistence-01';
const FILE_REF_ID = 'file-ref-binding-persistence-01';

describe('STORAGE-REPRESENTATION-BINDING-PERSISTENCE-MODEL-01', () => {
  describe('Fall A: Typkatalog', () => {
    it('Binding-Kinds sind archive, preview, thumbnail — ohne original', () => {
      expect([...DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS]).toEqual([
        'archive',
        'preview',
        'thumbnail',
      ]);
      expect(DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS).not.toContain('original');
      for (const kind of DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS) {
        expect(DOCUMENT_FILE_REPRESENTATION_KINDS).toContain(kind);
      }
    });
  });

  describe('Fall B–C: Factory und Felder', () => {
    it('erzeugt minimales Binding documentId + kind + fileRefId', () => {
      const binding = createDocumentFileRepresentationBinding({
        documentId: DOCUMENT_ID,
        kind: 'archive',
        fileRefId: FILE_REF_ID,
      });

      expect(binding).toEqual({
        documentId: DOCUMENT_ID,
        kind: 'archive',
        fileRefId: FILE_REF_ID,
      });
      expect(Object.keys(binding).sort()).toEqual(['documentId', 'fileRefId', 'kind']);
    });

    it('unterstützt preview und thumbnail', () => {
      expect(
        createDocumentFileRepresentationBinding({
          documentId: DOCUMENT_ID,
          kind: 'preview',
          fileRefId: FILE_REF_ID,
        }).kind,
      ).toBe('preview');
      expect(
        createDocumentFileRepresentationBinding({
          documentId: DOCUMENT_ID,
          kind: 'thumbnail',
          fileRefId: FILE_REF_ID,
        }).kind,
      ).toBe('thumbnail');
    });

    it('enthält keine Datei-Metadaten, keine Representation-ID, keinen mode', () => {
      const binding: DocumentFileRepresentationBinding = createDocumentFileRepresentationBinding({
        documentId: DOCUMENT_ID,
        kind: 'archive',
        fileRefId: FILE_REF_ID,
      });

      expect(binding).not.toHaveProperty('id');
      expect(binding).not.toHaveProperty('createdAt');
      expect(binding).not.toHaveProperty('contentHash');
      expect(binding).not.toHaveProperty('mimeType');
      expect(binding).not.toHaveProperty('fileSize');
      expect(binding).not.toHaveProperty('localDataKey');
      expect(binding).not.toHaveProperty('storageType');
      expect(binding).not.toHaveProperty('mode');
      expect(binding).not.toHaveProperty('sourceFileRefId');
    });
  });

  describe('Fall D: Natural Key documentId + kind', () => {
    it('Natural Key ist dokumentbezogen und enthält keine fileRefId', () => {
      const binding = createDocumentFileRepresentationBinding({
        documentId: DOCUMENT_ID,
        kind: 'archive',
        fileRefId: FILE_REF_ID,
      });
      const key = toDocumentFileRepresentationBindingNaturalKey(binding);

      expect(key).toEqual({ documentId: DOCUMENT_ID, kind: 'archive' });
      expect(Object.keys(key).sort()).toEqual(['documentId', 'kind']);
      expect(key).not.toHaveProperty('fileRefId');
      expect(JSON.stringify(key)).not.toMatch(/file-ref|:archive/);
    });

    it('gleiche documentId+kind → gleicher Natural Key trotz anderer fileRefId', () => {
      const a = createDocumentFileRepresentationBinding({
        documentId: DOCUMENT_ID,
        kind: 'archive',
        fileRefId: 'file-ref-a',
      });
      const b = createDocumentFileRepresentationBinding({
        documentId: DOCUMENT_ID,
        kind: 'archive',
        fileRefId: 'file-ref-b',
      });

      expect(toDocumentFileRepresentationBindingNaturalKey(a)).toEqual(
        toDocumentFileRepresentationBindingNaturalKey(b),
      );
    });

    it('gleiche FileRef in zwei Dokumenten → unterschiedliche Natural Keys', () => {
      const docA = createDocumentFileRepresentationBinding({
        documentId: 'doc-a',
        kind: 'archive',
        fileRefId: FILE_REF_ID,
      });
      const docB = createDocumentFileRepresentationBinding({
        documentId: 'doc-b',
        kind: 'archive',
        fileRefId: FILE_REF_ID,
      });

      expect(toDocumentFileRepresentationBindingNaturalKey(docA)).not.toEqual(
        toDocumentFileRepresentationBindingNaturalKey(docB),
      );
    });

    it('verwendet nicht `${fileRefId}:archive` als Identität', () => {
      const binding = createDocumentFileRepresentationBinding({
        documentId: DOCUMENT_ID,
        kind: 'archive',
        fileRefId: FILE_REF_ID,
      });
      const serialized = JSON.stringify({
        binding,
        key: toDocumentFileRepresentationBindingNaturalKey(binding),
      });
      expect(serialized).not.toContain(`${FILE_REF_ID}:archive`);
    });
  });

  describe('Fall E: Source-Reuse-Plan → Binding-Felder', () => {
    it('übernimmt sourceFileRefId als fileRefId; Plan bleibt unverändert getrennt', () => {
      const plan = planDocumentFileRepresentationSourceReuseBinding({
        materialization: { kind: 'source_reuse' },
        sourceFileRefId: FILE_REF_ID,
      });

      const binding = createDocumentFileRepresentationBinding({
        documentId: DOCUMENT_ID,
        kind: plan.targetKind,
        fileRefId: plan.sourceFileRefId,
      });

      expect(binding).toEqual({
        documentId: DOCUMENT_ID,
        kind: 'archive',
        fileRefId: FILE_REF_ID,
      });
      expect(plan).toEqual({
        mode: 'reuse_source_file',
        targetKind: 'archive',
        sourceFileRefId: FILE_REF_ID,
      });
    });
  });

  describe('Fall F–G: Validierung', () => {
    it('kind original → TypeError', () => {
      expect(() =>
        createDocumentFileRepresentationBinding({
          documentId: DOCUMENT_ID,
          kind: 'original' as unknown as 'archive',
          fileRefId: FILE_REF_ID,
        }),
      ).toThrow(TypeError);
    });

    it('unbekannter kind → TypeError', () => {
      expect(() =>
        createDocumentFileRepresentationBinding({
          documentId: DOCUMENT_ID,
          kind: 'export' as unknown as 'archive',
          fileRefId: FILE_REF_ID,
        }),
      ).toThrow(TypeError);
    });

    it('ungültige documentId / fileRefId → TypeError', () => {
      for (const invalid of ['', '   ', null, undefined, 42] as const) {
        expect(() =>
          createDocumentFileRepresentationBinding({
            documentId: invalid as unknown as string,
            kind: 'archive',
            fileRefId: FILE_REF_ID,
          }),
        ).toThrow(TypeError);

        expect(() =>
          createDocumentFileRepresentationBinding({
            documentId: DOCUMENT_ID,
            kind: 'archive',
            fileRefId: invalid as unknown as string,
          }),
        ).toThrow(TypeError);
      }
    });

    it('unvollständige Inputs → TypeError', () => {
      expect(() =>
        createDocumentFileRepresentationBinding(
          null as unknown as {
            documentId: string;
            kind: 'archive';
            fileRefId: string;
          },
        ),
      ).toThrow(TypeError);

      expect(() =>
        createDocumentFileRepresentationBinding({
          kind: 'archive',
          fileRefId: FILE_REF_ID,
        } as unknown as {
          documentId: string;
          kind: 'archive';
          fileRefId: string;
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Fall H–J: Immutability, Determinismus, keine Persistenzwirkung', () => {
    it('Result und Natural Key sind eingefroren; Eingaben unverändert', () => {
      const input = Object.freeze({
        documentId: DOCUMENT_ID,
        kind: 'archive' as const,
        fileRefId: FILE_REF_ID,
      });
      const before = structuredClone(input);

      const binding = createDocumentFileRepresentationBinding(input);
      const key = toDocumentFileRepresentationBindingNaturalKey(binding);

      expect(Object.isFrozen(binding)).toBe(true);
      expect(Object.isFrozen(key)).toBe(true);
      expect(input).toEqual(before);
    });

    it('mehrfache Aufrufe sind strukturell deterministisch', () => {
      const input = {
        documentId: DOCUMENT_ID,
        kind: 'archive' as const,
        fileRefId: FILE_REF_ID,
      };
      expect(createDocumentFileRepresentationBinding(input)).toEqual(
        createDocumentFileRepresentationBinding(input),
      );
      expect(
        JSON.stringify(createDocumentFileRepresentationBinding(input)),
      ).not.toMatch(/Date|Math\.random|uuid|navigator/);
    });

    it('IDs werden nicht normalisiert oder mit Suffix versehen', () => {
      const documentId = 'doc_With.Mixed-CHARS';
      const fileRefId = 'file-ref_With.Mixed-CHARS';
      const binding = createDocumentFileRepresentationBinding({
        documentId,
        kind: 'archive',
        fileRefId,
      });
      expect(binding.documentId).toBe(documentId);
      expect(binding.fileRefId).toBe(fileRefId);
      expect(binding.fileRefId).not.toBe(`${fileRefId}:archive`);
    });
  });
});
