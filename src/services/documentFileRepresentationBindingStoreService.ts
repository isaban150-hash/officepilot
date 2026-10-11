import type { DocumentFileRepresentationBinding } from '../types/documentFileRepresentationBinding';
import { createDocumentFileRepresentationBinding } from './documentFileRepresentationBindingService';

let representationBindings: DocumentFileRepresentationBinding[] = [];

function cloneBinding(binding: DocumentFileRepresentationBinding): DocumentFileRepresentationBinding {
  const normalized = createDocumentFileRepresentationBinding({
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
  /*
   * GO-LIVE-SECURITY-01 / FINALISIERUNG — Serverstand und Vertrauensmarke
   * überleben das Klonen.
   *
   * Die Fabrik kennt nur die fachlichen Felder. Bisher fiel deshalb hier die
   * Sync-Version weg: Jede gespeicherte Bindung sah danach aus, als hätte die
   * Cloud sie nie gesehen, und ein Ersetzen ginge mit Version 0 hinaus — in
   * einen Versionskonflikt. Ebenso fiel die Marke des Servers weg, an der der
   * Client eine nicht vertrauenswürdige E-Rechnungsdatei erkennt.
   */
  if (!binding.sync && !binding.einvoiceUntrustedAt) return normalized;
  return Object.freeze({
    ...normalized,
    ...(binding.einvoiceUntrustedAt ? { einvoiceUntrustedAt: binding.einvoiceUntrustedAt } : {}),
    ...(binding.sync ? { sync: { ...binding.sync } } : {}),
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
