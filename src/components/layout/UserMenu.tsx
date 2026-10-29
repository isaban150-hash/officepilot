import { useEffect, useMemo, useState } from 'react';
import { confirmLeaveIfDirty } from '../../services/navigation/leaveGuardRegistry';
import { DropdownMenu, type DropdownMenuItem } from '../ui/DropdownMenu';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { getSyncOutboxSnapshot } from '../../services/sync/syncOutboxService';
import { isSupabaseConfigured } from '../../lib/supabase';
import { listOwnMemberships, type OwnMembership } from '../../services/auth/accountService';
import { selectActiveWorkspace } from '../../services/team/teamService';
import { getWorkspaceStoreSnapshot } from '../../services/workspace/workspaceStore';
import { rebindWorkspace } from '../../services/workspace/workspaceMembershipChangeService';
import { PLATFORM_ADMIN_ROUTE } from '../../pages/AdminUsersPage';
import { t } from '../../i18n';

function ChevronDownIcon() {
  return (
    <svg className="user-menu__chevron" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 10.939l3.71-3.71a.75.75 0 111.06 1.061l-4.24 4.25a.75.75 0 01-1.06 0l-4.24-4.25a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * EINRICHTUNG-01 (AP2, A-06.1) — Änderungen dieses Bereichs, die noch auf die Übertragung warten: offen, nach einem
 * Fehler wartend oder in einem Konflikt. Zurückgehaltene Altaufträge (DOKUMENTE-01 R2) zählen nicht; sie gehen ohne
 * bewusste Freigabe ohnehin nie hinaus.
 */
export function countUnsentChanges(): number {
  return getSyncOutboxSnapshot().filter(
    (entry) => (entry.status === 'pending' || entry.status === 'error' || entry.status === 'blocked') && !entry.hold,
  ).length;
}

type LogoutDialog = { kind: 'local' | 'global'; count: number } | null;

/** EINRICHTUNG-01 (AP9; 1.30) — fehlgeschlagener Betriebswechsel: Ziel und bisheriger Betrieb für den bleibenden Hinweis. */
type SwitchFailure = { workspaceId: string; workspaceName: string; currentName: string } | null;

export function UserMenu() {
  const { translate, language } = useApp();
  const { user, logout, logoutEverywhere, isAdmin } = useAuth();
  const [dialog, setDialog] = useState<LogoutDialog>(null);
  const [busy, setBusy] = useState(false);
  const [memberships, setMemberships] = useState<OwnMembership[]>([]);
  const [switchFailure, setSwitchFailure] = useState<SwitchFailure>(null);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId || !isSupabaseConfigured()) return undefined;
    let active = true;
    void listOwnMemberships().then((rows) => {
      if (active) setMemberships(rows ?? []);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  /** Wählt den Betrieb auf dem Server und bindet die App um; `false`, wenn der Server den Wechsel nicht bestätigt. */
  const selectAndRebind = async (workspaceId: string, workspaceName: string): Promise<boolean> => {
    const result = await selectActiveWorkspace(workspaceId);
    if (!result.ok) return false;
    rebindWorkspace({ userId, notice: { kind: 'switched', workspaceName } });
    return true;
  };

  const switchWorkspace = async (workspaceId: string, workspaceName: string) => {
    // EINRICHTUNG-01 (AP8; 1.27) — ungespeicherte Änderungen: erst die Rückfrage („Bleiben“ / „Verlassen“).
    if (!(await confirmLeaveIfDirty())) return;
    if (await selectAndRebind(workspaceId, workspaceName)) return;
    /*
     * EINRICHTUNG-01 (AP9; 1.30, Q-01) — der Fehler bleibt als Hinweis stehen (kein verschwindender Toast), nennt den
     * Betrieb, in dem weitergearbeitet wird, und bietet den nächsten Schritt an.
     */
    setSwitchFailure({ workspaceId, workspaceName, currentName: getWorkspaceStoreSnapshot()?.name ?? '' });
  };

  const fallbackName = translate('userMenu.fallbackName');
  const displayName = (user ? `${user.firstName} ${user.lastName}`.trim() : '') || fallbackName;
  // WOW-Pass: Initialen für die kompakte mobile Anzeige (Name bleibt für Desktop und Screenreader erhalten).
  const initials = user ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || displayName.slice(0, 1).toUpperCase() : fallbackName.slice(0, 1).toUpperCase();

  /*
   * EINRICHTUNG-01 (AP2, EIN-16, EIN-26; A-04 bis A-06) — Abmelden gilt standardmäßig nur für dieses Gerät und wird
   * abgewartet. Warten Änderungen auf die Übertragung, fragt ein Dialog nach („Abbrechen“ lässt die Sitzung bestehen);
   * die Änderungen bleiben im Bereich des Kontos und gehen nach der nächsten Anmeldung hinaus. „Auf allen Geräten
   * abmelden“ fragt immer nach.
   */
  const runLogout = async (kind: 'local' | 'global'): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      if (kind === 'global') await logoutEverywhere();
      else await logout();
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startLogout = async (kind: 'local' | 'global') => {
    if (busy) return;
    // EINRICHTUNG-01 (AP8; 1.27) — ungespeicherte Eingaben zuerst (danach wie bisher die ungesendeten Änderungen).
    if (!(await confirmLeaveIfDirty())) return;
    const count = countUnsentChanges();
    if (kind === 'local' && count === 0) {
      void runLogout('local');
      return;
    }
    setDialog({ kind, count });
  };

  const items = useMemo((): DropdownMenuItem[] => {
    const menuItems: DropdownMenuItem[] = [
      /*
       * COMPANY-SETTINGS-ENTRY-01B — „Einstellungen" ersetzt den bisherigen
       * Direktsprung zu den Firmendaten.
       *
       * Die Firmendaten bleiben vollständig erreichbar, jetzt aber dort, wo ein
       * Betrieb sie sucht: als erster Eintrag im Einstellungsbereich. Zwei
       * konkurrierende Einstiege nebeneinander hätten genau die zerstreute
       * Struktur fortgeschrieben, die dieser Block beseitigt.
       */
      {
        id: 'einstellungen',
        label: translate('settings.title'),
        href: '/einstellungen',
        testId: 'user-menu-einstellungen',
      },
      /*
       * UIUX-FOUNDATION-01C — kein „Mehr“-Eintrag mehr: Das Benutzermenü ist
       * keine zweite Hauptnavigation, sondern nutzer-/systemnah (Einstellungen,
       * Admin nach bestehender Berechtigung, Abmelden).
       */
    ];
    /*
     * EINRICHTUNG-01 (AP4; M-13.1) — Betriebswahl bei mehr als einer Mitgliedschaft. Der gewählte Betrieb gilt auf dem
     * Server (ensure bindet ihn zuerst); die App lädt danach neu und bindet sauber um.
     */
    if (memberships.length > 1) {
      const currentId = getWorkspaceStoreSnapshot()?.id ?? null;
      for (const membership of memberships) {
        const current = membership.workspaceId === currentId;
        menuItems.push({
          id: `workspace-${membership.workspaceId}`,
          label: `${translate('workspaceSwitch.title')}: ${membership.workspaceName || '—'}${current ? ` (${translate('workspaceSwitch.current')})` : ''}`,
          onSelect: () => {
            if (!current) void switchWorkspace(membership.workspaceId, membership.workspaceName);
          },
          testId: `user-menu-workspace-${membership.workspaceId}`,
        });
      }
    }
    // EINRICHTUNG-01 (AP4; P-01.1) — der eine Einstieg in die Plattform-Verwaltung, außerhalb der Betriebseinstellungen.
    if (isAdmin) {
      menuItems.push({
        id: 'admin',
        label: translate('platform.entry'),
        href: PLATFORM_ADMIN_ROUTE,
        testId: 'user-menu-admin',
      });
    }

    menuItems.push({
      id: 'logout',
      label: busy ? translate('auth.logout.busy') : translate('auth.logout.action'),
      destructive: true,
      onSelect: () => void startLogout('local'),
      testId: 'logout-button',
    });
    menuItems.push({
      id: 'logout-everywhere',
      label: translate('auth.logout.everywhere'),
      destructive: true,
      onSelect: () => void startLogout('global'),
      testId: 'logout-everywhere-button',
    });

    return menuItems;
    // startLogout liest den aktuellen Zustand bei jedem Aufruf neu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, busy, translate, memberships]);

  if (!user) return null;

  const pendingText =
    dialog && dialog.count > 0 ? t('auth.logout.pendingWarning', language, { count: dialog.count }) : '';
  const message =
    dialog?.kind === 'global'
      ? [translate('auth.logout.everywhereConfirm'), pendingText].filter(Boolean).join(' ')
      : pendingText;

  return (
    <div className="user-menu" data-testid="user-menu">
      <DropdownMenu
        testId="user-menu-dropdown"
        ariaLabel={translate('userMenu.label')}
        align="end"
        trigger={
          <>
            <span className="user-menu__avatar" aria-hidden>
              {initials}
            </span>
            <span className="user-menu__name" data-testid="app-shell-user">
              {displayName}
            </span>
            <ChevronDownIcon />
          </>
        }
        items={items}
      />
      <SimpleConfirmDialog
        open={dialog !== null}
        title={dialog?.kind === 'global' ? translate('auth.logout.everywhere') : translate('auth.logout.title')}
        message={message}
        confirmLabel={dialog?.kind === 'global' ? translate('auth.logout.everywhereAction') : translate('auth.logout.confirm')}
        cancelLabel={translate('auth.logout.cancel')}
        dialogTestId="logout-dialog"
        confirmTestId="logout-dialog-confirm"
        cancelTestId="logout-dialog-cancel"
        failureMessage={dialog?.kind === 'global' ? translate('auth.logout.everywhereFailed') : translate('auth.error.unknown')}
        onConfirm={async () => {
          const kind = dialog?.kind ?? 'local';
          const ok = await runLogout(kind);
          if (ok) setDialog(null);
          return ok;
        }}
        onCancel={() => setDialog(null)}
      />
      <SimpleConfirmDialog
        open={switchFailure !== null}
        title={translate('workspaceSwitch.title')}
        message={t('workspaceSwitch.failedStay', language, { workspace: switchFailure?.currentName || '—' })}
        confirmLabel={translate('workspaceSwitch.retry')}
        cancelLabel={translate('common.close')}
        confirmVariant="primary"
        dialogTestId="user-menu-workspace-switch-dialog"
        confirmTestId="user-menu-workspace-switch-retry"
        cancelTestId="user-menu-workspace-switch-close"
        failureMessage={translate('workspaceSwitch.retryFailed')}
        details={
          <p className="dialog__error" role="alert" data-testid="user-menu-workspace-switch-error">
            {translate('workspaceSwitch.failed')}
          </p>
        }
        onConfirm={async () => {
          if (!switchFailure) return true;
          const ok = await selectAndRebind(switchFailure.workspaceId, switchFailure.workspaceName);
          if (ok) setSwitchFailure(null);
          return ok;
        }}
        onCancel={() => setSwitchFailure(null)}
      />
    </div>
  );
}
