import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
import { getCachedSetup } from '../services/persistenceService';
import { readPersonalUiLanguage } from '../services/auth/personalUiLanguage';
import {
  acceptInvitation,
  declineInvitation,
  previewInvitation,
  selectActiveWorkspace,
  type InvitationPreview,
} from '../services/team/teamService';
import { clearWorkspaceRevoked, rebindWorkspace } from '../services/workspace/workspaceMembershipChangeService';
import { failureText, t, type ShownFailure, type TranslationKey } from '../i18n';

/**
 * EINRICHTUNG-01 (AP4; Vertrag 1.5, Weg C; M-03, M-04, M-05, M-07) — `/einladung/:token`.
 *
 * Ohne Anmeldung: Anmelden oder Registrieren mit der eingeladenen Adresse (vorbelegt aus dem Link), danach zurück auf
 * diese Seite. Angemeldet (auch wartend): Einladung ansehen, annehmen oder ablehnen. Die Antworten verraten weder
 * Existenz noch Betrieb einer fremden Einladung („Einladung ungültig“). Nach der Annahme bindet die App neu.
 */
export function InvitationPage() {
  const { token = '' } = useParams<{ token: string }>();
  const location = useLocation();
  const { user, isAuthenticated } = useAuth();
  const language = readPersonalUiLanguage(user?.id ?? null) ?? getCachedSetup()?.language ?? 'de';
  const prefillEmail = new URLSearchParams(location.search).get('email') ?? '';
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [failure, setFailure] = useState<ShownFailure | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !token) return;
    let active = true;
    setChecking(true);
    void previewInvitation(token).then((result) => {
      if (!active) return;
      setChecking(false);
      if (result.ok) {
        setPreview(result.value);
        setFailure(null);
      } else {
        setPreview(null);
        setFailure({ errorKey: result.errorKey, ref: result.ref });
      }
    });
    return () => {
      active = false;
    };
  }, [isAuthenticated, token]);

  const next = `/einladung/${encodeURIComponent(token)}${prefillEmail ? `?email=${encodeURIComponent(prefillEmail)}` : ''}`;
  const authQuery = `?next=${encodeURIComponent(next)}${prefillEmail ? `&email=${encodeURIComponent(prefillEmail)}` : ''}`;

  if (!isAuthenticated) {
    return (
      <AuthLayout title={t('invitation.title', language)} subtitle={t('invitation.loginRequired', language)} testId="invitation-page">
        <div className="auth-form" data-testid="invitation-login-required">
          <Link to={`/login${authQuery}`} className="btn btn--primary btn--full" data-testid="invitation-login">
            {t('invitation.login', language)}
          </Link>
          <Link to={`/register${authQuery}`} className="btn btn--outline btn--full" data-testid="invitation-register">
            {t('invitation.register', language)}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  const accept = async () => {
    if (!preview || busy) return;
    setBusy(true);
    const result = await acceptInvitation({ token });
    if (!result.ok) {
      setBusy(false);
      setFailure({ errorKey: result.errorKey, ref: result.ref });
      setPreview(null);
      return;
    }
    await selectActiveWorkspace(result.value.workspaceId);
    if (user?.id) clearWorkspaceRevoked(user.id, result.value.workspaceId);
    rebindWorkspace({ userId: user?.id, notice: { kind: 'accepted', workspaceName: preview.workspaceName } });
  };

  const decline = async () => {
    if (!preview || busy) return;
    setBusy(true);
    const result = await declineInvitation({ token });
    setBusy(false);
    if (!result.ok) {
      setFailure({ errorKey: result.errorKey, ref: result.ref });
      return;
    }
    setPreview(null);
    setDeclined(true);
  };

  return (
    <AuthLayout title={t('invitation.title', language)} subtitle="" testId="invitation-page">
      <div className="auth-form">
        {checking ? <p data-testid="invitation-checking">{t('invitation.checking', language)}</p> : null}
        {failure ? (
          <p className="auth-form__error" role="alert" data-testid="invitation-error">
            {failureText(language, failure)}
          </p>
        ) : null}
        {declined ? (
          <p className="auth-form__success" role="status" data-testid="invitation-declined">
            {t('invitation.declined', language)}
          </p>
        ) : null}
        {preview ? (
          <div data-testid="invitation-preview">
            <p>
              {preview.inviterName
                ? t('invitation.from', language, {
                    inviter: preview.inviterName,
                    workspace: preview.workspaceName,
                    role: t(`team.role.${preview.role}` as TranslationKey, language),
                  })
                : t('invitation.fromUnknown', language, {
                    workspace: preview.workspaceName,
                    role: t(`team.role.${preview.role}` as TranslationKey, language),
                  })}
            </p>
            <p className="hint-text">
              {t('invitation.expires', language, { date: new Date(preview.expiresAt).toLocaleDateString(language === 'de' ? 'de-DE' : language) })}
            </p>
            <Button type="button" fullWidth disabled={busy} onClick={() => void accept()} data-testid="invitation-accept">
              {t('invitation.accept', language)}
            </Button>
            <Button type="button" variant="outline" fullWidth disabled={busy} onClick={() => void decline()} data-testid="invitation-decline">
              {t('invitation.decline', language)}
            </Button>
          </div>
        ) : null}
        <Link to="/" className="btn btn--ghost btn--full" data-testid="invitation-home">
          {t('invitation.backHome', language)}
        </Link>
      </div>
    </AuthLayout>
  );
}
