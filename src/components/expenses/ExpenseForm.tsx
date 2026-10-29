import { useId, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useInRouterContext } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import {
  EXPENSE_CATEGORIES,
  addExpense,
  hasBookedExpensePayments,
  updateExpense,
} from '../../services/expenseService';
import {
  EXPENSE_TAX_STATUS_OPTIONS,
  MANUAL_EXPENSE_DEFAULT_TAX_STATUS,
} from '../../services/expense/expenseTaxStatusOptions';
import { isZeroRateTaxStatus } from '../../services/expense/expenseMoneyIntegrity';
import { resolveExpenseTaxSplitState } from '../../services/expense/expenseTaxSplit';
import type {
  Expense,
  ExpenseCategory,
  ExpenseInput,
  ExpenseInputTaxDeduction,
  ExpenseTaxSplit,
} from '../../types/expense';
import type { TaxStatus } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { Button } from '../ui/Button';
import { getBusinessDay } from '../../services/businessDateService';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';
import { useResumeOffer, type ResumeOffer } from '../../hooks/useResumeOffer';
import { FormResumeOffer } from '../forms/FormResumeOffer';

export interface ExpenseFormDraft {
  title: string;
  category: ExpenseCategory;
  supplierName: string;
  invoiceNumber: string;
  description: string;
  issueDate: string;
  paymentDueDate: string;
  grossAmount: string;
  netAmount: string;
  taxAmount: string;
  /** FINANZCORE-05B-FIX1 — der Steuerstatus dieses Belegs, sichtbar und waehlbar. */
  taxStatus: TaxStatus;
  /**
   * P1-KORREKTURBLOCK A-04 — wie Netto und Steuer belegt sind. `''` = keine Angabe: nur beim Bearbeiten eines
   * Altbestands mit Prüfbefund; ohne Betragseingabe bleibt dessen gespeicherter Stand dann unverändert.
   */
  taxSplit: ExpenseTaxSplit | '';
  /** A-04 — der Vorsteuerabzug zur belegten Steuer. */
  inputTaxDeduction: ExpenseInputTaxDeduction;
  /** A-04 — der abziehbare Teil der Vorsteuer (nur bei „teilweise“). */
  deductibleTaxAmount: string;
}

const TAX_SPLIT_OPTIONS: readonly ExpenseTaxSplit[] = ['belegt', 'gemischt', 'offen'];
const INPUT_TAX_DEDUCTION_OPTIONS: readonly ExpenseInputTaxDeduction[] = ['voll', 'teilweise', 'keiner'];

/*
 * EINGANG-01D-1 Nacharbeit 2 (P1) — die eine Schreibweise, in der ein
 * gespeicherter oder vorbelegter Betrag ins Formular kommt: genau die, die
 * `parseAmount` zurückliest (Dezimalkomma, kein Tausenderpunkt).
 * `String(92.95)` ergab „92.95"; der Punkt galt beim Speichern als
 * Tausendertrenner, und Öffnen + Speichern machte aus 92,95 → 9295.
 */
function formatAmountForInput(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2).replace('.', ',') : '';
}

function draftFromExpense(expense: Expense): ExpenseFormDraft {
  /*
   * P1-KORREKTURBLOCK A-04 — die Platzhalter einer offenen Aufteilung und der Prüfbefund eines Altbestands
   * (Netto = Brutto, 0 € Steuer) kommen nicht als Netto/Steuer ins Formular: Sie sind keine Belegwerte, und
   * Öffnen + Speichern darf sie nicht nachträglich bestätigen.
   */
  const state = resolveExpenseTaxSplitState(expense);
  const ohneBelegwerte = state === 'offen' || state === 'altbestand_pruefen';
  return {
    title: expense.title,
    category: expense.category,
    supplierName: expense.supplierName,
    invoiceNumber: expense.invoiceNumber,
    description: expense.description,
    issueDate: expense.issueDate,
    paymentDueDate: expense.paymentDueDate ?? '',
    grossAmount: formatAmountForInput(expense.grossAmount),
    netAmount: ohneBelegwerte ? '' : formatAmountForInput(expense.netAmount),
    taxAmount: ohneBelegwerte ? '' : formatAmountForInput(expense.taxAmount),
    // Bearbeiten zeigt den gespeicherten Status — nie einen neu geratenen.
    taxStatus: expense.taxStatus,
    taxSplit: state === 'offen' || state === 'gemischt' ? state : state === 'altbestand_pruefen' ? '' : 'belegt',
    inputTaxDeduction: expense.inputTaxDeduction ?? 'voll',
    deductibleTaxAmount: formatAmountForInput(expense.deductibleTaxAmount),
  };
}

function emptyDraft(): ExpenseFormDraft {
  const today = getBusinessDay();
  return {
    title: '',
    category: 'material',
    supplierName: '',
    invoiceNumber: '',
    description: '',
    issueDate: today,
    paymentDueDate: '',
    grossAmount: '',
    netAmount: '',
    taxAmount: '',
    /*
     * Der Normalfall einer Lieferantenrechnung. Ausdruecklich **nicht** der
     * Steuerstatus der eigenen Ausgangsrechnungen: Wer selbst nach 13b
     * abrechnet, bekommt trotzdem Rechnungen mit ausgewiesenen 19 %.
     */
    taxStatus: MANUAL_EXPENSE_DEFAULT_TAX_STATUS,
    /*
     * A-04 — vorgewählt ist „vom Beleg“; ohne Netto oder Steuer verlangt das Speichern dann eine bewusste
     * Entscheidung (Beträge eintragen oder „Noch offen“), statt still 0 € Steuer anzunehmen.
     */
    taxSplit: 'belegt',
    inputTaxDeduction: 'voll',
    deductibleTaxAmount: '',
  };
}

function parseAmount(value: string): number {
  const normalized = value.trim().replace(/\./g, '').replace(',', '.');
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A-04 — ein leeres Feld ist „nicht angegeben“; eine eingetragene 0 ist eine Angabe, die die Prüfung bewertet
 * (bisher wurde aus 0 still „nicht angegeben“ und daraus Netto = Brutto). Unlesbares bleibt unlesbar (NaN).
 */
function parseOptionalAmount(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = parseFloat(value.trim().replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** A-04 — die Felder, die Beträge und Steueraufteilung tragen. Bleiben sie unverändert, sendet das Formular sie nicht. */
const MONEY_FIELDS = [
  'grossAmount', 'netAmount', 'taxAmount', 'taxStatus', 'taxSplit', 'inputTaxDeduction', 'deductibleTaxAmount',
] as const satisfies readonly (keyof ExpenseFormDraft)[];

type ExpenseMoneyInput = Pick<
  ExpenseInput,
  'grossAmount' | 'netAmount' | 'taxAmount' | 'taxStatus' | 'taxSplit' | 'inputTaxDeduction' | 'deductibleTaxAmount'
>;

function toMoneyInput(draft: ExpenseFormDraft): ExpenseMoneyInput {
  const grossAmount = parseAmount(draft.grossAmount);
  // Ohne Umsatzsteuer laut Steuerstatus gibt es keine Aufteilungsfrage (Netto = Brutto, Steuer 0 ist belegt).
  if (isZeroRateTaxStatus(draft.taxStatus)) {
    return {
      grossAmount,
      taxStatus: draft.taxStatus,
      netAmount: parseOptionalAmount(draft.netAmount),
      taxAmount: parseOptionalAmount(draft.taxAmount),
    };
  }
  const taxSplit: ExpenseTaxSplit = draft.taxSplit === '' ? 'belegt' : draft.taxSplit;
  // Offen: keine Beträge — auch eingetippte nicht, sie wären keine Belegwerte.
  if (taxSplit === 'offen') return { grossAmount, taxStatus: draft.taxStatus, taxSplit };
  return {
    grossAmount,
    taxStatus: draft.taxStatus,
    netAmount: parseOptionalAmount(draft.netAmount),
    taxAmount: parseOptionalAmount(draft.taxAmount),
    taxSplit,
    inputTaxDeduction: draft.inputTaxDeduction,
    ...(draft.inputTaxDeduction === 'teilweise'
      ? { deductibleTaxAmount: parseOptionalAmount(draft.deductibleTaxAmount) }
      : {}),
  };
}

function toBaseInput(draft: ExpenseFormDraft, linkedInboxId?: string): Omit<ExpenseInput, keyof ExpenseMoneyInput> {
  return {
    title: draft.title,
    category: draft.category,
    supplierName: draft.supplierName,
    invoiceNumber: draft.invoiceNumber,
    description: draft.description,
    issueDate: draft.issueDate,
    paymentDueDate: draft.paymentDueDate || null,
    linkedInboxId,
  };
}

interface ExpenseFormProps {
  mode: 'add' | 'edit';
  expense?: Expense;
  prefill?: Partial<ExpenseInput>;
  onSaved: (expense: Expense) => void;
  onCancel: () => void;
}

function draftFromInput(input: Partial<ExpenseInput>): ExpenseFormDraft {
  const base = emptyDraft();
  return {
    title: input.title ?? base.title,
    category: input.category ?? base.category,
    supplierName: input.supplierName ?? base.supplierName,
    invoiceNumber: input.invoiceNumber ?? base.invoiceNumber,
    description: input.description ?? base.description,
    issueDate: input.issueDate ?? base.issueDate,
    paymentDueDate: input.paymentDueDate ?? base.paymentDueDate,
    grossAmount: input.grossAmount ? formatAmountForInput(input.grossAmount) : base.grossAmount,
    netAmount: input.netAmount ? formatAmountForInput(input.netAmount) : base.netAmount,
    taxAmount: input.taxAmount ? formatAmountForInput(input.taxAmount) : base.taxAmount,
    taxStatus: input.taxStatus ?? base.taxStatus,
    /*
     * A-04 — eine Vorbelegung aus dem Eingang trägt meist nur den sicher erkannten Bruttobetrag. Dann ist die
     * Aufteilung ausdrücklich „noch offen“ vorgewählt (der Hinweis steht im Formular) — nie still 0 € Steuer.
     */
    taxSplit: input.taxSplit ?? (input.netAmount || input.taxAmount ? 'belegt' : 'offen'),
    inputTaxDeduction: input.inputTaxDeduction ?? base.inputTaxDeduction,
    deductibleTaxAmount:
      input.deductibleTaxAmount !== undefined ? formatAmountForInput(input.deductibleTaxAmount) : base.deductibleTaxAmount,
  };
}

function initialDraft(expense: Expense | undefined, prefill: Partial<ExpenseInput> | undefined): ExpenseFormDraft {
  if (expense) return draftFromExpense(expense);
  if (prefill) return draftFromInput(prefill);
  return emptyDraft();
}

const EXPENSE_FORM_FIELDS: readonly (keyof ExpenseFormDraft & string)[] = [
  'title', 'category', 'supplierName', 'invoiceNumber', 'description', 'issueDate', 'paymentDueDate',
  'grossAmount', 'netAmount', 'taxAmount', 'taxStatus', 'taxSplit', 'inputTaxDeduction', 'deductibleTaxAmount',
];

/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.27) — im Router mit Entwurfsaufnahme (je Konto, Betrieb und Beleg über die
 * UI-Sitzung; „Fortsetzen“ oder „Verwerfen“); ohne Router (Komponententests) das Formular allein. Die Fachlogik des
 * Formulars bleibt unverändert.
 */
export function ExpenseForm(props: ExpenseFormProps) {
  return useInRouterContext() ? <ExpenseFormMitEntwurf {...props} /> : <ExpenseFormFelder {...props} />;
}

function ExpenseFormMitEntwurf(props: ExpenseFormProps) {
  const [saved] = useState(() => initialDraft(props.expense, props.prefill));
  const [draft, setDraft] = useState<ExpenseFormDraft>(saved);
  const offer = useResumeOffer<ExpenseFormDraft>({
    namespace: `expense-form.${props.expense?.id ?? `neu.${props.prefill?.linkedInboxId ?? 'manuell'}`}`,
    fields: EXPENSE_FORM_FIELDS,
    saved,
    current: draft,
    workspaceType: 'other',
  });
  return <ExpenseFormFelder {...props} gesteuert={{ saved, draft, setDraft, offer }} />;
}

interface GesteuerterEntwurf {
  saved: ExpenseFormDraft;
  draft: ExpenseFormDraft;
  setDraft: Dispatch<SetStateAction<ExpenseFormDraft>>;
  offer: ResumeOffer<ExpenseFormDraft>;
}

function ExpenseFormFelder({ mode, expense, prefill, onSaved, onCancel, gesteuert }: ExpenseFormProps & { gesteuert?: GesteuerterEntwurf }) {
  const { translate, showToast } = useApp();
  const taxSplitLabelId = useId();
  const [linkedInboxId] = useState(prefill?.linkedInboxId);
  const [eigenerAusgang] = useState(() => initialDraft(expense, prefill));
  const [eigenerEntwurf, setEigenerEntwurf] = useState<ExpenseFormDraft>(eigenerAusgang);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const ausgang = gesteuert?.saved ?? eigenerAusgang;
  const draft = gesteuert?.draft ?? eigenerEntwurf;
  const setDraft = gesteuert?.setDraft ?? setEigenerEntwurf;
  const offer = gesteuert?.offer;
  // 1.27 — Rückfrage beim Verlassen, solange etwas geändert ist; mit Entwurfsaufnahme bleibt der Entwurf erhalten.
  const dirty = EXPENSE_FORM_FIELDS.some((field) => draft[field] !== ausgang[field]);
  const leaveGuard = useLeaveGuard(dirty, Boolean(offer));

  /*
   * OFFICEPILOT-V1-A — nach einer gebuchten Zahlung bleiben die Beträge fest
   * (Regel des Dienstes); die Felder zeigen das, statt beim Speichern zu scheitern.
   */
  const amountsLocked = mode === 'edit' && !!expense && hasBookedExpensePayments(expense);
  /*
   * P1 A-04 Produktregel A — nach einer Zahlung bleibt das Brutto fest. Ist die Steueraufteilung noch offen, bleiben
   * Steuerstatus, Aufteilung, Netto und Steuer für ihre Klärung frei (Dienst und Server prüfen dasselbe).
   */
  const splitLocked = amountsLocked && resolveExpenseTaxSplitState(expense!) !== 'offen';
  /*
   * P1-KORREKTURBLOCK A-04 — die Aufteilungsfrage stellt sich nur, wenn der Steuerstatus Umsatzsteuer kennen kann
   * (19 %, 7 %, unklar). Ein Altbestand mit Prüfbefund sagt das beim Bearbeiten ausdrücklich.
   */
  const taxable = !isZeroRateTaxStatus(draft.taxStatus);
  const legacyEntry = mode === 'edit' && !!expense && resolveExpenseTaxSplitState(expense) === 'altbestand_pruefen';
  const splitOpen = taxable && draft.taxSplit === 'offen';

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const base = toBaseInput(draft, linkedInboxId);
    /*
     * A-04 — beim Bearbeiten werden Beträge und Steueraufteilung nur gesendet, wenn sie geändert wurden. So bleibt
     * ein gespeicherter Stand (auch ein Altbestand, auch nach einer Zahlung) beim Ändern von Titel oder Ablage exakt.
     */
    const moneyChanged = MONEY_FIELDS.some((field) => draft[field] !== ausgang[field]);
    const result =
      mode === 'add'
        ? addExpense({ ...base, ...toMoneyInput(draft) })
        : updateExpense(expense!.id, moneyChanged ? { ...base, ...toMoneyInput(draft) } : base);

    if (!result.success) {
      setSubmitError(result.errorKey);
      showToast(translate(result.errorKey as TranslationKey));
      return;
    }

    setSubmitError(null);
    // Nach erfolgreichem Speichern: kein Entwurf, keine Rückfrage.
    offer?.clear();
    leaveGuard.release();
    onSaved(result.expense);
  };

  return (
    <form className="form-stack expense-form" onSubmit={handleSubmit}>
      {offer ? (
        <FormResumeOffer
          pending={offer.pending}
          stale={offer.stale}
          onContinue={() => {
            const werte = offer.continueDraft();
            setDraft((prev) => ({ ...prev, ...werte }));
          }}
          onDiscard={offer.discardDraft}
          onDismissStale={offer.dismissStale}
          testIdPrefix="expense-form"
        />
      ) : null}
      <label className="form-group">
        <span>{translate('expense.fieldTitle')}</span>
        <input
          className="input"
          value={draft.title}
          onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
          required
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldCategory')}</span>
        <select
          className="input"
          value={draft.category}
          data-testid="expense-category-select"
          onChange={(e) =>
            setDraft((prev) => ({ ...prev, category: e.target.value as ExpenseCategory }))
          }
        >
          {EXPENSE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {translate(`expense.category.${category}` as TranslationKey)}
            </option>
          ))}
        </select>
      </label>

      {/*
        * P1 MITARBEITERZAHLUNGEN — nicht blockierend: Eine Lohnabrechnung ist
        * keine zusätzliche Ausgabe, und Auszahlungen an Mitarbeiter gehören zu
        * den Mitarbeiterzahlungen. Gespeichert werden darf trotzdem.
        */}
      {draft.category === 'personal' ? (
        <p className="form-hint" role="note" data-testid="expense-personal-hint">
          {translate('expense.personalHint')}
        </p>
      ) : null}

      {/*
        * FINANZCORE-05B-FIX1 — der Steuerstatus dieses Belegs, sichtbar.
        *
        * Bis hierher gab es ihn im Formular nicht; er kam unsichtbar aus dem
        * Firmenprofil, also aus der eigenen Fakturierung. Ein Betrieb, der
        * selbst ohne Umsatzsteuer abrechnet, konnte deshalb keine einzige
        * Lieferantenrechnung mit 19 % erfassen.
        *
        * Angeboten werden ausschliesslich die Werte, die das Modell kennt —
        * in verständlicher Sprache, nicht als technische Bezeichner.
        */}
      <label className="form-group">
        <span>{translate('expense.fieldTaxStatus')}</span>
        <select
          className="input"
          value={draft.taxStatus}
          data-testid="expense-tax-status-select"
          disabled={splitLocked}
          onChange={(e) =>
            setDraft((prev) => ({ ...prev, taxStatus: e.target.value as TaxStatus }))
          }
        >
          {EXPENSE_TAX_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {translate(`expense.taxStatus.${status}` as TranslationKey)}
            </option>
          ))}
        </select>
        <span className="hint-text">{translate('expense.taxStatusHint')}</span>
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldSupplier')}</span>
        <input
          className="input"
          value={draft.supplierName}
          onChange={(e) => setDraft((prev) => ({ ...prev, supplierName: e.target.value }))}
          required
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldInvoiceNumber')}</span>
        <input
          className="input"
          value={draft.invoiceNumber}
          onChange={(e) => setDraft((prev) => ({ ...prev, invoiceNumber: e.target.value }))}
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldIssueDate')}</span>
        <input
          type="date"
          className="input"
          value={draft.issueDate}
          onChange={(e) => setDraft((prev) => ({ ...prev, issueDate: e.target.value }))}
          required
        />
      </label>

      <label className="form-group">
        <span>{translate('expense.fieldDueDate')}</span>
        <input
          type="date"
          className="input"
          value={draft.paymentDueDate}
          onChange={(e) => setDraft((prev) => ({ ...prev, paymentDueDate: e.target.value }))}
        />
      </label>

      {splitLocked ? (
        <p className="form-hint" data-testid="expense-amounts-locked">
          {translate('expense.edit.amountLockedHint')}
        </p>
      ) : amountsLocked ? (
        <p className="form-hint" data-testid="expense-gross-locked-tax-review">
          {translate('expense.edit.grossLockedTaxReviewHint')}
        </p>
      ) : null}

      <label className="form-group">
        <span>{translate('expense.fieldGrossAmount')}</span>
        <input
          className="input"
          inputMode="decimal"
          value={draft.grossAmount}
          disabled={amountsLocked}
          data-testid="expense-gross-input"
          onChange={(e) => setDraft((prev) => ({ ...prev, grossAmount: e.target.value }))}
          required
        />
      </label>

      {/*
        * P1-KORREKTURBLOCK A-04 — wie Netto und Steuer belegt sind. Ohne Angabe wird nichts mehr still zu
        * „0 € Steuer“: Entweder stehen die Werte auf dem Beleg, oder die Aufteilung ist ausdrücklich „noch offen“.
        */}
      {taxable ? (
        <div className="form-group" role="radiogroup" aria-labelledby={taxSplitLabelId} data-testid="expense-tax-split">
          <span id={taxSplitLabelId}>{translate('expense.taxSplit.label')}</span>
          <div className="radio-group">
            {TAX_SPLIT_OPTIONS.map((value) => (
              <label key={value} className="radio-label">
                <input
                  type="radio"
                  name="expense-tax-split"
                  value={value}
                  checked={draft.taxSplit === value}
                  disabled={splitLocked}
                  onChange={() => setDraft((prev) => ({ ...prev, taxSplit: value }))}
                  data-testid={`expense-tax-split-${value}`}
                />
                {translate(`expense.taxSplit.option.${value}` as TranslationKey)}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {taxable && legacyEntry && draft.taxSplit === '' ? (
        <p className="form-hint" role="note" data-testid="expense-tax-split-legacy-hint">
          {translate('expense.taxSplit.legacyHint')}
        </p>
      ) : null}

      {splitOpen ? (
        <p className="form-hint" role="note" data-testid="expense-tax-split-open-hint">
          {translate('expense.taxSplit.openHint')}
        </p>
      ) : (
        <>
          <label className="form-group">
            <span>{translate('expense.fieldNetAmount')}</span>
            <input
              className="input"
              inputMode="decimal"
              value={draft.netAmount}
              disabled={splitLocked}
              data-testid="expense-net-input"
              onChange={(e) => setDraft((prev) => ({ ...prev, netAmount: e.target.value }))}
            />
          </label>

          <label className="form-group">
            <span>{translate('expense.fieldTaxAmount')}</span>
            <input
              className="input"
              inputMode="decimal"
              value={draft.taxAmount}
              disabled={splitLocked}
              data-testid="expense-tax-input"
              onChange={(e) => setDraft((prev) => ({ ...prev, taxAmount: e.target.value }))}
            />
            {taxable ? (
              <span className="hint-text">
                {translate(draft.taxSplit === 'gemischt' ? 'expense.taxSplit.mixedHint' : 'expense.taxSplit.amountsHint')}
              </span>
            ) : null}
          </label>

          {taxable ? (
            <label className="form-group">
              <span>{translate('expense.inputTaxDeduction.label')}</span>
              {/*
                * P1-Abschluss-Rundgang (R-08) — der Vorsteuerabzug ist kein Betrag des Belegs: Server
                * (`upsert_workspace_expense`, „Geld unverändert“) und Dienst (`updateExpense`) erlauben die Änderung auch
                * nach einer gebuchten Zahlung. Das Formular sperrte ihn trotzdem mit den Beträgen.
                */}
              <select
                className="input"
                value={draft.inputTaxDeduction}
                data-testid="expense-input-tax-deduction-select"
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, inputTaxDeduction: e.target.value as ExpenseInputTaxDeduction }))
                }
              >
                {INPUT_TAX_DEDUCTION_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {translate(`expense.inputTaxDeduction.option.${value}` as TranslationKey)}
                  </option>
                ))}
              </select>
              <span className="hint-text">{translate('expense.inputTaxDeduction.hint')}</span>
            </label>
          ) : null}

          {taxable && draft.inputTaxDeduction === 'teilweise' ? (
            <label className="form-group">
              <span>{translate('expense.inputTaxDeduction.amountLabel')}</span>
              <input
                className="input"
                inputMode="decimal"
                value={draft.deductibleTaxAmount}
                data-testid="expense-deductible-tax-input"
                onChange={(e) => setDraft((prev) => ({ ...prev, deductibleTaxAmount: e.target.value }))}
              />
            </label>
          ) : null}
        </>
      )}

      <label className="form-group">
        <span>{translate('expense.fieldDescription')}</span>
        <textarea
          className="input"
          rows={3}
          value={draft.description}
          onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
        />
      </label>

      {/* A-04 — die Ablehnung bleibt am Formular sichtbar, nicht nur im kurzen Hinweis. */}
      {submitError ? (
        <p className="form-error" role="alert" data-testid="expense-form-error">
          {translate(submitError as TranslationKey)}
        </p>
      ) : null}

      <div className="form-actions">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            // „Abbrechen“ verwirft ausdrücklich: kein Entwurf, keine Rückfrage.
            offer?.clear();
            leaveGuard.release();
            onCancel();
          }}
        >
          {translate('common.cancel')}
        </Button>
        <Button type="submit">
          {mode === 'add' ? translate('expense.saveNew') : translate('expense.saveChanges')}
        </Button>
      </div>
    </form>
  );
}
