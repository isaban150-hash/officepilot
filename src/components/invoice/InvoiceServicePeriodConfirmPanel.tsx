/**
 * LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B
 *
 * Zwei Lagen, ein Panel:
 *
 *   A. Die Rechnung stammt aus der Zeit vor `servicePeriodConfirmed`. Der
 *      gespeicherte Leistungszeitraum wird **angezeigt** und kann ausdrücklich
 *      bestätigt werden. Ohne Bestätigung bleiben PDF und Druck gesperrt.
 *
 *   B. Die Bestätigung steht lokal, die Cloud weiss nachweislich noch nichts
 *      davon. Dann bietet dasselbe Panel an, sie nachzureichen.
 *
 * Ausdrücklich **keine** Eingabefelder: Ein falscher Leistungszeitraum ist eine
 * Belegänderung und gehört nach Storno/Korrektur, nicht hierher.
 *
 * Ist der Cloud-Zustand unbekannt (`cloudConfirmed === null`), zeigt das Panel
 * nichts — kein Beweis, keine Aussage.
 */
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import {
  confirmFinalizedInvoiceServicePeriod,
  isServicePeriodCloudSyncSilent,
  needsServicePeriodRecovery,
  syncInvoiceServicePeriodConfirmationToCloud,
} from '../../services/invoice/invoiceServicePeriodConfirmService';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  vorgangId: string;
  invoice: VorgangInvoice;
  /** true = in der Cloud bestätigt, false = nachweislich nicht, null = unbekannt. */
  cloudConfirmed: boolean | null;
  translate: (key: TranslationKey) => string;
  onUpdated: (invoice: VorgangInvoice) => void;
  onCloudStateChange: (confirmed: boolean | null) => void;
}

function formatDisplayDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('de-DE', { timeZone: 'UTC' });
}

export function InvoiceServicePeriodConfirmPanel({
  vorgangId,
  invoice,
  cloudConfirmed,
  translate,
  onUpdated,
  onCloudStateChange,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const needsRecovery = needsServicePeriodRecovery(invoice);
  const needsCloudSecure = invoice.servicePeriodConfirmed === true && cloudConfirmed === false;

  if (!needsRecovery && !needsCloudSecure) return null;

  const period = `${formatDisplayDate(invoice.servicePeriodFrom ?? '')} – ${formatDisplayDate(
    invoice.servicePeriodTo ?? '',
  )}`;

  /**
   * Zuerst lokal, dann Cloud. Ein Netzfehler nimmt die Entscheidung des
   * Nutzers nicht zurück: Lokal bleibt sie stehen, PDF und Druck sind sofort
   * frei, und die fehlende Sicherung wird beim nächsten Öffnen erneut erkannt.
   */
  const handleConfirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setErrorKey(null);

    if (needsRecovery) {
      const result = confirmFinalizedInvoiceServicePeriod(vorgangId, invoice.id);
      if (!result.ok) {
        setErrorKey('invoice.servicePeriodConfirmFailed');
        setBusy(false);
        return;
      }
      onUpdated(result.invoice);
    }

    const outcome = await syncInvoiceServicePeriodConfirmationToCloud(vorgangId, invoice.id);
    /*
     * 01B2 — nur ein bewiesener Erfolg wird behauptet.
     *
     * Zuvor galt jeder Fehlschlag als „noch nicht gesichert". Bei einer
     * Rechnung, die es in der Cloud gar nicht gibt, erzeugte das genau den
     * aussichtslosen Fall: Die Confirm-RPC kann dort nichts ergänzen, der
     * Sicherungsknopf wäre auf Dauer wirkungslos. Ohne Beweis bleibt die
     * Aussage deshalb aus; der Einzelread der Detailseite entscheidet — er
     * unterscheidet `missing` von `not_confirmed`.
     */
    if (outcome === 'synced') {
      onCloudStateChange(true);
    }
    if (!isServicePeriodCloudSyncSilent(outcome) && !needsRecovery) {
      setErrorKey('invoice.servicePeriodConfirmFailed');
    }
    setBusy(false);
  };

  return (
    <Card>
      <CardTitle>{translate('invoice.servicePeriodRecoveryTitle')}</CardTitle>
      <div
        className="invoice-service-period-confirm"
        data-testid={
          needsRecovery ? 'invoice-service-period-recovery' : 'invoice-service-period-pending'
        }
      >
        <p className="invoice-service-period-confirm__hint">
          {translate(
            needsRecovery
              ? 'invoice.servicePeriodRecoveryHint'
              : 'invoice.servicePeriodCloudPending',
          )}
        </p>
        <p className="invoice-service-period-confirm__period">
          <span className="invoice-service-period-confirm__label">
            {translate('invoice.servicePeriodLabel')}
          </span>{' '}
          <strong data-testid="invoice-service-period-value">{period}</strong>
        </p>
        <Button
          type="button"
          fullWidth
          disabled={busy}
          onClick={() => void handleConfirm()}
          data-testid={
            needsRecovery ? 'invoice-confirm-service-period' : 'invoice-secure-service-period'
          }
        >
          {translate(
            needsRecovery ? 'invoice.confirmServicePeriod' : 'invoice.servicePeriodSecureNow',
          )}
        </Button>
        {errorKey ? (
          <p
            className="invoice-service-period-confirm__error"
            data-testid="invoice-service-period-error"
          >
            {translate(errorKey)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
