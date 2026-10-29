import { Link, Outlet, useLocation } from 'react-router-dom';
import { Fragment, useEffect, useRef } from 'react';
import { useMainScrollRestoration } from './useMainScrollRestoration';
import { BetaModeBanner } from './BetaModeBanner';
import { PersistenceFailureBanner } from '../system/PersistenceFailureBanner';
import { CloudBackupPendingBanner } from '../system/CloudBackupPendingBanner';
import { WorkspaceReadOnlyBanner } from '../system/WorkspaceReadOnlyBanner';
import { ConnectionIssueBanner } from '../system/ConnectionIssueBanner';
import { SyncStatusIndicator } from '../system/SyncStatusIndicator';
import { BottomNav } from './BottomNav';
import { SidebarNav } from './SidebarNav';
import { UserMenu } from './UserMenu';
import { GlobalSearchBar } from '../search/GlobalSearchBar';
import { Toast } from '../ui/Card';
import { SafariResumeDebugOverlay } from '../system/SafariResumeDebugOverlay';
import { UiSessionRecoveryHost } from '../system/UiSessionRecoveryHost';
import { useApp } from '../../context/AppContext';
import { Icon } from '../ui/Icon';
import { ASSISTENT_ROUTE } from './navConfig';
import { runDailyInvoicePaymentTaskReconcile } from '../../services/invoice/invoicePaymentTaskSync';
import {
  resyncLocalOnlyInvoicePayments,
  shouldResyncAfterSyncStatus,
} from '../../services/invoice/invoicePaymentCloudResyncService';
import { resyncGeneratedInvoiceDocuments } from '../../services/document/generatedInvoiceDocumentCloudResyncService';
import { subscribeAutomaticSyncStatus } from '../../services/sync/syncSchedulerRuntime';
import { isSupabaseConfigured } from '../../lib/supabase';
import { useWorkspaceWriteAccess } from '../../hooks/useWorkspaceWriteAccess';
import { getSyncOutboxSnapshot, subscribeSyncOutbox } from '../../services/sync/syncOutboxService';
import { isWorkspaceLicenseRejectionMessage } from '../../services/sync/syncRoleDenial';
import {
  getActiveWorkspaceAccessRecord,
  requestWorkspaceAccessRefresh,
  subscribeWorkspaceAccessRevoked,
} from '../../services/workspace/workspaceAccessService';
import { useOptionalAuth } from '../../context/AuthContext';
import { getWorkspaceStoreSnapshot } from '../../services/workspace/workspaceStore';
import { handleConfirmedWorkspaceRevocation } from '../../services/workspace/workspaceMembershipChangeService';
import { WorkspaceChangeNotice } from '../team/WorkspaceChangeNotice';
import { PendingInvitationsPanel } from '../team/PendingInvitationsPanel';
import { IncomingTransfersBanner } from '../team/IncomingTransfersBanner';
import { SkipLink } from '../system/SkipLink';

export function AppShell() {
  const location = useLocation();
  const onSearchPage = location.pathname === '/suche' || location.pathname.startsWith('/suche/');
  /*
   * Die Kopfzeile zeigt die **aktuelle** Firmenidentität. Die liegt in
   * `CompanyProfile`; `CompanySetup.companyName` ist nur noch ein
   * Legacy-Spiegel und kann nach einem Cloud-Pull veraltet sein.
   */
  const { companyProfile, toast, clearToast, translate, language } = useApp();
  const companyName = companyProfile.companyName;
  const userId = useOptionalAuth()?.user?.id ?? null;

  /*
   * EINRICHTUNG-01 (AP4; Vertrag 1.7, M-10.3, M-10.5) — bestätigt der Server, dass die Mitgliedschaft im aktiven
   * Betrieb nicht mehr besteht, wird er isoliert: markiert (auch über Neustart und Seiten-Cache) und neu gebunden.
   * Andere Mitgliedschaften bleiben erreichbar; ensure bindet danach die nächste.
   */
  useEffect(() => {
    if (!isSupabaseConfigured()) return undefined;
    return subscribeWorkspaceAccessRevoked(({ workspaceId, userId: revokedFor }) => {
      if (getWorkspaceStoreSnapshot()?.id !== workspaceId) return;
      handleConfirmedWorkspaceRevocation({
        userId: revokedFor,
        workspaceId,
        workspaceName: companyProfile.companyName || getWorkspaceStoreSnapshot()?.name || '',
      });
    });
  }, [companyProfile.companyName]);
  /* 01D — Scrollregel: neue Seite oben, Rückweg an gemerkter Position. */
  const mainRef = useRef<HTMLElement | null>(null);
  useMainScrollRestoration(mainRef);
  /*
   * EINRICHTUNG-01 (AP1, Vertrag 1.3) — Nur-Lesen gilt für die ganze Seite. Wechselt der Zustand, wird der Inhalt
   * neu aufgebaut: Auch Seiten, die die Auskunft nur beim Aufbau lesen, zeigen dann sofort den richtigen Stand.
   */
  const readOnly = useWorkspaceWriteAccess().licenseReadOnly === true;

  /*
   * 02B — einmal je Tag beim App-Start: Überfälligkeitsaufgaben mit dem
   * Forderungsstand abgleichen. Die Seiten selbst (Heute, Eingang, Aufgaben)
   * zeigen nur an und legen beim Rendern nichts mehr an.
   */
  useEffect(() => {
    try {
      runDailyInvoicePaymentTaskReconcile();
    } catch (error) {
      console.warn('[tasks] täglicher Abgleich der Überfälligkeitsaufgaben fehlgeschlagen', error);
    }
  }, []);

  /*
   * FINANZ-CORE-01A (ZAH-02, STO-07) — nie gesicherte Rechnungszahlungen und
   * Archivdokumente freigegebener Rechnungen nachsichern: nach dem Start des
   * Planers (der Bootstrap hat soeben abgeglichen) und nach jedem erfolgreichen
   * automatischen Abgleich, höchstens alle zehn Minuten (siehe Dienste). Ohne
   * Cloud gibt es nichts zu sichern.
   */
  /*
   * EINRICHTUNG-01 (AP1; Verträge 1.3, 1.7) — die Betriebslizenz beim Server erfragen: beim Start, bei Fokus und
   * Netzrückkehr, nach jedem automatischen Abgleich (gedrosselt) und sofort nach einer Abweisung mit Lizenzcode.
   */
  useEffect(() => {
    if (!isSupabaseConfigured()) return undefined;
    requestWorkspaceAccessRefresh({ force: true });
    const anlass = () => requestWorkspaceAccessRefresh();
    const nachAbweisung = () => {
      const bestaetigt = getActiveWorkspaceAccessRecord()?.confirmedAt ?? '';
      const neu = getSyncOutboxSnapshot().some(
        (entry) =>
          entry.status === 'failed' &&
          isWorkspaceLicenseRejectionMessage(entry.lastErrorMessage) &&
          (entry.lastErrorAt ?? '') > bestaetigt,
      );
      if (neu) requestWorkspaceAccessRefresh({ force: true });
    };
    window.addEventListener('focus', anlass);
    window.addEventListener('online', anlass);
    const abmelden = subscribeSyncOutbox(nachAbweisung);
    const nachLauf = subscribeAutomaticSyncStatus((status) => {
      if (status && !status.running) anlass();
    });
    return () => {
      window.removeEventListener('focus', anlass);
      window.removeEventListener('online', anlass);
      abmelden();
      nachLauf();
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured()) return undefined;
    return subscribeAutomaticSyncStatus((status) => {
      if (shouldResyncAfterSyncStatus(status)) {
        void resyncLocalOnlyInvoicePayments().catch(() => undefined);
        void resyncGeneratedInvoiceDocuments().catch(() => undefined);
      }
    });
  }, []);

  return (
    <div className="app-shell" data-testid="app-shell">
      {/* EINRICHTUNG-01 (AP9; 1.32) — erstes fokussierbares Element: Sprung zur Überschrift des Inhalts. */}
      <SkipLink
        href="#app-main"
        label={translate('a11y.skipToContent')}
        findTarget={() => mainRef.current?.querySelector<HTMLElement>('h1') ?? mainRef.current}
      />
      <div className="app-shell__top">
        <div className="app-shell__top-left">
          <span className="app-shell__brand">{translate('app.name')}</span>
          {companyName ? (
            <span className="app-shell__company" title={companyName}>
              {companyName}
            </span>
          ) : null}
        </div>
        <div className="app-shell__top-right">
          {/* SYNC-AUTOMATIK-01A — Synchronisationsstand ohne Umweg über die Sync-Seite. */}
          <SyncStatusIndicator />
          {/*
            * UIUX-FOUNDATION-01C — globale Werkzeuge im Header: Assistent
            * (vorher ein Hauptnavigationsplatz), Einstellungen (Zahnrad),
            * Benutzermenü. Keine zweite Hauptnavigation.
            */}
          <Link
            to={ASSISTENT_ROUTE}
            className="app-shell__tool"
            aria-label={translate('nav.assistant.tool')}
            title={translate('nav.assistant.tool')}
            data-testid="assistant-entry"
          >
            <Icon id="assistant" />
          </Link>
          <Link
            to="/einstellungen"
            className="app-shell__tool app-shell__settings-gear"
            aria-label={translate('settings.gear')}
            title={translate('settings.gear')}
            data-testid="settings-gear"
          >
            <Icon id="settings" />
          </Link>
          <UserMenu />
        </div>
        {/*
          * VISUAL-POLISH-01B — Suche kompakt im Kopf (Desktop: Feld, mobil: Symbol), kein eigener Suchbalken.
          * PRODUCT-ACCEPTANCE-FIX-01B (F-04) — auf der Suchseite gehört der
          * Suchzustand der Seite selbst; die Kopfzeilensuche entfällt dort.
          */}
        {onSearchPage ? null : (
          <div className="app-shell__search" data-testid="app-shell-search">
            <GlobalSearchBar compact collapsibleOnMobile iconTrigger />
          </div>
        )}
      </div>
      <PersistenceFailureBanner />
      <CloudBackupPendingBanner />
      <WorkspaceReadOnlyBanner />
      <ConnectionIssueBanner />
      {/* EINRICHTUNG-01 (AP4) — Hinweis nach dem Neubinden, eingehende Einladungen und Übergaben. */}
      <WorkspaceChangeNotice language={language} />
      {isSupabaseConfigured() && userId ? (
        <>
          <PendingInvitationsPanel userId={userId} language={language} hideWhenEmpty testId="app-invitations" />
          <IncomingTransfersBanner userId={userId} language={language} />
        </>
      ) : null}
      <BetaModeBanner />
      <UiSessionRecoveryHost />
      <div className="app-shell__body">
        <SidebarNav />
        <main className="app-shell__main" id="app-main" ref={mainRef} data-testid="app-shell-main">
          <Fragment key={readOnly ? 'nur-lesen' : 'schreiben'}>
            <Outlet />
          </Fragment>
        </main>
      </div>
      <BottomNav />
      {toast && (
        <Toast message={toast} onClose={clearToast} closeLabel={translate('common.close')} />
      )}
      <SafariResumeDebugOverlay />
    </div>
  );
}
