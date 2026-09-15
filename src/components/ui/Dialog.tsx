import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

/**
 * UIUX-FOUNDATION-01B — gemeinsame, zugängliche Dialog-Basis.
 *
 * Verhalten:
 *  - `role="dialog"`, `aria-modal`, Überschrift per `aria-labelledby`,
 *    optionale Beschreibung per `aria-describedby`.
 *  - Fokus beim Öffnen: `initialFocusRef`, sonst das erste fokussierbare
 *    Element, sonst der Dialog selbst.
 *  - Tab/Shift+Tab bleiben im Dialog (Fokusfalle).
 *  - Escape und Backdrop-Klick rufen `onClose` — außer `busy` ist gesetzt
 *    (laufende Aktion darf nicht abgebrochen werden).
 *  - Fokus beim Schließen zurück: `returnFocusRef` → vorheriges aktives
 *    Element → `fallbackFocusRef`.
 *  - Mobil als Bottom-Sheet, ab Tablet zentriert; Safe-Area und
 *    reduced-motion über CSS (`.dialog`).
 *
 * Confirm-first-Semantik liegt beim Aufrufer: Der Dialog selbst löst keine
 * Aktion aus; er stellt nur den Rahmen.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getAttribute('aria-hidden') !== 'true' && el.getAttribute('aria-disabled') !== 'true',
  );
}

export function tryFocusElement(element: HTMLElement | null | undefined): boolean {
  if (!element || !element.isConnected) return false;
  if ('disabled' in element && Boolean((element as HTMLButtonElement).disabled)) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  try {
    element.focus({ preventScroll: true });
    return document.activeElement === element;
  } catch {
    return false;
  }
}

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Aktionsleiste; der Aufrufer stellt Cancel/Confirm bereit. */
  actions?: ReactNode;
  onClose: () => void;
  /** Laufende Aktion: Escape/Backdrop schließen nicht. */
  busy?: boolean;
  size?: DialogSize;
  /** Standard: schließt bei Klick auf den Hintergrund. */
  closeOnBackdrop?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Optionaler destruktiver Kontext — nur Darstellung (Titelfarbe). */
  tone?: 'default' | 'critical';
  className?: string;
  testId?: string;
  titleId?: string;
  descriptionId?: string;
}

export function Dialog({
  open,
  title,
  description,
  children,
  actions,
  onClose,
  busy = false,
  size = 'sm',
  closeOnBackdrop = true,
  initialFocusRef,
  returnFocusRef,
  fallbackFocusRef,
  tone = 'default',
  className = '',
  testId = 'dialog',
  titleId: titleIdProp,
  descriptionId: descriptionIdProp,
}: DialogProps) {
  const generatedTitleId = useId();
  const generatedDescriptionId = useId();
  const titleId = titleIdProp ?? generatedTitleId;
  const descriptionId = descriptionIdProp ?? generatedDescriptionId;
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  /* Fokus setzen beim Öffnen, zurückgeben beim Schließen. */
  useEffect(() => {
    if (open) {
      previousFocusRef.current =
        returnFocusRef?.current ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      wasOpenRef.current = true;
      const raf = window.requestAnimationFrame(() => {
        if (tryFocusElement(initialFocusRef?.current)) return;
        const [first] = focusableIn(dialogRef.current);
        if (tryFocusElement(first)) return;
        dialogRef.current?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(raf);
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      const raf = window.requestAnimationFrame(() => {
        if (tryFocusElement(previous)) return;
        tryFocusElement(fallbackFocusRef?.current);
      });
      return () => window.cancelAnimationFrame(raf);
    }
    return undefined;
  }, [open, initialFocusRef, returnFocusRef, fallbackFocusRef]);

  /* Escape + Fokusfalle. */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (busyRef.current) return;
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableIn(dialogRef.current);
      if (items.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = dialogRef.current?.contains(active) ?? false;
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    /* window statt document: bestehende Aufrufer/Tests senden Escape an window. */
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleBackdrop = () => {
    if (!closeOnBackdrop || busyRef.current) return;
    onClose();
  };

  return (
    <div className="dialog-backdrop" role="presentation" onClick={handleBackdrop} data-testid={`${testId}-backdrop`}>
      <div
        ref={dialogRef}
        className={['dialog', `dialog--${size}`, tone === 'critical' ? 'dialog--critical' : '', className]
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        data-testid={testId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="dialog__title">
          {title}
        </h2>
        {description ? (
          <div id={descriptionId} className="dialog__description">
            {description}
          </div>
        ) : null}
        {children ? <div className="dialog__body">{children}</div> : null}
        {actions ? <div className="dialog__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
