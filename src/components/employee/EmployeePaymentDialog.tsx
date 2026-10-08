/**
 * P1 MITARBEITERZAHLUNGEN — eine Mitarbeiterzahlung erfassen.
 *
 * Confirm-first: Formular → Zusammenfassung → „Zahlung jetzt erfassen". Erst
 * dieser letzte Klick hält die Zahlung fest; Abbrechen erzeugt nichts. Die
 * Kennung der Zahlung steht für die ganze Sitzung des Dialogs fest — ein
 * zweiter Klick oder ein erneuter Versuch trägt dieselbe Kennung und wird als
 * Wiederholung erkannt, nie als zweite Zahlung.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import { InlineNotice } from '../ui/States';
import { DataRow } from '../ui/Card';
import { PaymentProofField } from '../payment/PaymentProofField';
import type { TranslationKey } from '../../i18n';
import type {
  Employee,
  EmployeePayment,
  EmployeePaymentConfirmationIntent,
  EmployeePaymentDraft,
} from '../../types/employee';
import { EMPLOYEE_PAYMENT_KINDS, EMPLOYEE_PAYMENT_METHODS } from '../../types/employee';
import {
  confirmEmployeePayment,
  findPayrollExpensesForMonth,
  findPossibleDuplicateEmployeePayments,
  prepareEmployeePaymentConfirmation,
  type EmployeePaymentField,
} from '../../services/employee/employeePaymentService';
import { generateUuid } from '../../services/sync/syncMetaService';
import { getDocumentById } from '../../services/documentService';
import { formatReceiptDate, formatReceiptWageMonth } from '../../services/employee/payoutReceiptModel';
import { formatEuroAmount } from '../../utils/displayFormat';
import {
  fillText,
  isSelectableEmployeeProofDocument,
  kindHintKey,
  kindLabelKey,
  methodLabelKey,
  todayIsoLocal,
} from './employeePaymentUi';

interface Props {
  open: boolean;
  employees: Employee[];
  userId?: string;
  translate: (key: TranslationKey) => string;
  onClose: () => void;
  onConfirmed: (payment: EmployeePayment, replayed: boolean) => void;
}

function emptyDraft(): EmployeePaymentDraft {
  return {
    employeeId: '',
    kind: '',
    amount: '',
    paymentDate: todayIsoLocal(),
    paymentMethod: '',
    wageMonth: '',
    purpose: '',
    note: '',
    paidByName: '',
    proofDocumentId: '',
  };
}

interface FieldError {
  key: string;
  field: EmployeePaymentField | 'general';
}

export function EmployeePaymentDialog({ open, employees, userId, translate, onClose, onConfirmed }: Props) {
  const [step, setStep] = useState<'form' | 'summary'>('form');
  const [draft, setDraft] = useState<EmployeePaymentDraft>(emptyDraft);
  const [intent, setIntent] = useState<EmployeePaymentConfirmationIntent | null>(null);
  const [error, setError] = useState<FieldError | null>(null);
  const [saving, setSaving] = useState(false);
  /* Eine Kennung je Dialogsitzung; ein Klick-Schloss gegen den Doppelklick. */
  const paymentIdRef = useRef<string>(generateUuid());
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    paymentIdRef.current = generateUuid();
    inFlightRef.current = false;
    setStep('form');
    setDraft(emptyDraft());
    setIntent(null);
    setError(null);
    setSaving(false);
  }, [open]);

  const activeEmployees = useMemo(() => employees.filter((employee) => employee.active), [employees]);
  const t = translate;
  const fieldError = (field: EmployeePaymentField) =>
    error && error.field === field ? t(error.key as TranslationKey) : undefined;

  const update = (patch: Partial<EmployeePaymentDraft>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      // Ein Lohnmonat gibt es nur bei Lohn/Gehalt — beim Wechsel der Art fällt er weg.
      if (patch.kind !== undefined && patch.kind !== 'wage') next.wageMonth = '';
      return next;
    });
    setError(null);
  };

  const handleNext = () => {
    const result = prepareEmployeePaymentConfirmation(draft, { paymentId: paymentIdRef.current });
    if (!result.ok) {
      setError({ key: result.errorKey, field: result.field });
      return;
    }
    setIntent(result.intent);
    setError(null);
    setStep('summary');
  };

  const handleConfirm = () => {
    if (!intent || inFlightRef.current) return;
    inFlightRef.current = true;
    setSaving(true);
    try {
      const result = confirmEmployeePayment(intent, { userId });
      if (!result.success) {
        setError({ key: result.errorKey, field: 'general' });
        return;
      }
      onConfirmed(result.payment, result.replayed);
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  };

  const payrollWarning = useMemo(() => {
    if (!intent || intent.kind !== 'wage') return null;
    const month = intent.wageMonth || intent.paymentDate.slice(0, 7);
    const treffer = findPayrollExpensesForMonth(month);
    if (treffer.length === 0) return null;
    return fillText(t('employeePayment.warning.payrollExpense'), {
      month: formatReceiptWageMonth(month),
      count: treffer.length,
    });
  }, [intent, t]);

  /* P1MA WEISS — dieselbe gültige Zahlung ist schon erfasst: Hinweis, keine Sperre. */
  const duplicateWarning = useMemo(() => {
    if (!intent) return null;
    const treffer = findPossibleDuplicateEmployeePayments(intent);
    if (treffer.length === 0) return null;
    return fillText(t('employeePayment.warning.possibleDuplicate'), {
      date: formatReceiptDate(intent.paymentDate),
      references: treffer.map((payment) => payment.receiptReference).join(', '),
    });
  }, [intent, t]);

  const proofTitle = intent?.proofDocumentId ? getDocumentById(intent.proofDocumentId)?.title : undefined;

  const formView = (
    <div className="employee-payment-form" data-testid="employee-payment-form">
      {activeEmployees.length === 0 ? (
        <InlineNotice tone="warning" testId="employee-payment-no-employees">
          {t('employeePayment.form.noEmployees')}
        </InlineNotice>
      ) : null}
      <Select
        label={t('employeePayment.field.employee')}
        required
        value={draft.employeeId}
        onChange={(event) => update({ employeeId: event.target.value })}
        error={fieldError('employee')}
        data-testid="employee-payment-employee"
      >
        <option value="">{t('employeePayment.employee.choose')}</option>
        {activeEmployees.map((employee) => (
          <option key={employee.id} value={employee.id}>
            {employee.personnelNumber ? `${employee.name} (${employee.personnelNumber})` : employee.name}
          </option>
        ))}
      </Select>
      <Select
        label={t('employeePayment.field.kind')}
        helperText={t('employeePayment.field.kindHelp')}
        required
        value={draft.kind}
        onChange={(event) => update({ kind: event.target.value as EmployeePaymentDraft['kind'] })}
        error={fieldError('kind')}
        data-testid="employee-payment-kind"
      >
        <option value="">{t('employeePayment.kind.choose')}</option>
        {EMPLOYEE_PAYMENT_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(kindLabelKey(kind))}
          </option>
        ))}
      </Select>
      <Input
        label={t('employeePayment.field.amount')}
        required
        inputMode="decimal"
        autoComplete="off"
        placeholder={t('employeePayment.form.amountPlaceholder')}
        value={draft.amount}
        onChange={(event) => update({ amount: event.target.value })}
        error={fieldError('amount')}
        data-testid="employee-payment-amount"
      />
      <Input
        label={t('employeePayment.field.date')}
        required
        type="date"
        max={todayIsoLocal()}
        value={draft.paymentDate}
        onChange={(event) => update({ paymentDate: event.target.value })}
        error={fieldError('paymentDate')}
        data-testid="employee-payment-date"
      />
      <Select
        label={t('employeePayment.field.method')}
        helperText={t('employeePayment.field.methodHelp')}
        required
        value={draft.paymentMethod}
        onChange={(event) => update({ paymentMethod: event.target.value as EmployeePaymentDraft['paymentMethod'] })}
        error={fieldError('paymentMethod')}
        data-testid="employee-payment-method"
      >
        <option value="">{t('employeePayment.method.choose')}</option>
        {EMPLOYEE_PAYMENT_METHODS.map((method) => (
          <option key={method} value={method}>
            {t(methodLabelKey(method))}
          </option>
        ))}
      </Select>
      {draft.paymentMethod === 'bank' ? (
        <p className="form-hint" data-testid="employee-payment-bank-hint">
          {t('employeePayment.hint.bank')}
        </p>
      ) : null}
      {draft.kind === 'wage' ? (
        <Input
          label={t('employeePayment.field.wageMonth')}
          type="month"
          helperText={t('employeePayment.form.wageMonthHint')}
          value={draft.wageMonth ?? ''}
          onChange={(event) => update({ wageMonth: event.target.value })}
          error={fieldError('wageMonth')}
          data-testid="employee-payment-wage-month"
        />
      ) : null}
      <Input
        label={t('employeePayment.field.purpose')}
        value={draft.purpose ?? ''}
        maxLength={500}
        onChange={(event) => update({ purpose: event.target.value })}
        error={fieldError('purpose')}
        data-testid="employee-payment-purpose"
      />
      <Textarea
        label={t('employeePayment.field.note')}
        required={draft.kind === 'other'}
        rows={3}
        maxLength={500}
        placeholder={draft.kind === 'other' ? t('employeePayment.form.notePlaceholderOther') : undefined}
        value={draft.note ?? ''}
        onChange={(event) => update({ note: event.target.value })}
        error={fieldError('note')}
        data-testid="employee-payment-note"
      />
      <Input
        label={t('employeePayment.field.paidBy')}
        helperText={t('employeePayment.form.paidByHint')}
        value={draft.paidByName ?? ''}
        maxLength={120}
        onChange={(event) => update({ paidByName: event.target.value })}
        error={fieldError('paidByName')}
        data-testid="employee-payment-paid-by"
      />
      <PaymentProofField
        value={draft.proofDocumentId ?? ''}
        onChange={(value) => update({ proofDocumentId: value })}
        translate={t}
        testId="employee-payment-proof"
        isSelectable={isSelectableEmployeeProofDocument}
      />
      {fieldError('proof') ? (
        <p className="form-error" role="alert" data-testid="employee-payment-proof-error">
          {fieldError('proof')}
        </p>
      ) : (
        <p className="form-hint">{t('employeePayment.form.proofHint')}</p>
      )}
    </div>
  );

  const summaryView = intent ? (
    <div className="employee-payment-summary" data-testid="employee-payment-summary">
      <p className="form-hint">{t('employeePayment.summary.intro')}</p>
      <div className="employee-payment-summary__facts">
        <DataRow
          label={t('employeePayment.field.employee')}
          value={intent.personnelNumber ? `${intent.employeeName} (${intent.personnelNumber})` : intent.employeeName}
        />
        <DataRow label={t('employeePayment.field.kind')} value={t(kindLabelKey(intent.kind))} />
        <DataRow
          label={t('employeePayment.field.amount')}
          value={<strong data-testid="employee-payment-summary-amount">{formatEuroAmount(intent.amount)}</strong>}
        />
        <DataRow label={t('employeePayment.field.date')} value={formatReceiptDate(intent.paymentDate)} />
        <DataRow label={t('employeePayment.field.method')} value={t(methodLabelKey(intent.paymentMethod))} />
        {intent.wageMonth ? (
          <DataRow label={t('employeePayment.field.wageMonth')} value={formatReceiptWageMonth(intent.wageMonth)} />
        ) : null}
        {intent.purpose ? <DataRow label={t('employeePayment.field.purpose')} value={intent.purpose} /> : null}
        {intent.note ? <DataRow label={t('employeePayment.field.note')} value={intent.note} /> : null}
        {intent.paidByName ? <DataRow label={t('employeePayment.field.paidBy')} value={intent.paidByName} /> : null}
        <DataRow
          label={t('employeePayment.field.proof')}
          value={
            proofTitle
              ? `${t('employeePayment.summary.proofPresent')}: ${proofTitle}`
              : intent.paymentMethod === 'cash'
                ? t('employeePayment.summary.proofMissingCash')
                : t('employeePayment.summary.proofMissing')
          }
        />
      </div>
      <div className="employee-payment-summary__hints" aria-label={t('employeePayment.summary.hints')}>
        {duplicateWarning ? (
          <InlineNotice tone="warning" testId="employee-payment-duplicate-warning">
            {duplicateWarning}
          </InlineNotice>
        ) : null}
        <InlineNotice tone="info" testId={`employee-payment-hint-${intent.kind}`}>
          {t(kindHintKey(intent.kind))}
        </InlineNotice>
        <p className="form-hint" data-testid="employee-payment-hint-no-expense">
          {t('employeePayment.hint.noExpense')}
        </p>
        {intent.paymentMethod === 'bank' ? (
          <p className="form-hint" data-testid="employee-payment-summary-bank-hint">
            {t('employeePayment.hint.bank')}
          </p>
        ) : null}
        {payrollWarning ? (
          <InlineNotice tone="warning" testId="employee-payment-payroll-warning">
            {payrollWarning}
          </InlineNotice>
        ) : null}
      </div>
    </div>
  ) : null;

  const actions =
    step === 'form' ? (
      <>
        <Button variant="secondary" onClick={onClose} data-testid="employee-payment-cancel">
          {t('employeePayment.form.cancel')}
        </Button>
        <Button onClick={handleNext} data-testid="employee-payment-next">
          {t('employeePayment.form.next')}
        </Button>
      </>
    ) : (
      <>
        <Button
          variant="secondary"
          disabled={saving}
          onClick={() => {
            setStep('form');
            setError(null);
          }}
          data-testid="employee-payment-back"
        >
          {t('employeePayment.summary.back')}
        </Button>
        <Button
          onClick={handleConfirm}
          loading={saving}
          disabled={saving}
          data-testid="employee-payment-confirm"
        >
          {saving ? t('employeePayment.summary.saving') : t('employeePayment.summary.confirm')}
        </Button>
      </>
    );

  return (
    <Dialog
      open={open}
      title={step === 'form' ? t('employeePayment.form.title') : t('employeePayment.summary.title')}
      onClose={onClose}
      busy={saving}
      size="md"
      closeOnBackdrop={false}
      testId="employee-payment-dialog"
      actions={actions}
    >
      {error && error.field === 'general' ? (
        <p className="form-error" role="alert" data-testid="employee-payment-error">
          {t(error.key as TranslationKey)}
        </p>
      ) : null}
      {step === 'form' ? formView : summaryView}
    </Dialog>
  );
}
