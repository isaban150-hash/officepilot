import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  highlight?: boolean;
}

export function Card({ children, className = '', onClick, highlight }: CardProps) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`card ${highlight ? 'card--highlight' : ''} ${onClick ? 'card--clickable' : ''} ${className}`.trim()}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
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

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'success' | 'warning' | 'info' }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="page-header">
      <h1 className="page-header__title">{title}</h1>
      {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
    </header>
  );
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button type="button" className="toast__close" onClick={onClose} aria-label="Schließen">
        ×
      </button>
    </div>
  );
}
