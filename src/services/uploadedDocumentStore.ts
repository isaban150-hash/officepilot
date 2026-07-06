import type { UploadedDocument } from '../types/uploadedDocument';

let uploadedDocuments: UploadedDocument[] = [];

function cloneUploadedDocument(doc: UploadedDocument): UploadedDocument {
  return { ...doc };
}

function withPreviewUrl(doc: UploadedDocument): UploadedDocument {
  return {
    ...doc,
    previewUrl: doc.originalFileDataUrl,
  };
}

export function hydrateUploadedDocumentStore(items: UploadedDocument[]): void {
  uploadedDocuments = items.map((item) => withPreviewUrl(cloneUploadedDocument(item)));
}

export function getUploadedDocumentStoreSnapshot(): UploadedDocument[] {
  return uploadedDocuments.map((doc) => {
    const { previewUrl: _preview, ...persisted } = cloneUploadedDocument(doc);
    return persisted;
  });
}

export function getAllUploadedDocuments(): UploadedDocument[] {
  return uploadedDocuments.map(cloneUploadedDocument);
}

export function getUploadedDocumentById(id: string): UploadedDocument | undefined {
  const doc = uploadedDocuments.find((item) => item.id === id);
  return doc ? cloneUploadedDocument(doc) : undefined;
}

export function addUploadedDocumentToStore(doc: UploadedDocument): UploadedDocument {
  const stored = withPreviewUrl(cloneUploadedDocument(doc));
  uploadedDocuments = [stored, ...uploadedDocuments];
  return cloneUploadedDocument(stored);
}

export function setUploadedDocumentStoreForTests(items: UploadedDocument[]): void {
  uploadedDocuments = items.map((item) => withPreviewUrl(cloneUploadedDocument(item)));
}

export function resetUploadedDocumentStore(): void {
  uploadedDocuments = [];
}
