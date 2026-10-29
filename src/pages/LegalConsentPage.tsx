import { useState } from 'react';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
import { acceptCurrentLegalTerms } from '../services/auth/legalConsentService';
import { getCachedSetup } from '../services/persistenceService';
import { readPersonalUiLanguage } from '../services/auth/personalUiLanguage';
import { t } from '../i18n';

/**
 * EINRICHTUNG-01 (AP2, EIN-19; A-13.2, A-13.3, A-14.1, A-14.2) — Zustimmung zur geltenden Fassung der Rechtstexte.
 *
 * Erscheint, wenn die Zustimmung fehlt, unvollständig ist oder eine neue Fassung gilt — vor Betrieb, Bootstrap und
 * Abgleich. „Zustimmen“ speichert Fassung und Serverzeit für genau dieses Konto; „Ablehnen“ meldet ab.
 */
export function LegalConsentPage() {
  const { user, refreshAuth, logout } = useAuth();
  const lang = readPersonalUiLanguage(user?.id ?? null) ?? getCachedSetup()?.language ?? 'de';
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [license, setLicense] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (!user || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await acceptCurrentLegalTerms(user.id);
      if (outcome === 'ok') {
        await refreshAuth();
        return;
      }
      setError(t(outcome === 'session' ? 'auth.logoutReason.sessionInvalid' : outcome === 'blocked' ? 'auth.error.userBlocked' : 'auth.error.unknown', lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('legalConsent.title', lang)} subtitle={t('legalConsent.subtitle', lang)} testId="legal-consent-page">
      <div className="auth-form">
        {error ? (
          <p className="auth-form__error" role="alert" data-testid="legal-consent-error">
            {error}
          </p>
        ) : null}
        <label className="auth-form__checkbox">
          <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} data-testid="legal-consent-terms" />
          <span>
            {t('legalConsent.terms', lang)} (<a href="/agb" target="_blank" rel="noopener noreferrer">{t('legalConsent.read', lang)}</a>)
          </span>
        </label>
        <label className="auth-form__checkbox">
          <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} data-testid="legal-consent-privacy" />
          <span>
            {t('legalConsent.privacy', lang)} (<a href="/datenschutz" target="_blank" rel="noopener noreferrer">{t('legalConsent.read', lang)}</a>)
          </span>
        </label>
        <label className="auth-form__checkbox">
          <input type="checkbox" checked={license} onChange={(e) => setLicense(e.target.checked)} data-testid="legal-consent-license" />
          <span>
            {t('legalConsent.license', lang)} (<a href="/lizenzbedingungen" target="_blank" rel="noopener noreferrer">{t('legalConsent.read', lang)}</a>)
          </span>
        </label>
        <Button
          type="button"
          fullWidth
          disabled={busy || !terms || !privacy || !license}
          onClick={() => void accept()}
          data-testid="legal-consent-accept"
        >
          {t('legalConsent.accept', lang)}
        </Button>
        <Button type="button" variant="outline" fullWidth disabled={busy} onClick={() => void logout()} data-testid="legal-consent-decline">
          {t('legalConsent.decline', lang)}
        </Button>
      </div>
    </AuthLayout>
  );
}
