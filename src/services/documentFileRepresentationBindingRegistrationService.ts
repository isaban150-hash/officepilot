import type { DocumentFileRepresentationBinding } from '../types/documentFileRepresentationBinding';
import type { DocumentFileRepresentationBindingRegistrationResult } from '../types/documentFileRepresentationBindingRegistration';
import {
  createDocumentFileRepresentationBinding,
  toDocumentFileRepresentationBindingNaturalKey,
} from './documentFileRepresentationBindingService';

export interface RegisterDocumentFileRepresentationBindingInput {
  bindings: readonly DocumentFileRepresentationBinding[];
  binding: DocumentFileRepresentationBinding;
}

function freezeBindings(
  bindings: readonly DocumentFileRepresentationBinding[],
): readonly DocumentFileRepresentationBinding[] {
  return Object.freeze(bindings.slice());
}

function naturalKeysEqual(
  left: DocumentFileRepresentationBinding,
  right: DocumentFileRepresentationBinding,
): boolean {
  const a = toDocumentFileRepresentationBindingNaturalKey(left);
  const b = toDocumentFileRepresentationBindingNaturalKey(right);
  return a.documentId === b.documentId && a.kind === b.kind;
}

/**
 * Pure collection registration: create / unchanged / conflict by natural key.
 * Does not mutate inputs, persist, or replace conflicting bindings.
 */
export function registerDocumentFileRepresentationBinding(
  input: RegisterDocumentFileRepresentationBindingInput,
): DocumentFileRepresentationBindingRegistrationResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid representation binding registration input');
  }

  if (!Array.isArray(input.bindings)) {
    throw new TypeError('Invalid representation binding registration bindings');
  }

  // Normalize/validate requested binding via existing factory — no second validator.
  const requestedBinding = createDocumentFileRepresentationBinding({
    documentId: input.binding?.documentId,
    kind: input.binding?.kind,
    fileRefId: input.binding?.fileRefId,
  });

  const existingBinding = input.bindings.find((entry) =>
    naturalKeysEqual(entry, requestedBinding),
  );

  const bindingsSnapshot = freezeBindings(input.bindings);

  if (!existingBinding) {
    return Object.freeze({
      kind: 'created',
      binding: requestedBinding,
      bindings: freezeBindings([...input.bindings, requestedBinding]),
    });
  }

  if (existingBinding.fileRefId === requestedBinding.fileRefId) {
    return Object.freeze({
      kind: 'unchanged',
      binding: existingBinding,
      bindings: bindingsSnapshot,
    });
  }

  return Object.freeze({
    kind: 'conflict',
    existingBinding,
    requestedBinding,
    bindings: bindingsSnapshot,
  });
}
