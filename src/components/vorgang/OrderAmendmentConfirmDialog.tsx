import { useEffect, useId, useRef, type RefObject } from 'react';
import { Button } from '../ui/Button';

export interface OrderAmendmentConfirmDialogProps {
  open: boolean;
  title: string;
  titleLabel: string;
  amendmentTitle: string;
  positionsLabel: string;
  positionsValue: string;
  totalLabel: string;
  formattedTotal: string;
  impactText: string;
  noInvoiceText: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Parent-driven busy flag while orchestration runs (dialog should already be closed). */
  confirming?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}

function tryFocus(element: HTMLElement | null | undefined): boolean {
  if (!element || !element.isConnected) return false;
  if ('disabled' in element && Boolean((element as HTMLButtonElement).disabled)) {
    return false;
  }
  if (element.getAttribute('aria-disabled') === 'true') return false;
  try {
    element.focus({ preventScroll: true });
    return document.activeElement === element;
  } catch {
    return false;
  }
}

function restoreFocus(
  previous: HTMLElement | null,
  fallback: HTMLElement | null | undefined,
): void {
  if (tryFocus(previous)) return;
  if (tryFocus(fallback)) return;
}

/**
 * Accessible confirmation dialog for order-amendment confirm.
 * Presentation only — callers own orchestration and intent state.
 */
export function OrderAmendmentConfirmDialog({
  open,
  title,
  titleLabel,
  amendmentTitle,
  positionsLabel,
  positionsValue,
  totalLabel,
  formattedTotal,
  impactText,
  noInvoiceText,
  confirmLabel,
  cancelLabel,
  confirming = false,
  returnFocusRef,
  fallbackFocusRef,
  onConfirm,
  onCancel,
}: OrderAmendmentConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const startedRef = useRef(false);
  const restoreToFallbackRef = useRef(false);

  useEffect(() => {
    if (open) {
      previousFocusRef.current =
        returnFocusRef?.current ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      wasOpenRef.current = true;
      startedRef.current = false;
      restoreToFallbackRef.current = false;
      const focusCancel = () => {
        const cancelButton = dialogRef.current?.querySelector<HTMLButtonElement>(
          '[data-testid="order-amendment-confirm-dialog-cancel"]',
        );
        cancelButton?.focus();
      };
      const rafId = window.requestAnimationFrame(focusCancel);
      return () => window.cancelAnimationFrame(rafId);
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const preferFallback = restoreToFallbackRef.current;
      restoreToFallbackRef.current = false;
      const previous = preferFallback ? null : previousFocusRef.current;
      previousFocusRef.current = null;
      const rafId = window.requestAnimationFrame(() => {
        restoreFocus(previous, fallbackFocusRef?.current ?? null);
      });
      return () => window.cancelAnimationFrame(rafId);
    }
    return undefined;
  }, [open, returnFocusRef, fallbackFocusRef]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (startedRef.current || confirming) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel, confirming]);

  const handleConfirm = () => {
    if (startedRef.current || confirming) return;
    startedRef.current = true;
    restoreToFallbackRef.current = true;
    onConfirm();
  };

  const handleCancel = () => {
    if (startedRef.current || confirming) return;
    onCancel();
  };

  if (!open) return null;

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={handleCancel}>
      <div
        ref={dialogRef}
        className="vorgang-dialog order-amendment-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid="order-amendment-confirm-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} className="vorgang-dialog__title">
          {title}
        </h3>

        <div
          id={descriptionId}
          className="order-amendment-confirm-dialog__body"
          data-testid="order-amendment-confirm-dialog-summary"
        >
          <dl className="order-amendment-confirm-dialog__summary">
            <div className="order-amendment-confirm-dialog__row">
              <dt>{titleLabel}</dt>
              <dd data-testid="order-amendment-confirm-dialog-title-value">{amendmentTitle}</dd>
            </div>
            <div className="order-amendment-confirm-dialog__row">
              <dt>{positionsLabel}</dt>
              <dd data-testid="order-amendment-confirm-dialog-positions-value">
                {positionsValue}
              </dd>
            </div>
            <div className="order-amendment-confirm-dialog__row">
              <dt>{totalLabel}</dt>
              <dd data-testid="order-amendment-confirm-dialog-total-value">{formattedTotal}</dd>
            </div>
          </dl>

          <p className="order-amendment-confirm-dialog__impact">{impactText}</p>
          <p className="order-amendment-confirm-dialog__no-invoice">{noInvoiceText}</p>
        </div>

        <div className="vorgang-dialog__actions order-amendment-confirm-dialog__actions">
          <Button
            variant="outline"
            fullWidth
            disabled={confirming}
            onClick={handleCancel}
            data-testid="order-amendment-confirm-dialog-cancel"
          >
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            fullWidth
            disabled={confirming}
            loading={confirming}
            onClick={handleConfirm}
            data-testid="order-amendment-confirm-dialog-confirm"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
