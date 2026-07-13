import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { LanguageSwitcher } from '../components/settings/LanguageSwitcher';
import { useApp } from '../context/AppContext';
import { buildSkontoText } from '../services/invoiceTaxService';
import { validateCompanyProfileForSettings } from '../services/setupValidationService';
import { getInvoiceNumberSequenceSnapshot } from '../services/invoiceNumberService';
import type { CompanyProfile } from '../types/models';
import type { TranslationKey } from '../i18n';

type ProfileField = keyof CompanyProfile;

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

export function FirmendatenPage() {
  const { companyProfile, updateCompanyProfile, translate, showToast } = useApp();
  const [draft, setDraft] = useState<CompanyProfile>(() => ({ ...companyProfile }));
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const handleChange = (key: ProfileField, value: string | number | boolean) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'skontoEnabled' || key === 'skontoPercent' || key === 'skontoDays') {
        next.defaultSkonto = buildSkontoText(next);
      }
      return next;
    });
  };

  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        handleChange('logoDataUrl', reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setErrorKey(null);

    const payload = {
      ...draft,
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

      <form className="company-profile-form" onSubmit={handleSubmit}>
        {TEXT_FIELDS.map(({ key, labelKey, type = 'text' }) => (
          <fieldset key={key} className="form-group">
            <label htmlFor={`profile-${key}`}>{translate(labelKey)}</label>
            <input
              id={`profile-${key}`}
              type={type}
              className="input"
              value={String(draft[key] ?? '')}
              onChange={(e) => handleChange(key, e.target.value)}
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
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="input"
            onChange={handleLogoUpload}
          />
          {draft.logoDataUrl && (
            <img
              src={draft.logoDataUrl}
              alt=""
              className="company-profile-form__logo-preview"
              data-testid="company-logo-preview"
            />
          )}
          <label htmlFor="profile-logo">{translate('companyProfile.logoDataUrl')}</label>
          <input
            id="profile-logo"
            type="text"
            className="input"
            placeholder={translate('companyProfile.logoPlaceholder')}
            value={draft.logoDataUrl ?? ''}
            onChange={(e) => handleChange('logoDataUrl', e.target.value)}
          />
        </fieldset>

        {errorKey && <p className="form-error">{translate(errorKey)}</p>}

        <Button type="submit" fullWidth>
          {translate('common.save')}
        </Button>
      </form>
    </div>
  );
}
