import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import { INDUSTRY_OPTIONS } from '../../data/mockData';
import { validateSetupStep } from '../../services/setupValidationService';
import { reconcilePaymentTermsWithDays, standardPaymentTerms } from '../../services/invoice/invoiceDefaults';
import type { SetupDraftNumericText } from '../../services/setupDraftService';
import {
  SETUP_WIZARD_STEPS,
  type SetupWizardDraft,
  type SetupWizardStep,
} from '../../types/setup';
import type { AppLanguage, TaxStatus } from '../../types/models';
import { CHANNEL_OPTIONS, MATERIAL_OPTIONS } from './setupOptions';
import type { TranslationKey } from '../../i18n';
import type { SetupCompletionResult } from '../../services/setupCompletionService';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';

const LANGUAGES: { value: AppLanguage; labelKey: TranslationKey; code: string; preview?: boolean }[] = [
  { value: 'de', labelKey: 'language.de', code: 'DE' },
  { value: 'tr', labelKey: 'language.tr', code: 'TR' },
  { value: 'bg', labelKey: 'language.bg', code: 'BG' },
  { value: 'ro', labelKey: 'language.ro', code: 'RO', preview: true },
  { value: 'ru', labelKey: 'language.ru', code: 'RU', preview: true },
];

const TAX_OPTIONS: { value: TaxStatus; labelKey: TranslationKey }[] = [
  { value: 'standard_19', labelKey: 'tax.standard_19' },
  { value: 'kleinunternehmer_19', labelKey: 'tax.kleinunternehmer_19' },
  { value: 'reverse_charge_13b', labelKey: 'tax.reverse_charge_13b' },
  { value: 'unclear', labelKey: 'tax.unclear' },
];

/* EINRICHTUNG-01 (AP6; F-04) — Material und Kanal kommen aus `setupOptions` (gemeinsam mit den Firmendaten). */

/**
 * ONBOARDING-INVOICE-NUMBER-EMPTY-01B — Rohtext eines Ganzzahlfelds.
 *
 * Erlaubt sind nur der leere String und reine Ziffernfolgen; führende Nullen
 * werden entfernt, damit aus "06" sichtbar "6" wird. Alles andere (Minus,
 * Dezimaltrenner, Buchstaben, Exponent) wird verworfen, sodass der Draft
 * jederzeit eine gültige nicht-negative Ganzzahl trägt — leer bedeutet 0.
 */
function normalizeIntegerInput(raw: string): { text: string; value: number } | null {
  if (raw === '') return { text: '', value: 0 };
  if (!/^\d+$/.test(raw)) return null;
  const text = raw.replace(/^0+(?=\d)/, '');
  return { text, value: Number(text) };
}

/** EINRICHTUNG-01 (AP3, O-01) — der Stand, den die Einrichtungsseite als Entwurf merkt. */
export interface FirstRunWizardState {
  stepIndex: number;
  draft: SetupWizardDraft;
  numericText: SetupDraftNumericText;
}

interface FirstRunWizardProps {
  initialDraft: SetupWizardDraft;
  /** EINRICHTUNG-01 (AP3, O-01.1) — Fortsetzen am gespeicherten Schritt mit dem gespeicherten Rohtext. */
  initialStepIndex?: number;
  initialNumericText?: SetupDraftNumericText;
  /** Ein fortgesetzter Entwurf wird angezeigt, damit niemand meint, es seien Altwerte. */
  resumed?: boolean;
  /**
   * EINRICHTUNG-01 (AP3, O-04.3) — der Abschluss darf auf den Server warten (Nummernkreis). Bis dahin ist der
   * Abschlussknopf gesperrt; scheitert er, bleibt der Assistent mit allen Eingaben stehen.
   */
  onComplete: (draft: SetupWizardDraft, next: SetupCompletionTarget) => SetupCompletionResult | Promise<SetupCompletionResult>;
  /** Nach jeder Eingabe und jedem Schrittwechsel, nie für den unberührten Anfangsstand. */
  onStateChange?: (state: FirstRunWizardState) => void;
  /**
   * EINRICHTUNG-01 (AP4, O-06.1) — im Cloud-Betrieb bietet der letzte Schritt zusätzlich „Abschließen und Team
   * einladen“. Beide Wege schließen die Einrichtung ab; nur das Ziel danach unterscheidet sich (Teamseite oder
   * Start). Überspringbar, kein Setup-Zwang.
   */
  teamInvite?: boolean;
}

/** Wohin es nach dem Abschluss geht. */
export type SetupCompletionTarget = 'home' | 'team';

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | null)?.then === 'function';
}

export function FirstRunWizard({
  initialDraft,
  initialStepIndex = 0,
  initialNumericText,
  resumed = false,
  onComplete,
  onStateChange,
  teamInvite = false,
}: FirstRunWizardProps) {
  const steps = SETUP_WIZARD_STEPS;
  const { translate, updateLanguage } = useApp();
  const [draft, setDraft] = useState<SetupWizardDraft>(initialDraft);
  const [stepIndex, setStepIndex] = useState(() =>
    Number.isInteger(initialStepIndex) && initialStepIndex >= 0 && initialStepIndex < SETUP_WIZARD_STEPS.length
      ? initialStepIndex
      : 0,
  );
  const [errors, setErrors] = useState<Partial<Record<string, TranslationKey>>>({});
  const [formError, setFormError] = useState<TranslationKey | null>(null);
  const [formErrorRetryable, setFormErrorRetryable] = useState(false);
  /** EINRICHTUNG-01 (AP3, O-04.3) — der Abschluss läuft; kein zweiter Auslöser. */
  const [completing, setCompleting] = useState(false);
  const completingRef = useRef(false);
  /**
   * Sichtbarer Rohtext der Ganzzahlfelder. Getrennt vom Draft, damit das Feld
   * während der Bearbeitung leer bleiben kann, ohne dass eine 0 zurückspringt.
   */
  const [numericText, setNumericText] = useState<SetupDraftNumericText>(
    () =>
      initialNumericText ?? {
        lastInvoiceNumber: String(initialDraft.lastInvoiceNumber),
        defaultPaymentDays: String(initialDraft.defaultPaymentDays),
      },
  );
  /** EINRICHTUNG-01 (AP3, O-01) — erst nach der ersten Eingabe gilt der Stand als Entwurf. */
  const [dirty, setDirty] = useState(false);
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  // EINRICHTUNG-01 (AP8; 1.27) — Rückfrage beim Verlassen; der Entwurf bleibt wie in AP3 erhalten (Einrichtungsseite).
  useLeaveGuard(dirty && !completing, Boolean(onStateChange));

  useEffect(() => {
    if (!dirty) return;
    onStateChangeRef.current?.({ stepIndex, draft, numericText });
  }, [dirty, stepIndex, draft, numericText]);

  const step = steps[stepIndex];
  const isLastStep = stepIndex === steps.length - 1;

  const stepLabel = useMemo(
    () => translate(`setup.step.${step}` as TranslationKey),
    [step, translate],
  );

  const updateDraft = <K extends keyof SetupWizardDraft>(key: K, value: SetupWizardDraft[K]) => {
    setDirty(true);
    /*
     * EINRICHTUNG-01 (AP3, EIN-14; E6) — die Sprachwahl gilt der Person: im Cloud-Betrieb Profil und Gerät, ohne
     * Firmen-Schreibauftrag; im lokalen Betrieb wie bisher das Setup des Geräts. Außerhalb des Zustands-Updaters,
     * damit der Wechsel genau einmal geschieht.
     */
    if (key === 'language') updateLanguage(value as AppLanguage);
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (key === 'defaultPaymentDays') {
        const days = Number(value);
        if (Number.isFinite(days) && days >= 0) {
          /*
           * EINRICHTUNG-01 (AP3, O-04.1; EIN-34) — bisher ersetzte jede Änderung des Zahlungsziels den Zahlungstext,
           * auch einen selbst formulierten. Jetzt dieselbe Regel wie auf der Einstellungsseite: Ein Standardsatz folgt
           * der neuen Tageszahl, ein eigener Text bleibt wortgleich; ein leeres Feld bekommt den Standardsatz.
           */
          const rounded = Math.round(days);
          next.defaultPaymentTerms = current.defaultPaymentTerms.trim()
            ? reconcilePaymentTermsWithDays(current.defaultPaymentTerms, current.defaultPaymentDays, rounded)
            : standardPaymentTerms(rounded, true);
        }
      }
      return next;
    });
  };

  /** Gemeinsamer Eingabeweg beider Ganzzahlfelder. */
  const handleIntegerInput = (
    key: 'lastInvoiceNumber' | 'defaultPaymentDays',
    raw: string,
  ) => {
    const normalized = normalizeIntegerInput(raw);
    // Ungültige Eingabe wird verworfen: weder Anzeige noch Draft ändern sich.
    if (!normalized) return;
    setNumericText((current) => ({ ...current, [key]: normalized.text }));
    updateDraft(key, normalized.value);
  };

  const validateCurrentStep = (): boolean => {
    // P1-Abschluss-Rundgang (R-02) — der Assistent bearbeitet die USt-IdNr.: Formatprüfung wie in den Firmendaten.
    const result = validateSetupStep(step, draft, { formatChecks: 'strict' });
    setErrors(result.errors);
    return result.valid;
  };

  const applyCompletionResult = (result: SetupCompletionResult) => {
    if (!result.success) {
      setErrors(result.errors ?? {});
      /**
       * OFFICEPILOT-SETUP-CLOUD-PERSIST-01C — ein Fehler ohne Feldbezug (z. B.
       * fehlgeschlagenes lokales Speichern) darf nicht stumm bleiben. Die
       * Eingaben bleiben im Assistenten stehen.
       */
      setFormError(result.errorKey ?? null);
      setFormErrorRetryable(result.retryable === true);
      return;
    }
    setFormError(null);
    setFormErrorRetryable(false);
  };

  const handleNext = (target: SetupCompletionTarget = 'home') => {
    if (completingRef.current) return;
    if (!validateCurrentStep()) return;
    if (isLastStep) {
      const result = onComplete(draft, target);
      if (!isPromiseLike(result)) {
        applyCompletionResult(result);
        return;
      }
      completingRef.current = true;
      setCompleting(true);
      setFormError(null);
      void result
        .catch((): SetupCompletionResult => ({ success: false, errorKey: 'setupFlow.numberRange.failed', retryable: true }))
        .then((settled) => {
          completingRef.current = false;
          setCompleting(false);
          applyCompletionResult(settled);
        });
      return;
    }
    setErrors({});
    setDirty(true);
    setStepIndex((value) => value + 1);
  };

  const handleBack = () => {
    if (completingRef.current) return;
    setErrors({});
    setDirty(true);
    setStepIndex((value) => Math.max(0, value - 1));
  };

  const renderFieldError = (field: string) =>
    errors[field] ? <p className="form-error" role="alert">{translate(errors[field]!)}</p> : null;

  const inputClassName = (field: string) =>
    `input ${errors[field] ? 'input--error' : ''}`.trim();

  const progressPercent = ((stepIndex + 1) / steps.length) * 100;

  const renderStep = (currentStep: SetupWizardStep) => {
    switch (currentStep) {
      case 'company':
        return (
          <>
            <fieldset className="form-group">
              <legend className="form-group__legend">{translate('setup.language')}</legend>
              <div className="setup-lang-chips" role="group" aria-label={translate('setup.language')}>
                {LANGUAGES.map(({ value, labelKey, code }) => (
                  <button
                    key={value}
                    type="button"
                    className={`setup-lang-chip ${draft.language === value ? 'setup-lang-chip--active' : ''}`}
                    onClick={() => updateDraft('language', value)}
                    aria-pressed={draft.language === value}
                  >
                    <span className="setup-lang-chip__code">{code}</span>
                    <span className="setup-lang-chip__label">{translate(labelKey)}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="form-group">
              <label htmlFor="setup-companyName">{translate('setup.companyName')}</label>
              <input
                id="setup-companyName"
                className={inputClassName('companyName')}
                value={draft.companyName}
                onChange={(event) => updateDraft('companyName', event.target.value)}
                data-testid="setup-companyName"
                aria-invalid={errors.companyName ? true : undefined}
              />
              {renderFieldError('companyName')}
            </fieldset>

            {/* EINRICHTUNG-01 (AP3, O-02.2) — Rechtsform, Land und Telefon sind optional und landen im Firmenprofil. */}
            <fieldset className="form-group">
              <label htmlFor="setup-legalForm">{translate('setupFlow.field.legalForm')}</label>
              <input
                id="setup-legalForm"
                className="input"
                value={draft.legalForm ?? ''}
                maxLength={120}
                onChange={(event) => updateDraft('legalForm', event.target.value)}
                data-testid="setup-legalForm"
              />
            </fieldset>

            <fieldset className="form-group">
              <label htmlFor="setup-contactPerson">{translate('companyProfile.contactPerson')}</label>
              <input
                id="setup-contactPerson"
                className="input"
                value={draft.contactPerson}
                onChange={(event) => updateDraft('contactPerson', event.target.value)}
                data-testid="setup-contactPerson"
              />
              {renderFieldError('contactPerson')}
            </fieldset>

            <fieldset className="form-group">
              <label htmlFor="setup-street">{translate('companyProfile.street')}</label>
              <input
                id="setup-street"
                className="input"
                value={draft.street}
                onChange={(event) => updateDraft('street', event.target.value)}
                data-testid="setup-street"
              />
              {renderFieldError('street')}
            </fieldset>

            <div className="setup-form-row">
              <fieldset className="form-group">
                <label htmlFor="setup-zip">{translate('companyProfile.zip')}</label>
                <input
                  id="setup-zip"
                  className="input"
                  value={draft.zip}
                  onChange={(event) => updateDraft('zip', event.target.value)}
                  data-testid="setup-zip"
                />
                {renderFieldError('zip')}
              </fieldset>
              <fieldset className="form-group">
                <label htmlFor="setup-city">{translate('companyProfile.city')}</label>
                <input
                  id="setup-city"
                  className="input"
                  value={draft.city}
                  onChange={(event) => updateDraft('city', event.target.value)}
                  data-testid="setup-city"
                />
                {renderFieldError('city')}
              </fieldset>
            </div>

            <fieldset className="form-group">
              <label htmlFor="setup-country">{translate('setupFlow.field.country')}</label>
              <input
                id="setup-country"
                className="input"
                value={draft.country}
                maxLength={120}
                onChange={(event) => updateDraft('country', event.target.value)}
                data-testid="setup-country"
              />
            </fieldset>

            <fieldset className="form-group">
              <label htmlFor="setup-email">{translate('companyProfile.email')}</label>
              <input
                id="setup-email"
                type="email"
                className="input"
                value={draft.email}
                onChange={(event) => updateDraft('email', event.target.value)}
                data-testid="setup-email"
              />
              {renderFieldError('email')}
            </fieldset>

            <fieldset className="form-group">
              <label htmlFor="setup-phone">{translate('setupFlow.field.phone')}</label>
              <input
                id="setup-phone"
                type="tel"
                className="input"
                value={draft.phone}
                maxLength={60}
                onChange={(event) => updateDraft('phone', event.target.value)}
                data-testid="setup-phone"
              />
            </fieldset>

            <fieldset className="form-group">
              <label htmlFor="setup-industry">{translate('setup.industry')}</label>
              <div className="select-field">
                <select
                  id="setup-industry"
                  className="select"
                  value={draft.industry}
                  onChange={(event) => updateDraft('industry', event.target.value)}
                  data-testid="setup-industry"
                >
                  {INDUSTRY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>
          </>
        );

      case 'tax':
        return (
          <>
            <fieldset className="form-group">
              <label htmlFor="setup-taxNumber">{translate('companyProfile.taxNumber')}</label>
              <input
                id="setup-taxNumber"
                className="input"
                value={draft.taxNumber}
                onChange={(event) => updateDraft('taxNumber', event.target.value)}
                data-testid="setup-taxNumber"
              />
            </fieldset>
            <fieldset className="form-group">
              <label htmlFor="setup-vatId">{translate('companyProfile.vatId')}</label>
              <input
                id="setup-vatId"
                className={inputClassName('vatId')}
                value={draft.vatId}
                onChange={(event) => updateDraft('vatId', event.target.value)}
                data-testid="setup-vatId"
              />
              {renderFieldError('vatId')}
              {renderFieldError('taxIdentifier')}
            </fieldset>
            <fieldset className="form-group">
              <legend>{translate('setup.taxStatus')}</legend>
              <div className="radio-group">
                {TAX_OPTIONS.map(({ value, labelKey }) => (
                  <label key={value} className="radio-label">
                    <input
                      type="radio"
                      name="taxStatus"
                      checked={draft.taxStatus === value}
                      onChange={() => updateDraft('taxStatus', value)}
                    />
                    {translate(labelKey)}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        );

      case 'bank':
        return (
          <>
            <fieldset className="form-group">
              <label htmlFor="setup-iban">{translate('companyProfile.iban')}</label>
              <input
                id="setup-iban"
                className="input"
                value={draft.iban}
                onChange={(event) => updateDraft('iban', event.target.value)}
                data-testid="setup-iban"
              />
              {renderFieldError('iban')}
            </fieldset>
            <fieldset className="form-group">
              <label htmlFor="setup-bankName">{translate('companyProfile.bankName')}</label>
              <input
                id="setup-bankName"
                className="input"
                value={draft.bankName}
                onChange={(event) => updateDraft('bankName', event.target.value)}
              />
            </fieldset>
            <fieldset className="form-group">
              <label htmlFor="setup-bic">{translate('companyProfile.bic')}</label>
              <input
                id="setup-bic"
                className="input"
                value={draft.bic}
                onChange={(event) => updateDraft('bic', event.target.value)}
              />
            </fieldset>
          </>
        );

      case 'invoicing':
        return (
          <>
            <fieldset className="form-group">
              <label htmlFor="setup-lastInvoiceNumber">{translate('setup.lastInvoiceNumber')}</label>
              <input
                id="setup-lastInvoiceNumber"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                className="input"
                value={numericText.lastInvoiceNumber}
                onChange={(event) =>
                  handleIntegerInput('lastInvoiceNumber', event.target.value)
                }
                data-testid="setup-lastInvoiceNumber"
              />
              {renderFieldError('lastInvoiceNumber')}
              <p className="hint-text">{translate('setup.lastInvoiceNumberHint')}</p>
            </fieldset>
            <fieldset className="form-group">
              <label htmlFor="setup-paymentDays">{translate('companyProfile.defaultPaymentDays')}</label>
              <input
                id="setup-paymentDays"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                className="input"
                value={numericText.defaultPaymentDays}
                onChange={(event) =>
                  handleIntegerInput('defaultPaymentDays', event.target.value)
                }
                data-testid="setup-paymentDays"
              />
              {renderFieldError('defaultPaymentDays')}
            </fieldset>
            <fieldset className="form-group">
              <label htmlFor="setup-paymentTerms">{translate('companyProfile.defaultPaymentTerms')}</label>
              <textarea
                id="setup-paymentTerms"
                className="input"
                rows={2}
                value={draft.defaultPaymentTerms}
                onChange={(event) => updateDraft('defaultPaymentTerms', event.target.value)}
                data-testid="setup-paymentTerms"
              />
              {renderFieldError('defaultPaymentTerms')}
            </fieldset>
          </>
        );

      case 'communication':
        return (
          <>
            <fieldset className="form-group">
              <legend>{translate('setup.communicationChannel')}</legend>
              <div className="chip-group">
                {CHANNEL_OPTIONS.map(({ value, labelKey }) => (
                  <button
                    key={value}
                    type="button"
                    className={`chip ${draft.communicationChannel === value ? 'chip--active' : ''}`}
                    aria-pressed={draft.communicationChannel === value}
                    onClick={() => updateDraft('communicationChannel', value)}
                    data-testid={`setup-channel-${value}`}
                  >
                    {translate(labelKey)}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="form-group">
              <legend>{translate('setup.materialStandard')}</legend>
              <div className="radio-group">
                {MATERIAL_OPTIONS.map(({ value, labelKey }) => (
                  <label key={value} className="radio-label">
                    <input
                      type="radio"
                      name="materialStandard"
                      checked={draft.materialStandard === value}
                      onChange={() => updateDraft('materialStandard', value)}
                    />
                    {translate(labelKey)}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="hint-text">{translate('setup.finishHint')}</p>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <div className="setup-page" data-testid="first-run-wizard">
      <header className="setup-brand">
        <div className="setup-brand__mark" aria-hidden>
          OP
        </div>
        <div className="setup-brand__text">
          <h1 className="setup-brand__title">OfficeTakt</h1>
          <p className="setup-brand__subtitle">{translate('setup.subtitle')}</p>
        </div>
      </header>

      {/* EINRICHTUNG-01 (AP9; 1.32) — Ziel des Skip-Links der Einrichtungsseite. */}
      <div className="setup-progress" id="setup-progress" tabIndex={-1} data-testid="setup-progress">
        <div className="setup-progress__header">
          <span className="setup-progress__label">
            {translate('setup.stepProgress')
              .replace('{current}', String(stepIndex + 1))
              .replace('{total}', String(steps.length))}
          </span>
          <span className="setup-progress__step">{stepLabel}</span>
        </div>
        <div
          className="setup-progress__track"
          data-testid="setup-progress-bar"
          role="progressbar"
          aria-valuenow={stepIndex + 1}
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-label={stepLabel}
        >
          <div className="setup-progress__fill" style={{ width: `${progressPercent}%` }} />
        </div>
      </div>

      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          handleNext();
        }}
      >
        {resumed ? (
          <p className="hint-text" role="status" data-testid="setup-draft-resumed">
            {translate('setupFlow.resumed')}
          </p>
        ) : null}
        {formError ? (
          <div className="form-error" role="alert" data-testid="setup-form-error">
            <p>{translate(formError)}</p>
            {/* EINRICHTUNG-01 (AP3, O-04.3) — ein sichtbarer Weg zur Wiederholung; die Eingaben bleiben. */}
            {formErrorRetryable && isLastStep ? (
              <Button type="button" variant="outline" onClick={() => handleNext()} disabled={completing} data-testid="setup-retry">
                {translate('setupFlow.retry')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {renderStep(step)}
        {teamInvite && isLastStep ? (
          <div className="setup-team-invite" data-testid="setup-team-invite">
            <p className="hint-text">{translate('setupFlow.team.hint')}</p>
            <Button type="button" variant="outline" fullWidth disabled={completing} onClick={() => handleNext('team')} data-testid="setup-finish-team">
              {translate('setupFlow.team.finishAndInvite')}
            </Button>
          </div>
        ) : null}

        <div className="setup-form-actions">
          {stepIndex > 0 && (
            <Button type="button" variant="outline" onClick={handleBack} disabled={completing} data-testid="setup-back">
              {translate('setup.back')}
            </Button>
          )}
          <Button type="submit" fullWidth disabled={completing} aria-busy={completing || undefined} data-testid="setup-next">
            {completing ? translate('setupFlow.completing') : isLastStep ? translate('setup.finish') : translate('setup.next')}
          </Button>
        </div>
      </form>
    </div>
  );
}
