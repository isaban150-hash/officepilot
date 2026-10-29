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
  DEFAULT_OFFER_VALIDITY_DAYS,
  OFFER_VALIDITY_DAYS_MAX,
  OFFER_VALIDITY_DAYS_MIN,
  findCompanyProfileTextLimitViolations,
  textInputMaxLength,
} from '../../services/company/companyProfileSettingsContract';
import { getLastPersistSuccess } from '../../services/persistenceService';
import type { TranslationKey } from '../../i18n';
import type { CompanyProfile } from '../../types/models';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.21, V-01) — „Dokumente und Zahlungen › Angebote und Aufträge“.
 *
 * Vorgaben für **neue** Angebote (Gültigkeit in Tagen 1–365, Standard 30; Einleitung und Schluss) und neue Aufträge
 * (Einleitung und Schluss). Bestehende Entwürfe und freigegebene Dokumente bleiben unverändert. Gespeichert wird über
 * den kanonischen Profilweg (Schema-3-Patch); der Server prüft dieselben Grenzen.
 */
export const OFFER_SETTINGS_ROUTE = SETTINGS_TARGET_PATHS.offers;

export const OFFER_SETTINGS_TEXT_FIELDS = ['offerIntroText', 'offerClosingText', 'orderIntroText', 'orderClosingText'] as const;
export const OFFER_SETTINGS_FIELDS = ['offerValidityDays', ...OFFER_SETTINGS_TEXT_FIELDS] as const;

export type OfferSettingsDraft = Record<(typeof OFFER_SETTINGS_FIELDS)[number], string>;

export function pickOfferSettings(profile: CompanyProfile): OfferSettingsDraft {
  return {
    offerValidityDays: profile.offerValidityDays !== undefined ? String(profile.offerValidityDays) : '',
    offerIntroText: profile.offerIntroText ?? '',
    offerClosingText: profile.offerClosingText ?? '',
    orderIntroText: profile.orderIntroText ?? '',
    orderClosingText: profile.orderClosingText ?? '',
  };
}

type FieldErrors = Partial<Record<string, TranslationKey>>;

/** Ganze Tage 1–365; leer heißt „Standard“ (Feld entfällt). Alles andere ist ein Fehler, nie eine Umdeutung. */
export function parseOfferValidityDays(text: string): { ok: true; value: number | undefined } | { ok: false } {
  const raw = text.trim();
  if (!raw) return { ok: true, value: undefined };
  if (!/^\d{1,3}$/.test(raw)) return { ok: false };
  const value = Number(raw);
  return value >= OFFER_VALIDITY_DAYS_MIN && value <= OFFER_VALIDITY_DAYS_MAX ? { ok: true, value } : { ok: false };
}

const TEXT_LABELS: Record<(typeof OFFER_SETTINGS_TEXT_FIELDS)[number], TranslationKey> = {
  offerIntroText: 'settings.offers.introText',
  offerClosingText: 'settings.offers.closingText',
  orderIntroText: 'settings.orders.introText',
  orderClosingText: 'settings.orders.closingText',
};

export function OfferSettingsPage() {
  const { companyProfile, updateCompanyProfile, translate, showToast } = useApp();
  const { access, canEdit: editable } = useSettingsAccess();
  const noticeVariant = resolveSettingsNoticeVariant(access);
  useFocusFieldFromHash();

  const resume = useFormResume<OfferSettingsDraft>({
    namespace: 'offerSettings',
    fields: OFFER_SETTINGS_FIELDS,
    saved: pickOfferSettings(companyProfile),
    workspaceType: 'other',
  });
  const [draft, setDraft] = useState<OfferSettingsDraft>(() => ({ ...pickOfferSettings(companyProfile), ...resume.restored }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  // EINRICHTUNG-01 (AP9; 1.30) — Speicherfehler als bleibender Hinweis an der Speicherleiste, nicht als Toast.
  const [saveError, setSaveError] = useState<TranslationKey | null>(null);
  resume.observe(draft);
  const baseRef = useProfileFormBase(companyProfile, pickOfferSettings, setDraft);

  const saved = pickOfferSettings(companyProfile);
  const dirty = OFFER_SETTINGS_FIELDS.some((key) => draft[key] !== saved[key]);

  const setField = (key: (typeof OFFER_SETTINGS_FIELDS)[number], value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const discard = () => {
    setDraft(pickOfferSettings(companyProfile));
    baseRef.current = pickOfferSettings(companyProfile);
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
      const changed = changedProfileFields(draft, baseRef.current);
      if (Object.keys(changed).length === 0) return;
      const nextErrors: FieldErrors = {};
      const payload: Partial<CompanyProfile> = {};
      if (changed.offerValidityDays !== undefined) {
        const parsed = parseOfferValidityDays(changed.offerValidityDays);
        if (!parsed.ok) nextErrors.offerValidityDays = 'companyProfile.offerValidityDaysInvalid';
        else payload.offerValidityDays = parsed.value;
      }
      for (const field of OFFER_SETTINGS_TEXT_FIELDS) {
        if (changed[field] !== undefined) payload[field] = changed[field];
      }
      for (const violation of findCompanyProfileTextLimitViolations(payload as Record<string, unknown>)) {
        nextErrors[violation.field] = violation.errorKey as TranslationKey;
      }
      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        return;
      }
      setErrors({});
      const result = updateCompanyProfile(payload);
      if (!result.success) {
        setSaveError(result.errorKey as TranslationKey);
        return;
      }
      setDraft(pickOfferSettings(result.profile));
      baseRef.current = pickOfferSettings(result.profile);
      resume.clearResume();
      if (!getLastPersistSuccess()) {
        setSaveError('persist.failed.userAction');
        return;
      }
      showToast(translate('settings.offers.saved'));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !editable || saving;
  const renderError = (key: string) =>
    errors[key] ? (
      <p className="form-error" id={`settings-offers-${key}-error`} data-testid={`settings-offers-${key}-error`}>
        {translate(errors[key]!)}
      </p>
    ) : null;

  const renderText = (key: (typeof OFFER_SETTINGS_TEXT_FIELDS)[number]) => (
    <div className="settings-form__field" key={key}>
      <label htmlFor={`settings-offers-${key}`}>{translate(TEXT_LABELS[key])}</label>
      <textarea
        id={`settings-offers-${key}`}
        name={key}
        className={`input settings-invoices__textarea${errors[key] ? ' input--error' : ''}`}
        rows={3}
        maxLength={textInputMaxLength(COMPANY_PROFILE_TEXT_LIMITS[key])}
        value={draft[key]}
        readOnly={!editable}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `settings-offers-${key}-error` : undefined}
        onChange={(event) => setField(key, event.target.value)}
        data-testid={`settings-offers-${key}`}
      />
      {renderError(key)}
    </div>
  );

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-offers-page">
      <SettingsPageHeader target="offers" subtitle={translate('settings.offers.page.subtitle')} />

      {!editable && noticeVariant ? (
        <SettingsAccessNotice variant={noticeVariant} testId="settings-offers-readonly" />
      ) : editable ? (
        <p className="hint-text" data-testid="settings-offers-historical-hint">
          {translate('settings.offers.historicalHint')}
        </p>
      ) : null}

      <form className="settings-form settings-offers" onSubmit={handleSubmit} noValidate>
        <fieldset className="form-group settings-form__section" data-testid="settings-offers-section-offer" disabled={disabled}>
          <legend className="settings-form__legend">{translate('settings.offers.section.offer')}</legend>
          <div className="settings-form__field settings-invoices__days">
            <label htmlFor="settings-offers-offerValidityDays">{translate('settings.offers.validityDays')}</label>
            <div className="settings-invoices__unit-row">
              <input
                id="settings-offers-offerValidityDays"
                name="offerValidityDays"
                type="text"
                inputMode="numeric"
                className={`input settings-invoices__number${errors.offerValidityDays ? ' input--error' : ''}`}
                value={draft.offerValidityDays}
                placeholder={String(DEFAULT_OFFER_VALIDITY_DAYS)}
                maxLength={6}
                readOnly={!editable}
                aria-invalid={errors.offerValidityDays ? true : undefined}
                aria-describedby={errors.offerValidityDays ? 'settings-offers-offerValidityDays-error' : 'settings-offers-offerValidityDays-hint'}
                onChange={(event) => setField('offerValidityDays', event.target.value)}
                data-testid="settings-offers-offerValidityDays"
              />
              <span className="settings-invoices__unit">{translate('settings.invoices.days')}</span>
            </div>
            <p className="form-hint" id="settings-offers-offerValidityDays-hint">
              {translate('settings.offers.validityDays.hint')}
            </p>
            {renderError('offerValidityDays')}
          </div>
          {renderText('offerIntroText')}
          {renderText('offerClosingText')}
        </fieldset>

        <fieldset className="form-group settings-form__section" data-testid="settings-offers-section-order" disabled={disabled}>
          <legend className="settings-form__legend">{translate('settings.offers.section.order')}</legend>
          {renderText('orderIntroText')}
          {renderText('orderClosingText')}
        </fieldset>

        <p className="form-hint">{translate('settings.offers.texts.hint')}</p>

        {editable ? <SettingsSaveBar dirty={dirty} saving={saving} onDiscard={discard} testIdPrefix="settings-offers" draftKept error={saveError ? translate(saveError) : null} /> : null}
      </form>
    </div>
  );
}
