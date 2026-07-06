import type { ReactNode } from 'react';

interface EmptyStateBlockProps {
  title: string;
  description: string;
  actions?: ReactNode;
  testId?: string;
  className?: string;
}

export function EmptyStateBlock({
  title,
  description,
  actions,
  testId = 'empty-state-block',
  className = '',
}: EmptyStateBlockProps) {
  return (
    <div
      className={`empty-state-block${className ? ` ${className}` : ''}`}
      data-testid={testId}
    >
      <h2 className="empty-state-block__title">{title}</h2>
      {description ? <p className="empty-state-block__desc">{description}</p> : null}
      {actions ? <div className="empty-state-block__actions">{actions}</div> : null}
    </div>
  );
}
