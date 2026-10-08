/**
 * P1 MITARBEITERZAHLUNGEN — eine erfasste Mitarbeiterzahlung im Detail.
 *
 * Angezeigt wird die festgehaltene Zahlung; ändern lassen sich nur die
 * geldfreien Teile: Quittung erstellen (einmal), Nachweis zuordnen. Eine
 * Korrektur ist ein Storno mit Grund — bestätigt in einem eigenen Schritt.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { DataRow } from '../ui/Card';
import { StatusBadge } from '../ui/Badge';
import { InlineNotice } from '../ui/States';
import { Textarea } from '../ui/Textarea';
import { PaymentProofField } from '../payment/PaymentProofField';
import type { TranslationKey } from '../../i18n';
import type { EmployeePayment } from '../../types/employee';
import { isEmployeePaymentReversed } from '../../types/employee';
import {
  getEmployeePaymentById,
  reverseEmployeePayment,
  setEmployeePaymentProof,
} from '../../services/employee/employeePaymentService';
import {
  ensurePayoutReceiptArchived,
  loadPayoutReceiptOriginal,
  type PayoutReceiptArchiveFailure,
} from '../../services/employee/payoutReceiptArchiveService';
import { getDocumentById } from '../../services/documentService';
import type { EmployeeProofUploadDeps } from '../../services/employee/employeePaymentProofUploadService';
import { formatReceiptDate, formatReceiptWageMonth } from '../../services/employee/payoutReceiptModel';
import { formatDisplayDatePadded, formatDisplayDateTime, formatEuroAmount } from '../../utils/displayFormat';
import { EmployeePaymentProofUpload } from './EmployeePaymentProofUpload';
import {
  fillText,
  isEmployeeCloudSyncActive,
  isEmployeePaymentCloudPending,
  isSelectableEmployeeProofDocument,
  kindLabelKey,
  methodLabelKey,
} from './employeePaymentUi';

interface Props {
  paymentId: string | null;
  uploadOpen: boolean;
  canWrite: boolean;
  cloudConfigured: boolean;
  userId?: string;
  uploadDeps: EmployeeProofUploadDeps;
  translate: (key: TranslationKey) => string;
  showToast: (message: string) => void;
  onUploadOpenChange: (open: boolean) => void;
  onChanged: () => void;
  onClose: () => void;
}

const RECEIPT_ERRORS: Record<PayoutReceiptArchiveFailure, TranslationKey> = {
  not_found: 'employeePayment.error.notFound' as TranslationKey,
  not_cash: 'employeePayment.receipt.onlyCash' as TranslationKey,
  reversed: 'employeePayment.receipt.notAfterReversal' as TranslationKey,
  invalid_payment: 'employeePayment.receipt.error' as TranslationKey,
  receipt_unavailable: 'employeePayment.receipt.fileMissing' as TranslationKey,
  pdf_failed: 'employeePayment.receipt.error' as TranslationKey,
  archive_failed: 'employeePayment.receipt.error' as TranslationKey,
  id_taken: 'employeePayment.receipt.error' as TranslationKey,
  link_failed: 'employeePayment.receipt.error' as TranslationKey,
};

export function EmployeePaymentDetailDialog({
  paymentId,
  uploadOpen,
  canWrite,
  cloudConfigured,
  userId,
  uploadDeps,
  translate: t,
  showToast,
  onUploadOpenChange,
  onChanged,
  onClose,
}: Props) {
  const [version, setVersion] = useState(0);
  const [view, setView] = useState<'detail' | 'reverse'>('detail');
  const [reason, setReason] = useState('');
  const [reverseError, setReverseError] = useState<TranslationKey | null>(null);
  const [actionError, setActionError] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState<'receipt' | 'open' | 'download' | 'proof' | 'reverse' | null>(null);
  const [proofChoice, setProofChoice] = useState('');
  const lockRef = useRef(false);

  const payment: EmployeePayment | undefined = paymentId ? getEmployeePaymentById(paymentId) : undefined;
  void version;

  useEffect(() => {
    setView('detail');
    setReason('');
    setReverseError(null);
    setActionError(null);
    setBusy(null);
    lockRef.current = false;
  }, [paymentId]);

  useEffect(() => {
    setProofChoice(payment?.proofDocumentId ?? '');
  }, [payment?.proofDocumentId, paymentId]);

  const refresh = () => {
    setVersion((v) => v + 1);
    onChanged();
  };

  /** Ein Schloss für alle Handlungen dieses Dialogs: nie zwei gleichzeitig. */
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<void> | void) => {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(kind);
    setActionError(null);
    try {
      await work();
    } finally {
      lockRef.current = false;
      setBusy(null);
    }
  };

  if (!paymentId) return null;

  if (!payment) {
    return (
      <Dialog open title={t('employeePayment.error.notFound')} onClose={onClose} testId="employee-payment-detail">
        <p className="form-hint">{t('employeePayment.error.notFound')}</p>
      </Dialog>
    );
  }

  const reversed = isEmployeePaymentReversed(payment);
  const receiptDocument = payment.receiptDocumentId ? getDocumentById(payment.receiptDocumentId) : undefined;
  const proofDocument = payment.proofDocumentId ? getDocumentById(payment.proofDocumentId) : undefined;
  const cloudPending = cloudConfigured && isEmployeeCloudSyncActive() && isEmployeePaymentCloudPending(payment.id);

  const handleCreateReceipt = () =>
    run('receipt', async () => {
      const result = await ensurePayoutReceiptArchived(payment.id);
      if (!result.ok) {
        setActionError(RECEIPT_ERRORS[result.reason]);
        refresh();
        return;
      }
      showToast(t('employeePayment.toast.receiptCreated'));
      refresh();
    });

  const handleReceiptOriginal = (mode: 'open' | 'download') => {
    // Fenster im Klick öffnen, sonst blockiert der Browser das spätere Öffnen.
    const pending = mode === 'open' ? window.open('', '_blank') : null;
    void run(mode, async () => {
      const result = await loadPayoutReceiptOriginal(payment.id);
      if (!result.ok) {
        pending?.close();
        setActionError('employeePayment.receipt.fileMissing' as TranslationKey);
        return;
      }
      const url = URL.createObjectURL(result.blob);
      if (mode === 'open' && pending) {
        pending.location.href = url;
      } else {
        const link = document.createElement('a');
        link.href = url;
        if (mode === 'download') link.download = result.filename;
        else link.target = '_blank';
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  };

  const handleSaveProof = () =>
    run('proof', () => {
      const result = setEmployeePaymentProof(payment.id, proofChoice || null);
      if (!result.success) {
        setActionError(result.errorKey as TranslationKey);
        return;
      }
      if (!result.replayed) showToast(t('employeePayment.toast.proofSaved'));
      refresh();
    });

  const handleReverse = () =>
    run('reverse', () => {
      const result = reverseEmployeePayment(payment.id, reason, { userId });
      if (!result.success) {
        setReverseError(result.errorKey as TranslationKey);
        return;
      }
      showToast(t('employeePayment.toast.reversed'));
      setView('detail');
      setReason('');
      refresh();
    });

  if (view === 'reverse') {
    return (
      <Dialog
        open
        title={t('employeePayment.reverse.title')}
        tone="critical"
        busy={busy === 'reverse'}
        closeOnBackdrop={false}
        onClose={() => setView('detail')}
        testId="employee-payment-reverse-dialog"
        actions={
          <>
            <Button variant="secondary" disabled={busy === 'reverse'} onClick={() => setView('detail')} data-testid="employee-payment-reverse-cancel">
              {t('employeePayment.reverse.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy === 'reverse'}
              disabled={busy === 'reverse'}
              onClick={() => void handleReverse()}
              data-testid="employee-payment-reverse-confirm"
            >
              {t('employeePayment.reverse.confirm')}
            </Button>
          </>
        }
      >
        <div className="employee-payment-detail">
          <p className="form-hint">{t('employeePayment.reverse.intro')}</p>
          <p className="employee-payment-detail__reference">
            {payment.receiptReference} · {payment.employeeName} · {formatEuroAmount(payment.amount)}
          </p>
          <Textarea
            label={t('employeePayment.reverse.reason')}
            required
            rows={3}
            maxLength={300}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setReverseError(null);
            }}
            error={reverseError ? t(reverseError) : undefined}
            data-testid="employee-payment-reverse-reason"
          />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={t('employeePayment.detail.heading')}
      onClose={onClose}
      busy={busy !== null}
      size="md"
      testId="employee-payment-detail"
      actions={
        <>
          {canWrite && !reversed ? (
            <Button variant="outline" onClick={() => setView('reverse')} disabled={busy !== null} data-testid="employee-payment-reverse-open">
              {t('employeePayment.reverse.action')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={busy !== null} data-testid="employee-payment-detail-close">
            {t('employeePayment.detail.close')}
          </Button>
        </>
      }
    >
      <div className="employee-payment-detail" data-testid="employee-payment-detail-body">
        <div className="employee-payment-detail__head">
          <span className="employee-payment-detail__reference" data-testid="employee-payment-detail-reference">
            {payment.receiptReference}
          </span>
          <StatusBadge
            tone={reversed ? 'neutral' : 'success'}
            label={t(reversed ? 'employeePayments.status.reversed' : 'employeePayments.status.active')}
            data-testid="employee-payment-detail-status"
          />
        </div>
        {reversed ? (
          <InlineNotice tone="warning" testId="employee-payment-detail-reversed">
            {fillText(t('employeePayment.detail.reversedLine'), {
              date: formatDisplayDatePadded(payment.reversedAt),
              reason: payment.reversalReason ?? '',
            })}
          </InlineNotice>
        ) : null}
        {cloudPending ? (
          <p className="form-hint" data-testid="employee-payment-detail-cloud-pending">
            {t('employeePayment.detail.cloudPending')}
          </p>
        ) : null}
        <div className="employee-payment-detail__facts">
          <DataRow
            label={t('employeePayment.field.employee')}
            value={payment.personnelNumber ? `${payment.employeeName} (${payment.personnelNumber})` : payment.employeeName}
          />
          <DataRow label={t('employeePayment.field.kind')} value={t(kindLabelKey(payment.kind))} />
          <DataRow
            label={t('employeePayment.field.amount')}
            value={<strong data-testid="employee-payment-detail-amount">{formatEuroAmount(payment.amount)}</strong>}
          />
          <DataRow label={t('employeePayment.field.date')} value={formatReceiptDate(payment.paymentDate)} />
          <DataRow label={t('employeePayment.field.method')} value={t(methodLabelKey(payment.paymentMethod))} />
          {payment.wageMonth ? (
            <DataRow label={t('employeePayment.field.wageMonth')} value={formatReceiptWageMonth(payment.wageMonth)} />
          ) : null}
          {payment.purpose ? <DataRow label={t('employeePayment.field.purpose')} value={payment.purpose} /> : null}
          {payment.note ? <DataRow label={t('employeePayment.field.note')} value={payment.note} /> : null}
          {payment.paidByName ? <DataRow label={t('employeePayment.field.paidBy')} value={payment.paidByName} /> : null}
          <DataRow label={t('employeePayment.detail.createdAt')} value={formatDisplayDateTime(payment.createdAt)} />
        </div>
        {payment.paymentMethod === 'bank' ? (
          <p className="form-hint" data-testid="employee-payment-detail-bank-hint">
            {t('employeePayment.hint.bank')}
          </p>
        ) : null}

        <section className="employee-payment-detail__section" data-testid="employee-payment-receipt-section">
          <h3 className="employee-payment-detail__section-title">{t('employeePayment.detail.receiptSection')}</h3>
          {payment.paymentMethod !== 'cash' ? (
            <p className="form-hint" data-testid="employee-payment-receipt-only-cash">
              {t('employeePayment.receipt.onlyCash')}
            </p>
          ) : payment.receiptDocumentId ? (
            <>
              <div className="employee-payment-detail__buttons">
                <Button size="sm" variant="outline" loading={busy === 'open'} disabled={busy !== null} onClick={() => handleReceiptOriginal('open')} data-testid="employee-payment-receipt-open">
                  {t('employeePayment.receipt.open')}
                </Button>
                <Button size="sm" variant="outline" loading={busy === 'download'} disabled={busy !== null} onClick={() => handleReceiptOriginal('download')} data-testid="employee-payment-receipt-download">
                  {t('employeePayment.receipt.download')}
                </Button>
                {receiptDocument ? (
                  <Link to={`/dokumente/${encodeURIComponent(receiptDocument.id)}`} className="btn btn--ghost btn--sm" data-testid="employee-payment-receipt-archive-link">
                    {t('employeePayment.receipt.showInArchive')}
                  </Link>
                ) : null}
              </div>
              {!reversed && !payment.proofDocumentId ? (
                <p className="form-hint">{t('employeePayment.receipt.signHint')}</p>
              ) : null}
            </>
          ) : reversed ? (
            <p className="form-hint" data-testid="employee-payment-receipt-after-reversal">
              {t('employeePayment.receipt.notAfterReversal')}
            </p>
          ) : canWrite ? (
            <Button size="sm" loading={busy === 'receipt'} disabled={busy !== null} onClick={() => void handleCreateReceipt()} data-testid="employee-payment-receipt-create">
              {busy === 'receipt' ? t('employeePayment.receipt.creating') : t('employeePayment.receipt.create')}
            </Button>
          ) : (
            <p className="form-hint">{t('employeePayment.receipt.none')}</p>
          )}
        </section>

        <section className="employee-payment-detail__section" data-testid="employee-payment-proof-section">
          <h3 className="employee-payment-detail__section-title">{t('employeePayment.detail.proofSection')}</h3>
          {proofDocument ? (
            <p className="employee-payment-detail__proof" data-testid="employee-payment-proof-current">
              {t('employeePayment.proof.current')}:{' '}
              <Link to={`/dokumente/${encodeURIComponent(proofDocument.id)}`} data-testid="employee-payment-proof-open">
                {proofDocument.title}
              </Link>
            </p>
          ) : (
            <p className="form-hint" data-testid="employee-payment-proof-missing">
              {t('employeePayment.proofStatus.missing')}
            </p>
          )}
          {reversed ? (
            <p className="form-hint" data-testid="employee-payment-proof-locked">
              {t('employeePayment.proof.reversedLocked')}
            </p>
          ) : canWrite ? (
            <>
              {uploadOpen ? (
                <EmployeePaymentProofUpload
                  paymentId={payment.id}
                  deps={uploadDeps}
                  translate={t}
                  onCancel={() => onUploadOpenChange(false)}
                  onSaved={({ reusedExisting }) => {
                    showToast(t(reusedExisting ? 'employeePayment.proof.duplicate' : 'employeePayment.proof.saved'));
                    onUploadOpenChange(false);
                    refresh();
                  }}
                />
              ) : (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onUploadOpenChange(true)} data-testid="employee-payment-proof-upload-open">
                  {t('employeePayment.proof.uploadSigned')}
                </Button>
              )}
              <div className="employee-payment-detail__proof-select">
                <PaymentProofField
                  value={proofChoice}
                  onChange={setProofChoice}
                  disabled={busy !== null}
                  translate={t}
                  testId="employee-payment-proof-select"
                  isSelectable={isSelectableEmployeeProofDocument}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  /* Setzen oder ändern — ein Nachweis wird nicht wieder entfernt. */
                  disabled={busy !== null || !proofChoice || proofChoice === (payment.proofDocumentId ?? '')}
                  loading={busy === 'proof'}
                  onClick={() => void handleSaveProof()}
                  data-testid="employee-payment-proof-save"
                >
                  {t('employeePayment.proof.save')}
                </Button>
              </div>
            </>
          ) : null}
        </section>

        {actionError ? (
          <p className="form-error" role="alert" data-testid="employee-payment-detail-error">
            {t(actionError)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
