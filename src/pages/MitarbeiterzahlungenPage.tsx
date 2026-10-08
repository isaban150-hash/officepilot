/**
 * P1 MITARBEITERZAHLUNGEN — Finanzen → Mitarbeiterzahlungen.
 *
 * Zahlungen an Mitarbeiter festhalten: Lohn/Gehalt, Vorschuss,
 * Auslagenerstattung, Reisekosten, Sonstiges. Keine Lohnabrechnung, keine
 * Buchung, keine Ausgabe, kein Bankabgleich — die Zahlung ist eine eigene,
 * unveränderliche Tatsache; korrigiert wird per Storno.
 *
 * Sichtbar und bedienbar nur für Inhaber und Verwaltung (dieselbe
 * Schreibfreigabe wie die übrigen Finanzen). Die Zahlung im Detail steht in der
 * Adresse (`?zahlung=…`), ebenso das offene Nachweis-Hochladen
 * (`&nachweis=1`) — ein Neuladen oder der Kamerawechsel am Telefon verliert
 * das Ziel nicht.
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { Page } from '../components/ui/Page';
import { Select } from '../components/ui/Select';
import { ReadOnlyNotice } from '../components/ui/ReadOnlyNotice';
import { InlineNotice } from '../components/ui/States';
import { StatusBadge } from '../components/ui/Badge';
import { MoneyDisplay } from '../components/ui/Display';
import { BusinessList, BusinessListItem } from '../components/ui/Lists';
import { EmployeePaymentDialog } from '../components/employee/EmployeePaymentDialog';
import { EmployeePaymentDetailDialog } from '../components/employee/EmployeePaymentDetailDialog';
import { EmployeeManagementSection } from '../components/employee/EmployeeManagementSection';
import {
  fillText,
  isEmployeeCloudSyncActive,
  kindLabelKey,
  methodLabelKey,
} from '../components/employee/employeePaymentUi';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';
import { listEmployees } from '../services/employee/employeeService';
import { employeePaymentMonth, listEmployeePayments } from '../services/employee/employeePaymentService';
import { formatReceiptDate, formatReceiptWageMonth } from '../services/employee/payoutReceiptModel';
import type { EmployeePayment, EmployeePaymentKind } from '../types/employee';
import { EMPLOYEE_PAYMENT_KINDS, isEmployeePaymentReversed } from '../types/employee';
import type { TranslationKey } from '../i18n';

type StatusFilter = 'all' | 'active' | 'reversed';

export function MitarbeiterzahlungenPage() {
  const { translate: t, showToast } = useApp();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [version, setVersion] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [monthFilter, setMonthFilter] = useState('all');
  const [employeeFilter, setEmployeeFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState<EmployeePaymentKind | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const cloudConfigured = isSupabaseConfigured();
  const access = useMemo(
    () => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured }),
    [user?.id, cloudConfigured],
  );
  const canWrite = access.canWrite === true;
  const uploadDeps = useMemo(() => ({ access }), [access]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const employees = useMemo(() => listEmployees({ includeInactive: true }), [version]);
  const payments = useMemo(() => listEmployeePayments(), [version]);

  const months = useMemo(
    () => Array.from(new Set(payments.map((payment) => employeePaymentMonth(payment)))).sort().reverse(),
    [payments],
  );

  const filtered = useMemo(
    () =>
      payments.filter((payment) => {
        if (monthFilter !== 'all' && employeePaymentMonth(payment) !== monthFilter) return false;
        if (employeeFilter !== 'all' && payment.employeeId !== employeeFilter) return false;
        if (kindFilter !== 'all' && payment.kind !== kindFilter) return false;
        const reversed = isEmployeePaymentReversed(payment);
        if (statusFilter === 'active' && reversed) return false;
        if (statusFilter === 'reversed' && !reversed) return false;
        return true;
      }),
    [payments, monthFilter, employeeFilter, kindFilter, statusFilter],
  );

  const selectedPaymentId = searchParams.get('zahlung');
  const uploadOpen = searchParams.get('nachweis') === '1';

  const openPayment = (id: string | null, options: { upload?: boolean } = {}) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('zahlung', id);
    else next.delete('zahlung');
    if (id && options.upload) next.set('nachweis', '1');
    else next.delete('nachweis');
    setSearchParams(next, { replace: Boolean(id) && Boolean(selectedPaymentId) });
  };

  const handleConfirmed = (payment: EmployeePayment, replayed: boolean) => {
    setDialogOpen(false);
    showToast(
      replayed
        ? t('employeePayment.toast.replayed')
        : fillText(t('employeePayment.toast.created'), { reference: payment.receiptReference }),
    );
    refresh();
    openPayment(payment.id);
  };

  if (!canWrite) {
    return (
      <Page testId="employee-payments-page">
        <PageHeader
          title={t('employeePayments.title')}
          subtitle={t('employeePayments.subtitle')}
          backLabel={t('common.back')}
          backHref="/finanzen"
        />
        <ReadOnlyNotice message={t('employeePayments.readOnly')} testId="employee-payments-read-only" />
      </Page>
    );
  }

  const listLabel = (payment: EmployeePayment) => {
    const teile = [formatReceiptDate(payment.paymentDate), t(methodLabelKey(payment.paymentMethod))];
    if (payment.wageMonth) teile.push(formatReceiptWageMonth(payment.wageMonth));
    teile.push(t(payment.proofDocumentId ? 'employeePayment.proofStatus.present' : 'employeePayment.proofStatus.missing'));
    return teile.join(' · ');
  };

  return (
    <Page testId="employee-payments-page" className="employee-payments">
      <PageHeader
        title={t('employeePayments.title')}
        subtitle={t('employeePayments.subtitle')}
        backLabel={t('common.back')}
        backHref="/finanzen"
        primaryAction={
          <Button onClick={() => setDialogOpen(true)} data-testid="employee-payments-add">
            {t('employeePayments.add')}
          </Button>
        }
      />

      {cloudConfigured && !isEmployeeCloudSyncActive() ? (
        <InlineNotice tone="info" testId="employee-payments-local-only">
          {t('employeePayments.localOnly')}
        </InlineNotice>
      ) : null}

      <div className="employee-payments__filters" data-testid="employee-payments-filters">
        <Select
          label={t('employeePayments.filter.month')}
          value={monthFilter}
          onChange={(event) => setMonthFilter(event.target.value)}
          data-testid="employee-payments-filter-month"
        >
          <option value="all">{t('employeePayments.filter.allMonths')}</option>
          {months.map((month) => (
            <option key={month} value={month}>
              {formatReceiptWageMonth(month)}
            </option>
          ))}
        </Select>
        <Select
          label={t('employeePayments.filter.employee')}
          value={employeeFilter}
          onChange={(event) => setEmployeeFilter(event.target.value)}
          data-testid="employee-payments-filter-employee"
        >
          <option value="all">{t('employeePayments.filter.allEmployees')}</option>
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.name}
            </option>
          ))}
        </Select>
        <Select
          label={t('employeePayments.filter.kind')}
          value={kindFilter}
          onChange={(event) => setKindFilter(event.target.value as EmployeePaymentKind | 'all')}
          data-testid="employee-payments-filter-kind"
        >
          <option value="all">{t('employeePayments.filter.allKinds')}</option>
          {EMPLOYEE_PAYMENT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(kindLabelKey(kind))}
            </option>
          ))}
        </Select>
        <Select
          label={t('employeePayments.filter.status')}
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          data-testid="employee-payments-filter-status"
        >
          <option value="all">{t('employeePayments.filter.allStatus')}</option>
          <option value="active">{t('employeePayments.status.active')}</option>
          <option value="reversed">{t('employeePayments.status.reversed')}</option>
        </Select>
      </div>

      {payments.length === 0 ? (
        <p className="employee-payments__empty" data-testid="employee-payments-empty">
          {t('employeePayments.empty')}
        </p>
      ) : filtered.length === 0 ? (
        <p className="employee-payments__empty" data-testid="employee-payments-empty-filtered">
          {t('employeePayments.emptyFiltered')}
        </p>
      ) : (
        <>
          <p className="employee-payments__count" data-testid="employee-payments-count">
            {fillText(t(filtered.length === 1 ? 'employeePayments.countOne' : 'employeePayments.count'), { count: filtered.length })}
          </p>
          <BusinessList testId="employee-payments-list" ariaLabel={t('employeePayments.list.label')}>
            {filtered.map((payment) => {
              const reversed = isEmployeePaymentReversed(payment);
              return (
                <BusinessListItem
                  key={payment.id}
                  testId={`employee-payment-row-${payment.id}`}
                  linkTestId={`employee-payment-open-${payment.id}`}
                  className={reversed ? 'employee-payments__row--reversed' : undefined}
                  title={payment.employeeName}
                  subtitle={`${payment.receiptReference} · ${t(kindLabelKey(payment.kind))}`}
                  meta={listLabel(payment)}
                  status={
                    <StatusBadge
                      tone={reversed ? 'neutral' : 'success'}
                      label={t(reversed ? 'employeePayments.status.reversed' : 'employeePayments.status.active')}
                      icon={false}
                    />
                  }
                  amount={<MoneyDisplay value={payment.amount} />}
                  onClick={() => openPayment(payment.id)}
                />
              );
            })}
          </BusinessList>
        </>
      )}

      <EmployeeManagementSection
        employees={employees}
        canWrite={canWrite}
        userId={user?.id}
        translate={t}
        showToast={showToast}
        onChanged={refresh}
      />

      <EmployeePaymentDialog
        open={dialogOpen}
        employees={employees}
        userId={user?.id}
        translate={t}
        onClose={() => setDialogOpen(false)}
        onConfirmed={handleConfirmed}
      />

      <EmployeePaymentDetailDialog
        paymentId={selectedPaymentId}
        uploadOpen={uploadOpen}
        canWrite={canWrite}
        cloudConfigured={cloudConfigured}
        userId={user?.id}
        uploadDeps={uploadDeps}
        translate={t as (key: TranslationKey) => string}
        showToast={showToast}
        onUploadOpenChange={(open) => openPayment(selectedPaymentId, { upload: open })}
        onChanged={refresh}
        onClose={() => openPayment(null)}
      />
    </Page>
  );
}
