import type { DocumentFileRepresentationBinding } from './documentFileRepresentationBinding';

/**
 * Pure registration outcome for a document-scoped representation binding
 * against an explicit readonly collection. No storage side effects.
 */
export type DocumentFileRepresentationBindingRegistrationResult =
  | {
      readonly kind: 'created';
      readonly binding: DocumentFileRepresentationBinding;
      readonly bindings: readonly DocumentFileRepresentationBinding[];
    }
  | {
      readonly kind: 'unchanged';
      readonly binding: DocumentFileRepresentationBinding;
      readonly bindings: readonly DocumentFileRepresentationBinding[];
    }
  | {
      readonly kind: 'conflict';
      readonly existingBinding: DocumentFileRepresentationBinding;
      readonly requestedBinding: DocumentFileRepresentationBinding;
      readonly bindings: readonly DocumentFileRepresentationBinding[];
    };
