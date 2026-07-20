import type { DocumentFileRepresentationBinding } from './documentFileRepresentationBinding';
import type { DocumentFileRef } from './documentFileRef';

/**
 * Pure read result for a persisted non-original representation binding.
 * Does not invent fallbacks to original, create Object URLs, or transform bytes.
 */
export type DocumentFileRepresentationReadResult =
  | {
      readonly kind: 'ready';
      readonly binding: DocumentFileRepresentationBinding;
      readonly fileRef: DocumentFileRef;
      readonly blob: Blob;
    }
  | {
      readonly kind: 'missing_binding';
    }
  | {
      readonly kind: 'missing_file_ref';
    }
  | {
      readonly kind: 'not_committed';
    }
  | {
      readonly kind: 'missing_blob';
    };
