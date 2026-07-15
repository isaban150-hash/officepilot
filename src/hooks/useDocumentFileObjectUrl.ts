import { useEffect, useState } from 'react';
import type { DocumentFileRef } from '../types/documentFileRef';
import {
  getDocumentFileBlob,
  getDocumentFileDataUrl,
} from '../services/documentFileStoreService';

export type DocumentFileObjectUrlStatus = 'idle' | 'loading' | 'ready' | 'missing';

export interface DocumentFileObjectUrlState {
  status: DocumentFileObjectUrlStatus;
  objectUrl: string | undefined;
}

export function useDocumentFileObjectUrl(fileRef: DocumentFileRef | undefined): DocumentFileObjectUrlState {
  const [state, setState] = useState<DocumentFileObjectUrlState>({
    status: fileRef ? 'loading' : 'idle',
    objectUrl: undefined,
  });

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | undefined;

    void (async () => {
      if (!fileRef) {
        setState({ status: 'idle', objectUrl: undefined });
        return;
      }

      setState({ status: 'loading', objectUrl: undefined });

      if (fileRef.storageType === 'local_data_url') {
        const dataUrl = getDocumentFileDataUrl(fileRef);
        if (!cancelled) {
          setState({
            status: dataUrl ? 'ready' : 'missing',
            objectUrl: dataUrl,
          });
        }
        return;
      }

      try {
        const blob = await getDocumentFileBlob(fileRef);
        if (cancelled) return;
        if (!blob) {
          setState({ status: 'missing', objectUrl: undefined });
          return;
        }
        createdUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', objectUrl: createdUrl });
      } catch {
        if (!cancelled) {
          setState({ status: 'missing', objectUrl: undefined });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [fileRef?.id, fileRef?.storageType, fileRef?.localDataKey]);

  return state;
}
