/**
 * Pure archive materialization classification for a create_archive intent.
 * Does not bind representations, persist bytes, or assert runtime capability support.
 */
export type DocumentFileTransformArchiveMaterializationResult =
  | {
      readonly kind: 'source_reuse';
    }
  | {
      readonly kind: 'unresolved';
    };
