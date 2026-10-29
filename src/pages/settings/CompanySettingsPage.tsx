import { useState } from 'react';
import { SettingsAccessNotice, resolveSettingsNoticeVariant } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { SettingsSaveBar } from '../../components/settings/SettingsSaveBar';
import { useApp } from '../../context/AppContext';
import { SettingsForeignFieldErrors, foreignFieldErrors } from '../../components/settings/SettingsForeignFieldErrors';
import { CHANNEL_OPTIONS, MATERIAL_OPTIONS } from '../../components/setup/setupOptions';
import { useFocusFieldFromHash } from '../../hooks/useFocusFieldFromHash';
import { useFormResume } from '../../hooks/useFormResume';
import { useSettingsAccess } from '../../hooks/useSettingsAccess';
import { changedProfileFields, useProfileFormBase } from '../../hooks/useProfileFormBase';
import { getCompanyProfile } from '../../services/companyProfileService';
import { getLastPersistSuccess } from '../../services/persistenceService';
import { getInvoiceNumberSequenceSnapshot } from '../../services/invoiceNumberService';
import { ibanErrorKey, validateCompanyProfileForSettings } from '../../services/setupValidationService';
import { COMPANY_PROFILE_TEXT_LIMITS, textInputMaxLength } from '../../services/company/companyProfileSettingsContract';
import {
  formatIbanGroups,
  normalizeCompanyProfileFormats,
  normalizeIbanInput,
} from '../../services/company/companyProfileFormatRules';
import { INDUSTRY_OPTIONS } from '../../data/mockData';
import type { CompanyProfile, CompanySetup } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * SETTINGS-01B2 — die Firmenprofil-Unterseite `/einstellungen/firma`.
 *
 * Nur echte Firmenstammdaten: Unternehmen, Anschrift, Kontakt, Steuer,
 * Register, Bank. Vorbelegungen (Zahlungsziel, Skonto, Rechnungstexte,
 * Steuerstatus-Default), Logo, Sprache, Datensicherung gehören auf ihre
 * eigenen Unterseiten (01B3/01B4/01B5) und stehen hier bewusst nicht.
 *
 * Datenquelle ist das bestehende `CompanyProfile` (kein zweiter Store).
 * Speichern läuft über den kanonischen Weg: Validator → ein
 * `updateCompanyProfile` → `persistAll` → bestehende Sync-Queue. Der Entwurf
 * wird über `useFormResume` (dieselbe Infrastruktur wie die Firmendaten)
 * gegen Reload und Navigation gesichert und nach dem Speichern verworfen.
 */
export const COMPANY_SETTINGS_ROUTE = SETTINGS_TARGET_PATHS['company-profile'];

/** Die Felder dieser Seite — und nur diese werden gelesen und geschrieben. */
export const COMPANY_SETTINGS_FIELDS = [
  'companyName',
  'legalForm',
  'managingDirector',
  'contactPerson',
  'street',
  'zip',
  'city',
  'country',
  // E-RECHNUNG-04B — der Code neben dem Freitext, nicht an seiner Stelle.
  'countryCode',
  'phone',
  'email',
  'website',
  'taxNumber',
  'vatId',
  'registrationAuthority',
  'registrationNumber',
  'bankName',
  'accountHolder',
  'iban',
  'bic',
] as const satisfies readonly (keyof CompanyProfile & string)[];

export type CompanySettingsField = (typeof COMPANY_SETTINGS_FIELDS)[number];

/** Vorbelegungen, die hier nie erscheinen dürfen (Prüfung in Tests). */
export const COMPANY_SETTINGS_EXCLUDED_FIELDS = [
  'defaultTaxStatus',
  'defaultIntroText',
  'defaultClosingText',
  'defaultPaymentDays',
  'defaultPaymentTerms',
  'defaultSkonto',
  'skontoEnabled',
  'skontoPercent',
  'skontoDays',
  'invoiceFooterNotes',
  'taxFreeNotice',
  'branding',
  'logoDataUrl',
] as const satisfies readonly (keyof CompanyProfile & string)[];

interface FieldSpec {
  key: CompanySettingsField;
  labelKey: TranslationKey;
  type?: 'text' | 'tel' | 'email' | 'url';
  autoComplete?: string;
  hintKey?: TranslationKey;
  placeholderKey?: TranslationKey;
  maxLength?: number;
  /** Welcher Validator-Schlüssel den Fehler dieses Feldes trägt. */
  errorKeys?: readonly string[];
}

interface SectionSpec {
  id: string;
  titleKey: TranslationKey;
  fields: FieldSpec[];
}

const SECTIONS: SectionSpec[] = [
  {
    id: 'company',
    titleKey: 'settings.company.section.company',
    fields: [
      { key: 'companyName', labelKey: 'companyProfile.companyName', autoComplete: 'organization' },
      { key: 'legalForm', labelKey: 'companyProfile.legalForm' },
      {
        key: 'managingDirector',
        labelKey: 'companyProfile.managingDirector',
        hintKey: 'companyProfile.managingDirectorHint',
      },
      { key: 'contactPerson', labelKey: 'companyProfile.contactPerson', autoComplete: 'name' },
    ],
  },
  {
    id: 'address',
    titleKey: 'settings.company.section.address',
    fields: [
      { key: 'street', labelKey: 'companyProfile.street', autoComplete: 'street-address' },
      { key: 'zip', labelKey: 'companyProfile.zip', autoComplete: 'postal-code' },
      { key: 'city', labelKey: 'companyProfile.city', autoComplete: 'address-level2' },
      { key: 'country', labelKey: 'companyProfile.country', autoComplete: 'country-name' },
      /*
       * E-RECHNUNG-04B — der Ländercode steht direkt unter dem Land.
       *
       * Zwei Felder statt eines: Oben steht, was auf dem Briefkopf erscheint,
       * darunter der Code, den eine strukturierte Rechnung braucht. Den
       * Freitext stillschweigend in einen Code zu verwandeln hiesse, die
       * Anzeige zu verändern; ihn zu ersetzen hiesse, jedem Betrieb sein
       * gewohntes Feld wegzunehmen.
       */
      { key: 'countryCode', labelKey: 'companyProfile.countryCode' },
    ],
  },
  {
    id: 'contact',
    titleKey: 'settings.company.section.contact',
    fields: [
      { key: 'phone', labelKey: 'companyProfile.phone', type: 'tel', autoComplete: 'tel' },
      { key: 'email', labelKey: 'companyProfile.email', type: 'email', autoComplete: 'email' },
      { key: 'website', labelKey: 'companyProfile.website', type: 'url', autoComplete: 'url' },
    ],
  },
  {
    id: 'tax',
    titleKey: 'settings.company.section.tax',
    fields: [
      { key: 'taxNumber', labelKey: 'companyProfile.taxNumber', errorKeys: ['taxIdentifier'] },
      { key: 'vatId', labelKey: 'companyProfile.vatId', errorKeys: ['taxIdentifier'] },
    ],
  },
  {
    id: 'register',
    titleKey: 'settings.company.section.register',
    fields: [
      {
        key: 'registrationAuthority',
        labelKey: 'companyProfile.registrationAuthority',
        placeholderKey: 'companyProfile.registrationAuthority.placeholder',
      },
      {
        key: 'registrationNumber',
        labelKey: 'companyProfile.registrationNumber',
        placeholderKey: 'companyProfile.registrationNumber.placeholder',
      },
    ],
  },
  {
    id: 'bank',
    titleKey: 'settings.company.section.bank',
    fields: [
      { key: 'bankName', labelKey: 'companyProfile.bankName' },
      // EINRICHTUNG-01 (S-08) — Grenze in Codepunkten; das Feld blockiert keinen gültigen Wert.
      { key: 'accountHolder', labelKey: 'companyProfile.accountHolder', maxLength: textInputMaxLength(COMPANY_PROFILE_TEXT_LIMITS.accountHolder) },
      { key: 'iban', labelKey: 'companyProfile.iban' },
      { key: 'bic', labelKey: 'companyProfile.bic' },
    ],
  },
];

type CompanySettingsDraft = Pick<CompanyProfile, CompanySettingsField>;

/**
 * BROWSER-ACCEPTANCE-FIX 01 / B2 — Rechtsform mit Handelsregister-Angaben.
 *
 * Nur ein sichtbarer Hinweis, keine Pflicht und keine Rechtsauskunft: Die
 * Felder gibt es im Profil bereits; fehlen sie bei einer GmbH/UG, sagt die
 * Seite das, statt still weiterzumachen.
 */
const CAPITAL_COMPANY_FORM = /\b(gmbh|ug)\b/i;
const CAPITAL_COMPANY_FIELDS = [
  { key: 'managingDirector', labelKey: 'companyProfile.managingDirector' },
  { key: 'registrationAuthority', labelKey: 'companyProfile.registrationAuthority' },
  { key: 'registrationNumber', labelKey: 'companyProfile.registrationNumber' },
] as const satisfies readonly { key: CompanySettingsField; labelKey: TranslationKey }[];

export function missingCapitalCompanyFields(
  draft: Pick<CompanyProfile, 'legalForm' | 'managingDirector' | 'registrationAuthority' | 'registrationNumber'> &
    Partial<Pick<CompanyProfile, 'companyName'>>,
): (typeof CAPITAL_COMPANY_FIELDS)[number][] {
  /*
   * Die Rechtsform steht im eigenen Feld; ist es leer, steht sie oft im
   * Firmennamen („Muster Bau GmbH"). Ein ausgefülltes Feld hat Vorrang.
   */
  const form = (draft.legalForm ?? '').trim() || (draft.companyName ?? '');
  if (!CAPITAL_COMPANY_FORM.test(form)) return [];
  return CAPITAL_COMPANY_FIELDS.filter((field) => !(draft[field.key] ?? '').trim());
}

/** F-03 — die IBAN steht im Entwurf in Vierergruppen; verglichen und gespeichert wird die elektronische Form. */
function pickFields(profile: CompanyProfile): CompanySettingsDraft {
  const picked = {} as Record<CompanySettingsField, string>;
  for (const key of COMPANY_SETTINGS_FIELDS) picked[key] = profile[key] ?? '';
  picked.iban = formatIbanGroups(picked.iban);
  return picked;
}

function comparableValue(key: CompanySettingsField, value: string | undefined): string {
  const text = value ?? '';
  return key === 'iban' ? normalizeIbanInput(text) : text;
}

export function isCompanySettingsDirty(draft: CompanySettingsDraft, saved: CompanyProfile): boolean {
  return COMPANY_SETTINGS_FIELDS.some((key) => comparableValue(key, draft[key]) !== comparableValue(key, saved[key]));
}

/** F-04 — Gewerk, Materialstandard und Kanal (CompanySetup), dieselben Werte wie im Assistenten. */
type OperationsDraft = Pick<CompanySetup, 'industry' | 'materialStandard' | 'communicationChannel'>;

function pickOperations(setup: CompanySetup): OperationsDraft {
  return { industry: setup.industry, materialStandard: setup.materialStandard, communicationChannel: setup.communicationChannel };
}

function changedOperations(draft: OperationsDraft, saved: OperationsDraft): Partial<OperationsDraft> {
  const changed: Partial<OperationsDraft> = {};
  if (draft.industry !== saved.industry) changed.industry = draft.industry;
  if (draft.materialStandard !== saved.materialStandard) changed.materialStandard = draft.materialStandard;
  if (draft.communicationChannel !== saved.communicationChannel) changed.communicationChannel = draft.communicationChannel;
  return changed;
}

/** Fehlerschlüssel, die diese Seite selbst am Feld zeigt (F-01): ihre Felder, die Sammelangabe Steuer, F-04. */
const OWN_ERROR_KEYS: ReadonlySet<string> = new Set<string>([
  ...COMPANY_SETTINGS_FIELDS,
  'taxIdentifier',
  'industry',
  'materialStandard',
  'communicationChannel',
]);

export function CompanySettingsPage() {
  const { companyProfile, setup, updateCompanyProfile, updateSetup, translate, showToast } = useApp();
  // EINRICHTUNG-01 (AP5; 1.16) — reaktiv: Rolle, Lizenz und Löschantrag wirken ohne Neuladen.
  const { access, canEdit: editable } = useSettingsAccess();
  const noticeVariant = resolveSettingsNoticeVariant(access);
  // EINRICHTUNG-01 (AP6; F-01.2) — Sprung aus der Fehlerliste einer anderen Seite: Fokus am Feld.
  useFocusFieldFromHash();

  /*
   * Derselbe Resume-Namensraum wie die Firmendaten: Es gibt genau einen
   * ungespeicherten Firmenentwurf, egal über welche Seite er entstand. Die
   * Basis ist der gespeicherte Stand; weicht er inzwischen ab (Cloud-Pull),
   * verwirft der Hook den alten Entwurf, statt ihn darüberzulegen.
   */
  const resume = useFormResume<CompanySettingsDraft>({
    namespace: 'companyProfile',
    fields: COMPANY_SETTINGS_FIELDS,
    saved: pickFields(companyProfile),
    workspaceType: 'other',
  });

  const [draft, setDraft] = useState<CompanySettingsDraft>(() => ({
    ...pickFields(companyProfile),
    ...resume.restored,
  }));
  const [operations, setOperations] = useState<OperationsDraft>(() => pickOperations(setup));
  const [errors, setErrors] = useState<Partial<Record<string, TranslationKey>>>({});
  const [foreign, setForeign] = useState<Array<{ field: string; message: TranslationKey }>>([]);
  const [saving, setSaving] = useState(false);
  // EINRICHTUNG-01 (AP9; 1.30) — Speicherfehler als bleibender Hinweis an der Speicherleiste, nicht als Toast.
  const [saveError, setSaveError] = useState<TranslationKey | null>(null);

  resume.observe(draft);
  // FINANZ-CORE-01A (EIN-03) — Ausgangsstand des Entwurfs; unberührte Felder folgen dem Profil.
  const baseRef = useProfileFormBase(companyProfile, pickFields, setDraft);

  const savedOperations = pickOperations(setup);
  const operationsDirty = Object.keys(changedOperations(operations, savedOperations)).length > 0;
  const dirty = isCompanySettingsDirty(draft, companyProfile) || operationsDirty;

  /* EINRICHTUNG-01 (AP5; 1.17) — „Verwerfen“: zurück auf den gespeicherten Stand, der Entwurf entfällt. */
  const discard = () => {
    setDraft(pickFields(companyProfile));
    baseRef.current = pickFields(companyProfile);
    setOperations(pickOperations(setup));
    setErrors({});
    setForeign([]);
    // EINRICHTUNG-01 (AP9; 1.30) — mit dem Verwerfen gilt auch der Hinweis des letzten Speicherversuchs nicht mehr.
    setSaveError(null);
    resume.clearResume();
  };

  const clearError = (key: string) => {
    if (!errors[key]) return;
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const setField = (key: CompanySettingsField, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    clearError(key);
    if (key === 'taxNumber' || key === 'vatId') clearError('taxIdentifier');
  };

  const setOperation = <K extends keyof OperationsDraft>(key: K, value: OperationsDraft[K]) => {
    if (!editable) return;
    setOperations((prev) => ({ ...prev, [key]: value }));
    clearError(key);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    /*
     * BUGFIX-FIRMENDATEN-IBAN-01 (aus der alten Firmendaten-Seite übernommen,
     * SETTINGS-01B5): Browser-Autofill kann die IBAN ins DOM schreiben, ohne
     * dass React ein onChange sieht. Beim Absenden zählt der DOM-Wert.
     */
    const ibanField = event.currentTarget.elements.namedItem('iban');
    const ibanFromDom = ibanField instanceof HTMLInputElement ? ibanField.value : undefined;
    const effectiveDraft: CompanySettingsDraft =
      ibanFromDom !== undefined && normalizeIbanInput(ibanFromDom) !== normalizeIbanInput(draft.iban ?? '')
        ? { ...draft, iban: ibanFromDom }
        : draft;
    const opsChanged = changedOperations(operations, savedOperations);
    const profileDirty = isCompanySettingsDirty(effectiveDraft, companyProfile);
    if (!editable || saving || (!profileDirty && Object.keys(opsChanged).length === 0)) return;
    setSaving(true);
    setSaveError(null);
    try {
      /*
       * FINANZ-CORE-01A (EIN-03) — nur die geänderten Felder, über dem aktuellen Stand des Stores:
       * Ein inzwischen auf einem anderen Gerät geänderter Wert geht nicht mehr verloren.
       * EINRICHTUNG-01 (AP6; F-02, F-03) — gespeichert wird die einheitliche Form (IBAN ohne Leerzeichen, BIC und
       * USt-IdNr. in Großbuchstaben). Eine gespeicherte IBAN mit Leerzeichen wird beim nächsten Speichern normalisiert.
       */
      const changed = normalizeCompanyProfileFormats(
        changedProfileFields(effectiveDraft, baseRef.current) as Partial<CompanyProfile>,
      );
      const storedIban = getCompanyProfile().iban ?? '';
      if (changed.iban === undefined && storedIban && normalizeIbanInput(storedIban) !== storedIban) {
        changed.iban = normalizeIbanInput(storedIban);
      }
      const candidate: CompanyProfile = { ...getCompanyProfile(), ...changed };
      /*
       * Geprüft wird das vollständige Profil mit den Seitenwerten darüber — derselbe Validator wie bisher, jetzt mit den
       * Formatregeln (F-02) für die Felder dieser Seite.
       */
      const validation = validateCompanyProfileForSettings(candidate, getInvoiceNumberSequenceSnapshot().lastIssuedNumber, {
        formatChecks: 'strict',
      });
      if (!validation.valid) {
        const own: Partial<Record<string, TranslationKey>> = {};
        for (const [key, message] of Object.entries(validation.errors)) {
          if (message && OWN_ERROR_KEYS.has(key)) own[key] = message;
        }
        setErrors(own);
        // F-01 — Fehler anderer Seiten als Liste mit Sprung; keine Behauptung „markierte Felder“ ohne Markierung.
        setForeign(foreignFieldErrors(validation.errors, 'company-profile'));
        // EINRICHTUNG-01 (AP9; 1.30) — Sammelhinweis bleibt an der Speicherleiste stehen (kein verschwindender Toast).
        if (Object.keys(own).length > 0) setSaveError('settings.company.validationSummary');
        return;
      }
      setErrors({});
      setForeign([]);

      // Ein kanonisches Update mit genau den Feldern dieser Seite.
      if (Object.keys(changed).length > 0) {
        const result = updateCompanyProfile(changed);
        if (!result.success) {
          setSaveError(result.errorKey as TranslationKey);
          return;
        }
        setDraft(pickFields(result.profile));
        baseRef.current = pickFields(result.profile);
      }
      // F-04 — Gewerk, Material und Kanal über den bestehenden Setup-Weg (company_setup).
      if (Object.keys(opsChanged).length > 0) updateSetup(opsChanged);
      resume.clearResume();
      if (!getLastPersistSuccess()) {
        setSaveError('persist.failed.userAction');
        return;
      }
      showToast(translate('settings.company.saved'));
    } finally {
      setSaving(false);
    }
  };

  /*
   * B2 — die IBAN wird schon beim Anzeigen geprüft: Auch eine früher
   * gespeicherte ungültige IBAN ist sichtbar, geändert wird sie nicht.
   * Speichern ist erst mit gültiger IBAN möglich (Validator oben).
   */
  const ibanCheckKey = (draft.iban ?? '').trim() ? ibanErrorKey(draft.iban ?? '') : null;
  const ibanIsStored = normalizeIbanInput(draft.iban ?? '') === normalizeIbanInput(companyProfile.iban ?? '');
  const missingLegalFields = missingCapitalCompanyFields(draft);

  const errorFor = (field: FieldSpec): TranslationKey | null => {
    if (errors[field.key]) return errors[field.key] ?? null;
    for (const key of field.errorKeys ?? []) {
      if (errors[key]) return errors[key] ?? null;
    }
    return null;
  };

  const industryOptions = INDUSTRY_OPTIONS.includes(operations.industry) || !operations.industry
    ? INDUSTRY_OPTIONS
    : [operations.industry, ...INDUSTRY_OPTIONS];

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-company-page">
      <SettingsPageHeader
        target="company-profile"
        backTestId="settings-company-back"
        subtitle={translate('settings.company.page.subtitle')}
      />

      {!editable && noticeVariant ? (
        <SettingsAccessNotice variant={noticeVariant} testId="settings-company-readonly" />
      ) : editable ? (
        <p className="hint-text" data-testid="settings-company-historical-hint">
          {translate('settings.company.historicalHint')}
        </p>
      ) : null}

      <SettingsForeignFieldErrors entries={foreign} testId="settings-company-foreign-errors" />

      <form className="company-profile-form settings-form" onSubmit={handleSubmit} noValidate>
        {SECTIONS.map((section) => (
          <fieldset
            key={section.id}
            className="form-group settings-form__section"
            id={`settings-company-${section.id}`}
            data-testid={`settings-company-section-${section.id}`}
            disabled={!editable || saving}
          >
            <legend className="settings-form__legend">{translate(section.titleKey)}</legend>
            {section.fields.map((field) => {
              const error = errorFor(field);
              const inputId = `settings-company-${field.key}`;
              return (
                <div className="settings-form__field" key={field.key}>
                  <label htmlFor={inputId}>{translate(field.labelKey)}</label>
                  <input
                    id={inputId}
                    name={field.key}
                    type={field.type ?? 'text'}
                    className={`input${error ? ' input--error' : ''}`}
                    value={draft[field.key] ?? ''}
                    autoComplete={field.autoComplete}
                    maxLength={field.maxLength}
                    placeholder={field.placeholderKey ? translate(field.placeholderKey) : undefined}
                    readOnly={!editable}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${inputId}-error` : field.hintKey ? `${inputId}-hint` : undefined}
                    data-testid={inputId}
                    onChange={(event) => setField(field.key, event.target.value)}
                    onBlur={
                      field.key === 'iban'
                        ? (event) => setField('iban', formatIbanGroups(event.target.value))
                        : undefined
                    }
                  />
                  {field.hintKey && !error ? (
                    <p className="form-hint" id={`${inputId}-hint`}>
                      {translate(field.hintKey)}
                    </p>
                  ) : null}
                  {error ? (
                    <p className="form-error" id={`${inputId}-error`} data-testid={`${inputId}-error`}>
                      {translate(error)}
                    </p>
                  ) : null}
                  {field.key === 'iban' && !error && ibanCheckKey ? (
                    <p className="form-error" role="status" data-testid="settings-company-iban-check">
                      {translate(ibanIsStored ? 'settings.company.iban.storedInvalid' : 'settings.company.iban.invalidNow')}{' '}
                      {translate(ibanCheckKey)}
                    </p>
                  ) : null}
                  {field.key === 'legalForm' && missingLegalFields.length > 0 ? (
                    <p className="settings-form__notice" role="status" data-testid="settings-company-legal-hint">
                      {translate('settings.company.legalForm.missingHint').replace(
                        '{fields}',
                        missingLegalFields.map((missing) => translate(missing.labelKey)).join(', '),
                      )}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
        ))}

        {/* ---------------- EINRICHTUNG-01 (AP6; F-04) — Arbeitsweise ---------------- */}
        <fieldset
          className="form-group settings-form__section"
          id="settings-company-operations"
          data-testid="settings-company-section-operations"
          disabled={!editable || saving}
        >
          <legend className="settings-form__legend">{translate('settings.company.section.operations')}</legend>
          <p className="hint-text">{translate('settings.company.operations.hint')}</p>
          <div className="settings-form__field">
            <label htmlFor="settings-company-industry">{translate('setup.industry')}</label>
            <select
              id="settings-company-industry"
              className="select input"
              value={operations.industry}
              disabled={!editable}
              onChange={(event) => setOperation('industry', event.target.value)}
              data-testid="settings-company-industry"
            >
              {industryOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-form__field" role="group" aria-labelledby="settings-company-channel-label">
            <span id="settings-company-channel-label" className="settings-form__label">
              {translate('setup.communicationChannel')}
            </span>
            <div className="chip-group" id="settings-company-communicationChannel">
              {CHANNEL_OPTIONS.map(({ value, labelKey }) => (
                <button
                  key={value}
                  type="button"
                  className={`chip ${operations.communicationChannel === value ? 'chip--active' : ''}`}
                  aria-pressed={operations.communicationChannel === value}
                  disabled={!editable}
                  onClick={() => setOperation('communicationChannel', value)}
                  data-testid={`settings-company-channel-${value}`}
                >
                  {translate(labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-form__field" role="radiogroup" aria-labelledby="settings-company-material-label">
            <span id="settings-company-material-label" className="settings-form__label">
              {translate('setup.materialStandard')}
            </span>
            <div className="radio-group" id="settings-company-materialStandard">
              {MATERIAL_OPTIONS.map(({ value, labelKey }) => (
                <label key={value} className="radio-label">
                  <input
                    type="radio"
                    name="materialStandard"
                    checked={operations.materialStandard === value}
                    disabled={!editable}
                    onChange={() => setOperation('materialStandard', value)}
                    data-testid={`settings-company-material-${value}`}
                  />
                  {translate(labelKey)}
                </label>
              ))}
            </div>
          </div>
        </fieldset>

        {editable ? <SettingsSaveBar dirty={dirty} saving={saving} onDiscard={discard} testIdPrefix="settings-company" draftKept error={saveError ? translate(saveError) : null} /> : null}
      </form>
    </div>
  );
}
