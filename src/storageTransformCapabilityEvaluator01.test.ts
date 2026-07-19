import { describe, expect, it } from 'vitest';
import type { DocumentFileTransformCapabilitySnapshot } from './types/documentFileTransformCapability';

import type { DocumentFileTransformCapabilityRequirementSet } from './types/documentFileTransformCapabilityEvaluation';
import { evaluateDocumentFileTransformCapabilities } from './services/documentFileTransformCapabilityEvaluationService';
import {
  PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT,
  createProjectStaticDocumentFileTransformCapabilityProvider,
} from './services/documentFileTransformCapabilityProvider';

function allSupportedSnapshot(): DocumentFileTransformCapabilitySnapshot {
  return {
    load_pdf: 'supported',
    render_pdf_page: 'supported',
    decode_raster_image: 'supported',
    encode_raster_image: 'supported',
    write_pdf: 'supported',
  };
}

describe('STORAGE-TRANSFORM-CAPABILITY-EVALUATOR-01', () => {
  describe('Fall A: vollständig supported', () => {
    it('liefert supported bei zwei supported Capabilities', () => {
      const requiredCapabilities: DocumentFileTransformCapabilityRequirementSet = [
        'load_pdf',
        'render_pdf_page',
      ];
      const evaluation = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities,
        capabilitySnapshot: allSupportedSnapshot(),
      });
      expect(evaluation.status).toBe('supported');
      expect(evaluation.requiredCapabilities).toEqual(['load_pdf', 'render_pdf_page']);
      expect(evaluation.unsupportedCapabilities).toEqual([]);
      expect(evaluation.unknownCapabilities).toEqual([]);
    });
  });

  describe('Fall B–D: unsupported und unknown', () => {
    it('liefert unsupported und listet die Capability', () => {
      const evaluation = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities: ['encode_raster_image', 'load_pdf'],
        capabilitySnapshot: {
          ...allSupportedSnapshot(),
          encode_raster_image: 'unsupported',
        },
      });
      expect(evaluation.status).toBe('unsupported');
      expect(evaluation.unsupportedCapabilities).toEqual(['encode_raster_image']);
      expect(evaluation.unknownCapabilities).toEqual([]);
    });

    it('liefert unknown wenn keine unsupported, aber unknown vorhanden', () => {
      const evaluation = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities: ['load_pdf', 'render_pdf_page'],
        capabilitySnapshot: {
          ...allSupportedSnapshot(),
          render_pdf_page: 'unknown',
        },
      });
      expect(evaluation.status).toBe('unknown');
      expect(evaluation.unsupportedCapabilities).toEqual([]);
      expect(evaluation.unknownCapabilities).toEqual(['render_pdf_page']);
    });

    it('gibt unsupported Vorrang und behält unknown-Befunde', () => {
      const evaluation = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities: ['load_pdf', 'render_pdf_page', 'encode_raster_image'],
        capabilitySnapshot: {
          load_pdf: 'supported',
          render_pdf_page: 'unknown',
          decode_raster_image: 'supported',
          encode_raster_image: 'unsupported',
          write_pdf: 'supported',
        },
      });
      expect(evaluation.status).toBe('unsupported');
      expect(evaluation.unsupportedCapabilities).toEqual(['encode_raster_image']);
      expect(evaluation.unknownCapabilities).toEqual(['render_pdf_page']);
    });
  });

  describe('Fall E: mehrere Befunde und Katalogreihenfolge', () => {
    it('listet nur benötigte IDs in zentraler Reihenfolge', () => {
      const evaluation = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities: [
          'write_pdf',
          'encode_raster_image',
          'decode_raster_image',
          'load_pdf',
        ],
        capabilitySnapshot: {
          load_pdf: 'unknown',
          render_pdf_page: 'supported',
          decode_raster_image: 'unknown',
          encode_raster_image: 'unsupported',
          write_pdf: 'unsupported',
        },
      });
      expect(evaluation.requiredCapabilities).toEqual([
        'load_pdf',
        'decode_raster_image',
        'encode_raster_image',
        'write_pdf',
      ]);
      expect(evaluation.unsupportedCapabilities).toEqual([
        'encode_raster_image',
        'write_pdf',
      ]);
      expect(evaluation.unknownCapabilities).toEqual(['load_pdf', 'decode_raster_image']);
      expect(evaluation.status).toBe('unsupported');
    });
  });

  describe('Fall F: Projekt-Baseline', () => {
    it('wertet Baseline-Snapshot über Provider aus', async () => {
      const snapshot = await createProjectStaticDocumentFileTransformCapabilityProvider().getSnapshot();
      expect(snapshot).toEqual(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT);

      expect(
        evaluateDocumentFileTransformCapabilities({
          requiredCapabilities: ['encode_raster_image'],
          capabilitySnapshot: snapshot,
        }).status,
      ).toBe('supported');

      expect(
        evaluateDocumentFileTransformCapabilities({
          requiredCapabilities: ['decode_raster_image', 'encode_raster_image'],
          capabilitySnapshot: snapshot,
        }).status,
      ).toBe('supported');

      expect(
        evaluateDocumentFileTransformCapabilities({
          requiredCapabilities: ['load_pdf'],
          capabilitySnapshot: snapshot,
        }).status,
      ).toBe('supported');

      expect(
        evaluateDocumentFileTransformCapabilities({
          requiredCapabilities: ['write_pdf'],
          capabilitySnapshot: snapshot,
        }).status,
      ).toBe('supported');

      const multi = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities: ['load_pdf', 'render_pdf_page', 'encode_raster_image'],
        capabilitySnapshot: snapshot,
      });
      expect(multi.status).toBe('supported');
      expect(multi.unknownCapabilities).toEqual([]);
      expect(multi.unsupportedCapabilities).toEqual([]);
    });
  });

  describe('Fall G–I: Validierung', () => {
    it('lehnt leere Requirement-Liste ab', () => {
      expect(() =>
        evaluateDocumentFileTransformCapabilities({
          requiredCapabilities: [] as unknown as DocumentFileTransformCapabilityRequirementSet,
          capabilitySnapshot: allSupportedSnapshot(),
        }),
      ).toThrow(TypeError);
    });

    it('lehnt doppelte Capability-IDs ab', () => {
      expect(() =>
        evaluateDocumentFileTransformCapabilities({
          requiredCapabilities: ['load_pdf', 'load_pdf'] as unknown as DocumentFileTransformCapabilityRequirementSet,
          capabilitySnapshot: allSupportedSnapshot(),
        }),
      ).toThrow(TypeError);
    });

    it('lehnt unbekannte Capability-IDs ab', () => {
      expect(() =>
        evaluateDocumentFileTransformCapabilities({
          requiredCapabilities: [
            'create_preview',
          ] as unknown as DocumentFileTransformCapabilityRequirementSet,
          capabilitySnapshot: allSupportedSnapshot(),
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Fall J–M: Stabilität und Reinheit', () => {
    it('ist unabhängig von der Eingabereihenfolge', () => {
      const snapshot: DocumentFileTransformCapabilitySnapshot = {
        load_pdf: 'unknown',
        render_pdf_page: 'supported',
        decode_raster_image: 'supported',
        encode_raster_image: 'unsupported',
        write_pdf: 'unsupported',
      };
      const a = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities: ['encode_raster_image', 'load_pdf'],
        capabilitySnapshot: snapshot,
      });
      const b = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities: ['load_pdf', 'encode_raster_image'],
        capabilitySnapshot: snapshot,
      });
      expect(a).toEqual(b);
      expect(a.requiredCapabilities).toEqual(['load_pdf', 'encode_raster_image']);
    });

    it('mutiert Eingaben nicht und kopiert Requirements defensiv', () => {
      const mutableRequired = ['write_pdf', 'load_pdf'];
      const snapshotBefore = structuredClone(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT);
      const snapshot = { ...PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT };

      const evaluation = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities:
          mutableRequired as unknown as DocumentFileTransformCapabilityRequirementSet,
        capabilitySnapshot: snapshot,
      });
      mutableRequired[0] = 'decode_raster_image';
      (snapshot as { load_pdf: string }).load_pdf = 'supported';

      expect(evaluation.requiredCapabilities).toEqual(['load_pdf', 'write_pdf']);
      expect(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT).toEqual(snapshotBefore);
    });


    it('friert Ergebnis und Listen ein', () => {
      const evaluation = evaluateDocumentFileTransformCapabilities({
        requiredCapabilities: ['load_pdf', 'encode_raster_image'],
        capabilitySnapshot: PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT,
      });
      expect(Object.isFrozen(evaluation)).toBe(true);
      expect(Object.isFrozen(evaluation.requiredCapabilities)).toBe(true);
      expect(Object.isFrozen(evaluation.unsupportedCapabilities)).toBe(true);
      expect(Object.isFrozen(evaluation.unknownCapabilities)).toBe(true);
      try {
        (evaluation as { status: string }).status = 'supported';
      } catch {
        /* freeze may throw */
      }
      // load_pdf + encode_raster_image are both supported in the project baseline
      expect(evaluation.status).toBe('supported');
    });

    it('ist deterministisch', () => {
      const input = {
        requiredCapabilities: ['load_pdf', 'encode_raster_image'] as DocumentFileTransformCapabilityRequirementSet,
        capabilitySnapshot: PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT,
      };
      expect(evaluateDocumentFileTransformCapabilities(input)).toEqual(
        evaluateDocumentFileTransformCapabilities(input),
      );
    });
  });
});
