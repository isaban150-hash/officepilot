import { useNavigate } from 'react-router-dom';
import { ExpenseForm } from '../components/expenses/ExpenseForm';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';

export function AusgabeNeuPage() {
  const { translate } = useApp();
  const navigate = useNavigate();

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
        onSaved={(expense) => navigate(`/ausgaben/${expense.id}`, { replace: true })}
        onCancel={() => navigate('/ausgaben')}
      />
    </div>
  );
}
