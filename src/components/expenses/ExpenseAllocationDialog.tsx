import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import {
  assignExpenseToVorgang,
  getUnallocatedAmount,
} from '../../services/expenseService';
import { getAllVorgaenge } from '../../services/vorgangService';
import { formatPaymentCurrency } from '../../services/expensePaymentService';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

/**
 * ORDER-COST-ALLOCATION-01B — Ausgabe einem Auftrag zuordnen.
 *
 * Bewusst schlank: ein Auftrag, ein Nettobetrag. Keine Split-Maske, keine
 * technischen Kennungen — der Nutzer sieht Titel und Kunde. Der Dialog folgt
 * dem vorhandenen Dialogmuster (`vorgang-dialog-backdrop`), damit keine zweite
 * Dialoginfrastruktur entsteht. Die fachlichen Regeln liegen im Dienst; hier
 * stehen nur Vorbelegung und verständliche Fehlermeldungen.
 */
interface Props {
  expense: Expense;
  open: boolean;
  onClose: () => void;
  onSaved: (expense: Expense) => void;
}

function parseAmount(value: string): number {
  const normalized = value.trim().replace(/\./g, '').replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function ExpenseAllocationDialog({ expense, open, onClose, onSaved }: Props) {
  const { translate } = useApp();
  const existing = (expense.allocations ?? [])[0];
  const [vorgangId, setVorgangId] = useState(existing?.vorgangId ?? '');
  const [query, setQuery] = useState('');
  const [amount, setAmount] = useState('');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const orders = useMemo(() => getAllVorgaenge(), [open]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return orders;
    return orders.filter(
      (order) =>
        order.title.toLowerCase().includes(needle) || (order.customer ?? '').toLowerCase().includes(needle),
    );
  }, [orders, query]);

  useEffect(() => {
    if (!open) return;
    const current = (expense.allocations ?? []).find((allocation) => allocation.vorgangId === existing?.vorgangId);
    setVorgangId(current?.vorgangId ?? '');
    setQuery('');
    setErrorKey(null);
    /*
     * Vorbelegung: bei einer bestehenden Zuordnung ihr Betrag, sonst der noch
     * nicht zugeordnete Rest — nie mehr, als der Dienst annehmen würde.
     */
    const suggestion = current ? current.amount : getUnallocatedAmount(expense);
    setAmount(suggestion > 0 ? String(suggestion).replace('.', ',') : '');
  }, [open, expense, existing?.vorgangId]);

  if (!open) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!vorgangId) {
      setErrorKey('expense.allocation.selectRequired');
      return;
    }
    const parsed = parseAmount(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setErrorKey('expense.allocation.amountInvalid');
      return;
    }
    const result = assignExpenseToVorgang(expense.id, { vorgangId, amount: parsed });
    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }
    onSaved(result.expense);
    onClose();
  };

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="vorgang-dialog expense-allocation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="expense-allocation-dialog-title"
        data-testid="expense-allocation-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 id="expense-allocation-dialog-title" className="vorgang-dialog__title">
          {translate('expense.allocation.dialogTitle')}
        </h3>
        <p className="hint-text">
          {translate('expense.allocation.netHint').replace('{amount}', formatPaymentCurrency(expense.netAmount))}
        </p>

        {orders.length === 0 ? (
          <p className="hint-text" data-testid="expense-allocation-no-orders">
            {translate('expense.allocation.noOrders')}
          </p>
        ) : (
          <>
            <label className="form-group">
              <span>{translate('expense.allocation.searchLabel')}</span>
              <input
                className="input"
                value={query}
                placeholder={translate('expense.allocation.searchPlaceholder')}
                onChange={(event) => setQuery(event.target.value)}
                data-testid="expense-allocation-search"
              />
            </label>

            <label className="form-group">
              <span>{translate('expense.allocation.orderLabel')}</span>
              <select
                className="input"
                value={vorgangId}
                onChange={(event) => setVorgangId(event.target.value)}
                data-testid="expense-allocation-order"
              >
                <option value="">—</option>
                {filtered.map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.customer ? `${order.title} · ${order.customer}` : order.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-group">
              <span>{translate('expense.allocation.amountLabel')}</span>
              <input
                className="input"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                data-testid="expense-allocation-amount"
              />
              <span className="form-hint">{translate('expense.allocation.amountHint')}</span>
            </label>
          </>
        )}

        <p className="hint-text" data-testid="expense-allocation-tax-hint">
          {translate('expense.allocation.taxHint')}
        </p>

        {errorKey ? (
          <p className="form-error" role="alert" data-testid="expense-allocation-error">
            {translate(errorKey)}
          </p>
        ) : null}

        <div className="vorgang-dialog__actions">
          <Button type="submit" fullWidth disabled={orders.length === 0} data-testid="expense-allocation-save">
            {translate('common.save')}
          </Button>
          <Button type="button" variant="outline" fullWidth onClick={onClose} data-testid="expense-allocation-cancel">
            {translate('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
