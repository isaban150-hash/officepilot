import type { PdfInfoMetadataStripKey } from './documentFilePdfMetadataStrip';

/**
 * Pure plan for create_archive PDF Info-dictionary metadata strip.
 * Does not invoke the strip core, persist bytes, or bind FileRefs.
 * Does not claim XMP removal or that signed/encrypted/corrupt PDFs are strip-safe.
 */
export type DocumentFilePdfMetadataStripPlanResult =
  | {
      readonly kind: 'pdf_info_metadata_strip';
      readonly strategy: 'pdf_info_metadata_strip';
      readonly sourceMimeType: 'application/pdf';
      readonly targetMimeType: 'application/pdf';
      readonly clearedInfoKeys: readonly PdfInfoMetadataStripKey[];
      /**
       * Always false: Info-dict strip is not a full XMP / Metadata-stream wipe.
       */
      readonly xmpFullyRemoved: false;
      /**
       * Always false: this plan does not inspect bytes and does not claim that
       * signed, encrypted, password-protected, or corrupt PDFs are safe to strip.
       */
      readonly stripInputSafetyVerified: false;
    }
  | {
      readonly kind: 'unresolved';
    };
