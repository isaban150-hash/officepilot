import { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { buildDocumentFileDerivativeRecoveryDetailStatus } from '../../services/documentFileDerivativeRecoveryDetailStatusService';
import type { DocumentFileDerivativeRecoveryDetailStatusViewModel } from '../../types/documentFileDerivativeRecoveryDetailStatus';

export interface DocumentDerivativeRecoveryStatusPanelProps {
  documentId: string;
}

/**
 * Read-only diagnose block for missing derived representations.
 * Shows canRetry as informational hint only — no retry action.
 */
export function DocumentDerivativeRecoveryStatusPanel({
  documentId,
}: DocumentDerivativeRecoveryStatusPanelProps) {
  const [viewModel, setViewModel] =
    useState<DocumentFileDerivativeRecoveryDetailStatusViewModel | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const next = await buildDocumentFileDerivativeRecoveryDetailStatus(documentId);
        if (!cancelled) {
          setViewModel(next);
        }
      } catch {
        if (!cancelled) {
          setViewModel(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  if (!viewModel || viewModel.problems.length === 0) {
    return null;
  }

  return (
    <Card
      className="document-detail__recovery-status"
      data-testid={`document-derivative-recovery-status-${documentId}`}
    >
      <h3 className="document-detail__recovery-status-title">Ableitungen</h3>
      <ul className="document-detail__recovery-status-list">
        {viewModel.problems.map((problem) => (
          <li
            key={problem.representationKind}
            className="document-detail__recovery-status-item"
            data-testid={`document-derivative-recovery-problem-${problem.representationKind}`}
            data-status={problem.status}
            data-can-retry={problem.canRetry ? 'true' : 'false'}
          >
            <p className="document-detail__recovery-status-item-title">{problem.displayTitle}</p>
            <p className="document-detail__recovery-status-item-detail">{problem.displayDetail}</p>
            {problem.retryHint ? (
              <p className="document-detail__recovery-status-item-hint">{problem.retryHint}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
