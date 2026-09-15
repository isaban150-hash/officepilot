import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button, type ButtonVariant } from './Button';
import { Dialog } from './Dialog';

/**
 * UIUX-FOUNDATION-01B — Referenzintegration der Dialog-Basis.
 *
 * API, Testids und Verhalten (Fokus auf „Abbrechen“, Escape gesperrt während
 * der Bestätigung, Fehlertext bei `false`/Throw, Fokus-Rückgabe) sind
 * unverändert; nur Rahmen, Fokusfalle und Styling kommen jetzt aus `Dialog`.
 */
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const [errorVisible, setErrorVisible] = useState(false);

  useEffect(() => {
    if (!open) return;
    confirmingRef.current = false;
    setConfirming(false);
    setErrorVisible(false);
  }, [open]);

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
        window.requestAnimationFrame(() => confirmRef.current?.focus());
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

  return (
    <Dialog
      open={open}
      title={title}
      description={message}
      onClose={handleCancel}
      busy={confirming}
      tone={confirmVariant === 'danger' ? 'critical' : 'default'}
      initialFocusRef={cancelRef}
      returnFocusRef={returnFocusRef}
      fallbackFocusRef={fallbackFocusRef}
      testId={dialogTestId}
      actions={
        <>
          <Button
            ref={cancelRef}
            variant="outline"
            fullWidth
            disabled={confirming}
            onClick={handleCancel}
            data-testid={cancelTestId}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={confirmVariant}
            fullWidth
            disabled={confirming}
            loading={confirming}
            onClick={() => void handleConfirm()}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {errorVisible && failureMessage ? (
        <p className="dialog__error" role="alert" data-testid="simple-confirm-error">
          {failureMessage}
        </p>
      ) : null}
    </Dialog>
  );
}
