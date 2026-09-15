import type { ReactNode } from 'react';

export type CardVariant = 'default' | 'interactive' | 'compact' | 'highlight';

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  highlight?: boolean;
  variant?: CardVariant;
  'data-testid'?: string;
}

export function Card({
  children,
  className = '',
  onClick,
  highlight,
  variant = 'default',
  'data-testid': dataTestId,
}: CardProps) {
  const Tag = onClick || variant === 'interactive' ? 'button' : 'div';
  const resolvedVariant = highlight ? 'highlight' : variant;
  const isClickable = Boolean(onClick) || variant === 'interactive';

  return (
    <Tag
      className={[
        'card',
        resolvedVariant !== 'default' ? `card--${resolvedVariant}` : '',
        isClickable ? 'card--clickable' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      type={isClickable ? 'button' : undefined}
      data-testid={dataTestId}
    >
      {children}
    </Tag>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="card__title">{children}</h3>;
}

export function CardMeta({ children }: { children: ReactNode }) {
  return <p className="card__meta">{children}</p>;
}

export function DataRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="data-row">
      <span className="data-row__label">{label}</span>
      <span className="data-row__value">{value}</span>
    </div>
  );
}

/* UIUX-FOUNDATION-01B — Badge lebt in Badge.tsx; Re-Export für bestehende Importe. */
export { Badge, StatusBadge } from './Badge';
export type { BadgeTone } from './Badge';

export { PageHeader } from './PageHeader';

export function Toast({
  message,
  onClose,
  closeLabel = 'Schließen',
}: {
  message: string;
  onClose: () => void;
  closeLabel?: string;
}) {
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button type="button" className="toast__close" onClick={onClose} aria-label={closeLabel}>
        ×
      </button>
    </div>
  );
}
