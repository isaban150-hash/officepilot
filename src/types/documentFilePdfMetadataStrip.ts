/**
 * Pure in-memory PDF Info-dictionary metadata strip result.
 * Clears classic document Info fields only — does not claim XMP removal,
 * persist bytes, create FileRefs, or assert transform capabilities.
 */

/** Classic PDF Info dictionary keys cleared by the strip core. */
export const PDF_INFO_METADATA_STRIP_KEYS = [
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
] as const;

export type PdfInfoMetadataStripKey = (typeof PDF_INFO_METADATA_STRIP_KEYS)[number];

export interface DocumentFilePdfMetadataStripResult {
  readonly bytes: Uint8Array;
  readonly mimeType: 'application/pdf';
  readonly pageCount: number;
  /** Info dictionary keys this core attempts to clear. */
  readonly clearedInfoKeys: readonly PdfInfoMetadataStripKey[];
  /**
   * Always false: this core does not remove or rewrite XMP / Metadata streams.
   * Callers must not treat Info clearing as a full metadata wipe.
   */
  readonly xmpFullyRemoved: false;
}

export type DocumentFilePdfMetadataStripErrorCode =
  | 'invalid_input'
  | 'encrypted'
  | 'corrupt'
  | 'signed'
  | 'strip_failed';

export interface DocumentFilePdfMetadataStripError {
  readonly code: DocumentFilePdfMetadataStripErrorCode;
  readonly message: string;
}
