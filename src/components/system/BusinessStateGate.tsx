import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CompanySetup } from '../../types/models';
import { useAuth } from '../../context/AuthContext';
import { AppProvider } from '../../context/AppContext';
import { bootstrapBusinessState, isolateBusinessStateOnLogout } from '../../services/storage/storageBootstrapService';
import { clearUiSessionSnapshot } from '../../services/uiSession/uiSessionStore';
import { resetUiSessionLiveState } from '../../services/uiSession/uiSessionLiveState';
import {
  bootstrapWorkspaceCloudSyncIfNeeded,
  prepareWorkspaceCloudBootstrapRetry,
  type WorkspaceCloudBootstrapResult,
} from '../../services/workspace/workspaceCloudBootstrapService';
import { resetCompanySession } from '../../services/brain/companySessionService';
import { isSupabaseConfigured } from '../../lib/supabase';
import { getCachedSetup } from '../../services/persistenceService';
import { t } from '../../i18n';
import { getWorkspaceStoreSnapshot } from '../../services/workspace/workspaceStore';
import { WorkspaceRestoreFailure, WorkspaceSetupNotFound } from './WorkspaceRestoreFailure';
import { WorkspaceCompanyConflict } from './WorkspaceCompanyConflict';
import { applyConfirmedLocalCompany } from '../../services/workspace/workspaceCompanyRecoveryService';
import type { CompanyConflictInfo } from '../../services/workspace/workspaceCompanyConflictService';

function BootstrapLoading() {
  const lang = getCachedSetup()?.language ?? 'de';
  return (
    <div className="bootstrap-loading" data-testid="bootstrap-loading">
      <p className="bootstrap-loading__text">{t('common.loading.app', lang)}</p>
    </div>
  );
}

interface BusinessStateGateProps {
  children: ReactNode;
}

export function BusinessStateGate({ children }: BusinessStateGateProps) {
  const { user, isAuthReady, isAuthenticated, isAllowed, logout } = useAuth();
  const [setup, setSetup] = useState<CompanySetup | null>(null);
  const [bootstrapKey, setBootstrapKey] = useState('guest');
  const bootstrappedUserRef = useRef<string | null | undefined>(undefined);
  const [restoreFailure, setRestoreFailure] = useState<string | null>(null);
  const [setupNotFound, setSetupNotFound] = useState(false);
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
        setSetup(guestResult.setup);
        setBootstrapKey('guest');
        bootstrappedUserRef.current = null;
        return;
      }

      // Freigabe erst nach optionalem Workspace-Bootstrap — kein AppProvider auf User-Default-Seed.
      setSetup(null);
      bootstrappedUserRef.current = nextUserId;

      const result = bootstrapBusinessState(nextUserId ? { userId: nextUserId } : {});
      const needsWorkspaceBootstrap =
        Boolean(nextUserId) && isAuthenticated && isAllowed && isSupabaseConfigured();

      if (needsWorkspaceBootstrap) {
        /**
         * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B2 — ein technischer Fehler darf nicht
         * wie ein neuer Kunde aussehen. Früher verschluckte ein leerer catch jeden
         * Fehler und gab den lokalen Default frei — der Nutzer landete still im
         * leeren Einrichtungsassistenten und hätte Cloud-Daten überschreiben können.
         */
        const result = await bootstrapWorkspaceCloudSyncIfNeeded().catch(
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
        if (
          !cloudSetup.setupComplete &&
          result.status !== 'new_workspace' &&
          !continueSetupRef.current
        ) {
          setSetupNotFound(true);
          setSetup(null);
          return;
        }
        setSetupNotFound(false);
        setSetup(cloudSetup);
        setBootstrapKey(workspaceId ? `${nextUserId}:${workspaceId}` : (nextUserId ?? 'guest'));
        return;
      }

      if (cancelled) return;
      setSetup(result.setup);
      setBootstrapKey(nextUserId ?? 'guest');
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthReady, isAuthenticated, isAllowed, user?.id, retryToken]);

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
        onConfirmUseLocal={() => {
          if (conflictBusy) return;
          setConflictBusy(true);
          setConflictChanged(false);
          setConflictError(null);
          void applyConfirmedLocalCompany({
            workspaceId: companyConflict.workspaceId,
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
                  outcome.persistFailed ? 'local_persist_failed' : outcome.failed.join(', '),
                );
                return;
              }
              if (outcome.status === 'failed') {
                setConflictError(outcome.message ?? 'unknown');
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
        onRecheck={() => {
          prepareWorkspaceCloudBootstrapRetry();
          setSetupNotFound(false);
          setRetryToken((value) => value + 1);
        }}
        onSwitchAccount={() => {
          void logout();
        }}
        onContinueSetup={() => {
          continueSetupRef.current = true;
          setSetupNotFound(false);
          setSetup(getCachedSetup());
          const workspaceId = getWorkspaceStoreSnapshot()?.id;
          setBootstrapKey(workspaceId ? `${user?.id}:${workspaceId}` : (user?.id ?? 'guest'));
        }}
      />
    );
  }

  if (!isAuthReady || !setup) {
    return <BootstrapLoading />;
  }

  return (
    <AppProvider key={bootstrapKey} initialSetup={setup}>
      {children}
    </AppProvider>
  );
}
