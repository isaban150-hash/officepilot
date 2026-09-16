import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * UIUX-FOUNDATION-01D — kanonischer Seitenkopf.
 *
 * Aufbau: [Back] → Titel (+ Status) → Untertitel/Kontext | Aktionen.
 * Desktop: Titel links, Aktionen rechts. Mobil: gestapelt, Primary zuerst
 * in voller Breite, Sekundäres darunter. Kein Hero, keine Dekoration.
 *
 * Back-Semantik (drei Fälle, bewusst getrennt):
 *  - `backHref`   → echter Link (Deep-Link-fähig, Rechtsklick/Neuer Tab).
 *  - `onBack`     → Button für berechnete Ziele (z. B. `from`-Parameter).
 *  - beides fehlt → kein Back.
 * `backLabel` ist Pflicht, sobald eines von beiden gesetzt ist.
 */
export interface PageHeaderProps {
  /** Kleine Zeile über dem Titel, z. B. die Dokumentart (VISUAL-POLISH-01C). */
  eyebrow?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  backLabel?: string;
  onBack?: () => void;
  backHref?: string;
  backTestId?: string;
  /** Status neben dem Titel — bevorzugt `StatusBadge`. */
  status?: ReactNode;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
  testId?: string;
  /** Seitentitel ist h1; in eingebetteten Kontexten h2. */
  level?: 1 | 2;
}

export function BackLink({
  label,
  href,
  onClick,
  testId,
}: {
  label: string;
  href?: string;
  onClick?: () => void;
  testId?: string;
}) {
  if (href) {
    return (
      <Link to={href} className="page-header__back" data-testid={testId}>
        ← {label}
      </Link>
    );
  }
  return (
    <button type="button" className="page-header__back" onClick={onClick} data-testid={testId}>
      ← {label}
    </button>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  backLabel,
  onBack,
  backHref,
  backTestId,
  status,
  primaryAction,
  secondaryAction,
  className = '',
  testId,
  level = 1,
}: PageHeaderProps) {
  const hasActions = Boolean(primaryAction || secondaryAction);
  const hasBack = Boolean(backLabel && (onBack || backHref));
  const Heading = level === 2 ? 'h2' : 'h1';

  return (
    <header className={`page-header ${className}`.trim()} data-testid={testId}>
      <div className="page-header__main">
        {hasBack ? <BackLink label={backLabel!} href={backHref} onClick={onBack} testId={backTestId} /> : null}
        <div className="page-header__text">
          {eyebrow ? <p className="page-header__eyebrow">{eyebrow}</p> : null}
          <div className="page-header__title-row">
            <Heading className="page-header__title">{title}</Heading>
            {status ? <div className="page-header__status">{status}</div> : null}
          </div>
          {subtitle ? <p className="page-header__subtitle">{subtitle}</p> : null}
        </div>
      </div>
      {hasActions ? (
        <div className="page-header__actions">
          {secondaryAction ? <div className="page-header__secondary">{secondaryAction}</div> : null}
          {primaryAction ? <div className="page-header__primary">{primaryAction}</div> : null}
        </div>
      ) : null}
    </header>
  );
}
