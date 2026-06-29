import { useState, type FormEvent } from 'react';
import { useApp } from '../../context/AppContext';
import {
  EXPENSE_CATEGORIES,
  addExpense,
  updateExpense,
} from '../../services/expenseService';
import type { Expense, ExpenseCategory, ExpenseInput } from '../../types/expense';
import type { TranslationKey } from '../../i18n';
import { Button } from '../ui/Button';

export interface ExpenseFormDraft {
  title: string;
  category: ExpenseCategory;
  supplierName: string;
  invoiceNumber: string;
  description: string;
  issueDate: string;
  paymentDueDate: string;
  grossAmount: string;
  netAmount: string;
  taxAmount: string;
}

function draftFromExpense(expense: Expense): ExpenseFormDraft {
  return {
    title: expense.title,
    category: expense.category,
    supplierName: expense.supplierName,
    invoiceNumber: expense.invoiceNumber,
    description: expense.description,
    issueDate: expense.issueDate,
    paymentDueDate: expense.paymentDueDate ?? '',
    grossAmount: String(expense.grossAmount),
    netAmount: String(expense.netAmount),
    taxAmount: String(expense.taxAmount),
  };
}

function emptyDraft(): ExpenseFormDraft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    title: '',
    category: 'material',
    supplierName: '',
    invoiceNumber: '',
    description: '',
    issueDate: today,
    paymentDueDate: '',
    grossAmount: '',
    netAmount: '',
    taxAmount: '',
  };
}

function parseAmount(value: string): number {
  const normalized = value.trim().replace(/\./g, '').replace(',', '.');
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toInput(draft: ExpenseFormDraft): ExpenseInput {
  const grossAmount = parseAmount(draft.grossAmount);
  const netAmount = parseAmount(draft.netAmount);
  const taxAmount = parseAmount(draft.taxAmount);
  return {
    title: draft.title,
    category: draft.category,
    supplierName: draft.supplierName,
    invoiceNumber: draft.invoiceNumber,
    description: draft.description,
    issueDate: draft.issueDate,
    paymentDueDate: draft.paymentDueDate || null,
    grossAmount,
    netAmount: netAmount || undefined,
    taxAmount: taxAmount || undefined,
  };
}

interface ExpenseFormProps {
  mode: 'add' | 'edit';
  expense?: Expense;
  onSaved: (expense: Expense) => void;
  onCancel: () => void;
}

export function ExpenseForm({ mode, expense, onSaved, onCancel }: ExpenseFormProps) {
  const { translate, showToast } = useApp();
  const [draft, setDraft] = useState<ExpenseFormDraft>(
    expense ? draftFromExpense(expense) : emptyDraft(),
  );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const input = toInput(draft);
    const result =
      mode === 'add'
        ? addExpense(input)
        : updateExpense(expense!.id, input);

    if (!result.success) {
      showToast(translate(result.errorKey as TranslationKey));
      return;
    }

    onSaved(result.expense);
  };

  return (
    <form className="form-stack expense-form" onSubmit={handleSubmit}>
      <label className="form-group">
        <span>{translate('expense.fieldTitle')}</span>
        <input
          className="input"
          value={draft.title}
          onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
          required
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldCategory')}</span>
        <select
          className="input"
          value={draft.category}
          onChange={(e) =>
            setDraft((prev) => ({ ...prev, category: e.target.value as ExpenseCategory }))
          }
        >
          {EXPENSE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {translate(`expense.category.${category}` as TranslationKey)}
            </option>
          ))}
        </select>
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldSupplier')}</span>
        <input
          className="input"
          value={draft.supplierName}
          onChange={(e) => setDraft((prev) => ({ ...prev, supplierName: e.target.value }))}
          required
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldInvoiceNumber')}</span>
        <input
          className="input"
          value={draft.invoiceNumber}
          onChange={(e) => setDraft((prev) => ({ ...prev, invoiceNumber: e.target.value }))}
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldIssueDate')}</span>
        <input
          type="date"
          className="input"
          value={draft.issueDate}
          onChange={(e) => setDraft((prev) => ({ ...prev, issueDate: e.target.value }))}
          required
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldDueDate')}</span>
        <input
          type="date"
          className="input"
          value={draft.paymentDueDate}
          onChange={(e) => setDraft((prev) => ({ ...prev, paymentDueDate: e.target.value }))}
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldGrossAmount')}</span>
        <input
          className="input"
          inputMode="decimal"
          value={draft.grossAmount}
          onChange={(e) => setDraft((prev) => ({ ...prev, grossAmount: e.target.value }))}
          required
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldNetAmount')}</span>
        <input
          className="input"
          inputMode="decimal"
          value={draft.netAmount}
          onChange={(e) => setDraft((prev) => ({ ...prev, netAmount: e.target.value }))}
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldTaxAmount')}</span>
        <input
          className="input"
          inputMode="decimal"
          value={draft.taxAmount}
          onChange={(e) => setDraft((prev) => ({ ...prev, taxAmount: e.target.value }))}
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldDescription')}</span>
        <textarea
          className="input"
          rows={3}
          value={draft.description}
          onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
        />
      </label>

      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {translate('common.cancel')}
        </Button>
        <Button type="submit">
          {mode === 'add' ? translate('expense.saveNew') : translate('expense.saveChanges')}
        </Button>
      </div>
    </form>
  );
}
