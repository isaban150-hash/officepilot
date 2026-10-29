import { useApp } from '../../context/AppContext';
import type { ProductLanguage } from '../../i18n/types';
import type { AppLanguage } from '../../types/models';
import { t, type TranslationKey } from '../../i18n';
import { Card, CardTitle } from '../ui/Card';

const PRODUCT_LANGUAGE_OPTIONS: { value: ProductLanguage; labelKey: TranslationKey }[] = [
  { value: 'de', labelKey: 'language.de' },
  { value: 'tr', labelKey: 'language.tr' },
  { value: 'bg', labelKey: 'language.bg' },
];

const PREVIEW_LANGUAGE_OPTIONS: { value: AppLanguage; labelKey: TranslationKey }[] = [
  { value: 'ro', labelKey: 'language.ro' },
  { value: 'ru', labelKey: 'language.ru' },
];

interface LanguageSwitcherProps {
  testId?: string;
}

export function LanguageSwitcher({ testId = 'language-switcher' }: LanguageSwitcherProps) {
  const { translate, language, updateLanguage, showToast } = useApp();

  const handleChange = (next: AppLanguage) => {
    if (next === language) return;
    // EINRICHTUNG-01 (E6, S-15.3) — im Cloud-Betrieb je Person, ohne Firmen-Schreibauftrag.
    updateLanguage(next);
    // App-Eigenprüfung (N-09) — die Bestätigung in der gewählten Sprache; `translate` gehört noch zur bisherigen.
    showToast(t('language.saved', next));
  };

  return (
    <Card className="language-switcher" data-testid={testId}>
      <CardTitle>{translate('language.title')}</CardTitle>
      <p className="language-switcher__subtitle">{translate('language.subtitle')}</p>
      <p className="language-switcher__current">
        {translate('language.current').replace(
          '{language}',
          translate(`language.${language}` as TranslationKey),
        )}
      </p>
      <div className="chip-group language-switcher__chips" role="group" aria-label={translate('language.title')}>
        {PRODUCT_LANGUAGE_OPTIONS.map(({ value, labelKey }) => (
          <button
            key={value}
            type="button"
            className={`chip ${language === value ? 'chip--active' : ''}`}
            aria-pressed={language === value}
            onClick={() => handleChange(value)}
            data-testid={`language-option-${value}`}
          >
            {translate(labelKey)}
          </button>
        ))}
      </div>
      <details className="language-switcher__preview">
        <summary>{translate('language.previewNotice')}</summary>
        <div className="chip-group language-switcher__chips" role="group" aria-label={translate('language.previewNotice')}>
          {PREVIEW_LANGUAGE_OPTIONS.map(({ value, labelKey }) => (
            <button
              key={value}
              type="button"
              className={`chip ${language === value ? 'chip--active' : ''}`}
              aria-pressed={language === value}
              onClick={() => handleChange(value)}
              data-testid={`language-option-${value}`}
            >
              {translate(labelKey)}
            </button>
          ))}
        </div>
      </details>
    </Card>
  );
}
