import type { DocumentFileTransformTargetKind } from './documentFileTransformPlan';

/**
 * Pure plan for PDF page-1 preview/thumbnail JPEG encode.
 * Does not render PDF pages, invoke the encoder, persist bytes, or bind FileRefs.
 */
export type DocumentFilePdfDerivativeEncodePlanResult =
  | {
      readonly kind: 'page_1_preview_jpeg_encode';
      readonly strategy: 'page_1_preview_jpeg_encode';
      readonly role: 'preview';
      readonly sourceMimeType: 'application/pdf';
      readonly targetMimeType: 'image/jpeg';
      readonly pageNumber: 1;
      readonly quality: number;
      readonly maxEdge: number;
    }
  | {
      readonly kind: 'page_1_thumbnail_jpeg_encode';
      readonly strategy: 'page_1_thumbnail_jpeg_encode';
      readonly role: 'thumbnail';
      readonly sourceMimeType: 'application/pdf';
      readonly targetMimeType: 'image/jpeg';
      readonly pageNumber: 1;
      readonly quality: number;
      readonly maxEdge: number;
    }
  | {
      readonly kind: 'unresolved';
    };

export type DocumentFilePdfDerivativeEncodeRole = Extract<
  DocumentFileTransformTargetKind,
  'preview' | 'thumbnail'
>;
