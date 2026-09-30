/**
 * 02B — die optionale Zahlungsart, gleich für Rechnungs- und Ausgabenzahlungen.
 *
 * „Nicht angegeben“ ist ein gültiger Zustand und die Voreinstellung: Eine
 * fehlende Angabe wird nie als Bank angenommen. Eine Barzahlung gilt sofort
 * als Zahlung — ein Bankabgleich ist dafür nicht nötig.
 */
import type { TranslationKey } from '../../i18n';
import { PAYMENT_METHODS, type PaymentMethod } from '../../types/models';

interface Props {
  value: PaymentMethod | '';
  onChange: (value: PaymentMethod | '') => void;
  disabled?: boolean;
  translate: (key: TranslationKey) => string;
  testId: string;
}

export function paymentMethodLabel(
  method: PaymentMethod | undefined,
  translate: (key: TranslationKey) => string,
): string | undefined {
  return method ? translate(`payment.method.${method}` as TranslationKey) : undefined;
}

export function PaymentMethodField({ value, onChange, disabled, translate, testId }: Props) {
  return (
    <label className="invoice-payment-form__field">
      <span>{translate('payment.method')}</span>
      <select
        className="input"
        value={value}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value as PaymentMethod | '')}
      >
        <option value="">{translate('payment.method.none')}</option>
        {PAYMENT_METHODS.map((method) => (
          <option key={method} value={method}>
            {translate(`payment.method.${method}` as TranslationKey)}
          </option>
        ))}
      </select>
      {value === 'cash' ? (
        <small className="detail-hint" data-testid={`${testId}-cash-hint`}>
          {translate('payment.method.cashHint')}
        </small>
      ) : null}
    </label>
  );
}
