/**
 * STEUERBERATER-06A — der Kontierungsbereich eines Belegs.
 *
 * Derselbe Bereich für Eingangsbelege und Ausgangsrechnungen: Die Kontierung
 * ist dieselbe Frage, unabhängig davon, in welche Richtung das Geld fliesst.
 *
 * Der Aufbau folgt der Confirm-first-Architektur des Projekts:
 *
 *   Ansehen → Bearbeiten → **Übernehmen** → **Bestätigen**
 *
 * „Übernehmen" und „Bestätigen" sind zwei Knöpfe und zwei Vorgänge. Wer ein
 * Konto einträgt und speichert, hat gespeichert — nicht zugesagt. Ein stilles
 * Confirm-on-Save wäre genau die Abkürzung, die eine ungeprüfte Zahl in die
 * Buchhaltung trägt.
 */
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { DataRow } from '../ui/Card';
import { SummaryList } from '../ui/Section';
import { Badge } from '../ui/Badge';
import { InlineNotice } from '../ui/States';
import {
  confirmAccountingAssignment,
  markAccountingAssignmentUnclear,
  resolveVisibleSuggestionReason,
  updateAccountingAssignment,
} from '../../services/accounting/accountingAssignmentService';
import type { AccountingAssignment, AccountingAssignmentStatus } from '../../types/accounting';
import type { TranslationKey } from '../../i18n';

interface Props {
  /** `undefined`: für diesen Beleg wurde noch nichts angelegt. */
  assignment: AccountingAssignment | undefined;
  /** Legt die Kontierung an — der Aufrufer kennt den Beleg. */
  onStart: () => void;
  onChanged: () => void;
  translate: (key: TranslationKey) => string;
  testIdPrefix: string;
}

/** Zu jedem Stand ein Ton — dieselbe Sprache wie die übrigen Abzeichen. */
function statusTone(status: AccountingAssignmentStatus): 'success' | 'warning' | 'critical' {
  if (status === 'confirmed') return 'success';
  if (status === 'needs_clarification') return 'critical';
  return 'warning';
}

export function AccountingAssignmentPanel({
  assignment,
  onStart,
  onChanged,
  translate,
  testIdPrefix,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [accountNumber, setAccountNumber] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [bookingText, setBookingText] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    if (!assignment) return;
    setAccountNumber(assignment.accountNumber);
    setAccountLabel(assignment.accountLabel);
    setBookingText(assignment.bookingText);
  }, [assignment?.id, assignment?.updatedAt]);

  if (!assignment) {
    return (
      <div data-testid={`${testIdPrefix}-accounting`}>
        <p className="detail-empty" data-testid={`${testIdPrefix}-accounting-empty`}>
          {translate('accounting.empty')}
        </p>
        <Button type="button" onClick={onStart} data-testid={`${testIdPrefix}-accounting-start`}>
          {translate('accounting.action.start')}
        </Button>
      </div>
    );
  }

  const visibleReason = resolveVisibleSuggestionReason(assignment);

  const handleSave = () => {
    const result = updateAccountingAssignment(assignment.id, {
      accountNumber,
      accountLabel,
      bookingText,
    });
    if (!result.success) {
      setErrorKey(result.errorKey);
      return;
    }
    setErrorKey(null);
    setEditing(false);
    onChanged();
  };

  const handleConfirm = () => {
    const result = confirmAccountingAssignment(assignment.id);
    if (!result.success) {
      setErrorKey(result.errorKey);
      return;
    }
    setErrorKey(null);
    onChanged();
  };

  const handleUnclear = () => {
    const result = markAccountingAssignmentUnclear(assignment.id);
    if (!result.success) {
      setErrorKey(result.errorKey);
      return;
    }
    setErrorKey(null);
    onChanged();
  };

  return (
    <div data-testid={`${testIdPrefix}-accounting`}>
      <SummaryList columns={2} testId={`${testIdPrefix}-accounting-summary`}>
        <DataRow
          label={translate('accounting.chart')}
          value={
            <span data-testid={`${testIdPrefix}-accounting-chart`}>{assignment.chartOfAccounts}</span>
          }
        />
        <DataRow
          label={translate('accounting.status')}
          value={
            <Badge
              tone={statusTone(assignment.status)}
              data-testid={`${testIdPrefix}-accounting-status`}
            >
              {translate(`accounting.status.${assignment.status}` as TranslationKey)}
            </Badge>
          }
        />
        <DataRow
          label={translate('accounting.account')}
          value={
            <span data-testid={`${testIdPrefix}-accounting-account`}>
              {assignment.accountNumber.trim() || translate('accounting.accountEmpty')}
            </span>
          }
        />
        <DataRow
          label={translate('accounting.accountLabel')}
          value={
            <span data-testid={`${testIdPrefix}-accounting-account-label`}>
              {assignment.accountLabel.trim() || '—'}
            </span>
          }
        />
        <DataRow
          label={translate('accounting.taxTreatment')}
          value={
            <span data-testid={`${testIdPrefix}-accounting-tax`}>
              {translate(`expense.taxStatus.${assignment.taxTreatment}` as TranslationKey)}
            </span>
          }
        />
        <DataRow
          label={translate('accounting.origin')}
          value={
            <span data-testid={`${testIdPrefix}-accounting-origin`}>
              {translate(`accounting.origin.${assignment.origin}` as TranslationKey)}
            </span>
          }
        />
      </SummaryList>

      <SummaryList columns={1}>
        <DataRow
          label={translate('accounting.bookingText')}
          value={
            <span data-testid={`${testIdPrefix}-accounting-booking-text`}>
              {assignment.bookingText || '—'}
            </span>
          }
        />
      </SummaryList>

      {/*
        * Die Begründung des Vorschlags bleibt stehen, solange sie zum
        * aktuellen Stand passt. Sie sagt unter anderem, warum kein Sachkonto
        * vorgeschlagen wurde — das ist eine Auskunft, kein Mangel. 01H: Ist
        * ein Sachkonto eingetragen, ist dieser Teil erledigt.
        */}
      {visibleReason ? (
        <InlineNotice
          tone={assignment.status === 'needs_clarification' ? 'warning' : 'info'}
          testId={`${testIdPrefix}-accounting-reason`}
        >
          {translate(visibleReason as TranslationKey)}
        </InlineNotice>
      ) : null}

      {editing ? (
        <div data-testid={`${testIdPrefix}-accounting-form`}>
          <label className="invoice-payment-form__field">
            <span>{translate('accounting.account')}</span>
            <input
              type="text"
              className="input"
              value={accountNumber}
              data-testid={`${testIdPrefix}-accounting-input-account`}
              onChange={(event) => setAccountNumber(event.target.value)}
            />
          </label>
          <label className="invoice-payment-form__field">
            <span>{translate('accounting.accountLabel')}</span>
            <input
              type="text"
              className="input"
              value={accountLabel}
              data-testid={`${testIdPrefix}-accounting-input-label`}
              onChange={(event) => setAccountLabel(event.target.value)}
            />
          </label>
          <label className="invoice-payment-form__field">
            <span>{translate('accounting.bookingText')}</span>
            <input
              type="text"
              className="input"
              value={bookingText}
              data-testid={`${testIdPrefix}-accounting-input-booking-text`}
              onChange={(event) => setBookingText(event.target.value)}
            />
          </label>

          {/* Der Satz, der den Unterschied benennt. */}
          <p className="detail-hint" data-testid={`${testIdPrefix}-accounting-save-hint`}>
            {translate('accounting.saveHint')}
          </p>

          {errorKey ? (
            <p className="invoice-payment-form__error" data-testid={`${testIdPrefix}-accounting-error`}>
              {translate(errorKey as TranslationKey)}
            </p>
          ) : null}

          <div className="vorgang-dialog__actions">
            <Button type="button" onClick={handleSave} data-testid={`${testIdPrefix}-accounting-save`}>
              {translate('accounting.action.save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditing(false);
                setErrorKey(null);
                setAccountNumber(assignment.accountNumber);
                setAccountLabel(assignment.accountLabel);
                setBookingText(assignment.bookingText);
              }}
              data-testid={`${testIdPrefix}-accounting-cancel`}
            >
              {translate('accounting.action.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {errorKey ? (
            <p className="invoice-payment-form__error" data-testid={`${testIdPrefix}-accounting-error`}>
              {translate(errorKey as TranslationKey)}
            </p>
          ) : null}
          <div className="vorgang-dialog__actions">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditing(true)}
              data-testid={`${testIdPrefix}-accounting-edit`}
            >
              {translate('accounting.action.edit')}
            </Button>
            {assignment.status !== 'confirmed' ? (
              <Button
                type="button"
                onClick={handleConfirm}
                data-testid={`${testIdPrefix}-accounting-confirm`}
              >
                {translate('accounting.action.confirm')}
              </Button>
            ) : null}
            {assignment.status !== 'needs_clarification' ? (
              <Button
                type="button"
                variant="outline"
                onClick={handleUnclear}
                data-testid={`${testIdPrefix}-accounting-unclear`}
              >
                {translate('accounting.action.unclear')}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
