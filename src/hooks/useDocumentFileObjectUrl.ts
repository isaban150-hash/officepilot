import { useEffect, useState } from 'react';
import type { DocumentFileRef } from '../types/documentFileRef';
import {
  getDocumentFileBlob,
  getDocumentFileDataUrl,
} from '../services/documentFileStoreService';

export function useDocumentFileObjectUrl(fileRef: DocumentFileRef | undefined): string | undefined {
  const [objectUrl, setObjectUrl] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | undefined;

    void (async () => {
      if (!fileRef) {
        setObjectUrl(undefined);
        return;
      }

      if (fileRef.storageType === 'local_data_url') {
        const dataUrl = getDocumentFileDataUrl(fileRef);
        if (!cancelled) {
          setObjectUrl(dataUrl);
        }
        return;
      }

      try {
        const blob = await getDocumentFileBlob(fileRef);
        if (cancelled || !blob) {
          if (!cancelled) setObjectUrl(undefined);
          return;
        }
        createdUrl = URL.createObjectURL(blob);
        if (!cancelled) {
          setObjectUrl(createdUrl);
        }
      } catch {
        if (!cancelled) setObjectUrl(undefined);
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
      setObjectUrl(undefined);
    };
  }, [fileRef?.id, fileRef?.storageType, fileRef?.localDataKey]);

  return objectUrl;
}
