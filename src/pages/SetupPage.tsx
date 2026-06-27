import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { INDUSTRY_OPTIONS } from '../data/mockData';
import type { AppLanguage, MaterialStandard, TaxStatus } from '../types/models';

const LANGUAGES: { value: AppLanguage; labelKey: 'lang.de' | 'lang.tr' | 'lang.bg' | 'lang.ro' | 'lang.ru' }[] = [
  { value: 'de', labelKey: 'lang.de' },
  { value: 'tr', labelKey: 'lang.tr' },
  { value: 'bg', labelKey: 'lang.bg' },
  { value: 'ro', labelKey: 'lang.ro' },
  { value: 'ru', labelKey: 'lang.ru' },
];

const TAX_OPTIONS: { value: TaxStatus; labelKey: 'tax.standard_19' | 'tax.kleinunternehmer_19' | 'tax.reverse_charge_13b' | 'tax.unclear' }[] = [
  { value: 'standard_19', labelKey: 'tax.standard_19' },
  { value: 'kleinunternehmer_19', labelKey: 'tax.kleinunternehmer_19' },
  { value: 'reverse_charge_13b', labelKey: 'tax.reverse_charge_13b' },
  { value: 'unclear', labelKey: 'tax.unclear' },
];

const MATERIAL_OPTIONS: { value: MaterialStandard; labelKey: 'material.auftraggeber' | 'material.betrieb' | 'material.gemischt' | 'material.unclear' }[] = [
  { value: 'auftraggeber', labelKey: 'material.auftraggeber' },
  { value: 'betrieb', labelKey: 'material.betrieb' },
  { value: 'gemischt', labelKey: 'material.gemischt' },
  { value: 'unclear', labelKey: 'material.unclear' },
];

export function SetupPage() {
  const { setup, updateSetup, completeSetup, translate } = useApp();
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState(setup.companyName);
  const [industry, setIndustry] = useState(setup.industry || INDUSTRY_OPTIONS[0]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) return;
    updateSetup({ companyName: companyName.trim(), industry });
    completeSetup();
    navigate('/eingang');
  };

  return (
    <div className="setup-page">
      <PageHeader title={translate('setup.title')} subtitle={translate('setup.subtitle')} />

      <form className="setup-form" onSubmit={handleSubmit}>
        <fieldset className="form-group">
          <label htmlFor="language">{translate('setup.language')}</label>
          <div className="chip-group">
            {LANGUAGES.map(({ value, labelKey }) => (
              <button
                key={value}
                type="button"
                className={`chip ${setup.language === value ? 'chip--active' : ''}`}
                onClick={() => updateSetup({ language: value })}
              >
                {translate(labelKey)}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="form-group">
          <label htmlFor="companyName">{translate('setup.companyName')}</label>
          <input
            id="companyName"
            type="text"
            className="input"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder={translate('setup.companyNamePlaceholder')}
            required
          />
        </fieldset>

        <fieldset className="form-group">
          <label htmlFor="industry">{translate('setup.industry')}</label>
          <select
            id="industry"
            className="select"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
          >
            {INDUSTRY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </fieldset>

        <fieldset className="form-group">
          <legend>{translate('setup.taxStatus')}</legend>
          <div className="radio-group">
            {TAX_OPTIONS.map(({ value, labelKey }) => (
              <label key={value} className="radio-label">
                <input
                  type="radio"
                  name="taxStatus"
                  value={value}
                  checked={setup.taxStatus === value}
                  onChange={() => updateSetup({ taxStatus: value })}
                />
                {translate(labelKey)}
              </label>
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
                  value={value}
                  checked={setup.materialStandard === value}
                  onChange={() => updateSetup({ materialStandard: value })}
                />
                {translate(labelKey)}
              </label>
            ))}
          </div>
        </fieldset>

        <Button type="submit" fullWidth disabled={!companyName.trim()}>
          {translate('setup.start')}
        </Button>
      </form>
    </div>
  );
}
