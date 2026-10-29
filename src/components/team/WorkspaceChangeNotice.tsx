import { useState } from 'react';
import { Button } from '../ui/Button';
import { takeWorkspaceChangeNotice, type WorkspaceChangeNotice as Notice } from '../../services/workspace/workspaceMembershipChangeService';
import { t, type TranslationKey } from '../../i18n';
import type { AppLanguage } from '../../types/models';

const TEXTS: Record<Notice['kind'], TranslationKey> = {
  revoked: 'workspaceAccess.revoked.body',
  left: 'workspaceChange.left',
  switched: 'workspaceChange.switched',
  accepted: 'invitation.accepted',
  owner: 'transferIn.accepted',
  handedOver: 'workspaceChange.handedOver',
};

/**
 * EINRICHTUNG-01 (AP4; M-10.3) — der einmalige Hinweis nach dem Neubinden, etwa „Zugang zu W1 entzogen“. Er überlebt das
 * Neuladen (Sitzungsspeicher) und wird beim Anzeigen verbraucht.
 */
export function WorkspaceChangeNotice({ language }: { language: AppLanguage }) {
  const [notice, setNotice] = useState<Notice | null>(() => takeWorkspaceChangeNotice());
  if (!notice) return null;
  return (
    <div
      className={notice.kind === 'revoked' ? 'persistence-failure-banner' : 'workspace-read-only-banner'}
      role={notice.kind === 'revoked' ? 'alert' : 'status'}
      data-testid="workspace-change-notice"
      data-kind={notice.kind}
    >
      {notice.kind === 'revoked' ? <strong>{t('workspaceAccess.revoked.title', language)} </strong> : null}
      <span>{t(TEXTS[notice.kind], language, { workspace: notice.workspaceName })}</span>
      <Button type="button" size="sm" variant="ghost" onClick={() => setNotice(null)} data-testid="workspace-change-notice-close">
        {t('workspaceAccess.revoked.continue', language)}
      </Button>
    </div>
  );
}
