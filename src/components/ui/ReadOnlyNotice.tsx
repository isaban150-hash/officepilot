import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * UIUX-FOUNDATION-01B — kompakter Hinweis für Flächen ohne Schreibrecht.
 *
 * Reine Darstellung: Der Aufrufer entscheidet anhand der bestehenden
 * Berechtigungslogik (`resolveWorkspaceWriteAccess`, Server-Antwort), ob
 * und mit welchem Text der Hinweis erscheint. Keine Rollenlogik hier.
 */
export interface ReadOnlyNoticeProps {
  message: ReactNode;
  title?: ReactNode;
  className?: string;
  testId?: string;
  /** EINRICHTUNG-01 (AP5; 1.16) — Variante des einheitlichen Einstellungshinweises, als `data-variant` lesbar. */
  variant?: string;
}

export function ReadOnlyNotice({ message, title, className = '', testId = 'read-only-notice', variant }: ReadOnlyNoticeProps) {
  return (
    <div className={['read-only-notice', className].filter(Boolean).join(' ')} role="status" data-testid={testId} data-variant={variant}>
      <Icon id="lock" size="sm" className="read-only-notice__icon" />
      <div className="read-only-notice__text">
        {title ? <p className="read-only-notice__title">{title}</p> : null}
        <p className="read-only-notice__message">{message}</p>
      </div>
    </div>
  );
}
