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
      <PageHeader
        title={translate('expense.addTitle')}
        subtitle={translate('expense.addSubtitle')}
        backLabel={translate('common.back')}
        onBack={() => navigate('/ausgaben')}
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
