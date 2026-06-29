import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ExpenseForm } from '../components/expenses/ExpenseForm';
import { Button } from '../components/ui/Button';
import { Badge, Card, DataRow, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { formatPaperFilingInstruction } from '../services/paperFolderService';
import { deleteExpense, getExpenseById } from '../services/expenseService';
import type { Expense } from '../types/expense';
import type { TranslationKey } from '../i18n';

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}

function formatEuro(amount: number): string {
  return `${amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function AusgabeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const [expense, setExpense] = useState<Expense | undefined>(() =>
    id ? getExpenseById(id) : undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (id) {
      setExpense(getExpenseById(id));
      setIsEditing(false);
      setConfirmDelete(false);
    }
  }, [id]);

  useEffect(() => {
    if (id && !getExpenseById(id)) {
      navigate('/ausgaben', { replace: true });
    }
  }, [id, navigate]);

  if (!expense) return null;

  const categoryKey = `expense.category.${expense.category}` as TranslationKey;
  const statusKey = `expense.status.${expense.status}` as TranslationKey;
  const paymentStatusKey = `expense.paymentStatus.${expense.paymentStatus}` as TranslationKey;

  const handleDelete = () => {
    const result = deleteExpense(expense.id);
    if (result.success) {
      showToast(translate('expense.deleted'));
      navigate('/ausgaben', { replace: true });
    }
  };

  if (isEditing) {
    return (
      <div className="page">
        <button type="button" className="back-link" onClick={() => setIsEditing(false)}>
          ← {translate('common.back')}
        </button>
        <PageHeader title={translate('expense.editTitle')} subtitle={expense.title} />
        <ExpenseForm
          mode="edit"
          expense={expense}
          onSaved={(updated) => {
            setExpense(updated);
            setIsEditing(false);
          }}
          onCancel={() => setIsEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <button type="button" className="back-link" onClick={() => navigate('/ausgaben')}>
        ← {translate('common.back')}
      </button>

      <PageHeader title={expense.title} subtitle={expense.supplierName} />

      <div className="badge-row">
        <Badge tone="info">{translate(categoryKey)}</Badge>
        <Badge>{translate(statusKey)}</Badge>
        <Badge tone="warning">{translate(paymentStatusKey)}</Badge>
      </div>

      <Card>
        <DataRow label={translate('expense.fieldSupplier')} value={expense.supplierName} />
        <DataRow
          label={translate('expense.fieldInvoiceNumber')}
          value={expense.invoiceNumber || '—'}
        />
        <DataRow label={translate('expense.fieldIssueDate')} value={formatDate(expense.issueDate)} />
        <DataRow
          label={translate('expense.fieldDueDate')}
          value={formatDate(expense.paymentDueDate)}
        />
        <DataRow label={translate('expense.fieldGrossAmount')} value={formatEuro(expense.grossAmount)} />
        <DataRow label={translate('expense.fieldNetAmount')} value={formatEuro(expense.netAmount)} />
        <DataRow label={translate('expense.fieldTaxAmount')} value={formatEuro(expense.taxAmount)} />
        {expense.description && (
          <DataRow label={translate('expense.fieldDescription')} value={expense.description} />
        )}
        <DataRow
          label={translate('expense.fieldPaperFolder')}
          value={formatPaperFilingInstruction(expense.paperFolder)}
        />
        <DataRow
          label={translate('expense.fieldDigitalFolder')}
          value={`${expense.digitalFolder.name} (${expense.digitalFolder.path})`}
        />
        {expense.tags.length > 0 && (
          <div className="badge-row document-detail__tags">
            {expense.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        )}
      </Card>

      <div className="form-actions document-detail__actions">
        <Button variant="outline" onClick={() => setIsEditing(true)}>
          {translate('expense.edit')}
        </Button>
        {!confirmDelete ? (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            {translate('expense.delete')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {translate('common.cancel')}
            </Button>
            <Button variant="danger" onClick={handleDelete}>
              {translate('expense.deleteConfirm')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
