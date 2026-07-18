/**
 * Pure classification of why a create_archive intent cannot use source_reuse
 * materialization — or source_reuse when reuse remains valid.
 * Does not invent a concrete transform strategy, assert capabilities, or bind bytes.
 */
export type DocumentFileArchiveTransformResolutionResult =
  | {
      readonly kind: 'source_reuse';
    }
  | {
      readonly kind: 'metadata_rewrite_required';
    }
  | {
      readonly kind: 'output_conversion_required';
    }
  | {
      readonly kind: 'color_processing_required';
    }
  | {
      readonly kind: 'strategy_unresolved';
    };
