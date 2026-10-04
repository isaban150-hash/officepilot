import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import { previewRebillNet, rebillAllocation } from '../../services/order/orderCostRebillingService';
import { formatPaymentCurrency } from '../../services/expensePaymentService';
import type { TranslationKey } from '../../i18n';

/**
 * BEREICH-7-V1 — Lieferantenkosten weiterberechnen.
 *
 * Vier Zeilen und ein Knopf, im vorhandenen Dialogmuster
 * (`vorgang-dialog-backdrop`) wie der Zuordnungsdialog nebenan. Keine neue
 * Seite, keine neue Navigation, keine zweite Dialoginfrastruktur.
 *
 * Der Einkaufspreis steht fest und ist deshalb kein Eingabefeld: Er ist der
 * zugeordnete Nettobetrag des Belegs, nicht etwas, das hier verhandelt wird.
 * Die fachlichen Regeln liegen vollständig im Dienst; hier stehen Vorbelegung,
 * Vorschau und die verständliche Fehlermeldung.
 */
interface Props {
  open: boolean;
  expenseId: string;
  vorgangId: string;
  /** Zugeordneter Nettobetrag — die Basis der Weiterberechnung. */
  allocatedNet: number;
  supplierName: string;
  invoiceNumber: string;
  onClose: () => void;
  onDone: () => void;
}

/** Dieselbe Eingabekonvention wie im Zuordnungsdialog: Komma oder Punkt. */
function parseMarkup(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Number.parseFloat(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function RebillCostDialog({
  open,
  expenseId,
  vorgangId,
  allocatedNet,
  supplierName,
  invoiceNumber,
  onClose,
  onDone,
}: Props) {
  const { translate } = useApp();
  const [description, setDescription] = useState('');
  const [markup, setMarkup] = useState('0');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  useEffect(() => {
    if (!open) return;
    setDescription(
      translate('expense.rebill.defaultDescription')
        .replace('{supplier}', supplierName)
        .replace('{invoiceNumber}', invoiceNumber)
        .replace(/\s+/g, ' ')
        .trim(),
    );
    setMarkup('0');
    setErrorKey(null);
  }, [open, supplierName, invoiceNumber, translate]);

  const parsedMarkup = parseMarkup(markup);
  const preview = useMemo(
    () =>
      Number.isFinite(parsedMarkup) && parsedMarkup >= 0
        ? previewRebillNet(allocatedNet, parsedMarkup)
        : NaN,
    [allocatedNet, parsedMarkup],
  );

  if (!open) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!Number.isFinite(parsedMarkup) || parsedMarkup < 0) {
      setErrorKey('expense.rebill.markupInvalid');
      return;
    }
    const result = rebillAllocation({
      expenseId,
      vorgangId,
      description,
      markupPercent: parsedMarkup,
    });
    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }
    onDone();
    onClose();
  };

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="vorgang-dialog rebill-cost-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebill-cost-dialog-title"
        data-testid="rebill-cost-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 id="rebill-cost-dialog-title" className="vorgang-dialog__title">
          {translate('expense.rebill.dialogTitle')}
        </h3>
        <p className="hint-text">{translate('expense.rebill.intro')}</p>

        <label className="form-group">
          <span>{translate('expense.rebill.descriptionLabel')}</span>
          <input
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            data-testid="rebill-description"
          />
        </label>

        <div className="form-group">
          <span>{translate('expense.rebill.purchaseLabel')}</span>
          <p className="form-static" data-testid="rebill-purchase">
            {formatPaymentCurrency(allocatedNet)}
          </p>
        </div>

        <label className="form-group">
          <span>{translate('expense.rebill.markupLabel')}</span>
          <input
            className="input"
            inputMode="decimal"
            value={markup}
            onChange={(event) => setMarkup(event.target.value)}
            data-testid="rebill-markup"
          />
          <span className="form-hint">{translate('expense.rebill.markupHint')}</span>
        </label>

        <div className="form-group">
          <span>{translate('expense.rebill.resultLabel')}</span>
          <p className="form-static" data-testid="rebill-preview">
            {Number.isFinite(preview) ? formatPaymentCurrency(preview) : '—'}
          </p>
        </div>

        <p className="hint-text" data-testid="rebill-tax-hint">
          {translate('expense.rebill.taxHint')}
        </p>

        {errorKey ? (
          <p className="form-error" role="alert" data-testid="rebill-error">
            {translate(errorKey)}
          </p>
        ) : null}

        <div className="vorgang-dialog__actions">
          <Button type="submit" fullWidth data-testid="rebill-submit">
            {translate('expense.rebill.submit')}
          </Button>
          <Button type="button" variant="outline" fullWidth onClick={onClose} data-testid="rebill-cancel">
            {translate('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
