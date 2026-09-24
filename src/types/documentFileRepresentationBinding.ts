import {
  DOCUMENT_FILE_REPRESENTATION_KINDS,
  type DocumentFileRepresentationKind,
} from './documentFileRepresentation';

/**
 * Additional representation roles that may be persisted as document-scoped bindings.
 * `original` remains document.fileRefId in the current transitional architecture.
 */
export const DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS =
  DOCUMENT_FILE_REPRESENTATION_KINDS.filter(
    (kind): kind is Exclude<DocumentFileRepresentationKind, 'original'> => kind !== 'original',
  );

export type DocumentFileRepresentationBindingKind =
  (typeof DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS)[number];

/**
 * Backend-neutral persisted binding shape: document role → existing FileRef.
 * Does not store denormalized file metadata; those stay on DocumentFileRef.
 */
export interface DocumentFileRepresentationBinding {
  readonly documentId: string;
  readonly kind: DocumentFileRepresentationBindingKind;
  readonly fileRefId: string;
  /**
   * E-RECHNUNG-04E3 — die Unterrolle innerhalb einer Rolle.
   *
   * Ein Beleg kann mehrere strukturierte Darstellungen tragen: die XRechnung
   * als XML und die ZUGFeRD-Rechnung als Hybrid-PDF. Beide sind `structured`,
   * beide gehören demselben Dokument — und ohne eine zweite Unterscheidung
   * würde die eine die andere verdrängen.
   *
   * Der Server kennt diese Spalte längst; sein eindeutiger Index lautet
   * `(workspace_id, client_document_id, binding_kind, coalesce(part, ''))`.
   * Auch Push, Pull und Sync-Kennung lesen `part` bereits. Nur die Entität,
   * die Fabrik und der Vergleich hier wussten nichts davon — genau das wird
   * jetzt geschlossen. **Keine Migration nötig.**
   *
   * Fehlender, leerer und aus Leerzeichen bestehender Wert sind dasselbe:
   * „keine Unterrolle". Der Server rechnet mit `coalesce(part, '')` genauso.
   * Ältere Bindungen aus 04D3 tragen deshalb keinen Wert und bleiben gültig.
   */
  readonly part?: string | null;
  /** 01B — Herkunft der Repraesentation (Cloud-Spiegel); lokal bisher immer `derived`. */
  readonly provenance?: 'received' | 'extracted' | 'derived';
  readonly sync?: import('./sync').SyncMeta;
}

/**
 * Natural uniqueness key for one active binding per document role.
 * Document-scoped — not FileRef-scoped — so duplicate-shared FileRefs stay correct.
 *
 * E-RECHNUNG-04E3 — inklusive `part`, damit XRechnung und ZUGFeRD unter
 * derselben Rolle nebeneinander bestehen. Der Schlüssel trägt den
 * **normalisierten** Wert: `''` für „keine Unterrolle", wie serverseitig auch.
 */
export interface DocumentFileRepresentationBindingNaturalKey {
  readonly documentId: string;
  readonly kind: DocumentFileRepresentationBindingKind;
  readonly part: string;
}

/**
 * Die eine Stelle, an der entschieden wird, was „keine Unterrolle" heisst.
 *
 * `undefined`, `null`, `''` und reine Leerzeichen bedeuten dasselbe. Würde das
 * an mehreren Stellen einzeln entschieden, liefen Vergleich, Speicherung und
 * Sync früher oder später auseinander — und dann verschwände eine Bindung,
 * ohne dass jemand sähe, warum.
 */
export function normalizeDocumentFileRepresentationBindingPart(
  part: string | null | undefined,
): string {
  return typeof part === 'string' ? part.trim() : '';
}
