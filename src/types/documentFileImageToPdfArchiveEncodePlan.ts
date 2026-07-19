import type { ImageToPdfSourceMimeType } from './documentFileImageToPdfWrite';

/**
 * Pure plan for raster archive conversion to a single-page PDF.
 * Does not invoke the writer, persist bytes, or bind FileRefs.
 */
export type DocumentFileImageToPdfArchiveEncodePlanResult =
  | {
      readonly kind: 'image_to_pdf';
      readonly strategy: 'image_to_pdf';
      readonly sourceMimeType: ImageToPdfSourceMimeType;
      readonly targetMimeType: 'application/pdf';
      readonly pageWidth: number;
      readonly pageHeight: number;
    }
  | {
      readonly kind: 'unresolved';
    };
