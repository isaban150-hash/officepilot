import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ExpenseForm } from '../components/expenses/ExpenseForm';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { getExpensePrefillForInbox } from '../services/officeActionService';
import { getInboxItemById } from '../services/inboxService';
import { isPayrollDocumentKind } from '../services/payrollDocumentKind';
import { PayrollDocumentHint } from '../components/employee/PayrollDocumentHint';
import { ReadOnlyNotice } from '../components/ui/ReadOnlyNotice';
import { useOptionalAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';

export function AusgabeNeuPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  /*
   * GO-LIVE-SECURITY-01 / ABSCHLUSS — eine Ausgabe anlegen ist Buchhaltung: nur Inhaber,
   * Verwaltung und der lokale Betrieb. Ein Mitglied, das aus dem Eingang hierher kommt,
   * sieht den Hinweis statt eines Formulars, dessen Ergebnis der Server abweisen würde.
   */
  const authUser = useOptionalAuth()?.user;
  const darfFinanzen = resolveWorkspaceWriteAccess({
    userId: authUser?.id,
    cloudConfigured: isSupabaseConfigured(),
  }).canWrite;
  const [searchParams] = useSearchParams();
  const prefill = useMemo(() => {
    const inboxId = searchParams.get('inboxId');
    if (!inboxId) return undefined;
    return getExpensePrefillForInbox(inboxId) ?? undefined;
  }, [searchParams]);
  /* P1 MITARBEITERZAHLUNGEN — aus einer Lohnabrechnung entsteht keine vorbelegte Ausgabe. */
  const payrollSource = useMemo(() => {
    const inboxId = searchParams.get('inboxId');
    if (!inboxId) return false;
    return isPayrollDocumentKind(getInboxItemById(inboxId)?.classifiedKind);
  }, [searchParams]);

  return (
    <div className="page">
      <PageHeader
        title={translate('expense.addTitle')}
        subtitle={translate('expense.addSubtitle')}
        backLabel={translate('common.back')}
        onBack={() => navigate('/ausgaben')}
      />
      {payrollSource ? <PayrollDocumentHint translate={translate} testId="expense-new-payroll-hint" /> : null}
      {darfFinanzen ? (
        <ExpenseForm
          mode="add"
          prefill={prefill}
          onSaved={(expense) => navigate(`/ausgaben/${expense.id}`, { replace: true })}
          onCancel={() => navigate('/ausgaben')}
        />
      ) : (
        <ReadOnlyNotice message={translate('expense.roleHint')} testId="expense-new-role-hint" />
      )}
    </div>
  );
}
