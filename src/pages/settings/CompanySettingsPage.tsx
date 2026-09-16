import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { ReadOnlyNotice } from '../../components/ui/ReadOnlyNotice';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useFormResume } from '../../hooks/useFormResume';
import { isSupabaseConfigured } from '../../lib/supabase';
import { getLastPersistSuccess } from '../../services/persistenceService';
import { getInvoiceNumberSequenceSnapshot } from '../../services/invoiceNumberService';
import { validateCompanyProfileForSettings } from '../../services/setupValidationService';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import type { CompanyProfile } from '../../types/models';
import type { TranslationKey } from '../../i18n';

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
export const COMPANY_SETTINGS_ROUTE = '/einstellungen/firma';

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
      { key: 'accountHolder', labelKey: 'companyProfile.accountHolder', maxLength: 120 },
      { key: 'iban', labelKey: 'companyProfile.iban' },
      { key: 'bic', labelKey: 'companyProfile.bic' },
    ],
  },
];

type CompanySettingsDraft = Pick<CompanyProfile, CompanySettingsField>;

function pickFields(profile: CompanyProfile): CompanySettingsDraft {
  const picked = {} as Record<CompanySettingsField, string>;
  for (const key of COMPANY_SETTINGS_FIELDS) picked[key] = profile[key] ?? '';
  return picked;
}

export function isCompanySettingsDirty(draft: CompanySettingsDraft, saved: CompanyProfile): boolean {
  return COMPANY_SETTINGS_FIELDS.some((key) => (draft[key] ?? '') !== (saved[key] ?? ''));
}

export function CompanySettingsPage() {
  const { companyProfile, updateCompanyProfile, translate, showToast } = useApp();
  const { user } = useAuth();

  const access = useMemo(
    () => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() }),
    [user?.id],
  );
  const editable = access.canWrite;

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
  const [errors, setErrors] = useState<Partial<Record<string, TranslationKey>>>({});
  const [saving, setSaving] = useState(false);

  resume.observe(draft);

  const dirty = isCompanySettingsDirty(draft, companyProfile);

  const setField = (key: CompanySettingsField, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
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
      ibanFromDom !== undefined && ibanFromDom !== (draft.iban ?? '') ? { ...draft, iban: ibanFromDom } : draft;
    if (!editable || saving || !isCompanySettingsDirty(effectiveDraft, companyProfile)) return;
    setSaving(true);
    try {
      /*
       * Geprüft wird das vollständige Profil mit den Seitenwerten darüber —
       * derselbe Validator wie bisher, keine eigene Oberflächenregel.
       */
      const candidate: CompanyProfile = { ...companyProfile, ...effectiveDraft };
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

      // Ein kanonisches Update mit genau den Feldern dieser Seite.
      const result = updateCompanyProfile({ ...effectiveDraft });
      if (!result.success) {
        showToast(translate(result.errorKey as TranslationKey));
        return;
      }
      setDraft(pickFields(result.profile));
      resume.clearResume();
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
        return;
      }
      showToast(translate('settings.company.saved'));
    } finally {
      setSaving(false);
    }
  };

  const errorFor = (field: FieldSpec): TranslationKey | null => {
    if (errors[field.key]) return errors[field.key] ?? null;
    for (const key of field.errorKeys ?? []) {
      if (errors[key]) return errors[key] ?? null;
    }
    return null;
  };

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-company-page">
      <PageHeader
        title={translate('settings.company.title')}
        backLabel={translate('settings.backToHub')}
        backHref="/einstellungen"
        backTestId="settings-company-back"
        subtitle={translate('settings.company.page.subtitle')}
      />

      {!editable ? (
        <ReadOnlyNotice message={translate(
            access.reason === 'member' ? 'settings.company.readOnly' : 'settings.company.roleUnknown',
          )} testId="settings-company-readonly" />
      ) : (
        <p className="hint-text" data-testid="settings-company-historical-hint">
          {translate('settings.company.historicalHint')}
        </p>
      )}

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
                </div>
              );
            })}
          </fieldset>
        ))}

        {editable ? (
          <div className="settings-form__actions" data-testid="settings-company-actions">
            <span className="settings-form__dirty" data-testid="settings-company-dirty">
              {dirty ? translate('settings.company.unsavedHint') : translate('settings.company.noChanges')}
            </span>
            <Button type="submit" disabled={!dirty || saving} loading={saving} data-testid="settings-company-save">
              {translate('common.save')}
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
