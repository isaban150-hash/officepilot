import { deliveryErrorLabelKey, deliveryKindLabelKey } from '../../services/delivery/documentDeliveryDefaults';
import { deliveryDisplayHintKey, deliveryDisplayLabelKey, displayDeliveryStatus } from '../../services/delivery/providerDeliveryState';
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { TranslationKey } from '../../i18n';
import { formatDisplayDateTime } from '../../utils/displayFormat';

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

// HALBZEIT-FIX B3 — dasselbe Datumsformat wie überall im E-Mail-Bereich.
const formatTimestamp = (value?: string): string => formatDisplayDateTime(value);

function statusTone(status: string): 'success' | 'danger' | 'warning' | 'info' {
  // `provider_accepted` ist „übergeben" — erfolgreich aus Sicht von OfficeTakt, nie „zugestellt".
  if (status === 'provider_accepted' || status === 'delivered') return 'success';
  if (status === 'failed' || status === 'rejected' || status === 'bounced' || status === 'complained') return 'danger';
  if (status === 'unknown' || status === 'deferred') return 'warning';
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
      {deliveries.map((d) => {
        // E-MAIL 07F-01B — nach der Übergabe zählt die Rückmeldung des E-Mail-Dienstes (nie „gelesen").
        const shown = displayDeliveryStatus(d.status, d.deliveryState);
        const hint = shown !== d.status ? deliveryDisplayHintKey(shown) : null;
        return (
        <li key={d.id} className="invoice-delivery-panel__item" data-testid="invoice-delivery-item" data-status={d.status} data-client-delivery-id={d.clientDeliveryId}>
          <span className={`badge badge--${statusTone(shown)}`} data-testid="invoice-delivery-status" data-delivery-state={d.deliveryState}>
            {translate(deliveryDisplayLabelKey(shown))}
          </span>
          <span className="invoice-delivery-panel__meta">
            <span data-testid="invoice-delivery-kind">{translate(deliveryKindLabelKey(d.documentKind))}</span> · {formatTimestamp(d.providerAcceptedAt ?? d.requestedAt)} · {d.recipientEmail}
            {/* HALBZEIT-FIX B3 — jeder Versuch trägt seine Nummer, auch der erste. */}
            {` · ${translate('delivery.history.attempt' as TranslationKey).replace('{n}', String(d.attemptNumber || 1))}`}
          </span>
          {d.status === 'failed' || d.status === 'rejected' ? (
            <span className="form-error" data-testid="invoice-delivery-error">{translate(deliveryErrorLabelKey(d))}</span>
          ) : null}
          {d.status === 'unknown' ? (
            <span className="hint-text" data-testid="invoice-delivery-unknown-hint">{translate('delivery.status.unknownHint' as TranslationKey)}</span>
          ) : null}
          {d.status === 'sending' ? (
            <span className="hint-text" data-testid="invoice-delivery-sending-hint">{translate('delivery.status.sendingHint' as TranslationKey)}</span>
          ) : null}
          {d.retryOfDeliveryId ? <span className="invoice-delivery-panel__retry-of" data-testid="invoice-delivery-retry-of">{translate('delivery.history.retryOf' as TranslationKey)}</span> : null}
          {hint ? <span className="hint-text" data-testid="invoice-delivery-state-hint">{translate(hint)}</span> : null}
        </li>
        );
      })}
    </ul>
  );
}
