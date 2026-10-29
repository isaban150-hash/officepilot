import { useState } from 'react';
import { SettingsAccessNotice, resolveSettingsNoticeVariant } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { SettingsSaveBar } from '../../components/settings/SettingsSaveBar';
import { useApp } from '../../context/AppContext';
import { useFocusFieldFromHash } from '../../hooks/useFocusFieldFromHash';
import { useFormResume } from '../../hooks/useFormResume';
import { changedProfileFields, useProfileFormBase } from '../../hooks/useProfileFormBase';
import { useSettingsAccess } from '../../hooks/useSettingsAccess';
import {
  COMPANY_PROFILE_TEXT_LIMITS,
  findCompanyProfileTextLimitViolations,
  textInputMaxLength,
} from '../../services/company/companyProfileSettingsContract';
import { getLastPersistSuccess } from '../../services/persistenceService';
import type { TranslationKey } from '../../i18n';
import type { CompanyProfile } from '../../types/models';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.21, V-01.4) — „Dokumente und Zahlungen › Briefe“: Standard-Anrede und Grußformel für
 * **neue** Briefe. Bestehende Briefe bleiben unverändert.
 */
export const LETTER_SETTINGS_ROUTE = SETTINGS_TARGET_PATHS.letters;

export const LETTER_SETTINGS_FIELDS = ['letterSalutation', 'letterClosing'] as const;
export type LetterSettingsDraft = Record<(typeof LETTER_SETTINGS_FIELDS)[number], string>;

export function pickLetterSettings(profile: CompanyProfile): LetterSettingsDraft {
  return { letterSalutation: profile.letterSalutation ?? '', letterClosing: profile.letterClosing ?? '' };
}

const LABELS: Record<(typeof LETTER_SETTINGS_FIELDS)[number], TranslationKey> = {
  letterSalutation: 'settings.letters.salutation',
  letterClosing: 'settings.letters.closing',
};

const PLACEHOLDERS: Record<(typeof LETTER_SETTINGS_FIELDS)[number], TranslationKey> = {
  letterSalutation: 'settings.letters.salutation.placeholder',
  letterClosing: 'settings.letters.closing.placeholder',
};

export function LetterSettingsPage() {
  const { companyProfile, updateCompanyProfile, translate, showToast } = useApp();
  const { access, canEdit: editable } = useSettingsAccess();
  const noticeVariant = resolveSettingsNoticeVariant(access);
  useFocusFieldFromHash();

  const resume = useFormResume<LetterSettingsDraft>({
    namespace: 'letterSettings',
    fields: LETTER_SETTINGS_FIELDS,
    saved: pickLetterSettings(companyProfile),
    workspaceType: 'other',
  });
  const [draft, setDraft] = useState<LetterSettingsDraft>(() => ({ ...pickLetterSettings(companyProfile), ...resume.restored }));
  const [errors, setErrors] = useState<Partial<Record<string, TranslationKey>>>({});
  const [saving, setSaving] = useState(false);
  // EINRICHTUNG-01 (AP9; 1.30) — Speicherfehler als bleibender Hinweis an der Speicherleiste, nicht als Toast.
  const [saveError, setSaveError] = useState<TranslationKey | null>(null);
  resume.observe(draft);
  const baseRef = useProfileFormBase(companyProfile, pickLetterSettings, setDraft);

  const saved = pickLetterSettings(companyProfile);
  const dirty = LETTER_SETTINGS_FIELDS.some((key) => draft[key] !== saved[key]);

  const discard = () => {
    setDraft(pickLetterSettings(companyProfile));
    baseRef.current = pickLetterSettings(companyProfile);
    setErrors({});
    // EINRICHTUNG-01 (AP9; 1.30) — mit dem Verwerfen gilt auch der Hinweis des letzten Speicherversuchs nicht mehr.
    setSaveError(null);
    resume.clearResume();
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editable || saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = changedProfileFields(draft, baseRef.current) as Partial<CompanyProfile>;
      if (Object.keys(payload).length === 0) return;
      const violations = findCompanyProfileTextLimitViolations(payload as Record<string, unknown>);
      if (violations.length > 0) {
        setErrors(Object.fromEntries(violations.map((violation) => [violation.field, violation.errorKey as TranslationKey])));
        return;
      }
      setErrors({});
      const result = updateCompanyProfile(payload);
      if (!result.success) {
        setSaveError(result.errorKey as TranslationKey);
        return;
      }
      setDraft(pickLetterSettings(result.profile));
      baseRef.current = pickLetterSettings(result.profile);
      resume.clearResume();
      if (!getLastPersistSuccess()) {
        setSaveError('persist.failed.userAction');
        return;
      }
      showToast(translate('settings.letters.saved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-letters-page">
      <SettingsPageHeader target="letters" subtitle={translate('settings.letters.page.subtitle')} />

      {!editable && noticeVariant ? (
        <SettingsAccessNotice variant={noticeVariant} testId="settings-letters-readonly" />
      ) : editable ? (
        <p className="hint-text" data-testid="settings-letters-historical-hint">
          {translate('settings.letters.historicalHint')}
        </p>
      ) : null}

      <form className="settings-form settings-letters" onSubmit={handleSubmit} noValidate>
        <fieldset className="form-group settings-form__section" data-testid="settings-letters-section-texts" disabled={!editable || saving}>
          <legend className="settings-form__legend">{translate('settings.letters.section.texts')}</legend>
          {LETTER_SETTINGS_FIELDS.map((key) => (
            <div className="settings-form__field" key={key}>
              <label htmlFor={`settings-letters-${key}`}>{translate(LABELS[key])}</label>
              <textarea
                id={`settings-letters-${key}`}
                name={key}
                className={`input settings-invoices__textarea${errors[key] ? ' input--error' : ''}`}
                rows={2}
                maxLength={textInputMaxLength(COMPANY_PROFILE_TEXT_LIMITS[key])}
                value={draft[key]}
                placeholder={translate(PLACEHOLDERS[key])}
                readOnly={!editable}
                aria-invalid={errors[key] ? true : undefined}
                aria-describedby={errors[key] ? `settings-letters-${key}-error` : undefined}
                onChange={(event) => {
                  setDraft((prev) => ({ ...prev, [key]: event.target.value }));
                  if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
                }}
                data-testid={`settings-letters-${key}`}
              />
              {errors[key] ? (
                <p className="form-error" id={`settings-letters-${key}-error`} data-testid={`settings-letters-${key}-error`}>
                  {translate(errors[key]!)}
                </p>
              ) : null}
            </div>
          ))}
          <p className="form-hint">{translate('settings.letters.texts.hint')}</p>
        </fieldset>

        {editable ? <SettingsSaveBar dirty={dirty} saving={saving} onDiscard={discard} testIdPrefix="settings-letters" draftKept error={saveError ? translate(saveError) : null} /> : null}
      </form>
    </div>
  );
}
