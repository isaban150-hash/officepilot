export type SkeletonVariant = 'text' | 'text-sm' | 'card' | 'list-row';

export interface SkeletonProps {
  variant?: SkeletonVariant;
  className?: string;
  testId?: string;
}

export function Skeleton({ variant = 'text', className = '', testId = 'skeleton' }: SkeletonProps) {
  return (
    <div
      className={`skeleton skeleton--${variant}${className ? ` ${className}` : ''}`}
      data-testid={testId}
      aria-hidden
    />
  );
}

export interface SkeletonStackProps {
  count?: number;
  variant?: SkeletonVariant;
  testId?: string;
}

export function SkeletonStack({ count = 3, variant = 'list-row', testId = 'skeleton-stack' }: SkeletonStackProps) {
  return (
    <div className="skeleton-stack" data-testid={testId} aria-hidden aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} variant={variant} testId={`${testId}-item-${index}`} />
      ))}
    </div>
  );
}
