import { useState } from 'react';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
import { getCachedSetup } from '../services/persistenceService';
import { t } from '../i18n';

/**
 * EINRICHTUNG-01 (AP2; A-01.1, A-10.2) — angemeldet, aber das Profil ließ sich gerade nicht laden und es gibt keinen
 * bestätigten Zwischenstand. Das ist keine Abmeldung: Die Sitzung bleibt, die App versucht es automatisch erneut. Keine
 * Daten werden gezeigt, weil Konto und Rechte noch nicht feststehen.
 */
export function ProfileUnavailablePage() {
  const { retryProfile, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const lang = getCachedSetup()?.language ?? 'de';
  return (
    <AuthLayout
      title={t('auth.profileUnavailable.title', lang)}
      subtitle={t('auth.profileUnavailable.body', lang)}
      testId="profile-unavailable-page"
    >
      <div className="auth-info">
        <Button
          type="button"
          fullWidth
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void retryProfile().finally(() => setBusy(false));
          }}
          data-testid="profile-unavailable-retry"
        >
          {t('auth.connection.retry', lang)}
        </Button>
        <Button type="button" variant="outline" fullWidth onClick={() => void logout()} data-testid="profile-unavailable-logout">
          {t('auth.logout.action', lang)}
        </Button>
      </div>
    </AuthLayout>
  );
}
