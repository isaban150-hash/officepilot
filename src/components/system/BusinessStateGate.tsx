import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import type { CompanySetup } from '../../types/models';
import { useAuth } from '../../context/AuthContext';
import { AppProvider } from '../../context/AppContext';
import { bootstrapBusinessState, isolateBusinessStateOnLogout } from '../../services/storage/storageBootstrapService';
import { getActiveStorageAccount } from '../../services/storage/storageScopeService';
import { watchPageCacheAccount } from '../../services/auth/pageCacheAccountGuard';
import { clearUiSessionSnapshot } from '../../services/uiSession/uiSessionStore';
import { resetUiSessionLiveState } from '../../services/uiSession/uiSessionLiveState';
import {
  bootstrapWorkspaceCloudSyncIfNeeded,
  getLastSuccessfulWorkspaceBootstrap,
  prepareWorkspaceCloudBootstrapRetry,
  readRememberedWorkspaceBinding,
  setLastSuccessfulWorkspaceBootstrap,
  type WorkspaceCloudBootstrapResult,
} from '../../services/workspace/workspaceCloudBootstrapService';
import { resetCompanySession } from '../../services/brain/companySessionService';
import { isSupabaseConfigured } from '../../lib/supabase';
import { hasCurrentLegalConsent } from '../../services/auth/legalConsentService';
import { getCachedSetup } from '../../services/persistenceService';
import { genericErrorText, t } from '../../i18n';
import { getWorkspaceStoreSnapshot } from '../../services/workspace/workspaceStore';
import { startAutomaticSync } from '../../services/sync/syncSchedulerRuntime';
import { runInvoiceDraftCloudBackfillOnce } from '../../services/invoice/invoiceDraftCloudBridge';
import {
  WorkspaceInvitationPending,
  WorkspaceNoLicense,
  WorkspaceRestoreFailure,
  WorkspaceSetupNotFound,
} from './WorkspaceRestoreFailure';
import { AdminUsersPage } from '../../pages/AdminUsersPage';
import { InvitationPage } from '../../pages/InvitationPage';
import {
  clearWorkspaceRevoked,
  handleConfirmedWorkspaceRevocation,
  isWorkspaceRevoked,
} from '../../services/workspace/workspaceMembershipChangeService';
import { watchPageCacheWorkspace } from '../../services/workspace/pageCacheWorkspaceGuard';
import { LocalStateLoadFailure } from './LocalStateLoadFailure';
import { DocumentLanguage } from './DocumentLanguage';
import { WorkspaceCompanyConflict } from './WorkspaceCompanyConflict';
import { applyConfirmedCloudCompany, applyConfirmedLocalCompany } from '../../services/workspace/workspaceCompanyRecoveryService';
import type { CompanyConflictInfo } from '../../services/workspace/workspaceCompanyConflictService';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import { resolveSetupWizardAccess, type SetupWizardAccess } from '../../services/setupAccessService';
import { readSetupDraft, resolveSetupDraftBinding } from '../../services/setupDraftService';

/**
 * EINRICHTUNG-01 (AP9; 1.30, EIN-27) — Fehler der Firmenkonflikt-Auflösung für die Anzeige: bekannte Codes mit eigenem
 * Text, alles andere (Ausnahmen, Serverantworten, Listen nicht übertragener Teile) als allgemeiner Text mit
 * Kurzreferenz. Nie der Rohtext.
 */
function conflictErrorText(code: string): string {
  const lang = getCachedSetup()?.language ?? 'de';
  if (code === 'local_changed') return t('companyConflict.changed', lang);
  if (code === 'local_persist_failed') return t('persist.failed.userAction', lang);
  if (code === 'pull_failed') return t('companyConflict.error.pullFailed', lang);
  if (code === 'local_candidate_missing') return t('companyConflict.error.localMissing', lang);
  return genericErrorText(lang, code);
}

function BootstrapLoading() {
  const lang = getCachedSetup()?.language ?? 'de';
  return (
    <div className="bootstrap-loading" data-testid="bootstrap-loading">
      <DocumentLanguage language={lang} />
      <p className="bootstrap-loading__text">{t('common.loading.app', lang)}</p>
    </div>
  );
}

interface BusinessStateGateProps {
  children: ReactNode;
}

export function BusinessStateGate({ children }: BusinessStateGateProps) {
  const { user, isAuthReady, isAuthenticated, isAllowed, isAdmin, logout, passwordRecoveryPending, profileConfirmed } = useAuth();
  /** EINRICHTUNG-01 (AP4, P-01.1) — Plattform-Verwaltung aus einer Hinweisseite ohne Betrieb geöffnet. */
  const [platformAdminOpen, setPlatformAdminOpen] = useState(false);
  /* EINRICHTUNG-01 (AP2, EIN-19; A-13.3) — ohne gültige Zustimmung keine Geschäftsdaten und kein Abgleich. */
  const legalConsented = hasCurrentLegalConsent(user);
  const [setup, setSetup] = useState<CompanySetup | null>(null);
  const [bootstrapKey, setBootstrapKey] = useState('guest');
  const bootstrappedUserRef = useRef<string | null | undefined>(undefined);
  const [restoreFailure, setRestoreFailure] = useState<string | null>(null);
  /**
   * LOAD_FAILED-UX-GUARD-01B — der aktive Speicherbereich enthält Daten, die
   * nicht gelesen werden konnten.
   *
   * Der Persistenz-Guard hat sie bewahrt und sperrt weitere Schreibvorgänge.
   * Hier fehlt nur noch, dass der Nutzer es sieht: Ohne diese Sperre erschiene
   * ein normales, leeres OfficePilot — und die Neuerfassung von Daten wäre
   * genau der Schritt, der den geretteten Bestand am Ende doch überschreibt.
   */
  const [localStateLoadFailed, setLocalStateLoadFailed] = useState(false);
  const [setupNotFound, setSetupNotFound] = useState(false);
  /** EINRICHTUNG-01 (AP3, O-05.1) — darf diese Person die Einrichtung fortsetzen? Festgestellt nach dem Abzug. */
  const [setupNotFoundAccess, setSetupNotFoundAccess] = useState<SetupWizardAccess>('unknown');
  const [companyConflict, setCompanyConflict] = useState<CompanyConflictInfo | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictChanged, setConflictChanged] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  /** Erhöht sich bei jedem neuen Vergleichsstand und setzt die Bestätigung zurück. */
  const [conflictStep, setConflictStep] = useState(0);
  /** Bereits übertragene Entitäten dieses Vorgangs — kein Doppelversand beim Retry. */
  const appliedEntitiesRef = useRef<{ setupRowVersion?: number; profileRowVersion?: number }>({});
  /** Rohtext, wie er beim Anzeigen des Konflikts galt — exakt gebunden. */
  const conflictRawRef = useRef<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  /** Nur eine ausdrückliche Nutzeraktion öffnet den Assistenten. */
  const continueSetupRef = useRef(false);

  /*
   * DOKUMENTE-01 N1 — kehrt die Seite aus dem Seiten-Cache zurück, während die
   * gespeicherte Sitzung inzwischen einem anderen Konto gehört (oder keinem),
   * lädt sie neu, statt den Bestand des früheren Kontos zu zeigen.
   */
  useEffect(() => watchPageCacheAccount(() => bootstrappedUserRef.current), []);
  /*
   * EINRICHTUNG-01 (AP4; M-10.3, M-13.5) — dasselbe für den Betrieb: Wurde inzwischen gewechselt oder der Zugang
   * entzogen, zeigt die Rückkehr aus dem Seiten-Cache nicht den alten Bestand, sondern lädt neu.
   */
  useEffect(() => watchPageCacheWorkspace(() => bootstrappedUserRef.current, () => getWorkspaceStoreSnapshot()?.id ?? null), []);

  useEffect(() => {
    if (!isAuthReady) return;

    let cancelled = false;
    const nextUserId = user?.id ?? null;

    void (async () => {
      if (bootstrappedUserRef.current && !nextUserId) {
        isolateBusinessStateOnLogout();
        resetCompanySession();
        clearUiSessionSnapshot();
        resetUiSessionLiveState();
        prepareWorkspaceCloudBootstrapRetry();
        const guestResult = bootstrapBusinessState();
        if (cancelled) return;
        setLocalStateLoadFailed(guestResult.loadFailed === true);
        setSetup(guestResult.setup);
        setBootstrapKey('guest');
        bootstrappedUserRef.current = null;
        // Beim Abmelden endet die Nutzer-Workspace-Bindung. Kein Übertrag.
        setLastSuccessfulWorkspaceBootstrap(null);
        return;
      }

      /*
       * DOKUMENTE-01 N1 — direkter Kontowechsel ohne abgemeldeten Zwischenstand
       * (z. B. Anmeldung in einem anderen Tab): Alles Sitzungsgebundene des
       * vorigen Kontos wird wie beim Abmelden verworfen, bevor das neue Konto
       * lädt — Firmensitzung des Assistenten, Arbeitsstand „Weiterarbeiten“,
       * Bootstrap-Bindung. Gespeicherte Bestände bleiben unberührt.
       */
      if (bootstrappedUserRef.current && nextUserId && bootstrappedUserRef.current !== nextUserId) {
        isolateBusinessStateOnLogout();
        resetCompanySession();
        clearUiSessionSnapshot();
        resetUiSessionLiveState();
        prepareWorkspaceCloudBootstrapRetry();
        setLastSuccessfulWorkspaceBootstrap(null);
      }

      // Freigabe erst nach optionalem Workspace-Bootstrap — kein AppProvider auf User-Default-Seed.
      setSetup(null);
      bootstrappedUserRef.current = nextUserId;

      /*
       * BUSINESS-CONTEXT-FLASH-01B — ein Zweitlauf für denselben Nutzer bleibt
       * im bereits freigegebenen Workspace-Scope.
       *
       * Die ID wird **vor** `bootstrapBusinessState` gelesen: Die Funktion ruft
       * als Erstes `clearInMemoryBusinessState()`, danach wäre der
       * Workspace-Store leer.
       *
       * Der Nutzervergleich ist die Sicherheitsbedingung, nicht eine
       * Optimierung: Ohne ihn würde nach einem Kontowechsel der Workspace des
       * vorherigen Nutzers weiterverwendet.
       */
      /*
       * EINRICHTUNG-01 (AP2; A-02.1, A-02.2) — ein Offline-Start (Profil unbestätigt) desselben Kontos lädt den zuletzt
       * bestätigten kontogebundenen Betriebsbestand, nie einen anderen Bereich und nie den Gaststand.
       */
      const offlineStart = Boolean(nextUserId) && isAuthenticated && profileConfirmed === false && isSupabaseConfigured();
      const rememberedRaw = offlineStart ? readRememberedWorkspaceBinding(nextUserId) : null;
      // EINRICHTUNG-01 (AP4, M-10.3) — ein bestätigt entzogener Betrieb kommt auch offline nicht zurück.
      const remembered = rememberedRaw && !isWorkspaceRevoked(nextUserId, rememberedRaw.workspaceId) ? rememberedRaw : null;
      const lastBootstrap = remembered ?? getLastSuccessfulWorkspaceBootstrap();
      const preservedWorkspaceId =
        nextUserId && lastBootstrap?.userId === nextUserId ? lastBootstrap.workspaceId : null;

      const result = bootstrapBusinessState(
        nextUserId
          ? preservedWorkspaceId
            ? // DOKUMENTE-01 N1 — derselbe Kontobestand wie bei der Freigabe (Sicht inklusive).
              { userId: nextUserId, workspaceId: preservedWorkspaceId, access: lastBootstrap?.access }
            : { userId: nextUserId }
          : {},
      );
      if (cancelled) return;
      /*
       * LOAD_FAILED-UX-GUARD-01B — vor jeder weiteren Entscheidung. Weder ein
       * Cloud-Bootstrap noch der Einrichtungsassistent darf auf einem Bereich
       * anlaufen, dessen gespeicherte Daten unlesbar sind.
       */
      if (result.loadFailed) {
        setLocalStateLoadFailed(true);
        setSetup(null);
        return;
      }
      setLocalStateLoadFailed(false);

      /*
       * EINRICHTUNG-01 (AP2; A-02, Vertrag 1.11) — offline mit bekanntem Kontobestand: kein Cloud-Bootstrap (er
       * scheiterte ohnehin), sondern der lokale Stand dieses Kontos; Änderungen bleiben „lokal gespeichert, nicht
       * bestätigt“, cloudbestätigte Aktionen sind gesperrt. Sobald das Profil bestätigt ist, läuft dieser Effekt erneut
       * und bootstrapt normal.
       */
      if (offlineStart && remembered && result.setup.setupComplete && legalConsented && !passwordRecoveryPending) {
        setRestoreFailure(null);
        setSetup(result.setup);
        setBootstrapKey(`${nextUserId}:${remembered.workspaceId}:offline`);
        return;
      }

      // EINRICHTUNG-01 (AP2, A-11.1) — während einer Passwort-Wiederherstellung kein Bootstrap und kein Abgleich.
      const needsWorkspaceBootstrap =
        Boolean(nextUserId) && isAuthenticated && isAllowed && isSupabaseConfigured() && !passwordRecoveryPending && legalConsented;

      if (needsWorkspaceBootstrap) {
        /**
         * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B2 — ein technischer Fehler darf nicht
         * wie ein neuer Kunde aussehen. Früher verschluckte ein leerer catch jeden
         * Fehler und gab den lokalen Default frei — der Nutzer landete still im
         * leeren Einrichtungsassistenten und hätte Cloud-Daten überschreiben können.
         */
        const result = await bootstrapWorkspaceCloudSyncIfNeeded({ sessionUserId: nextUserId }).catch(
          (): WorkspaceCloudBootstrapResult => ({ status: 'failed', reason: 'unknown' }),
        );
        if (cancelled) return;

        if (result.status === 'company_conflict' && result.conflict) {
          // Nichts wurde angewendet: Entscheidung liegt beim Nutzer.
          setCompanyConflict(result.conflict);
          try {
            conflictRawRef.current = localStorage.getItem(result.conflict.storageKey);
          } catch {
            conflictRawRef.current = null;
          }
          setSetup(null);
          return;
        }

        if (result.status === 'failed' && result.reason === 'revoked' && result.revokedWorkspaceId && nextUserId) {
          /*
           * EINRICHTUNG-01 (AP4, M-10.3) — während die App geschlossen war, wurde die Mitgliedschaft im gemerkten Betrieb
           * beendet. Derselbe Weg wie beim bestätigten Entzug in der Sitzung: Betrieb isolieren, Bindung vergessen, neu
           * binden; danach erscheint der Hinweis „Zugang entzogen“.
           */
          const store = getWorkspaceStoreSnapshot();
          handleConfirmedWorkspaceRevocation({
            userId: nextUserId,
            workspaceId: result.revokedWorkspaceId,
            workspaceName: (store?.id === result.revokedWorkspaceId ? store?.name : '') || getCachedSetup()?.companyName || '',
          });
          setSetup(null);
          return;
        }

        if (result.status === 'failed' && result.reason === 'invitation_pending') {
          // EINRICHTUNG-01 (AP4, M-07.4) — keine Mitgliedschaft, aber eine offene Einladung: Die Person entscheidet.
          setRestoreFailure('invitation_pending');
          setSetup(null);
          setLastSuccessfulWorkspaceBootstrap(null);
          return;
        }

        if (result.status === 'failed' && result.reason === 'no_license') {
          /*
           * EINRICHTUNG-01 (AP1, Z-03.1) — eine bestätigte Antwort des Servers, kein technischer Fehler: Es gibt
           * weder einen Betrieb zum Binden noch eine Lizenz für einen eigenen. Kein Rückfall auf einen lokalen
           * Bestand und keine Einrichtung, deren Eingaben nicht gespeichert werden könnten.
           */
          setRestoreFailure('no_license');
          setSetup(null);
          setLastSuccessfulWorkspaceBootstrap(null);
          return;
        }

        if (result.status === 'failed') {
          const localSetup = getCachedSetup();
          /**
           * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02B-K2 — existiert ein
           * konkurrierender echter Workspace-Bestand, darf kein anderer Scope
           * ersatzweise als normale Firma freigegeben werden.
           */
          if (localSetup.setupComplete && !result.localWorkspaceCandidate) {
            // Vollständige lokale Kopie: offline weiterarbeiten ist sicher.
            setRestoreFailure(null);
            setSetup(localSetup);
            setBootstrapKey(nextUserId ?? 'guest');
            return;
          }
          setRestoreFailure(result.reason ?? 'unknown');
          setSetup(null);
          return;
        }

        setRestoreFailure(null);
        const workspaceId = getWorkspaceStoreSnapshot()?.id;
        const cloudSetup = getCachedSetup();
        /**
         * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B3 — ein bestehender Workspace ohne
         * abgeschlossenes Setup ist mehrdeutig (abgebrochene Einrichtung oder
         * falsches Konto). Nur ein serverseitig neu angelegter Workspace darf
         * ohne Rückfrage in den Assistenten führen.
         */
        /*
         * EINRICHTUNG-01 (AP3; EIN-13, O-05.1) — die Rolle aus dem eben gezogenen Mitgliederstand: Nur Inhaber und
         * Admins mit Schreibrecht bekommen „Einrichtung fortsetzen“.
         */
        const setupAccess = cloudSetup.setupComplete
          ? 'allowed'
          : resolveSetupWizardAccess(resolveWorkspaceWriteAccess({ userId: nextUserId, cloudConfigured: true }));
        /*
         * EINRICHTUNG-01 (AP3, O-01.1) — ein gespeicherter Entwurf genau dieses Kontos in genau diesem Betrieb löst die
         * Mehrdeutigkeit auf: Es ist die eigene, abgebrochene Einrichtung. Dann geht es ohne Rückfrage dort weiter.
         */
        const resumableDraft =
          !cloudSetup.setupComplete &&
          setupAccess === 'allowed' &&
          Boolean(workspaceId) &&
          readSetupDraft(resolveSetupDraftBinding(nextUserId, workspaceId)) !== null;
        if (
          !cloudSetup.setupComplete &&
          result.status !== 'new_workspace' &&
          !continueSetupRef.current &&
          !resumableDraft
        ) {
          setSetupNotFoundAccess(setupAccess);
          setSetupNotFound(true);
          setSetup(null);
          /*
           * BUSINESS-CONTEXT-FLASH-01B — kein freigegebener Betrieb, also auch
           * keine Bindung. Eine ältere darf diesen Zustand nicht überdauern.
           */
          setLastSuccessfulWorkspaceBootstrap(null);
          return;
        }
        setSetupNotFound(false);
        setSetup(cloudSetup);
        setBootstrapKey(workspaceId ? `${nextUserId}:${workspaceId}` : (nextUserId ?? 'guest'));
        // EINRICHTUNG-01 (AP4, M-10.3) — der Server hat die Mitgliedschaft eben bestätigt; eine alte Entzugsmarke gilt nicht mehr.
        if (nextUserId && workspaceId) clearWorkspaceRevoked(nextUserId, workspaceId);
        /*
         * BUSINESS-CONTEXT-FLASH-01B — erst hier, nach erfolgreicher Freigabe,
         * gilt die Verknüpfung Nutzer ↔ Workspace. Ein gescheiterter oder
         * abgebrochener Lauf hinterlässt sie nicht.
         */
        const account = getActiveStorageAccount();
        setLastSuccessfulWorkspaceBootstrap(
          nextUserId && workspaceId
            ? {
                userId: nextUserId,
                workspaceId,
                access: account?.userId === nextUserId ? account.access : undefined,
              }
            : null,
        );
        return;
      }

      if (cancelled) return;
      setSetup(result.setup);
      setBootstrapKey(nextUserId ?? 'guest');
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthReady, isAuthenticated, isAllowed, user?.id, retryToken, passwordRecoveryPending, legalConsented, profileConfirmed]);

  /*
   * SYNC-AUTOMATIK-01A — automatische Synchronisation, solange ein angemeldeter
   * Nutzer in einem freigegebenen Workspace arbeitet. Der Bootstrap-Lauf oben
   * bleibt der Start-/Anmelde-Abgleich; der Planer übernimmt danach.
   *
   * Der Schlüssel `${user}:${workspace}` entsteht nur nach einer gelungenen
   * Workspace-Freigabe. Abmeldung (Schlüssel `guest`) und Workspace-Wechsel
   * beenden den Planer über das Aufräumen dieses Effekts — mit allen
   * Zeitgebern, Ereignissen und Kanälen.
   */
  // EINRICHTUNG-01 (AP2, B3) — ohne bestätigtes Profil (Offline-Start) kein automatischer Abgleich.
  const automaticSyncReady =
    setup !== null && isAuthenticated && isAllowed && !localStateLoadFailed && !companyConflict && !passwordRecoveryPending && legalConsented && profileConfirmed !== false;
  useEffect(() => {
    if (!automaticSyncReady || !isSupabaseConfigured()) return;
    const separator = bootstrapKey.indexOf(':');
    if (separator <= 0) return;
    const userId = bootstrapKey.slice(0, separator);
    const workspaceId = bootstrapKey.slice(separator + 1);
    if (!userId || !workspaceId || userId !== user?.id) return;
    const stop = startAutomaticSync({ userId, workspaceId });
    /*
     * CLOUD-SYNC S5 — einmal je App-Lauf und Workspace: aktive lokale
     * Rechnungsentwürfe, die der Spiegel noch nicht kennt, mit ihrer
     * vorhandenen Kennung spiegeln. Rein lesend auf der IndexedDB; gesendet wird
     * über die bestehende Kette. Ein Fehlschlag berührt nichts.
     */
    void runInvoiceDraftCloudBackfillOnce(workspaceId).catch(() => undefined);
    return stop;
  }, [automaticSyncReady, bootstrapKey, user?.id]);

  /*
   * LOAD_FAILED-UX-GUARD-01B — die höchste Sperre, vor allen anderen.
   *
   * Sie gilt auch ohne Anmeldung: Der Gastbereich trägt ebenso echte Daten.
   * Es gibt bewusst keinen Ausweg auf dieser Ansicht — jeder angebotene Weg
   * führte zu einem Schreibvorgang auf einem Bereich, dessen Bestand gerade
   * geschützt wird.
   */
  if (localStateLoadFailed) {
    return <LocalStateLoadFailure />;
  }

  if (companyConflict && isAuthenticated) {
    return (
      <WorkspaceCompanyConflict
        key={conflictStep}
        conflict={companyConflict}
        busy={conflictBusy}
        changed={conflictChanged}
        errorMessage={conflictError}
        onCancel={() => {
          /**
           * WORKSPACE-COMPANY-CONFLICT-SAFE-EXIT-01 — Abbrechen war bisher
           * wirkungslos: der Nutzer blieb auf der Sperrfläche, und der einzige
           * sichtbare Ausweg war der cloud-überschreibende Knopf.
           *
           * Jetzt führt Abbrechen über den **bestehenden** Auth-Logout-Pfad
           * hinaus: `logout()` ruft `isolateBusinessStateOnLogout()`, das nur
           * den Arbeitsspeicher isoliert und den Scope auf `guest` setzt — es
           * löscht **keinen** gespeicherten Bestand. Der Konflikt wird damit
           * nicht aufgelöst, sondern verlassen; bei der nächsten Anmeldung
           * erscheint er unverändert wieder.
           */
          if (conflictBusy) return;
          setConflictChanged(false);
          setConflictError(null);
          setConflictBusy(true);
          void logout()
            .then(() => {
              // Nur der UI-Zustand des Gates — keine gespeicherten Daten.
              setCompanyConflict(null);
              conflictRawRef.current = null;
              appliedEntitiesRef.current = {};
            })
            .finally(() => {
              setConflictBusy(false);
            });
        }}
        onConfirmUseCloud={() => {
          /*
           * OFFICETAKT-02B-F2 — Cloud behalten. Die Funktion sichert die
           * lokale Kopie vollständig in die Quarantäne und gibt danach nur
           * den einen Workspace-Schlüssel frei. Der anschliessende Bootstrap
           * läuft wie auf einem neuen Gerät: Cloud lesen, leere Outbox —
           * nichts Altes wird hochgeladen.
           */
          if (conflictBusy) return;
          setConflictBusy(true);
          setConflictChanged(false);
          setConflictError(null);
          void applyConfirmedCloudCompany({
            workspaceId: companyConflict.workspaceId,
            account: companyConflict.account,
            confirmedLocalCompanyName: companyConflict.localCompanyName,
            confirmedCloudCompanyName: companyConflict.cloudCompanyName,
            confirmedCloudSetupRowVersion: companyConflict.cloudSetupRowVersion,
            confirmedCloudProfileRowVersion: companyConflict.cloudProfileRowVersion,
            confirmedRawText: conflictRawRef.current ?? '',
          })
            .then((outcome) => {
              if (outcome.status === 'changed') {
                setCompanyConflict(outcome.conflict);
                try {
                  conflictRawRef.current = localStorage.getItem(outcome.conflict.storageKey);
                } catch {
                  conflictRawRef.current = null;
                }
                setConflictChanged(true);
                setConflictStep((value) => value + 1);
                return;
              }
              if (outcome.status === 'failed') {
                setConflictError(conflictErrorText(outcome.message));
                return;
              }
              // Gesichert und freigegeben: derselbe Neustart wie im Gegenweg.
              appliedEntitiesRef.current = {};
              conflictRawRef.current = null;
              prepareWorkspaceCloudBootstrapRetry();
              setCompanyConflict(null);
              setRetryToken((value) => value + 1);
            })
            .finally(() => {
              setConflictBusy(false);
            });
        }}
        onConfirmUseLocal={() => {
          if (conflictBusy) return;
          setConflictBusy(true);
          setConflictChanged(false);
          setConflictError(null);
          void applyConfirmedLocalCompany({
            workspaceId: companyConflict.workspaceId,
            account: companyConflict.account,
            confirmedCompanyName: companyConflict.localCompanyName,
            confirmedSavedAt: companyConflict.localSavedAt,
            confirmedCloudSetupRowVersion: companyConflict.cloudSetupRowVersion,
            confirmedCloudProfileRowVersion: companyConflict.cloudProfileRowVersion,
            confirmedRawText: conflictRawRef.current ?? '',
            confirmedCloudCompanyName: companyConflict.cloudCompanyName,
            alreadyApplied: appliedEntitiesRef.current,
          })
            .then((outcome) => {
              if (outcome.status === 'changed') {
                /**
                 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02B-K3 — neuer
                 * Vergleichsstand: der bisherige Fortschritt gilt nicht mehr.
                 * Sonst würde eine inzwischen geänderte Entität mit alter
                 * Serverversion übersprungen.
                 */
                appliedEntitiesRef.current = {};
                // Die zweistufige Bestätigung beginnt von vorne.
                setCompanyConflict(outcome.conflict);
                try {
                  conflictRawRef.current = localStorage.getItem(outcome.conflict.storageKey);
                } catch {
                  conflictRawRef.current = null;
                }
                setConflictChanged(true);
                setConflictStep((value) => value + 1);
                return;
              }
              if (outcome.status === 'partial') {
                // Nur wirklich übertragene Entitäten samt Serverversion merken.
                appliedEntitiesRef.current = {
                  setupRowVersion:
                    outcome.setupRowVersion ?? appliedEntitiesRef.current.setupRowVersion,
                  profileRowVersion:
                    outcome.profileRowVersion ?? appliedEntitiesRef.current.profileRowVersion,
                };
                // Der eigene verifizierte Schreibvorgang bindet den Stand neu.
                try {
                  conflictRawRef.current = localStorage.getItem(companyConflict.storageKey);
                } catch {
                  conflictRawRef.current = null;
                }
                setConflictError(
                  conflictErrorText(outcome.persistFailed ? 'local_persist_failed' : `partial:${outcome.failed.join(',')}`),
                );
                return;
              }
              if (outcome.status === 'failed') {
                setConflictError(conflictErrorText(outcome.message ?? 'unknown'));
                return;
              }
              // Vollständig übertragen: lokalen Bestand aktivieren und freigeben.
              appliedEntitiesRef.current = {
                setupRowVersion: outcome.setupRowVersion,
                profileRowVersion: outcome.profileRowVersion,
              };
              prepareWorkspaceCloudBootstrapRetry();
              setCompanyConflict(null);
              setRetryToken((value) => value + 1);
            })
            .finally(() => {
              setConflictBusy(false);
            });
        }}
      />
    );
  }

  /*
   * EINRICHTUNG-01 (AP4; P-01.1) — Plattform-Admins erreichen die Plattform-Verwaltung auch ohne eigenen Betrieb, ohne
   * Setup und ohne Lizenz. Die Seite hängt nicht am Betriebskontext.
   */
  if (platformAdminOpen && isAuthenticated && isAdmin) {
    return <AdminUsersPage onClose={() => setPlatformAdminOpen(false)} />;
  }

  /*
   * EINRICHTUNG-01 (AP0–AP4-Abschluss, N1; Vertrag 1.5, Weg C) — auch ohne Betrieb gilt die Einladungsadresse: Die
   * Einladungsseite prüft genau dieses Token und meldet „ungültig“, „abgelaufen“ oder „widerrufen“, statt der
   * Hinweisseite. Jede andere Adresse zeigt weiter den Hinweis.
   */
  const withInvitationRoute = (hint: ReactNode) => (
    <Routes>
      <Route path="/einladung/:token" element={<InvitationPage />} />
      <Route path="*" element={hint} />
    </Routes>
  );

  if (restoreFailure === 'invitation_pending' && isAuthenticated) {
    return withInvitationRoute(
      <WorkspaceInvitationPending
        userId={user?.id ?? null}
        onRecheck={() => {
          prepareWorkspaceCloudBootstrapRetry();
          setRestoreFailure(null);
          setRetryToken((value) => value + 1);
        }}
        onLogout={() => {
          void logout();
        }}
        onOpenPlatform={isAdmin ? () => setPlatformAdminOpen(true) : undefined}
      />,
    );
  }

  if (restoreFailure === 'no_license' && isAuthenticated) {
    return withInvitationRoute(
      <WorkspaceNoLicense
        userId={user?.id ?? null}
        onRecheck={() => {
          prepareWorkspaceCloudBootstrapRetry();
          setRestoreFailure(null);
          setRetryToken((value) => value + 1);
        }}
        onLogout={() => {
          void logout();
        }}
        onOpenPlatform={isAdmin ? () => setPlatformAdminOpen(true) : undefined}
      />,
    );
  }

  if (restoreFailure && isAuthenticated) {
    return (
      <WorkspaceRestoreFailure
        onRetry={() => {
          prepareWorkspaceCloudBootstrapRetry();
          setRestoreFailure(null);
          setRetryToken((value) => value + 1);
        }}
        onSwitchAccount={() => {
          void logout();
        }}
      />
    );
  }

  if (setupNotFound && isAuthenticated) {
    return (
      <WorkspaceSetupNotFound
        access={setupNotFoundAccess}
        userId={user?.id ?? null}
        onRecheck={() => {
          prepareWorkspaceCloudBootstrapRetry();
          setSetupNotFound(false);
          setRetryToken((value) => value + 1);
        }}
        onSwitchAccount={() => {
          void logout();
        }}
        onContinueSetup={() => {
          // EINRICHTUNG-01 (AP3, O-05.1) — auch der Weg selbst prüft die Rolle, nicht nur die Anzeige.
          if (
            resolveSetupWizardAccess(resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: true })) !== 'allowed'
          ) {
            return;
          }
          continueSetupRef.current = true;
          setSetupNotFound(false);
          setSetup(getCachedSetup());
          const workspaceId = getWorkspaceStoreSnapshot()?.id;
          setBootstrapKey(workspaceId ? `${user?.id}:${workspaceId}` : (user?.id ?? 'guest'));
        }}
      />
    );
  }

  /*
   * EINRICHTUNG-01 (AP2, A-12.1; N-A1.1) — zwischen Anmeldung bzw. Kontowechsel und der Bindung des neuen Kontos gilt
   * noch der Stand des vorigen (meist der leere Gaststand). Die App darf in diesem Takt nicht rendern: Sie leitete
   * sonst auf die Einrichtung um und verlöre das Rücksprungziel, oder zeigte kurz den Bestand des vorigen Kontos.
   */
  const accountPending = isAuthReady && (user?.id ?? null) !== (bootstrappedUserRef.current ?? null);

  if (!isAuthReady || !setup || accountPending) {
    return <BootstrapLoading />;
  }

  return (
    <AppProvider key={bootstrapKey} initialSetup={setup}>
      {children}
    </AppProvider>
  );
}
