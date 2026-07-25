import { Button } from '../ui/Button';
import type { TranslationKey } from '../../i18n';
import type { OrderAmendmentConfirmIntentState } from '../../services/orderAmendment/orderAmendmentConfirmIntentService';

/** UI-facing status kinds — never expose raw intent enum names in the DOM. */
export type OrderAmendmentStatusKind =
  | 'confirming'
  | 'pending'
  | 'checking'
  | 'updating'
  | 'conflict';

interface OrderAmendmentStatusBannerProps {
  kind: OrderAmendmentStatusKind;
  translate: (key: TranslationKey) => string;
  confirming?: boolean;
  onRetry?: () => void;
  conflictMessage?: string;
}

function resolveCopy(
  kind: OrderAmendmentStatusKind,
  translate: (key: TranslationKey) => string,
  conflictMessage?: string,
): { title: string; detail: string; retryLabel?: string } {
  if (kind === 'confirming' || kind === 'pending') {
    return {
      title: translate('orderAmendment.status.confirmingTitle'),
      detail: translate('orderAmendment.status.confirmingDetail'),
      retryLabel: kind === 'pending' ? translate('orderAmendment.status.retryCheck') : undefined,
    };
  }
  if (kind === 'updating') {
    return {
      title: translate('orderAmendment.status.localApplyTitle'),
      detail: translate('orderAmendment.status.localApplyDetail'),
      retryLabel: translate('orderAmendment.status.retryLocalApply'),
    };
  }
  if (kind === 'conflict') {
    return {
      title: translate('orderAmendment.status.conflictTitle'),
      detail: conflictMessage ?? translate('orderAmendment.status.conflictDetail'),
      retryLabel: translate('orderAmendment.status.retryCheck'),
    };
  }
  return {
    title: translate('orderAmendment.status.outcomeUnknownTitle'),
    detail: translate('orderAmendment.status.outcomeUnknownDetail'),
    retryLabel: translate('orderAmendment.status.retryCheck'),
  };
}

export function intentStateToStatusKind(
  state: OrderAmendmentConfirmIntentState | undefined,
): Exclude<OrderAmendmentStatusKind, 'confirming' | 'conflict'> | null {
  if (state === 'local_apply_pending') return 'updating';
  if (state === 'pending') return 'pending';
  if (state === 'outcome_unknown') return 'checking';
  return null;
}

export function OrderAmendmentStatusBanner({
  kind,
  translate,
  confirming = false,
  onRetry,
  conflictMessage,
}: OrderAmendmentStatusBannerProps) {
  const copy = resolveCopy(kind, translate, conflictMessage);

  return (
    <div
      className="order-amendment-status-banner"
      role="status"
      aria-live="polite"
      data-testid="order-amendment-status-banner"
      data-status-kind={kind}
    >
      <p className="order-amendment-status-banner__title" data-testid="order-amendment-status-title">
        {copy.title}
      </p>
      <p className="order-amendment-status-banner__detail" data-testid="order-amendment-status-detail">
        {copy.detail}
      </p>
      {copy.retryLabel && onRetry ? (
        <Button
          fullWidth
          disabled={confirming}
          loading={confirming}
          onClick={onRetry}
          data-testid="order-amendment-confirm-retry"
        >
          {confirming ? translate('orderAmendment.confirming') : copy.retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
