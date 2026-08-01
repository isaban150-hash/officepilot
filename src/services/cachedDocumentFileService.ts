import { validateUploadFile } from './documentUploadValidation';
import { prepareUploadFileForPipeline } from './heicUploadNormalizeService';
import type { DocumentUploadValidationError } from '../types/uploadedDocument';

export interface CachedDocumentFilePayload {
  fileName: string;
  mimeType: string;
  fileSize: number;
  bytes: Uint8Array;
  /** Lazy-built from bytes; not stored in React state longer than needed. */
  dataUrl?: string;
}

export type LoadCachedFileResult =
  | { success: true; payload: CachedDocumentFilePayload }
  | { success: false; error: DocumentUploadValidationError | 'file_read_failed' };

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export function dataUrlFromCachedPayload(payload: CachedDocumentFilePayload): string {
  if (payload.dataUrl) return payload.dataUrl;
  const dataUrl = bytesToDataUrl(payload.bytes, payload.mimeType);
  payload.dataUrl = dataUrl;
  return dataUrl;
}

export function stableFileFromCachedPayload(payload: CachedDocumentFilePayload): File {
  return new File([payload.bytes], payload.fileName, { type: payload.mimeType });
}

export async function loadCachedDocumentFileFromUpload(file: File): Promise<LoadCachedFileResult> {
  const validation = validateUploadFile(file);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const prepared = await prepareUploadFileForPipeline(file);
  if (!prepared.success) {
    return { success: false, error: prepared.error };
  }

  const pipelineFile = prepared.file;

  try {
    const arrayBuffer = await pipelineFile.arrayBuffer();
    return {
      success: true,
      payload: {
        fileName: pipelineFile.name,
        mimeType: pipelineFile.type || 'application/octet-stream',
        fileSize: pipelineFile.size,
        bytes: new Uint8Array(arrayBuffer),
      },
    };
  } catch {
    return { success: false, error: 'file_read_failed' };
  }
}

/** Releases optional dataUrl reference to reduce memory after successful storage. */
export function releaseCachedDocumentFile(payload: CachedDocumentFilePayload): void {
  delete payload.dataUrl;
}
