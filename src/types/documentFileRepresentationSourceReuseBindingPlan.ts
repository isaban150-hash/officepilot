/**
 * Declarative plan to bind the archive representation role to an existing FileRef.
 * Does not persist, allocate representation IDs, or write bytes.
 */
export interface DocumentFileRepresentationSourceReuseBindingPlan {
  readonly mode: 'reuse_source_file';
  readonly targetKind: 'archive';
  readonly sourceFileRefId: string;
}
