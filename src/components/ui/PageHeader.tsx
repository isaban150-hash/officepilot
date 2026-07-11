import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  backLabel?: string;
  onBack?: () => void;
  backHref?: string;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  backLabel,
  onBack,
  primaryAction,
  secondaryAction,
  className = '',
}: PageHeaderProps) {
  const hasActions = Boolean(primaryAction || secondaryAction);

  return (
    <header className={`page-header ${className}`.trim()}>
      <div className="page-header__main">
        {backLabel && onBack ? (
          <button type="button" className="page-header__back" onClick={onBack}>
            ← {backLabel}
          </button>
        ) : null}
        <div>
          <h1 className="page-header__title">{title}</h1>
          {subtitle ? <p className="page-header__subtitle">{subtitle}</p> : null}
        </div>
      </div>
      {hasActions ? (
        <div className="page-header__actions">
          {secondaryAction}
          {primaryAction}
        </div>
      ) : null}
    </header>
  );
}
