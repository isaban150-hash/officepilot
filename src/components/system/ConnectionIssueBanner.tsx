import { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useOptionalAuth } from '../../context/AuthContext';

/**
 * EINRICHTUNG-01 (AP2; A-01.1, A-02, N-A2.5; Vertrag 1.11) — die App läuft auf dem zuletzt bestätigten Profil.
 *
 * Die Anmeldung bleibt bestehen. Der Hinweis sagt, was das bedeutet: Änderungen werden auf dem Gerät gespeichert und
 * später übertragen; Zahlungen, Freigaben und Versand sind gesperrt, weil die Rechte dafür gerade nicht bestätigt sind.
 */
export function ConnectionIssueBanner() {
  const { translate } = useApp();
  const auth = useOptionalAuth();
  const [busy, setBusy] = useState(false);
  if (!auth || auth.profileConfirmed || !auth.user) return null;
  return (
    <div className="persistence-failure-banner workspace-read-only-banner" role="status" data-testid="connection-issue-banner">
      <p className="persistence-failure-banner__text">{translate('auth.connection.banner')}</p>
      <button
        type="button"
        className="persistence-failure-banner__link"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void auth.retryProfile().finally(() => setBusy(false));
        }}
        data-testid="connection-issue-retry"
      >
        {translate('auth.connection.retry')}
      </button>
    </div>
  );
}
