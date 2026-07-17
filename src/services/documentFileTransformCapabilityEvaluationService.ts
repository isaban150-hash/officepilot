import {
  DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS,
  DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES,
  type DocumentFileTransformCapabilityId,
  type DocumentFileTransformCapabilitySnapshot,
  type DocumentFileTransformCapabilityStatus,
} from '../types/documentFileTransformCapability';
import type {
  DocumentFileTransformCapabilityEvaluation,
  DocumentFileTransformCapabilityRequirementSet,
} from '../types/documentFileTransformCapabilityEvaluation';

export interface EvaluateDocumentFileTransformCapabilitiesInput {
  requiredCapabilities: DocumentFileTransformCapabilityRequirementSet;
  capabilitySnapshot: DocumentFileTransformCapabilitySnapshot;
}

function isCapabilityId(value: unknown): value is DocumentFileTransformCapabilityId {
  return (
    typeof value === 'string' &&
    (DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS as readonly string[]).includes(value)
  );
}

function isCapabilityStatus(value: unknown): value is DocumentFileTransformCapabilityStatus {
  return (DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES as readonly string[]).includes(
    value as string,
  );
}

function assertRequirementSet(
  requiredCapabilities: readonly unknown[],
): asserts requiredCapabilities is DocumentFileTransformCapabilityRequirementSet {
  if (!Array.isArray(requiredCapabilities) || requiredCapabilities.length === 0) {
    throw new TypeError('Invalid transform capability requirements');
  }

  const seen = new Set<string>();
  for (const id of requiredCapabilities) {
    if (!isCapabilityId(id)) {
      throw new TypeError('Invalid transform capability requirements');
    }
    if (seen.has(id)) {
      throw new TypeError('Invalid transform capability requirements');
    }
    seen.add(id);
  }
}

function freezeIdList(
  ids: DocumentFileTransformCapabilityId[],
): readonly DocumentFileTransformCapabilityId[] {
  return Object.freeze(ids.slice());
}

/**
 * Pure evaluation of an explicit non-empty capability requirement set
 * against a capability snapshot. Does not derive requirements from intents.
 */
export function evaluateDocumentFileTransformCapabilities(
  input: EvaluateDocumentFileTransformCapabilitiesInput,
): DocumentFileTransformCapabilityEvaluation {
  assertRequirementSet(input.requiredCapabilities);

  const requiredSet = new Set<DocumentFileTransformCapabilityId>(input.requiredCapabilities);
  const requiredCapabilities = DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS.filter((id) =>
    requiredSet.has(id),
  );

  const unsupportedCapabilities: DocumentFileTransformCapabilityId[] = [];
  const unknownCapabilities: DocumentFileTransformCapabilityId[] = [];

  for (const id of requiredCapabilities) {
    const status = input.capabilitySnapshot[id];
    if (!isCapabilityStatus(status)) {
      throw new TypeError('Invalid transform capability snapshot status');
    }
    if (status === 'unsupported') {
      unsupportedCapabilities.push(id);
    } else if (status === 'unknown') {
      unknownCapabilities.push(id);
    }
  }

  let status: DocumentFileTransformCapabilityStatus = 'supported';
  if (unsupportedCapabilities.length > 0) {
    status = 'unsupported';
  } else if (unknownCapabilities.length > 0) {
    status = 'unknown';
  }

  return Object.freeze({
    status,
    requiredCapabilities: freezeIdList(requiredCapabilities),
    unsupportedCapabilities: freezeIdList(unsupportedCapabilities),
    unknownCapabilities: freezeIdList(unknownCapabilities),
  });
}
