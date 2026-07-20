import { useEffect, useState } from 'react';
import type { DocumentFileRepresentationBindingKind } from '../types/documentFileRepresentationBinding';
import { resolveDocumentFileRepresentation } from '../services/documentFileRepresentationReadService';
import type {
  DocumentFileObjectUrlState,
  DocumentFileObjectUrlStatus,
} from './useDocumentFileObjectUrl';

export type { DocumentFileObjectUrlState, DocumentFileObjectUrlStatus };

/**
 * Resolve a persisted representation binding to an Object URL for display.
 * Does not fall back to original, mutate stores, or transform bytes.
 * Callers must only pass archive|preview|thumbnail kinds (never original).
 */
export function useDocumentFileRepresentationObjectUrl(
  documentId: string | undefined,
  kind: DocumentFileRepresentationBindingKind,
  /** Bump to force a fresh resolve (e.g. after derivative recovery). */
  revision = 0,
): DocumentFileObjectUrlState {
  const [state, setState] = useState<DocumentFileObjectUrlState>({
    status: documentId ? 'loading' : 'idle',
    objectUrl: undefined,
  });

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | undefined;

    void (async () => {
      if (!documentId) {
        setState({ status: 'idle', objectUrl: undefined });
        return;
      }

      setState({ status: 'loading', objectUrl: undefined });

      try {
        const resolved = await resolveDocumentFileRepresentation({
          documentId,
          kind,
        });

        if (cancelled) return;

        if (resolved.kind !== 'ready') {
          setState({ status: 'missing', objectUrl: undefined });
          return;
        }

        createdUrl = URL.createObjectURL(resolved.blob);
        if (cancelled) {
          URL.revokeObjectURL(createdUrl);
          createdUrl = undefined;
          return;
        }

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
  }, [documentId, kind, revision]);

  return state;
}
