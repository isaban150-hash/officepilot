import { useMemo } from 'react';
import { resolveCloudConfirmedActionAccess } from '../services/workspace/workspaceRoleService';
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
  // EINRICHTUNG-01 (AP2, Vertrag 1.11) — zusätzlich gesperrt, solange die Rechte nur aus dem Zwischenspeicher stammen.
  const darfFinanzen = resolveCloudConfirmedActionAccess(
    resolveWorkspaceWriteAccess({
      userId: authUser?.id,
      cloudConfigured: isSupabaseConfigured(),
    }),
  );
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
