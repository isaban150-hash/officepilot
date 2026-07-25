import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Button, type ButtonVariant } from './Button';

interface SimpleConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmVariant?: ButtonVariant;
  confirmTestId?: string;
  cancelTestId?: string;
  dialogTestId?: string;
  /** Shown inside the dialog when onConfirm returns false or throws. */
  failureMessage?: string;
  /**
   * Element that should receive focus when the dialog closes.
   * Prefer capturing this in the trigger click handler before opening.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Focus target when returnFocusRef is missing or no longer focusable. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Return true after the caller closed the dialog (open=false).
   * Return false to keep the dialog open after a failed action.
   */
  onConfirm: () => boolean | Promise<boolean>;
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

export function SimpleConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  confirmVariant = 'danger',
  confirmTestId = 'simple-confirm-confirm',
  cancelTestId = 'simple-confirm-cancel',
  dialogTestId = 'simple-confirm-dialog',
  failureMessage,
  returnFocusRef,
  fallbackFocusRef,
  onConfirm,
  onCancel,
}: SimpleConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const [errorVisible, setErrorVisible] = useState(false);

  useEffect(() => {
    if (open) {
      previousFocusRef.current =
        returnFocusRef?.current ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      wasOpenRef.current = true;
      confirmingRef.current = false;
      setConfirming(false);
      setErrorVisible(false);
      const focusCancel = () => {
        const cancelButton = dialogRef.current?.querySelector<HTMLButtonElement>(
          `[data-testid="${cancelTestId}"]`,
        );
        cancelButton?.focus();
      };
      // Prefer rAF so the dialog is committed before focusing.
      const rafId = window.requestAnimationFrame(focusCancel);
      return () => window.cancelAnimationFrame(rafId);
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      const rafId = window.requestAnimationFrame(() => {
        restoreFocus(previous, fallbackFocusRef?.current ?? null);
      });
      return () => window.cancelAnimationFrame(rafId);
    }
    return undefined;
  }, [open, cancelTestId, returnFocusRef, fallbackFocusRef]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (confirmingRef.current || confirming) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel, confirming]);

  const handleConfirm = async () => {
    if (confirmingRef.current || confirming) return;
    confirmingRef.current = true;
    setConfirming(true);
    setErrorVisible(false);
    try {
      const ok = await onConfirm();
      if (!ok) {
        setErrorVisible(true);
        confirmingRef.current = false;
        setConfirming(false);
        window.requestAnimationFrame(() => {
          dialogRef.current
            ?.querySelector<HTMLButtonElement>(`[data-testid="${confirmTestId}"]`)
            ?.focus();
        });
      }
    } catch {
      setErrorVisible(true);
      confirmingRef.current = false;
      setConfirming(false);
    }
  };

  const handleCancel = () => {
    if (confirmingRef.current || confirming) return;
    onCancel();
  };

  if (!open) return null;

  const describedBy =
    errorVisible && failureMessage ? `${descriptionId} ${errorId}` : descriptionId;

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={handleCancel}>
      <div
        ref={dialogRef}
        className="vorgang-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        data-testid={dialogTestId}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} className="vorgang-dialog__title">
          {title}
        </h3>
        <p id={descriptionId} className="vorgang-dialog__subtitle">
          {message}
        </p>
        {errorVisible && failureMessage ? (
          <p
            id={errorId}
            className="invoice-hint invoice-hint--warning"
            role="alert"
            data-testid="simple-confirm-error"
          >
            {failureMessage}
          </p>
        ) : null}
        <div className="vorgang-dialog__actions">
          <Button
            variant="outline"
            fullWidth
            disabled={confirming}
            onClick={handleCancel}
            data-testid={cancelTestId}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            fullWidth
            disabled={confirming}
            loading={confirming}
            onClick={() => void handleConfirm()}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
