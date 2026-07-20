import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { buildDocumentFileDerivativeRecoveryDetailStatus } from '../../services/documentFileDerivativeRecoveryDetailStatusService';
import { executeDocumentFileDerivativeRecoveryDetailRetry } from '../../services/documentFileDerivativeRecoveryDetailRetryService';
import type { DocumentFileDerivativeRecoveryDetailStatusViewModel } from '../../types/documentFileDerivativeRecoveryDetailStatus';
import type { DocumentFileRepresentationBindingKind } from '../../types/documentFileRepresentationBinding';
import type { DocumentFileDerivativeStepId } from '../../types/documentFileDerivativeStepOutcome';

export interface DocumentDerivativeRecoveryStatusPanelProps {
  documentId: string;
  /** Called after a successful retry or already_ready so the preview can remount. */
  onRecovered?: () => void;
}

type RowRetryUi =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'failed' }
  | { phase: 'in_flight' };

function buttonLabel(ui: RowRetryUi): string {
  switch (ui.phase) {
    case 'running':
      return 'Wird erstellt…';
    case 'failed':
      return 'Erneut fehlgeschlagen';
    case 'in_flight':
      return 'Wird bereits ausgeführt';
    case 'idle':
    default:
      return 'Erneut erstellen';
  }
}

/**
 * Diagnose block for missing derived representations with per-row manual retry.
 */
export function DocumentDerivativeRecoveryStatusPanel({
  documentId,
  onRecovered,
}: DocumentDerivativeRecoveryStatusPanelProps) {
  const [viewModel, setViewModel] =
    useState<DocumentFileDerivativeRecoveryDetailStatusViewModel | null>(null);
  const [rowUi, setRowUi] = useState<
    Partial<Record<DocumentFileRepresentationBindingKind, RowRetryUi>>
  >({});
  const inFlightRef = useRef<
    Partial<Record<DocumentFileRepresentationBindingKind, boolean>>
  >({});

  const reloadStatus = async (): Promise<void> => {
    try {
      const next = await buildDocumentFileDerivativeRecoveryDetailStatus(documentId);
      setViewModel(next);
    } catch {
      setViewModel(null);
    }
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const next = await buildDocumentFileDerivativeRecoveryDetailStatus(documentId);
        if (!cancelled) {
          setViewModel(next);
          setRowUi({});
          inFlightRef.current = {};
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

  const handleRetry = (
    representationKind: DocumentFileRepresentationBindingKind,
    selectedStepId: DocumentFileDerivativeStepId,
  ): void => {
    if (inFlightRef.current[representationKind]) {
      return;
    }
    inFlightRef.current[representationKind] = true;
    setRowUi((prev) => ({
      ...prev,
      [representationKind]: { phase: 'running' },
    }));

    void (async () => {
      try {
        const result = await executeDocumentFileDerivativeRecoveryDetailRetry({
          documentId,
          selectedStepId,
        });

        await reloadStatus();

        if (result.feedback === 'success') {
          setRowUi((prev) => {
            const next = { ...prev };
            delete next[representationKind];
            return next;
          });
          onRecovered?.();
          return;
        }

        if (result.feedback === 'in_flight') {
          setRowUi((prev) => ({
            ...prev,
            [representationKind]: { phase: 'in_flight' },
          }));
          return;
        }

        if (result.feedback === 'failed') {
          setRowUi((prev) => ({
            ...prev,
            [representationKind]: { phase: 'failed' },
          }));
          return;
        }

        // missing_plan / noop — rebuild already ran; drop local row state
        setRowUi((prev) => {
          const next = { ...prev };
          delete next[representationKind];
          return next;
        });
      } catch {
        await reloadStatus();
        setRowUi((prev) => ({
          ...prev,
          [representationKind]: { phase: 'failed' },
        }));
      } finally {
        inFlightRef.current[representationKind] = false;
      }
    })();
  };

  if (!viewModel || viewModel.problems.length === 0) {
    return null;
  }

  return (
    <Card className="document-detail__recovery-status">
      <div data-testid={`document-derivative-recovery-status-${documentId}`}>
        <h3 className="document-detail__recovery-status-title">Ableitungen</h3>
        <ul className="document-detail__recovery-status-list">
          {viewModel.problems.map((problem) => {
            const ui = rowUi[problem.representationKind] ?? { phase: 'idle' };
            const showRetry =
              problem.canRetry === true &&
              typeof problem.selectedStepId === 'string' &&
              problem.selectedStepId.length > 0;
            const busy = ui.phase === 'running' || ui.phase === 'in_flight';

            return (
              <li
                key={problem.representationKind}
                className="document-detail__recovery-status-item"
                data-testid={`document-derivative-recovery-problem-${problem.representationKind}`}
                data-status={problem.status}
                data-can-retry={problem.canRetry ? 'true' : 'false'}
              >
                <p className="document-detail__recovery-status-item-title">
                  {problem.displayTitle}
                </p>
                <p className="document-detail__recovery-status-item-detail">
                  {problem.displayDetail}
                </p>
                {problem.retryHint ? (
                  <p className="document-detail__recovery-status-item-hint">
                    {problem.retryHint}
                  </p>
                ) : null}
                {showRetry ? (
                  <div className="document-detail__recovery-status-item-actions">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      data-testid={`document-derivative-recovery-retry-${problem.representationKind}`}
                      onClick={() => {
                        if (!problem.selectedStepId) return;
                        handleRetry(problem.representationKind, problem.selectedStepId);
                      }}
                    >
                      {buttonLabel(ui)}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
