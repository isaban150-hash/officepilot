import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import type { CompanyProfile } from '../types/models';
import type { TranslationKey } from '../i18n';

type ProfileField = keyof CompanyProfile;

const TEXT_FIELDS: { key: ProfileField; labelKey: TranslationKey; type?: string }[] = [
  { key: 'companyName', labelKey: 'companyProfile.companyName' },
  { key: 'legalForm', labelKey: 'companyProfile.legalForm' },
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
  { key: 'defaultSkonto', labelKey: 'companyProfile.defaultSkonto' },
];

export function FirmendatenPage() {
  const { companyProfile, updateCompanyProfile, translate, showToast } = useApp();
  const [draft, setDraft] = useState<CompanyProfile>(() => ({ ...companyProfile }));
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const handleChange = (key: ProfileField, value: string | number) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setErrorKey(null);
    const result = updateCompanyProfile(draft);
    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }
    setDraft({ ...result.profile });
    showToast(translate('companyProfile.saved'));
  };

  return (
    <div className="page">
      <Link to="/eingang" className="back-link">
        ← {translate('common.back')}
      </Link>

      <PageHeader
        title={translate('companyProfile.title')}
        subtitle={translate('companyProfile.subtitle')}
      />

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
