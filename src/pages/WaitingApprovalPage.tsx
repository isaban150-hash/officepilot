import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { AuthLayout } from '../components/auth/AuthLayout';
import { useAuth } from '../context/AuthContext';
import { useAuthPageText } from '../hooks/useAuthPageText';
import { WAITING_ACCOUNT_DELETE_ROUTE } from './settings/AccountDeletePage';
import { getPostLoginRoute } from '../services/auth/authService';
import { PendingInvitationsPanel } from '../components/team/PendingInvitationsPanel';

/** EINRICHTUNG-01 (AP2, A-15.1) — Abstand der automatischen Prüfung auf Freischaltung. */
export const WAITING_APPROVAL_POLL_MS = 30_000;

export function WaitingApprovalPage() {
  const { logout, user, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  const userId = user?.id ?? null;
  // Die Warteseite erscheint auch ohne AppProvider (Tests der Anmeldewege); dann aus der Kontosprache übersetzen.
  // EINRICHTUNG-01 (AP9; 1.31) — alle Texte der Seite aus den Sprachdateien.
  const { language, text } = useAuthPageText(userId);

  /*
   * EINRICHTUNG-01 (AP2, A-15) — sofort und dann alle 30 s prüfen, solange genau dieses Konto wartet. Abmelden oder
   * ein Kontowechsel beenden die Abfrage (die Seite verlässt die Route bzw. die Konto-ID wechselt).
   */
  useEffect(() => {
    if (!userId) return undefined;
    void refreshAuth();
    const timer = setInterval(() => {
      void refreshAuth();
    }, WAITING_APPROVAL_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshAuth, userId]);

  useEffect(() => {
    if (user && user.status !== 'pending') {
      navigate(getPostLoginRoute(user), { replace: true });
    }
  }, [user, navigate]);

  return (
    <AuthLayout
      language={language}
      title={text('auth.waitingApproval.title')}
      subtitle={text('auth.waitingApproval.subtitle')}
      testId="waiting-approval-page"
    >
      <div className="auth-info">
        {user ? (
          <p data-testid="waiting-approval-email">
            <strong>{user.firstName} {user.lastName}</strong> ({user.email})
          </p>
        ) : null}
        <p>{text('auth.waitingApproval.info')}</p>
        {/*
          * EINRICHTUNG-01 (AP4; Vertrag 1.5, M-03.4, M-07.1) — eine Einladung an die bestätigte E-Mail gibt auch einem
          * wartenden Konto den Weg in den Betrieb: Mit der Annahme wird es freigegeben (Weg C).
          */}
        <PendingInvitationsPanel
          userId={userId}
          language={language}
          hideWhenEmpty
          testId="waiting-approval-invitations"
        />
        <Button
          fullWidth
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void refreshAuth().finally(() => setChecking(false));
          }}
          data-testid="waiting-approval-recheck"
        >
          {text('auth.waitingApproval.recheck')}
        </Button>
        <Button variant="outline" fullWidth onClick={() => void logout()} data-testid="waiting-approval-logout">
          {text('auth.logout.action')}
        </Button>
        {/* EINRICHTUNG-01 (AP7; 1.25, L-01.6) — auch ein wartendes Konto kann sich selbst löschen. */}
        <p className="auth-form__links">
          <Link to={WAITING_ACCOUNT_DELETE_ROUTE} data-testid="waiting-approval-delete-account">
            {text('accountDelete.waiting.link')}
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
