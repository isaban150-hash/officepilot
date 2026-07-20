import { useDocumentFileRepresentationObjectUrl } from '../../hooks/useDocumentFileRepresentationObjectUrl';

export interface DocumentCardThumbnailProps {
  documentId: string;
  /** Existing emoji/text placeholder when thumbnail is loading or missing. */
  placeholder: string;
}

/**
 * List-card thumbnail from the persisted `thumbnail` representation binding.
 * Loading / missing / error keep the placeholder — never loads the original FileRef.
 */
export function DocumentCardThumbnail({ documentId, placeholder }: DocumentCardThumbnailProps) {
  const { status, objectUrl } = useDocumentFileRepresentationObjectUrl(documentId, 'thumbnail');
  const showImage = status === 'ready' && Boolean(objectUrl);

  return (
    <span
      className={`document-card__preview${showImage ? '' : ' document-card__preview--placeholder'}`}
      aria-hidden
      data-testid={`document-card-preview-${documentId}`}
    >
      {showImage ? (
        <img
          src={objectUrl}
          alt=""
          className="document-card__thumbnail"
          data-testid={`document-card-thumbnail-${documentId}`}
        />
      ) : (
        placeholder
      )}
    </span>
  );
}
