import type { DocumentFileRepresentationBinding } from '../types/documentFileRepresentationBinding';
import { createDocumentFileRepresentationBinding } from './documentFileRepresentationBindingService';

let representationBindings: DocumentFileRepresentationBinding[] = [];

function cloneBinding(binding: DocumentFileRepresentationBinding): DocumentFileRepresentationBinding {
  return createDocumentFileRepresentationBinding({
    documentId: binding.documentId,
    kind: binding.kind,
    fileRefId: binding.fileRefId,
    /*
     * E-RECHNUNG-04E3 — die Unterrolle überlebt das Klonen.
     *
     * Der Store gibt jede Bindung durch die Fabrik, bevor er sie herausgibt
     * oder aufnimmt. Ohne dieses Feld ging `part` genau hier verloren: Die
     * Registrierung legte zwei Bindungen korrekt an, und beim nächsten Lesen
     * trugen beide keine Unterrolle mehr — die ZUGFeRD-Rechnung war damit
     * nicht mehr auffindbar.
     */
    part: binding.part,
  });
}

/**
 * Replace in-memory representation bindings. Does not persist.
 */
export function hydrateDocumentFileRepresentationBindingStore(
  bindings: readonly DocumentFileRepresentationBinding[] = [],
): void {
  if (!Array.isArray(bindings)) {
    throw new TypeError('Invalid representation binding store hydrate input');
  }
  representationBindings = bindings.map(cloneBinding);
}

export function resetDocumentFileRepresentationBindingStoreForTests(): void {
  representationBindings = [];
}

export function getDocumentFileRepresentationBindingStoreSnapshot(): DocumentFileRepresentationBinding[] {
  return representationBindings.map(cloneBinding);
}

export function replaceDocumentFileRepresentationBindingStore(
  bindings: readonly DocumentFileRepresentationBinding[],
): void {
  if (!Array.isArray(bindings)) {
    throw new TypeError('Invalid representation binding store replace input');
  }
  representationBindings = bindings.map(cloneBinding);
}

export function removeDocumentFileRepresentationBindingsForDocument(documentId: string): number {
  if (typeof documentId !== 'string' || documentId.length === 0 || documentId.trim().length === 0) {
    throw new TypeError('Invalid representation binding documentId');
  }
  const before = representationBindings.length;
  representationBindings = representationBindings.filter((entry) => entry.documentId !== documentId);
  return before - representationBindings.length;
}
