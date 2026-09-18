import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ExpenseAllocationDialog } from '../components/expenses/ExpenseAllocationDialog';
import { ExpenseCancelDialog } from '../components/expenses/ExpenseCancelDialog';
import { ExpenseForm } from '../components/expenses/ExpenseForm';
import { ExpensePaymentForm } from '../components/expenses/ExpensePaymentForm';
import { getExpensePaymentSavedToastKey } from '../components/expenses/ExpensePaymentSummary';
import { ExpensePaymentHistory } from '../components/expenses/ExpensePaymentHistory';
import { ExpensePaymentSummary } from '../components/expenses/ExpensePaymentSummary';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { EXPENSE_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { Button } from '../components/ui/Button';
import { Badge, DataRow, PageHeader, StatusBadge } from '../components/ui/Card';
import { DateDisplay, MoneyDisplay } from '../components/ui/Display';
import { Page } from '../components/ui/Page';
import { DetailSection, SummaryList } from '../components/ui/Section';
import { expenseStatusTone, paymentStatusTone } from '../services/ui/statusTone';
import { useApp } from '../context/AppContext';
import { formatPaperFilingInstruction } from '../services/paperFolderService';
import { formatDisplayDate } from '../utils/displayFormat';
import {
  calculateExpensePaymentSummary,
  isExpenseCancelled,
  isExpensePayable,
  removeExpensePayment,
} from '../services/expensePaymentService';
import {
  deleteExpense,
  getExpenseById,
  getUnallocatedAmount,
  hasBookedExpensePayments,
  removeExpenseAllocation,
} from '../services/expenseService';
import { formatPaymentCurrency } from '../services/expensePaymentService';
import { getInboxItemById } from '../services/inboxService';
import type { Expense } from '../types/expense';
import type { TranslationKey } from '../i18n';

/**
 * UIUX-FOUNDATION-01D — repräsentative Detailseite.
 * Oben: Back (from-Parameter bleibt), Identität, Zahlungsstatus, eine
 * Hauptaktion. Dann Zahlungsstand, Details als Schlüssel/Wert-Liste,
 * Kommunikation, zuletzt Bearbeiten/Löschen. Fachlogik unverändert.
 */
export function AusgabeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const fromOverview = searchParams.get('from') === 'overview';
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const [expense, setExpense] = useState<Expense | undefined>(() =>
    id ? getExpenseById(id) : undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showAllocationDialog, setShowAllocationDialog] = useState(false);

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
  /*
   * F-15 — der Beleg hinter der Ausgabe: solange er im Eingang liegt, führt der
   * Weg dorthin; nach der Archivierung zum Dokument. Nur Anzeige, keine neue Datenhaltung.
   */
  const sourceInbox = expense.linkedInboxId ? getInboxItemById(expense.linkedInboxId) : undefined;
  const linkedDocument = sourceInbox
    ? sourceInbox.archiveDocumentId?.trim()
      ? { route: `/dokumente/${sourceInbox.archiveDocumentId}`, label: sourceInbox.title }
      : { route: `/ablage/${sourceInbox.id}`, label: sourceInbox.title }
    : null;

  const handleDelete = () => {
    const result = deleteExpense(expense.id);
    if (result.success) {
      showToast(translate('expense.deleted'));
      navigate('/ausgaben', { replace: true });
    } else {
      showToast(translate(result.errorKey as TranslationKey));
    }
  };

  const handlePaymentSaved = (updated: Expense) => {
    setExpense(updated);
    showToast(translate(getExpensePaymentSavedToastKey(updated)));
  };

  const handleRemovePayment = (paymentId: string) => {
    const result = removeExpensePayment(expense.id, paymentId);
    if (!result.success) {
      showToast(translate(result.errorKey as TranslationKey));
      return;
    }
    setExpense(result.expense);
    showToast(translate('expense.payment.removedSuccess'));
  };

  if (isEditing) {
    return (
      <Page testId="ausgabe-detail-edit">
        <PageHeader
          title={translate('expense.editTitle')}
          subtitle={expense.title}
          backLabel={translate('common.back')}
          onBack={() => setIsEditing(false)}
          backTestId="ausgabe-edit-back"
        />
        <ExpenseForm
          mode="edit"
          expense={expense}
          onSaved={(updated) => {
            setExpense(updated);
            setIsEditing(false);
          }}
          onCancel={() => setIsEditing(false)}
        />
      </Page>
    );
  }

  const paymentSummary = calculateExpensePaymentSummary(expense);
  const cancelled = isExpenseCancelled(expense);
  const canRecordPayment = isExpensePayable(expense) && !cancelled;
  /*
   * OFFICEPILOT-V1-A — Storno und Bearbeiten nur für gebuchte, nicht stornierte
   * Belege. Der Dienst prüft dasselbe; hier wird es nicht erst angeboten.
   * Die nächste sinnvolle Aktion steht als ein Satz über den Details.
   */
  const canCancel = expense.status === 'gebucht' && !cancelled;
  const paymentsBooked = hasBookedExpensePayments(expense);
  /*
   * ORDER-COST-ALLOCATION-01B — der Auftragsbezug der Ausgabe. Eine stornierte
   * Ausgabe behält ihre Zuordnung als Historie, wird aber nicht mehr geändert.
   */
  const allocation = (expense.allocations ?? [])[0];
  const unallocated = getUnallocatedAmount(expense);
  const handleRemoveAllocation = () => {
    if (!allocation) return;
    const result = removeExpenseAllocation(expense.id, allocation.vorgangId);
    if (!result.success) {
      showToast(translate(result.errorKey as TranslationKey));
      return;
    }
    setExpense(result.expense);
    showToast(translate('expense.allocation.removed'));
  };
  const nextActionKey: TranslationKey = cancelled
    ? 'expense.nextAction.cancelled'
    : paymentSummary.status === 'bezahlt'
      ? 'expense.nextAction.paid'
      : paymentSummary.status === 'teilbezahlt'
        ? 'expense.nextAction.partial'
        : 'expense.nextAction.open';

  return (
    <Page testId="ausgabe-detail-page">
      <PageHeader
        title={expense.title}
        subtitle={
          <>
            {expense.supplierName}
            {' · '}
            {translate(categoryKey)}
            {/* V1-A — storniert steht bereits als Statusabzeichen im Kopf; kein zweites Abzeichen daneben. */}
            {expense.status !== 'gebucht' && !cancelled ? (
              <>
                {' · '}
                <Badge tone={expenseStatusTone(expense.status)}>{translate(statusKey)}</Badge>
              </>
            ) : null}
          </>
        }
        status={
          <StatusBadge
            tone={cancelled ? expenseStatusTone('storniert') : paymentStatusTone(paymentSummary.status)}
            label={translate(`payment.status.${paymentSummary.status}` as TranslationKey)}
            data-testid="ausgabe-payment-status"
          />
        }
        backLabel={fromOverview ? translate('expenseOverview.backToOverview') : translate('common.back')}
        backHref={fromOverview ? '/ausgaben/offen' : '/ausgaben'}
        backTestId="ausgabe-detail-back"
        primaryAction={
          canRecordPayment ? (
            <Button type="button" onClick={() => setShowPaymentForm(true)} data-testid="ausgabe-record-payment">
              {translate('payment.record')}
            </Button>
          ) : undefined
        }
      />

      {cancelled ? (
        <section className="invoice-cancelled-panel" data-testid="ausgabe-cancelled-panel">
          <p className="invoice-hint invoice-hint--warning" data-testid="ausgabe-cancelled-notice">
            {expense.cancelledAt
              ? translate('expense.cancelledOn').replace('{date}', formatDisplayDate(expense.cancelledAt))
              : translate('expense.payment.cancelledNotice')}
          </p>
          {expense.cancelReason ? (
            <div className="data-row" data-testid="ausgabe-cancelled-reason">
              <span className="data-row__label">{translate('expense.fieldCancelReason')}</span>
              <span className="data-row__value">{expense.cancelReason}</span>
            </div>
          ) : null}
        </section>
      ) : null}

      <p className="invoice-hint" data-testid="ausgabe-next-action">
        {translate(nextActionKey)}
      </p>

      <DetailSection title={translate('payment.summaryTitle')} surface testId="ausgabe-section-payment">
        <ExpensePaymentSummary expense={expense} translate={translate} />
        <ExpensePaymentHistory
          expense={expense}
          translate={translate}
          onRemovePayment={handleRemovePayment}
        />
      </DetailSection>

      <DetailSection title={translate('documentExperience.details')} testId="ausgabe-section-details">
        <SummaryList>
          {/* PRODUCT-ACCEPTANCE-FIX-01B (F-15) — Dokumentbezug: aus dem Eingang erzeugte Ausgaben verweisen auf ihren Beleg. */}
          {linkedDocument ? (
            <DataRow
              label={translate('expense.fieldSourceDocument')}
              value={
                <Link to={linkedDocument.route} data-testid="ausgabe-source-document">
                  {linkedDocument.label}
                </Link>
              }
            />
          ) : null}
          <DataRow label={translate('expense.fieldSupplier')} value={expense.supplierName} />
          <DataRow label={translate('expense.fieldCategory')} value={translate(categoryKey)} />
          {/* V1-B2/01B — Auftragsbezug: Name des Auftrags, nie eine technische Kennung. */}
          <DataRow
            label={translate('expense.allocation.label')}
            value={
              allocation ? (
                <span data-testid="ausgabe-allocation-value">
                  <Link to={`/vorgaenge/${allocation.vorgangId}`}>{allocation.vorgangTitle}</Link>
                  {' · '}
                  {formatPaymentCurrency(allocation.amount)}
                </span>
              ) : (
                <span data-testid="ausgabe-allocation-none">{translate('expense.allocation.none')}</span>
              )
            }
          />
          {allocation && unallocated > 0 ? (
            <DataRow
              label={translate('expense.allocation.unallocated').split(':')[0]}
              value={formatPaymentCurrency(unallocated)}
            />
          ) : null}
          <DataRow
            label={translate('expense.fieldStatus')}
            value={<Badge tone={expenseStatusTone(expense.status)}>{translate(statusKey)}</Badge>}
          />
          <DataRow
            label={translate('expense.fieldPaymentStatus')}
            value={translate(`payment.status.${paymentSummary.status}` as TranslationKey)}
          />
          <DataRow
            label={translate('expense.fieldInvoiceNumber')}
            value={expense.invoiceNumber || '—'}
          />
          <DataRow label={translate('expense.fieldIssueDate')} value={<DateDisplay value={expense.issueDate} />} />
          <DataRow
            label={translate('expense.fieldDueDate')}
            value={<DateDisplay value={expense.paymentDueDate} />}
          />
          <DataRow label={translate('expense.fieldGrossAmount')} value={<MoneyDisplay value={expense.grossAmount} emphasis />} />
          <DataRow label={translate('expense.fieldNetAmount')} value={<MoneyDisplay value={expense.netAmount} />} />
          <DataRow label={translate('expense.fieldTaxAmount')} value={<MoneyDisplay value={expense.taxAmount} />} />
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
        </SummaryList>
        {expense.tags.length > 0 && (
          <div className="badge-row document-detail__tags">
            {expense.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        )}
      </DetailSection>

      <CommunicationIntegrationPanel
        contextRef={{ type: 'expense', id: expense.id }}
        buttonKeys={EXPENSE_COMMUNICATION_BUTTON_KEYS}
        testIdPrefix="ausgabe"
      />

      <div className="detail-actions" data-testid="ausgabe-detail-actions">
        {!cancelled ? (
          <Button variant="outline" onClick={() => setIsEditing(true)} data-testid="ausgabe-edit">
            {translate('expense.edit')}
          </Button>
        ) : null}
        {/* V1-A — Storno sekundär (outline), bestätigt im Dialog; nie die Hauptaktion. */}
        {!cancelled ? (
          <Button
            variant="outline"
            onClick={() => setShowAllocationDialog(true)}
            data-testid="ausgabe-allocation-assign"
          >
            {translate(allocation ? 'expense.allocation.change' : 'expense.allocation.assign')}
          </Button>
        ) : null}
        {!cancelled && allocation ? (
          <Button variant="ghost" onClick={handleRemoveAllocation} data-testid="ausgabe-allocation-remove">
            {translate('expense.allocation.remove')}
          </Button>
        ) : null}
        {canCancel ? (
          <Button
            variant="outline"
            onClick={() => setShowCancelDialog(true)}
            title={paymentsBooked ? translate('expense.cancel.hasPayments') : undefined}
            data-testid="ausgabe-cancel-action"
          >
            {translate('expense.cancel')}
          </Button>
        ) : null}
        {cancelled ? null : !confirmDelete ? (
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

      <ExpensePaymentForm
        expense={expense}
        open={showPaymentForm}
        onClose={() => setShowPaymentForm(false)}
        onSaved={handlePaymentSaved}
        translate={translate}
      />
      {!cancelled ? (
        <ExpenseAllocationDialog
          expense={expense}
          open={showAllocationDialog}
          onClose={() => setShowAllocationDialog(false)}
          onSaved={(updated) => {
            setExpense(updated);
            showToast(translate('expense.allocation.saved'));
          }}
        />
      ) : null}
      {canCancel ? (
        <ExpenseCancelDialog
          expense={expense}
          open={showCancelDialog}
          onClose={() => setShowCancelDialog(false)}
          onCancelled={(updated) => {
            setExpense(updated);
            showToast(translate('expense.cancel.success'));
          }}
          translate={translate}
        />
      ) : null}
    </Page>
  );
}
