import type { ReactNode } from 'react';
import { Button } from './Button';
import { Icon, type IconId } from './Icon';
import { Skeleton, type SkeletonVariant } from './Skeleton';
import type { StatusTone } from '../../services/ui/statusTone';

/**
 * UIUX-FOUNDATION-01D — kanonische Zustände.
 *
 * - `EmptyStateBlock` (01B) bleibt der Leerzustand.
 * - `LoadingState`: ruhige Skeletons in der Form des späteren Inhalts —
 *   keine Layoutsprünge, keine Spinner-Wand.
 * - `ErrorState`: verständliche Sprache, technisches Detail nur zugeklappt,
 *   Retry nur wenn der Aufrufer eine Aktion anbietet.
 * - `InlineNotice`: Hinweis/Warnung/Fehler/Erfolg im Fluss — Warnungen sind
 *   keine Fehler und nennen die Handlung.
 */
export interface LoadingStateProps {
  /** Beschreibt, was lädt — für Screenreader. */
  label: string;
  variant?: SkeletonVariant;
  count?: number;
  testId?: string;
}

export function LoadingState({ label, variant = 'list-row', count = 3, testId = 'loading-state' }: LoadingStateProps) {
  return (
    <div className="loading-state" role="status" aria-live="polite" aria-busy="true" data-testid={testId}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} variant={variant} testId={`${testId}-skeleton`} />
      ))}
    </div>
  );
}

export interface ErrorStateProps {
  title: string;
  description?: ReactNode;
  /** Technischer Hinweis — zugeklappt, nie Haupttext. */
  detail?: string;
  detailLabel?: string;
  retryLabel?: string;
  onRetry?: () => void;
  testId?: string;
}

export function ErrorState({ title, description, detail, detailLabel = 'Technische Details', retryLabel, onRetry, testId = 'error-state' }: ErrorStateProps) {
  return (
    <div className="error-state" role="alert" data-testid={testId}>
      <Icon id="alert" className="error-state__icon" />
      <div className="error-state__body">
        <p className="error-state__title">{title}</p>
        {description ? <p className="error-state__description">{description}</p> : null}
        {detail ? (
          <details className="error-state__details">
            <summary>{detailLabel}</summary>
            <code className="error-state__detail">{detail}</code>
          </details>
        ) : null}
        {onRetry && retryLabel ? (
          <div className="error-state__actions">
            <Button variant="outline" size="sm" onClick={onRetry} data-testid={`${testId}-retry`}>
              {retryLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const NOTICE_ICON: Record<StatusTone, IconId> = {
  neutral: 'info',
  info: 'info',
  success: 'check',
  warning: 'warning',
  critical: 'alert',
};

export interface InlineNoticeProps {
  tone?: StatusTone;
  title?: ReactNode;
  children: ReactNode;
  /** Handlung direkt beim Hinweis (Link/Button). */
  action?: ReactNode;
  testId?: string;
  className?: string;
}

export function InlineNotice({ tone = 'info', title, children, action, testId = 'inline-notice', className = '' }: InlineNoticeProps) {
  return (
    <div
      className={['inline-notice', `inline-notice--${tone}`, className].filter(Boolean).join(' ')}
      role={tone === 'critical' ? 'alert' : 'status'}
      data-tone={tone}
      data-testid={testId}
    >
      <Icon id={NOTICE_ICON[tone]} size="sm" className="inline-notice__icon" />
      <div className="inline-notice__body">
        {title ? <p className="inline-notice__title">{title}</p> : null}
        <div className="inline-notice__message">{children}</div>
        {action ? <div className="inline-notice__action">{action}</div> : null}
      </div>
    </div>
  );
}
