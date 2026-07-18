import { describe, expect, it } from 'vitest';
import {
  createDocumentFileRepresentationBinding,
} from './services/documentFileRepresentationBindingService';
import { registerDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingRegistrationService';
import { planDocumentFileRepresentationSourceReuseBinding } from './services/documentFileRepresentationSourceReuseBindingPlanService';
import type { DocumentFileRepresentationBinding } from './types/documentFileRepresentationBinding';
import type { DocumentFileRepresentationBindingRegistrationResult } from './types/documentFileRepresentationBindingRegistration';

const DOC_A = 'doc-binding-registry-a';
const DOC_B = 'doc-binding-registry-b';
const FILE_X = 'file-ref-binding-registry-x';
const FILE_Y = 'file-ref-binding-registry-y';

function archiveBinding(
  documentId: string,
  fileRefId: string,
): DocumentFileRepresentationBinding {
  return createDocumentFileRepresentationBinding({
    documentId,
    kind: 'archive',
    fileRefId,
  });
}

describe('STORAGE-REPRESENTATION-BINDING-REGISTRY-01', () => {
  describe('Fall A: created', () => {
    it('legt Binding an, wenn Natural Key fehlt', () => {
      const binding = archiveBinding(DOC_A, FILE_X);
      const result = registerDocumentFileRepresentationBinding({
        bindings: [],
        binding,
      });

      expect(result.kind).toBe('created');
      if (result.kind !== 'created') return;
      expect(result.binding).toEqual(binding);
      expect(result.bindings).toEqual([binding]);
      expect(result.bindings).toHaveLength(1);
    });

    it('hängt an bestehende andere Bindings an ohne sie zu mutieren', () => {
      const existing = archiveBinding(DOC_B, FILE_X);
      const incoming = Object.freeze([existing]);
      const binding = archiveBinding(DOC_A, FILE_X);

      const result = registerDocumentFileRepresentationBinding({
        bindings: incoming,
        binding,
      });

      expect(result.kind).toBe('created');
      if (result.kind !== 'created') return;
      expect(result.bindings).toEqual([existing, binding]);
      expect(incoming).toEqual([existing]);
      expect(incoming).toHaveLength(1);
    });
  });

  describe('Fall B: unchanged', () => {
    it('bei gleichem Natural Key und gleicher fileRefId → unchanged', () => {
      const existing = archiveBinding(DOC_A, FILE_X);
      const requested = archiveBinding(DOC_A, FILE_X);

      const result = registerDocumentFileRepresentationBinding({
        bindings: [existing],
        binding: requested,
      });

      expect(result).toEqual({
        kind: 'unchanged',
        binding: existing,
        bindings: [existing],
      });
    });

    it('ändert die Sammlung nicht und ersetzt nicht still', () => {
      const existing = archiveBinding(DOC_A, FILE_X);
      const other = createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'preview',
        fileRefId: FILE_Y,
      });
      const before = [existing, other];

      const result = registerDocumentFileRepresentationBinding({
        bindings: before,
        binding: archiveBinding(DOC_A, FILE_X),
      });

      expect(result.kind).toBe('unchanged');
      expect(result.bindings).toEqual(before);
      expect(JSON.stringify(result)).not.toMatch(/created|conflict/);
    });
  });

  describe('Fall C: conflict', () => {
    it('bei gleichem Natural Key und anderer fileRefId → conflict ohne Replace', () => {
      const existing = archiveBinding(DOC_A, FILE_X);
      const requested = archiveBinding(DOC_A, FILE_Y);

      const result = registerDocumentFileRepresentationBinding({
        bindings: [existing],
        binding: requested,
      });

      expect(result.kind).toBe('conflict');
      if (result.kind !== 'conflict') return;
      expect(result.existingBinding).toEqual(existing);
      expect(result.requestedBinding).toEqual(requested);
      expect(result.bindings).toEqual([existing]);
      expect(result.bindings.some((entry) => entry.fileRefId === FILE_Y)).toBe(false);
    });
  });

  describe('Fall D: Natural Key Semantik', () => {
    it('vergleicht Natural Keys semantisch, nicht per Referenz', () => {
      const existing = archiveBinding(DOC_A, FILE_X);
      const requested = archiveBinding(DOC_A, FILE_X);

      const result = registerDocumentFileRepresentationBinding({
        bindings: [existing],
        binding: requested,
      });
      expect(result.kind).toBe('unchanged');
    });

    it('fileRefId ist nicht Teil des Natural Keys; gleiche FileRef in zwei Docs → created', () => {
      const docA = archiveBinding(DOC_A, FILE_X);
      const docB = archiveBinding(DOC_B, FILE_X);

      const result = registerDocumentFileRepresentationBinding({
        bindings: [docA],
        binding: docB,
      });

      expect(result.kind).toBe('created');
      if (result.kind !== 'created') return;
      expect(result.bindings).toEqual([docA, docB]);
    });

    it('unterschiedliche kinds desselben Dokuments kollidieren nicht', () => {
      const archive = archiveBinding(DOC_A, FILE_X);
      const preview = createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'preview',
        fileRefId: FILE_Y,
      });

      const result = registerDocumentFileRepresentationBinding({
        bindings: [archive],
        binding: preview,
      });

      expect(result.kind).toBe('created');
      if (result.kind !== 'created') return;
      expect(result.bindings).toEqual([archive, preview]);
    });
  });

  describe('Fall E: Source-Reuse-Plan', () => {
    it('Plan-Felder können als Binding registriert werden', () => {
      const plan = planDocumentFileRepresentationSourceReuseBinding({
        materialization: { kind: 'source_reuse' },
        sourceFileRefId: FILE_X,
      });
      const binding = createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: plan.targetKind,
        fileRefId: plan.sourceFileRefId,
      });

      const result = registerDocumentFileRepresentationBinding({
        bindings: [],
        binding,
      });

      expect(result.kind).toBe('created');
      if (result.kind !== 'created') return;
      expect(result.binding).toEqual({
        documentId: DOC_A,
        kind: 'archive',
        fileRefId: FILE_X,
      });
    });
  });

  describe('Fall F: Immutability und Determinismus', () => {
    it('Eingabesammlung und Binding werden nicht mutiert; Result ist eingefroren', () => {
      const binding = Object.freeze(archiveBinding(DOC_A, FILE_X));
      const bindings = Object.freeze([archiveBinding(DOC_B, FILE_Y)]);
      const bindingsBefore = structuredClone(bindings as DocumentFileRepresentationBinding[]);
      const bindingBefore = structuredClone(binding);

      const result = registerDocumentFileRepresentationBinding({
        bindings,
        binding,
      });

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.bindings)).toBe(true);
      expect(bindings).toEqual(bindingsBefore);
      expect(binding).toEqual(bindingBefore);
    });

    it('mehrfache Aufrufe mit gleichen Eingaben sind strukturell deterministisch', () => {
      const binding = archiveBinding(DOC_A, FILE_X);
      const bindings = [archiveBinding(DOC_B, FILE_Y)];
      const a = registerDocumentFileRepresentationBinding({ bindings, binding });
      const b = registerDocumentFileRepresentationBinding({ bindings, binding });
      expect(a).toEqual(b);
    });
  });

  describe('Fall G: ungültige Inputs', () => {
    it('null/ungültige Sammlung → TypeError', () => {
      expect(() =>
        registerDocumentFileRepresentationBinding({
          bindings: null as unknown as readonly DocumentFileRepresentationBinding[],
          binding: archiveBinding(DOC_A, FILE_X),
        }),
      ).toThrow(TypeError);

      expect(() =>
        registerDocumentFileRepresentationBinding(
          null as unknown as {
            bindings: readonly DocumentFileRepresentationBinding[];
            binding: DocumentFileRepresentationBinding;
          },
        ),
      ).toThrow(TypeError);
    });

    it('ungültiges Binding → TypeError über Factory-Invarianten', () => {
      expect(() =>
        registerDocumentFileRepresentationBinding({
          bindings: [],
          binding: {
            documentId: DOC_A,
            kind: 'original',
            fileRefId: FILE_X,
          } as unknown as DocumentFileRepresentationBinding,
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Fall H: Result-Form', () => {
    it('Result-Arten sind ausschließlich created, unchanged, conflict', () => {
      const results: DocumentFileRepresentationBindingRegistrationResult[] = [
        registerDocumentFileRepresentationBinding({
          bindings: [],
          binding: archiveBinding(DOC_A, FILE_X),
        }),
        registerDocumentFileRepresentationBinding({
          bindings: [archiveBinding(DOC_A, FILE_X)],
          binding: archiveBinding(DOC_A, FILE_X),
        }),
        registerDocumentFileRepresentationBinding({
          bindings: [archiveBinding(DOC_A, FILE_X)],
          binding: archiveBinding(DOC_A, FILE_Y),
        }),
      ];

      expect(results.map((r) => r.kind)).toEqual(['created', 'unchanged', 'conflict']);
      for (const result of results) {
        expect(result).not.toHaveProperty('status');
        expect(result).not.toHaveProperty('replaced');
        expect(result).not.toHaveProperty('upserted');
      }
    });
  });
});
