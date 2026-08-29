import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { LanguageSwitcher } from '../components/settings/LanguageSwitcher';
import { BackupExportPanel } from '../components/settings/BackupExportPanel';
import { PilotHintsPanel } from '../components/settings/PilotHintsPanel';
import { useApp } from '../context/AppContext';
import { getLastPersistSuccess } from '../services/persistenceService';
import { BACKUP_SECTION_ID } from '../services/backupSectionNavigation';
import { buildSkontoText } from '../services/invoiceTaxService';
import { validateCompanyProfileForSettings } from '../services/setupValidationService';
import { getInvoiceNumberSequenceSnapshot } from '../services/invoiceNumberService';
import {
  validateBrandingLogoFile,
  type BrandingLogoValidationError,
} from '../services/branding/brandingLogoValidation';
import type { CompanyProfile } from '../types/models';
import type { TranslationKey } from '../i18n';

type ProfileField = keyof CompanyProfile;

/** Fehlercodes des Validators werden hier — und nur hier — zu Nutzertexten. */
const LOGO_ERROR_KEYS: Record<BrandingLogoValidationError, TranslationKey> = {
  file_too_large: 'companyProfile.logoError.tooLarge',
  unsupported_mime: 'companyProfile.logoError.unsupportedType',
  signature_mismatch: 'companyProfile.logoError.contentMismatch',
  invalid_file: 'companyProfile.logoError.unreadable',
};

const TEXT_FIELDS: { key: ProfileField; labelKey: TranslationKey; type?: string }[] = [
  { key: 'companyName', labelKey: 'companyProfile.companyName' },
  { key: 'legalForm', labelKey: 'companyProfile.legalForm' },
  { key: 'managingDirector', labelKey: 'companyProfile.managingDirector' },
  { key: 'street', labelKey: 'companyProfile.street' },
  { key: 'zip', labelKey: 'companyProfile.zip' },
  { key: 'city', labelKey: 'companyProfile.city' },
  { key: 'country', labelKey: 'companyProfile.country' },
  { key: 'contactPerson', labelKey: 'companyProfile.contactPerson' },
  { key: 'phone', labelKey: 'companyProfile.phone', type: 'tel' },
  { key: 'email', labelKey: 'companyProfile.email', type: 'email' },
  { key: 'website', labelKey: 'companyProfile.website', type: 'url' },
  { key: 'taxNumber', labelKey: 'companyProfile.taxNumber' },
  { key: 'vatId', labelKey: 'companyProfile.vatId' },
  { key: 'bankName', labelKey: 'companyProfile.bankName' },
  { key: 'iban', labelKey: 'companyProfile.iban' },
  { key: 'bic', labelKey: 'companyProfile.bic' },
  { key: 'defaultPaymentTerms', labelKey: 'companyProfile.defaultPaymentTerms' },
  { key: 'taxFreeNotice', labelKey: 'companyProfile.taxFreeNotice' },
];

function focusBackupSection(): void {
  const el = document.getElementById(BACKUP_SECTION_ID);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (typeof el.focus === 'function') {
    el.focus({ preventScroll: true });
  }
}

export function FirmendatenPage() {
  const { companyProfile, updateCompanyProfile, translate, showToast } = useApp();
  const location = useLocation();
  const [draft, setDraft] = useState<CompanyProfile>(() => ({ ...companyProfile }));
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  /*
   * Eigener Zustand: Ein Logo-Fehler darf einen offenen Firmendaten- oder
   * IBAN-Fehler nicht überschreiben — und umgekehrt.
   */
  const [logoErrorKey, setLogoErrorKey] = useState<TranslationKey | null>(null);

  useEffect(() => {
    if (location.hash !== `#${BACKUP_SECTION_ID}`) return;
    const frame = window.requestAnimationFrame(() => {
      focusBackupSection();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, location.key]);

  const handleChange = (key: ProfileField, value: string | number | boolean) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'skontoEnabled' || key === 'skontoPercent' || key === 'skontoDays') {
        next.defaultSkonto = buildSkontoText(next);
      }
      return next;
    });
  };

  /**
   * BRANDING-01C — geprüft wird vor dem Lesen, nicht danach.
   *
   * Die Datei wird erst vollständig eingelesen, wenn Grösse, Typ und
   * tatsächliche Anfangsbytes stimmen. Scheitert etwas, bleibt der Entwurf
   * unangetastet: kein neues Logo, keine halbe Vorschau, nichts Gespeichertes.
   * Persistiert wird ohnehin erst beim Absenden des Formulars.
   */
  const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0] ?? null;
    setLogoErrorKey(null);
    if (!file) return;

    const validation = await validateBrandingLogoFile(file);
    if (!validation.valid) {
      setLogoErrorKey(LOGO_ERROR_KEYS[validation.error]);
      // Dieselbe Datei soll erneut auswählbar sein.
      input.value = '';
      return;
    }

    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });

    if (dataUrl === null) {
      setLogoErrorKey('companyProfile.logoError.unreadable');
      input.value = '';
      return;
    }

    handleChange('logoDataUrl', dataUrl);
  };

  const handleLogoRemove = () => {
    setLogoErrorKey(null);
    handleChange('logoDataUrl', '');
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorKey(null);

    // Browsers may autofill IBAN into the DOM without firing onChange, so
    // React draft.iban can stay empty while the field still looks filled.
    const ibanField = event.currentTarget.elements.namedItem('iban');
    const ibanFromDom =
      ibanField instanceof HTMLInputElement ? ibanField.value : undefined;
    const iban = (ibanFromDom ?? draft.iban ?? '').toString();

    const payload = {
      ...draft,
      iban,
      defaultSkonto: draft.skontoEnabled ? buildSkontoText(draft) : '',
    };

    const validation = validateCompanyProfileForSettings(
      payload,
      getInvoiceNumberSequenceSnapshot().lastIssuedNumber,
    );
    if (!validation.valid) {
      const firstError = Object.values(validation.errors)[0];
      if (firstError) setErrorKey(firstError);
      return;
    }

    const result = updateCompanyProfile(payload);
    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }
    setDraft({ ...result.profile });
    if (!getLastPersistSuccess()) {
      showToast(translate('persist.failed.userAction'));
      return;
    }
    showToast(translate('companyProfile.saved'));
  };

  return (
    <div className="page">
      <Link to="/" className="back-link">
        ← {translate('common.back')}
      </Link>

      <PageHeader
        title={translate('companyProfile.title')}
        subtitle={translate('companyProfile.subtitle')}
      />

      <LanguageSwitcher />

      <PilotHintsPanel />

      <BackupExportPanel />

      <form className="company-profile-form" onSubmit={handleSubmit}>
        {TEXT_FIELDS.map(({ key, labelKey, type = 'text' }) => (
          <fieldset key={key} className="form-group">
            <label htmlFor={`profile-${key}`}>{translate(labelKey)}</label>
            <input
              id={`profile-${key}`}
              name={key}
              type={type}
              className="input"
              value={String(draft[key] ?? '')}
              onChange={(e) => handleChange(key, e.target.value)}
              autoComplete={key === 'iban' ? 'off' : undefined}
              required={key === 'companyName'}
            />
          </fieldset>
        ))}

        <fieldset className="form-group">
          <label htmlFor="profile-payment-days">{translate('companyProfile.defaultPaymentDays')}</label>
          <input
            id="profile-payment-days"
            type="number"
            min="0"
            className="input"
            value={draft.defaultPaymentDays}
            onChange={(e) => handleChange('defaultPaymentDays', Number(e.target.value) || 0)}
          />
        </fieldset>

        <fieldset className="form-group company-profile-form__skonto">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(draft.skontoEnabled)}
              onChange={(e) => handleChange('skontoEnabled', e.target.checked)}
            />
            {translate('companyProfile.skontoEnabled')}
          </label>
          {draft.skontoEnabled && (
            <div className="form-row">
              <div>
                <label htmlFor="profile-skonto-percent">{translate('companyProfile.skontoPercent')}</label>
                <input
                  id="profile-skonto-percent"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  className="input"
                  value={draft.skontoPercent ?? 0}
                  onChange={(e) => handleChange('skontoPercent', Number(e.target.value) || 0)}
                />
              </div>
              <div>
                <label htmlFor="profile-skonto-days">{translate('companyProfile.skontoDays')}</label>
                <input
                  id="profile-skonto-days"
                  type="number"
                  min="1"
                  className="input"
                  value={draft.skontoDays ?? 0}
                  onChange={(e) => handleChange('skontoDays', Number(e.target.value) || 0)}
                />
              </div>
            </div>
          )}
          {draft.skontoEnabled && buildSkontoText(draft) && (
            <p className="hint-text">{buildSkontoText(draft)}</p>
          )}
        </fieldset>

        <fieldset className="form-group">
          <label htmlFor="profile-footer">{translate('companyProfile.invoiceFooterNotes')}</label>
          <textarea
            id="profile-footer"
            className="input company-profile-form__textarea"
            rows={3}
            value={draft.invoiceFooterNotes}
            onChange={(e) => handleChange('invoiceFooterNotes', e.target.value)}
          />
        </fieldset>

        <fieldset className="form-group">
          <label htmlFor="profile-logo-file">{translate('companyProfile.logoUpload')}</label>
          <input
            id="profile-logo-file"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="input"
            onChange={handleLogoUpload}
          />
          <p className="hint-text">{translate('companyProfile.logoHint')}</p>
          {logoErrorKey && (
            <p className="form-error" data-testid="company-logo-error">
              {translate(logoErrorKey)}
            </p>
          )}
          {draft.logoDataUrl && (
            <>
              <img
                src={draft.logoDataUrl}
                alt=""
                className="company-profile-form__logo-preview"
                data-testid="company-logo-preview"
              />
              {/*
                * Das frühere Freitextfeld war der einzige Weg, ein Logo wieder
                * loszuwerden — und zugleich ein Weg, jede Prüfung zu umgehen.
                * Es entfällt; das Entfernen bleibt als eigene Schaltfläche.
                * Wirksam wird es wie jede andere Änderung erst beim Speichern.
                */}
              <Button
                type="button"
                variant="outline"
                onClick={handleLogoRemove}
                data-testid="company-logo-remove"
              >
                {translate('companyProfile.logoRemove')}
              </Button>
            </>
          )}
        </fieldset>

        {errorKey && <p className="form-error">{translate(errorKey)}</p>}

        <Button type="submit" fullWidth>
          {translate('common.save')}
        </Button>
      </form>
    </div>
  );
}
