import { deliveryErrorLabelKey, deliveryKindLabelKey, deliveryStatusLabelKey } from '../../services/delivery/documentDeliveryDefaults';
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { TranslationKey } from '../../i18n';

/**
 * V1-B2 — die Versandhistorie, wie sie im Rechnungspanel entstanden ist,
 * als ein Baustein für Rechnung, Korrekturbeleg und normale Dokumente.
 * Darstellung unverändert: `provider_accepted` heißt „übergeben", nie
 * „zugestellt"; Fehler nur als Kategorie-Text; `unknown` mit dem Hinweis
 * auf die mögliche Doppelzustellung. Test-IDs bleiben die des Rechnungspanels.
 */
interface Props {
  deliveries: DocumentDelivery[] | null;
  emptyKey: TranslationKey;
  translate: (key: TranslationKey) => string;
}

function formatTimestamp(value?: string): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString('de-DE');
}

function statusTone(status: DocumentDelivery['status']): 'success' | 'danger' | 'warning' | 'info' {
  if (status === 'provider_accepted' || status === 'delivered') return 'success';
  if (status === 'failed' || status === 'rejected' || status === 'bounced') return 'danger';
  if (status === 'unknown') return 'warning';
  return 'info';
}

export function DeliveryHistoryList({ deliveries, emptyKey, translate }: Props) {
  if (deliveries === null) {
    return <p className="hint-text" data-testid="invoice-delivery-loading">{translate('delivery.phase.refreshing' as TranslationKey)}</p>;
  }
  if (deliveries.length === 0) {
    return <p className="hint-text" data-testid="invoice-delivery-empty">{translate(emptyKey)}</p>;
  }
  return (
    <ul className="invoice-delivery-panel__list" data-testid="invoice-delivery-list">
      {deliveries.map((d) => (
        <li key={d.id} className="invoice-delivery-panel__item" data-testid="invoice-delivery-item" data-status={d.status} data-client-delivery-id={d.clientDeliveryId}>
          <span className={`badge badge--${statusTone(d.status)}`} data-testid="invoice-delivery-status">
            {translate(deliveryStatusLabelKey(d.status))}
          </span>
          <span className="invoice-delivery-panel__meta">
            <span data-testid="invoice-delivery-kind">{translate(deliveryKindLabelKey(d.documentKind))}</span> · {formatTimestamp(d.providerAcceptedAt ?? d.requestedAt)} · {d.recipientEmail}
            {d.attemptNumber > 1 ? ` · ${translate('delivery.history.attempt' as TranslationKey).replace('{n}', String(d.attemptNumber))}` : ''}
          </span>
          {d.status === 'failed' || d.status === 'rejected' ? (
            <span className="form-error" data-testid="invoice-delivery-error">{translate(deliveryErrorLabelKey(d))}</span>
          ) : null}
          {d.status === 'unknown' ? (
            <span className="hint-text" data-testid="invoice-delivery-unknown-hint">{translate('delivery.status.unknownHint' as TranslationKey)}</span>
          ) : null}
          {d.retryOfDeliveryId ? <span className="hint-text">{translate('delivery.history.retryOf' as TranslationKey)}</span> : null}
        </li>
      ))}
    </ul>
  );
}
