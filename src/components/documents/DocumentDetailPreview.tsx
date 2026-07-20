import { useDocumentFileRepresentationObjectUrl } from '../../hooks/useDocumentFileRepresentationObjectUrl';

export interface DocumentDetailPreviewProps {
  documentId: string;
}

/**
 * Detail JPEG preview from the persisted `preview` representation binding.
 * Loading / missing / error render nothing — callers keep DocumentOriginalFilePanel.
 * Does not fall back to or load the original FileRef.
 */
export function DocumentDetailPreview({ documentId }: DocumentDetailPreviewProps) {
  const { status, objectUrl } = useDocumentFileRepresentationObjectUrl(documentId, 'preview');

  if (status !== 'ready' || !objectUrl) {
    return null;
  }

  return (
    <div
      className="document-detail__representation-preview"
      data-testid={`document-detail-preview-${documentId}`}
    >
      <img
        src={objectUrl}
        alt=""
        className="document-detail__representation-preview-image"
        data-testid={`document-detail-preview-image-${documentId}`}
      />
    </div>
  );
}
