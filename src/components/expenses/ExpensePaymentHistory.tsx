import { Link } from 'react-router-dom';
import { paymentMethodLabel } from '../payment/PaymentMethodField';
import { PaymentProofField, paymentProofLabel } from '../payment/PaymentProofField';
import { getDocumentById } from '../../services/documentService';
import { setExpensePaymentProof } from '../../services/expensePaymentService';
import { formatDisplayDatePadded } from '../../utils/displayFormat';
import { isPaymentFromBankReconciliation } from '../../services/bank/bankReconciliationStore';
import { useState } from 'react';
import { Button } from '../ui/Button';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
import { formatDisplayDate, formatEuroAmount } from '../../utils/displayFormat';
import { DateDisplay, MoneyDisplay } from '../ui/Display';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { getExpensePayments } from '../../services/expensePaymentService';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

interface Props {
  expense: Expense;
  translate: (key: TranslationKey) => string;
  onRemovePayment?: (paymentId: string) => void;
  allowRemove?: boolean;
  /**
   * BLOCK 1 — ohne diesen Rückruf bleibt die Historie reine Anzeige.
   * Nur wo die Seite eine Änderung auch übernehmen kann, wird sie
   * angeboten.
   */
  onProofChanged?: (expense: Expense) => void;
}

/**
 * UIUX-FOUNDATION-01F — Zahlungshistorie als Business-Liste (Datum, Betrag,
 * Referenz/Notiz, Entfernen). Confirm-first über den kanonischen Dialog
 * (UIUX-01G); die Reversal-Logik dahinter ist unverändert.
 */
export function ExpensePaymentHistory({
  expense,
  translate,
  onRemovePayment,
  allowRemove = true,
  onProofChanged,
}: Props) {
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  /*
   * BLOCK 1 — der nachträgliche Weg zum Nachweis.
   *
   * Ohne ihn müsste man eine Zahlung stornieren und neu buchen, nur weil
   * die Quittung erst am nächsten Tag fotografiert wurde — eine
   * Geldbewegung rückgängig machen für eine Belegfrage.
   */
  const [proofPaymentId, setProofPaymentId] = useState<string | null>(null);
  const [proofAuswahl, setProofAuswahl] = useState('');
  const [proofFehler, setProofFehler] = useState<string | null>(null);
  const payments = [...getExpensePayments(expense)].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  if (payments.length === 0) {
    return (
      <section className="invoice-payment-history">
        <h3 className="invoice-payment-history__title">{translate('payment.historyTitle')}</h3>
        <p className="detail-empty invoice-payment-history__empty">{translate('payment.historyEmpty')}</p>
      </section>
    );
  }

  return (
    <section className="invoice-payment-history">
      <h3 className="invoice-payment-history__title">{translate('payment.historyTitle')}</h3>
      <BusinessList className="invoice-payment-history__list">
        {payments.map((payment) => (
          <BusinessListItem
            key={payment.id}
            className="invoice-payment-history__item"
            title={<DateDisplay value={payment.date} />}
            amount={<MoneyDisplay value={payment.amount} />}
            subtitle={
              [
                paymentMethodLabel(payment.method, translate),
                payment.reference ? `${translate('payment.reference')}: ${payment.reference}` : undefined,
              ]
                .filter(Boolean)
                .join(' · ') || undefined
            }
            meta={
              /*
               * BLOCK 1 — der Zahlungsnachweis gehört in die Zeile dieser
               * Zahlung, nicht an den Beleg: Bei zwei Teilzahlungen muss
               * sichtbar bleiben, welche Quittung zu welchem Geld gehört.
               *
               * Fehlt er, wird das benannt statt verschwiegen — aber ohne
               * Warnton. Eine Barzahlung ohne Quittung ist nicht falsch,
               * nur unvollständig belegt.
               */
              <>
                {payment.note ? <span>{payment.note}</span> : null}
                <span data-testid={`payment-proof-${payment.id}`}>
                  {(() => {
                    const nachweis = payment.proofDocumentId
                      ? getDocumentById(payment.proofDocumentId)
                      : undefined;
                    /*
                     * NACHTRAG 1 — drei Fälle, nicht zwei.
                     *
                     * Eine Zahlung, deren Nachweis nicht mehr auffindbar
                     * ist, sah bis hierher aus wie eine, die nie einen
                     * hatte. Das ist eine andere Aussage, und zwar eine
                     * falsche: Es gab einen Nachweis.
                     */
                    if (!payment.proofDocumentId) return translate('payment.proof.missing');
                    if (!nachweis) return translate('payment.proof.unresolved');
                    return (
                      <>
                        {translate('payment.proof.linked')}:{' '}
                        <Link
                          to={`/dokumente/${nachweis.id}`}
                          data-testid={`payment-proof-link-${payment.id}`}
                        >
                          {paymentProofLabel(nachweis)}
                        </Link>
                      </>
                    );
                  })()}
                </span>
              </>
            }
            action={
              <>
                {onProofChanged ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setProofPaymentId(payment.id);
                      setProofAuswahl(payment.proofDocumentId ?? '');
                      setProofFehler(null);
                    }}
                    data-testid={`payment-proof-edit-${payment.id}`}
                  >
                    {translate(payment.proofDocumentId ? 'payment.proof.edit' : 'payment.proof.add')}
                  </Button>
                ) : null}
                {allowRemove && onRemovePayment ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingRemoveId(payment.id)}
                    data-testid={`payment-remove-${payment.id}`}
                  >
                    {translate('payment.remove')}
                  </Button>
                ) : null}
              </>
            }
          />
        ))}
      </BusinessList>

      {(() => {
        /*
         * BLOCK 1 — der Nachweisdialog. Bewusst derselbe schlichte
         * Formularrahmen wie der Zahlungsdialog, und bewusst ohne jede
         * Geldangabe: Hier wird nichts gebucht, nur ein Beleg benannt.
         */
        const zahlung = payments.find((entry) => entry.id === proofPaymentId);
        if (!zahlung) return null;
        const schliessen = () => {
          setProofPaymentId(null);
          setProofFehler(null);
        };
        const speichern = () => {
          const ergebnis = setExpensePaymentProof(expense.id, zahlung.id, proofAuswahl || null);
          if (!ergebnis.success) {
            setProofFehler(ergebnis.errorKey);
            return;
          }
          onProofChanged?.(ergebnis.expense);
          schliessen();
        };
        return (
          <div className="vorgang-dialog-backdrop" role="presentation" onClick={schliessen}>
            <div
              className="vorgang-dialog invoice-payment-form"
              role="dialog"
              aria-modal="true"
              aria-labelledby="payment-proof-dialog-title"
              data-testid="payment-proof-dialog"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="payment-proof-dialog-title" className="vorgang-dialog__title">
                {translate('payment.proof.dialogTitle')}
              </h3>
              <p className="vorgang-dialog__subtitle" data-testid="payment-proof-dialog-payment">
                {formatDisplayDatePadded(zahlung.date)} · {formatEuroAmount(zahlung.amount)}
                {paymentMethodLabel(zahlung.method, translate) ? ` · ${paymentMethodLabel(zahlung.method, translate)}` : ''}
              </p>
              <p className="detail-hint">{translate('payment.proof.dialogIntro')}</p>

              <PaymentProofField
                value={proofAuswahl}
                onChange={setProofAuswahl}
                translate={translate}
                testId="payment-proof-select"
              />

              {proofFehler ? (
                <p className="invoice-payment-form__error" data-testid="payment-proof-error">
                  {translate(proofFehler as TranslationKey)}
                </p>
              ) : null}

              <div className="vorgang-dialog__actions">
                <Button type="button" fullWidth onClick={speichern} data-testid="payment-proof-save">
                  {translate('payment.proof.save')}
                </Button>
                <Button type="button" variant="outline" fullWidth onClick={schliessen} data-testid="payment-proof-cancel">
                  {translate('common.cancel')}
                </Button>
              </div>
            </div>
          </div>
        );
      })()}

      {(() => {
        const pending = payments.find((entry) => entry.id === pendingRemoveId);
        return (
          <SimpleConfirmDialog
            open={Boolean(pending)}
            title={translate('payment.remove')}
            /*
             * BLOCK 5 — stammt die Zahlung aus einer Bankzuordnung, sagt die
             * Rueckfrage, was ausserdem geschieht. Der Nutzer soll nicht
             * ueberrascht werden, dass die Bankbewegung danach wieder offen ist.
             */
            message={
              pending
                ? `${translate('payment.removeConfirm')} ${formatDisplayDate(pending.date)} · ${formatEuroAmount(pending.amount)}${
                    isPaymentFromBankReconciliation(pending.id)
                      ? ` ${translate('payment.removeBankHint')}`
                      : ''
                  }`
                : translate('payment.removeConfirm')
            }
            confirmLabel={translate('payment.remove')}
            cancelLabel={translate('common.cancel')}
            dialogTestId="payment-remove-dialog"
            confirmTestId="payment-remove-confirm"
            cancelTestId="payment-remove-cancel"
            onConfirm={() => {
              if (pending && onRemovePayment) onRemovePayment(pending.id);
              setPendingRemoveId(null);
              return true;
            }}
            onCancel={() => setPendingRemoveId(null)}
          />
        );
      })()}
    </section>
  );
}
