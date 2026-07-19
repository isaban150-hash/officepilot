import {
  DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS,
  DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES,
  type DocumentFileTransformCapabilityId,
  type DocumentFileTransformCapabilitySnapshot,
  type DocumentFileTransformCapabilityStatus,
} from '../types/documentFileTransformCapability';

/**
 * Supplies a complete capability snapshot for the current runtime/build.
 * Async so a later probe provider can perform asynchronous checks.
 * Never datei- or intent-specific.
 */
export interface DocumentFileTransformCapabilityProvider {
  getSnapshot(): Promise<DocumentFileTransformCapabilitySnapshot>;
}

/**
 * Project-static baseline for the current OfficePilot build.
 * Not a browser feature detection result.
 * - supported: productive path exists in this build (technical availability only)
 * - unknown: library/path may exist, runtime not probed
 * - unsupported: no productive path in this build
 *
 * supported does not imply every transform intent is orchestrated or persisted
 * (e.g. PDF load/render does not imply PDF preview/thumbnail FileRefs).
 */
export const PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT = {
  load_pdf: 'supported',
  render_pdf_page: 'supported',
  decode_raster_image: 'supported',
  encode_raster_image: 'supported',
  write_pdf: 'unsupported',
} as const satisfies DocumentFileTransformCapabilitySnapshot;

function isCapabilityStatus(value: unknown): value is DocumentFileTransformCapabilityStatus {
  return (DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES as readonly string[]).includes(
    value as string,
  );
}

function isCapabilityId(value: string): value is DocumentFileTransformCapabilityId {
  return (DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS as readonly string[]).includes(value);
}

/**
 * Validates a complete snapshot against the central capability/status catalogs.
 * Throws TypeError on incomplete, invalid, or unknown keys — no silent defaults.
 */
export function assertDocumentFileTransformCapabilitySnapshot(
  snapshot: unknown,
): asserts snapshot is DocumentFileTransformCapabilitySnapshot {
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new TypeError('Invalid transform capability snapshot');
  }

  const record = snapshot as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length !== DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS.length) {
    throw new TypeError('Invalid transform capability snapshot');
  }

  for (const key of keys) {
    if (!isCapabilityId(key)) {
      throw new TypeError('Invalid transform capability snapshot');
    }
  }

  for (const id of DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS) {
    if (!(id in record) || !isCapabilityStatus(record[id])) {
      throw new TypeError('Invalid transform capability snapshot');
    }
  }
}

function freezeSnapshot(
  snapshot: DocumentFileTransformCapabilitySnapshot,
): DocumentFileTransformCapabilitySnapshot {
  const copy = {} as Record<DocumentFileTransformCapabilityId, DocumentFileTransformCapabilityStatus>;
  for (const id of DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS) {
    copy[id] = snapshot[id];
  }
  return Object.freeze(copy);
}

/**
 * Creates a static provider from a complete injected snapshot.
 * Defensive copy; no browser APIs; no merge with project defaults.
 */
export function createStaticDocumentFileTransformCapabilityProvider(
  snapshot: DocumentFileTransformCapabilitySnapshot,
): DocumentFileTransformCapabilityProvider {
  assertDocumentFileTransformCapabilitySnapshot(snapshot);
  const frozen = freezeSnapshot(snapshot);

  return {
    getSnapshot(): Promise<DocumentFileTransformCapabilitySnapshot> {
      return Promise.resolve(frozen);
    },
  };
}

/** Provider using the project-static baseline snapshot for this OfficePilot build. */
export function createProjectStaticDocumentFileTransformCapabilityProvider(): DocumentFileTransformCapabilityProvider {
  return createStaticDocumentFileTransformCapabilityProvider(
    PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT,
  );
}
