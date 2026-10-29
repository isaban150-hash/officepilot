import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import {
  acceptInvitation,
  declineInvitation,
  listMyInvitations,
  selectActiveWorkspace,
  type MyInvitation,
} from '../../services/team/teamService';
import { clearWorkspaceRevoked, rebindWorkspace } from '../../services/workspace/workspaceMembershipChangeService';
import { failureText, t, type ShownFailure, type TranslationKey } from '../../i18n';
import type { AppLanguage } from '../../types/models';

interface PendingInvitationsPanelProps {
  userId: string | null;
  language: AppLanguage;
  /** Nach einer Ablehnung: die Einrichtung bzw. Bindung erneut prüfen (z. B. eigener Betrieb mit Lizenz). */
  onDeclined?: () => void;
  /** Ohne offene Einladung nichts anzeigen (Banner in der App). */
  hideWhenEmpty?: boolean;
  testId?: string;
}

/**
 * EINRICHTUNG-01 (AP4; Vertrag 1.5, M-07.1, M-07.3, M-13.1) — offene Einladungen an die eigene bestätigte E-Mail mit
 * Annehmen und Ablehnen; keine automatische Annahme. Nach der Annahme wird der Betrieb der Einladung der aktive Betrieb
 * (Betriebswahl) und die App bindet neu.
 */
export function PendingInvitationsPanel({ userId, language, onDeclined, hideWhenEmpty = false, testId = 'pending-invitations' }: PendingInvitationsPanelProps) {
  const [items, setItems] = useState<MyInvitation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ShownFailure | null>(null);
  const [declined, setDeclined] = useState(false);

  const load = useCallback(async () => {
    const result = await listMyInvitations();
    setItems(result.ok ? result.value : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load, userId]);

  if (items === null) return null;
  if (items.length === 0 && hideWhenEmpty) return null;

  const accept = async (item: MyInvitation) => {
    if (busy) return;
    setBusy(item.invitationId);
    setError(null);
    const result = await acceptInvitation({ invitationId: item.invitationId });
    if (!result.ok) {
      setError({ errorKey: result.errorKey, ref: result.ref });
      setBusy(null);
      await load();
      return;
    }
    // Der Betrieb der Einladung wird der aktive (M-13.1); scheitert das, bindet ensure nach Rangfolge.
    await selectActiveWorkspace(result.value.workspaceId);
    if (userId) clearWorkspaceRevoked(userId, result.value.workspaceId);
    rebindWorkspace({ userId, notice: { kind: 'accepted', workspaceName: item.workspaceName } });
  };

  const decline = async (item: MyInvitation) => {
    if (busy) return;
    setBusy(item.invitationId);
    setError(null);
    const result = await declineInvitation({ invitationId: item.invitationId });
    setBusy(null);
    if (!result.ok) {
      setError({ errorKey: result.errorKey, ref: result.ref });
    } else {
      setDeclined(true);
    }
    await load();
    if (result.ok) onDeclined?.();
  };

  return (
    <section className="pending-invitations" data-testid={testId}>
      {declined ? (
        <p className="hint-text" role="status" data-testid={`${testId}-declined`}>
          {t('invitation.declined', language)}
        </p>
      ) : null}
      {error ? (
        <p className="auth-form__error" role="alert" data-testid={`${testId}-error`}>
          {failureText(language, error)}
        </p>
      ) : null}
      {items.map((item) => (
        <div className="pending-invitations__item" key={item.invitationId} data-testid={`${testId}-item-${item.invitationId}`}>
          <p>
            {item.inviterName
              ? t('invitation.from', language, {
                  inviter: item.inviterName,
                  workspace: item.workspaceName,
                  role: t(`team.role.${item.role}` as TranslationKey, language),
                })
              : t('invitation.fromUnknown', language, {
                  workspace: item.workspaceName,
                  role: t(`team.role.${item.role}` as TranslationKey, language),
                })}
          </p>
          <p className="hint-text">
            {t('invitation.expires', language, { date: new Date(item.expiresAt).toLocaleDateString(language === 'de' ? 'de-DE' : language) })}
          </p>
          <div className="form-actions">
            <Button type="button" disabled={busy !== null} onClick={() => void accept(item)} data-testid={`${testId}-accept-${item.invitationId}`}>
              {t('invitation.accept', language)}
            </Button>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void decline(item)} data-testid={`${testId}-decline-${item.invitationId}`}>
              {t('invitation.decline', language)}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
