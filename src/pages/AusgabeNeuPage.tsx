import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ExpenseForm } from '../components/expenses/ExpenseForm';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { getExpensePrefillForInbox } from '../services/officeActionService';

export function AusgabeNeuPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefill = useMemo(() => {
    const inboxId = searchParams.get('inboxId');
    if (!inboxId) return undefined;
    return getExpensePrefillForInbox(inboxId) ?? undefined;
  }, [searchParams]);

  return (
    <div className="page">
      <button type="button" className="back-link" onClick={() => navigate('/ausgaben')}>
        ← {translate('common.back')}
      </button>
      <PageHeader
        title={translate('expense.addTitle')}
        subtitle={translate('expense.addSubtitle')}
      />
      <ExpenseForm
        mode="add"
        prefill={prefill}
        onSaved={(expense) => navigate(`/ausgaben/${expense.id}`, { replace: true })}
        onCancel={() => navigate('/ausgaben')}
      />
    </div>
  );
}
