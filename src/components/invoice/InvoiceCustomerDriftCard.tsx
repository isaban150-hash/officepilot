import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import type { CustomerBillingField } from '../../services/customer/customerBillingCopy';
import type { CustomerBilling } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  fields: readonly CustomerBillingField[];
  /** Die Empfängerangaben dieser Rechnung (Entwurf). */
  draftBilling: CustomerBilling;
  /** Der Stand des Kundenstamms, den „Übernehmen" schreibt. */
  masterBilling: CustomerBilling;
  translate: (key: TranslationKey) => string;
  onKeep: () => void;
  onApply: () => void;
}

/**
 * FINANZ-CORE-01A (KUN-08) — Rückfrage vor der Freigabe, wenn der Kundenstamm von den
 * Empfängerangaben der Rechnung abweicht. Wie bei den Firmendaten steht der bisherige neben
 * dem aktuellen Wert, nur für die abweichenden Felder und ohne Eingabefelder.
 */
export function InvoiceCustomerDriftCard({ fields, draftBilling, masterBilling, translate, onKeep, onApply }: Props) {
  return (
    <Card className="invoice-confirm" data-testid="invoice-customer-drift-confirm">
      <strong>{translate('invoice.customerDrift.title')}</strong>
      <p>{translate('invoice.customerDrift.message')}</p>
      <dl className="invoice-drift-list" data-testid="invoice-customer-drift-fields">
        {fields.map((field) => (
          <div className="invoice-drift-list__item" key={field} data-field={field}>
            <dt>{translate(`invoice.customerDrift.field.${field}` as TranslationKey)}</dt>
            <dd>
              <span className="invoice-drift-list__label">{translate('invoice.companyDrift.before')}</span>
              <span className="invoice-drift-list__value">
                {draftBilling[field]?.trim() || translate('invoice.companyDrift.empty')}
              </span>
            </dd>
            <dd>
              <span className="invoice-drift-list__label">{translate('invoice.companyDrift.after')}</span>
              <span className="invoice-drift-list__value invoice-drift-list__value--next">
                {masterBilling[field]?.trim() || translate('invoice.companyDrift.empty')}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="invoice-confirm__actions">
        <Button type="button" variant="outline" onClick={onKeep} data-testid="invoice-customer-drift-keep">
          {translate('invoice.customerDrift.keep')}
        </Button>
        <Button type="button" onClick={onApply} data-testid="invoice-customer-drift-apply">
          {translate('invoice.customerDrift.apply')}
        </Button>
      </div>
    </Card>
  );
}
