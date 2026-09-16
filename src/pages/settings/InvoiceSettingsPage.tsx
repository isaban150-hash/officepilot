import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { ReadOnlyNotice } from '../../components/ui/ReadOnlyNotice';
import { InlineNotice } from '../../components/ui/States';
import { NumericInput } from '../../components/ui/NumericInput';
import { InvoiceNumberFormatSection } from '../../components/settings/InvoiceNumberFormatSection';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useFormResume } from '../../hooks/useFormResume';
import { isSupabaseConfigured } from '../../lib/supabase';
import {
  COMPANY_PROFILE_TEXT_LIMITS,
  TAX_STATUS_VALUES,
  isTaxStatus,
} from '../../services/company/companyProfileSettingsContract';
import {
  reconcilePaymentTermsWithDays,
  resolveDefaultTaxStatus,
  resolveInvoiceDefaults,
  standardPaymentTerms,
} from '../../services/invoice/invoiceDefaults';
import { getInvoiceNumberSequenceSnapshot } from '../../services/invoiceNumberService';
import { formatInvoiceDate } from '../../services/invoicePrintModel';
import { buildSkontoText } from '../../services/invoiceTaxService';
import { getLastPersistSuccess } from '../../services/persistenceService';
import { validateCompanyProfileForSettings } from '../../services/setupValidationService';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import { migrateCompanyProfileLegacyFields } from '../../services/company/companyProfileLegacyMigrationService';
import { resolveProfileCurrency } from '../../services/company/companyProfileSettingsContract';
import { getAllExpensesFromStore } from '../../services/expenseStore';
import { COMMUNICATION_SETTINGS_ROUTE } from './CommunicationSettingsPage';
import type { TranslationKey } from '../../i18n';
import type { CompanyProfile, TaxStatus } from '../../types/models';

/**
 * SETTINGS-01B4 — die Unterseite `/einstellungen/rechnungen`.
 *
 * Der eine sichtbare Ort für die Vorbelegung neuer Rechnungen: Zahlungsziel,
 * Zahlungstext, Skonto, Steuerstatus (+ Hinweis bei steuerfreien Rechnungen,
 * 01B5), Einleitung, Schluss, Fusszeile. Die
 * Seite hält lokalen Formularzustand, prüft mit dem bestehenden Validator und
 * schreibt genau **ein** Profil-Update. Was daraus auf einer neuen Rechnung
 * steht, entscheidet ausschliesslich `resolveInvoiceDefaults` — die Vorschau
 * unten ruft denselben Resolver und baut nichts nach.
 *
 * Alles hier ist Vorbelegung: Ein bestehender Entwurf behält seine Werte,
 * eine freigegebene Rechnung ihren Snapshot; die §13b-Bestätigung bleibt ein
 * entwurfsgebundener Nutzerakt und wird von einem Default nie gesetzt.
 */
export const INVOICE_SETTINGS_ROUTE = '/einstellungen/rechnungen';

export const INVOICE_SETTINGS_FIELDS = [
  'defaultPaymentDays',
  'defaultPaymentTerms',
  'skontoEnabled',
  'skontoPercent',
  'skontoDays',
  'defaultTaxStatus',
  'taxFreeNotice',
  'defaultIntroText',
  'defaultClosingText',
  'invoiceFooterNotes',
] as const satisfies readonly (keyof CompanyProfile & string)[];

export interface InvoiceSettingsDraft {
  defaultPaymentDays: number;
  defaultPaymentTerms: string;
  skontoEnabled: boolean;
  skontoPercent: number;
  skontoDays: number;
  /** `''` = nicht gesetzt → Onboarding-Wert (`CompanySetup.taxStatus`) bleibt Fallback. */
  defaultTaxStatus: string;
  /** SETTINGS-01B5 — Rechnungs-/Dokumentstandard, nicht Betrieb: `buildLegalNotices` bei `tax_free`. */
  taxFreeNotice: string;
  defaultIntroText: string;
  defaultClosingText: string;
  invoiceFooterNotes: string;
}

export function pickInvoiceSettings(profile: CompanyProfile): InvoiceSettingsDraft {
  return {
    defaultPaymentDays: profile.defaultPaymentDays,
    defaultPaymentTerms: profile.defaultPaymentTerms ?? '',
    skontoEnabled: profile.skontoEnabled === true,
    skontoPercent: profile.skontoPercent ?? 0,
    skontoDays: profile.skontoDays ?? 0,
    defaultTaxStatus: profile.defaultTaxStatus ?? '',
    taxFreeNotice: profile.taxFreeNotice ?? '',
    defaultIntroText: profile.defaultIntroText ?? '',
    defaultClosingText: profile.defaultClosingText ?? '',
    invoiceFooterNotes: profile.invoiceFooterNotes ?? '',
  };
}

export function isInvoiceSettingsDirty(draft: InvoiceSettingsDraft, saved: CompanyProfile): boolean {
  const base = pickInvoiceSettings(saved);
  return INVOICE_SETTINGS_FIELDS.some((key) => draft[key] !== base[key]);
}

/**
 * Der Kandidat, der geprüft und gespeichert wird. `defaultTaxStatus` wird nur
 * dann ins Profil geschrieben, wenn der Betrieb ihn hier gewählt hat — ein
 * Altprofil bekommt durch Öffnen oder Speichern anderer Felder keinen
 * stillen Backfill. `defaultSkonto` folgt wie bisher dem strukturierten Skonto.
 */
export function buildInvoiceSettingsPayload(draft: InvoiceSettingsDraft): Partial<CompanyProfile> {
  const payload: Partial<CompanyProfile> = {
    defaultPaymentDays: draft.defaultPaymentDays,
    defaultPaymentTerms: draft.defaultPaymentTerms,
    skontoEnabled: draft.skontoEnabled,
    skontoPercent: draft.skontoPercent,
    skontoDays: draft.skontoDays,
    taxFreeNotice: draft.taxFreeNotice,
    defaultIntroText: draft.defaultIntroText,
    defaultClosingText: draft.defaultClosingText,
    invoiceFooterNotes: draft.invoiceFooterNotes,
  };
  if (draft.defaultTaxStatus && isTaxStatus(draft.defaultTaxStatus)) {
    payload.defaultTaxStatus = draft.defaultTaxStatus;
  }
  const skontoCandidate = { ...payload } as CompanyProfile;
  payload.defaultSkonto = draft.skontoEnabled ? buildSkontoText(skontoCandidate) : '';
  return payload;
}

const TAX_HINT_KEYS: Record<TaxStatus, TranslationKey> = {
  standard_19: 'settings.invoices.tax.hint.standard_19',
  standard_7: 'settings.invoices.tax.hint.standard_7',
  kleinunternehmer_19: 'settings.invoices.tax.hint.kleinunternehmer_19',
  reverse_charge_13b: 'settings.invoices.tax.hint.reverse_charge_13b',
  tax_free: 'settings.invoices.tax.hint.tax_free',
  unclear: 'settings.invoices.tax.hint.unclear',
};

type FieldErrors = Partial<Record<string, TranslationKey>>;

export function InvoiceSettingsPage() {
  const { companyProfile, setup, updateCompanyProfile, translate, showToast } = useApp();
  const { user } = useAuth();

  const access = useMemo(
    () => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() }),
    [user?.id],
  );
  const editable = access.canWrite;

  const resume = useFormResume<InvoiceSettingsDraft>({
    namespace: 'invoiceSettings',
    fields: INVOICE_SETTINGS_FIELDS,
    saved: pickInvoiceSettings(companyProfile),
    workspaceType: 'other',
  });

  const [draft, setDraft] = useState<InvoiceSettingsDraft>(() => ({
    ...pickInvoiceSettings(companyProfile),
    ...resume.restored,
  }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  resume.observe(draft);

  const dirty = isInvoiceSettingsDirty(draft, companyProfile);

  const clearError = (...keys: string[]) => {
    if (!keys.some((key) => errors[key])) return;
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of keys) delete next[key];
      return next;
    });
  };

  const setField = <K extends keyof InvoiceSettingsDraft>(key: K, value: InvoiceSettingsDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    clearError(key);
  };

  /* Zahlungsziel: ein noch standardmässiger Zahlungstext folgt der neuen Tageszahl. */
  const setPaymentDays = (days: number) => {
    setDraft((prev) => ({
      ...prev,
      defaultPaymentDays: days,
      defaultPaymentTerms: reconcilePaymentTermsWithDays(prev.defaultPaymentTerms, prev.defaultPaymentDays, days),
    }));
    clearError('defaultPaymentDays', 'skontoDays');
  };

  /*
   * Der Kandidat für Vorschau und Prüfung: das gespeicherte Profil mit den
   * Seitenwerten darüber. Ein nicht gewählter Steuerstatus bleibt `undefined`,
   * damit `resolveDefaultTaxStatus` wie im Rechnungsaufbau auf das Onboarding
   * zurückfällt.
   */
  const candidate: CompanyProfile = useMemo(
    () => ({ ...companyProfile, ...buildInvoiceSettingsPayload(draft) }),
    [companyProfile, draft],
  );
  const previewIssueDate = new Date().toISOString().slice(0, 10);
  const preview = useMemo(
    () => resolveInvoiceDefaults(candidate, setup, previewIssueDate),
    [candidate, setup, previewIssueDate],
  );
  const effectiveTaxStatus = resolveDefaultTaxStatus(candidate, setup);
  /*
   * FIRMENPROFIL-01D — Waehrung: kanonisch im Profil, derzeit nur EUR (Anzeige,
   * keine freie Eingabe). Ein Altbestand mit fremdwaehrigen Belegen wurde von
   * der Migration bewusst nicht auf EUR gesetzt — deterministisch wiedererkannt
   * ueber dieselbe reine Regel, kein zweiter Speicher.
   */
  const currency = resolveProfileCurrency(companyProfile);
  const currencyAmbiguous = useMemo(
    () =>
      migrateCompanyProfileLegacyFields({
        profile: companyProfile,
        setup,
        documentCurrencies: getAllExpensesFromStore().map((expense) => expense.currency),
      }).conflicts.includes('currency_ambiguous'),
    [companyProfile, setup],
  );
  const skontoSentence = buildSkontoText(candidate);
  const standardSentence = standardPaymentTerms(draft.defaultPaymentDays, !skontoSentence);
  const usesStandardSentence = draft.defaultPaymentTerms.trim() === standardSentence;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editable || saving || !dirty) return;
    setSaving(true);
    try {
      const validation = validateCompanyProfileForSettings(
        candidate,
        getInvoiceNumberSequenceSnapshot().lastIssuedNumber,
      );
      if (!validation.valid) {
        setErrors(validation.errors);
        showToast(translate('settings.company.validationSummary'));
        return;
      }
      setErrors({});

      const result = updateCompanyProfile(buildInvoiceSettingsPayload(draft));
      if (!result.success) {
        showToast(translate(result.errorKey as TranslationKey));
        return;
      }
      setDraft(pickInvoiceSettings(result.profile));
      resume.clearResume();
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
        return;
      }
      showToast(translate('settings.invoices.saved'));
    } finally {
      setSaving(false);
    }
  };

  const error = (key: string): TranslationKey | null => errors[key] ?? null;
  const disabled = !editable || saving;

  const renderError = (key: string) =>
    error(key) ? (
      <p className="form-error" id={`settings-invoices-${key}-error`} data-testid={`settings-invoices-${key}-error`}>
        {translate(error(key)!)}
      </p>
    ) : null;

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-invoices-page">
      <PageHeader
        title={translate('settings.invoices.title')}
        subtitle={translate('settings.invoices.page.subtitle')}
        backLabel={translate('settings.backToHub')}
        backHref="/einstellungen"
        backTestId="settings-invoices-back"
      />

      {!editable ? (
        <ReadOnlyNotice message={translate(access.reason === 'member' ? 'settings.invoices.readOnly' : 'settings.company.roleUnknown')} testId="settings-invoices-readonly" />
      ) : (
        <p className="hint-text" data-testid="settings-invoices-historical-hint">
          {translate('settings.invoices.historicalHint')}
        </p>
      )}

      {/* 01C — Nummernformat ist Server-/Sequenz-Wahrheit mit eigener Speicherung, kein Profilfeld. */}
      <InvoiceNumberFormatSection editable={editable} />

      <form className="settings-form settings-invoices" onSubmit={handleSubmit} noValidate>
        {/* ---------------- Zahlungsbedingungen ---------------- */}
        <fieldset className="form-group settings-form__section" data-testid="settings-invoices-section-payment" disabled={disabled}>
          <legend className="settings-form__legend">{translate('settings.invoices.section.payment')}</legend>

          <div className="settings-form__field settings-invoices__days">
            <label htmlFor="settings-invoices-defaultPaymentDays">{translate('settings.invoices.paymentDays')}</label>
            <div className="settings-invoices__unit-row">
              <NumericInput
                id="settings-invoices-defaultPaymentDays"
                mode="integer"
                min={0}
                className={`input settings-invoices__number${error('defaultPaymentDays') ? ' input--error' : ''}`}
                value={draft.defaultPaymentDays}
                onChange={setPaymentDays}
                disabled={disabled}
                data-testid="settings-invoices-defaultPaymentDays"
              />
              <span className="settings-invoices__unit">{translate('settings.invoices.days')}</span>
            </div>
            <p className="form-hint">
              {translate('settings.invoices.paymentDays.hint').replace('{date}', formatInvoiceDate(preview.paymentDueDate))}
            </p>
            {renderError('defaultPaymentDays')}
          </div>

          <div className="settings-form__field">
            <label htmlFor="settings-invoices-defaultPaymentTerms">{translate('settings.invoices.paymentTerms')}</label>
            <textarea
              id="settings-invoices-defaultPaymentTerms"
              name="defaultPaymentTerms"
              className={`input settings-invoices__textarea${error('defaultPaymentTerms') ? ' input--error' : ''}`}
              rows={2}
              value={draft.defaultPaymentTerms}
              readOnly={!editable}
              onChange={(event) => setField('defaultPaymentTerms', event.target.value)}
              data-testid="settings-invoices-defaultPaymentTerms"
            />
            <p className="form-hint" data-testid="settings-invoices-paymentTerms-hint">
              {usesStandardSentence
                ? translate('settings.invoices.paymentTerms.standardHint')
                : translate('settings.invoices.paymentTerms.customHint')}
            </p>
            {editable && !usesStandardSentence ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setField('defaultPaymentTerms', standardSentence)}
                data-testid="settings-invoices-paymentTerms-reset"
              >
                {translate('settings.invoices.paymentTerms.useStandard')}
              </Button>
            ) : null}
            {renderError('defaultPaymentTerms')}
          </div>
        </fieldset>

        {/* ---------------- Skonto ---------------- */}
        <fieldset className="form-group settings-form__section" data-testid="settings-invoices-section-skonto" disabled={disabled}>
          <legend className="settings-form__legend">{translate('settings.invoices.section.skonto')}</legend>

          <label className="checkbox-row settings-invoices__toggle" htmlFor="settings-invoices-skontoEnabled">
            <input
              id="settings-invoices-skontoEnabled"
              type="checkbox"
              role="switch"
              aria-checked={draft.skontoEnabled}
              checked={draft.skontoEnabled}
              onChange={(event) => {
                setField('skontoEnabled', event.target.checked);
                clearError('skontoPercent', 'skontoDays');
              }}
              data-testid="settings-invoices-skontoEnabled"
            />
            <span>{translate('settings.invoices.skontoEnabled')}</span>
          </label>

          <div className="settings-invoices__skonto-row">
            <div className="settings-form__field">
              <label htmlFor="settings-invoices-skontoPercent">{translate('settings.invoices.skontoPercent')}</label>
              <div className="settings-invoices__unit-row">
                <NumericInput
                  id="settings-invoices-skontoPercent"
                  mode="decimal"
                  min={0}
                  max={100}
                  className={`input settings-invoices__number${error('skontoPercent') ? ' input--error' : ''}`}
                  value={draft.skontoPercent}
                  onChange={(value) => setField('skontoPercent', value)}
                  disabled={disabled || !draft.skontoEnabled}
                  data-testid="settings-invoices-skontoPercent"
                />
                <span className="settings-invoices__unit">%</span>
              </div>
              {renderError('skontoPercent')}
            </div>
            <div className="settings-form__field">
              <label htmlFor="settings-invoices-skontoDays">{translate('settings.invoices.skontoDays')}</label>
              <div className="settings-invoices__unit-row">
                <NumericInput
                  id="settings-invoices-skontoDays"
                  mode="integer"
                  min={1}
                  className={`input settings-invoices__number${error('skontoDays') ? ' input--error' : ''}`}
                  value={draft.skontoDays}
                  onChange={(value) => setField('skontoDays', value)}
                  disabled={disabled || !draft.skontoEnabled}
                  data-testid="settings-invoices-skontoDays"
                />
                <span className="settings-invoices__unit">{translate('settings.invoices.days')}</span>
              </div>
              {renderError('skontoDays')}
            </div>
          </div>

          <p className="form-hint" data-testid="settings-invoices-skonto-sentence">
            {draft.skontoEnabled
              ? skontoSentence || translate('settings.invoices.skonto.incomplete')
              : translate('settings.invoices.skonto.off')}
          </p>
        </fieldset>

        {/* ---------------- Steuer ---------------- */}
        <fieldset className="form-group settings-form__section" data-testid="settings-invoices-section-tax" disabled={disabled}>
          <legend className="settings-form__legend">{translate('settings.invoices.section.tax')}</legend>
          <div className="settings-form__field">
            <label htmlFor="settings-invoices-defaultTaxStatus">{translate('settings.invoices.taxStatus')}</label>
            <select
              id="settings-invoices-defaultTaxStatus"
              name="defaultTaxStatus"
              className={`input${error('defaultTaxStatus') ? ' input--error' : ''}`}
              value={effectiveTaxStatus}
              disabled={disabled}
              onChange={(event) => setField('defaultTaxStatus', event.target.value)}
              data-testid="settings-invoices-defaultTaxStatus"
            >
              {TAX_STATUS_VALUES.map((value) => (
                <option key={value} value={value}>
                  {translate(`tax.${value}` as TranslationKey)}
                </option>
              ))}
            </select>
            <p className="form-hint" data-testid="settings-invoices-tax-hint">
              {translate(TAX_HINT_KEYS[effectiveTaxStatus])}
            </p>
            {!draft.defaultTaxStatus ? (
              <p className="form-hint" data-testid="settings-invoices-tax-fallback">
                {translate('settings.invoices.taxStatus.fromSetup')}
              </p>
            ) : null}
            {effectiveTaxStatus === 'reverse_charge_13b' ? (
              <InlineNotice tone="warning" testId="settings-invoices-tax-13b-hint">{translate('settings.invoices.taxStatus.reverseChargeHint')}</InlineNotice>
            ) : null}
            {renderError('defaultTaxStatus')}
          </div>
          <div className="settings-form__field">
            <label htmlFor="settings-invoices-taxFreeNotice">{translate('settings.invoices.taxFreeNotice')}</label>
            <input
              id="settings-invoices-taxFreeNotice"
              name="taxFreeNotice"
              type="text"
              className={`input${error('taxFreeNotice') ? ' input--error' : ''}`}
              value={draft.taxFreeNotice}
              readOnly={!editable}
              onChange={(event) => setField('taxFreeNotice', event.target.value)}
              data-testid="settings-invoices-taxFreeNotice"
            />
            <p className="form-hint">{translate('settings.invoices.taxFreeNotice.hint')}</p>
            {renderError('taxFreeNotice')}
          </div>
        </fieldset>

        {/* ---------------- Standardtexte ---------------- */}
        <fieldset className="form-group settings-form__section" data-testid="settings-invoices-section-texts" disabled={disabled}>
          <legend className="settings-form__legend">{translate('settings.invoices.section.texts')}</legend>
          {(
            [
              ['defaultIntroText', 'settings.invoices.introText', COMPANY_PROFILE_TEXT_LIMITS.defaultIntroText],
              ['defaultClosingText', 'settings.invoices.closingText', COMPANY_PROFILE_TEXT_LIMITS.defaultClosingText],
              ['invoiceFooterNotes', 'settings.invoices.footerNotes', undefined],
            ] as const
          ).map(([key, labelKey, maxLength]) => (
            <div className="settings-form__field" key={key}>
              <label htmlFor={`settings-invoices-${key}`}>{translate(labelKey)}</label>
              <textarea
                id={`settings-invoices-${key}`}
                name={key}
                className={`input settings-invoices__textarea${error(key) ? ' input--error' : ''}`}
                rows={3}
                maxLength={maxLength}
                value={draft[key]}
                readOnly={!editable}
                onChange={(event) => setField(key, event.target.value)}
                data-testid={`settings-invoices-${key}`}
              />
              {renderError(key)}
            </div>
          ))}
          <p className="form-hint">{translate('settings.invoices.texts.hint')}</p>
        </fieldset>

        {/* ---------------- Waehrung (FIRMENPROFIL-01D) ---------------- */}
        <section className="form-group settings-form__section" data-testid="settings-invoices-section-currency">
          <h2 className="settings-form__legend">{translate('settings.invoices.currency.title')}</h2>
          <p className="data-row__value" data-testid="settings-invoices-currency">
            {currency} — {translate('settings.invoices.currency.eurLabel')}
          </p>
          <p className="form-hint">{translate('settings.invoices.currency.hint')}</p>
          {currencyAmbiguous ? (
            <InlineNotice tone="warning" testId="settings-invoices-currency-ambiguous">{translate('settings.invoices.currency.ambiguous')}</InlineNotice>
          ) : null}
        </section>

        {/* ---------------- E-Mail-Versand: seit 01D unter „E-Mail & Kommunikation" ---------------- */}
        <p className="hint-text" data-testid="settings-invoices-email-moved">
          {translate('settings.invoices.email.movedHint')}{' '}
          <Link to={COMMUNICATION_SETTINGS_ROUTE} data-testid="settings-invoices-email-moved-link">{translate('settings.communication.title')}</Link>
        </p>

        {/* ---------------- Beispiel für neue Rechnung ---------------- */}
        <section className="settings-form__section settings-invoices__preview" data-testid="settings-invoices-preview">
          <h2 className="settings-form__legend">{translate('settings.invoices.preview.title')}</h2>
          <p className="hint-text">{translate('settings.invoices.preview.hint')}</p>
          <dl className="settings-invoices__preview-list">
            <div>
              <dt>{translate('settings.invoices.preview.due')}</dt>
              <dd data-testid="settings-invoices-preview-due">
                {formatInvoiceDate(preview.paymentDueDate)} ({draft.defaultPaymentDays} {translate('settings.invoices.days')})
              </dd>
            </div>
            <div>
              <dt>{translate('settings.invoices.paymentTerms')}</dt>
              <dd data-testid="settings-invoices-preview-terms">{preview.paymentTermsText}</dd>
            </div>
            <div>
              <dt>{translate('settings.invoices.section.skonto')}</dt>
              <dd data-testid="settings-invoices-preview-skonto">{preview.skontoText || '—'}</dd>
            </div>
            <div>
              <dt>{translate('settings.invoices.taxStatus')}</dt>
              <dd data-testid="settings-invoices-preview-tax">{translate(`tax.${preview.taxStatus}` as TranslationKey)}</dd>
            </div>
            <div>
              <dt>{translate('settings.invoices.introText')}</dt>
              <dd data-testid="settings-invoices-preview-intro">{preview.introText || '—'}</dd>
            </div>
            <div>
              <dt>{translate('settings.invoices.closingText')}</dt>
              <dd data-testid="settings-invoices-preview-closing">{preview.closingText || '—'}</dd>
            </div>
          </dl>
        </section>

        {editable ? (
          <div className="settings-form__actions">
            <span className="settings-form__dirty" data-testid="settings-invoices-dirty">
              {dirty ? translate('settings.company.unsavedHint') : translate('settings.company.noChanges')}
            </span>
            <Button type="submit" disabled={!dirty || saving} loading={saving} data-testid="settings-invoices-save">
              {translate('common.save')}
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
