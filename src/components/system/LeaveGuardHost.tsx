import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import {
  dirtyGuardsKeepDrafts,
  getLeaveGuardVersion,
  hasDirtyLeaveGuard,
  setLeaveConfirmer,
  subscribeLeaveGuards,
} from '../../services/navigation/leaveGuardRegistry';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';

/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.27, X-01/X-02) — der Wächter für ungespeicherte Änderungen.
 *
 * - App-Links, Menüs, Browser-Zurück und -Vor: `useBlocker` (nur im Daten-Router der App; ohne ihn — etwa in
 *   Komponententests mit `MemoryRouter` — bleibt es beim Schutz vor Neuladen und Schließen).
 * - Neuladen und Schließen: `beforeunload` mit der Rückfrage des Browsers.
 * - Abmelden und Betriebswechsel aus dem Benutzermenü: `confirmLeaveIfDirty` öffnet dieselbe Rückfrage.
 * Rückfrage „Ungespeicherte Änderungen“ mit „Bleiben“ (Fokus) und „Verlassen“; der Text sagt, ob ein Entwurf bleibt.
 * Ein Wechsel nur des Ankers (#…) auf derselben Seite fragt nicht.
 */
export function LeaveGuardHost() {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  return dataRouter ? <RouterLeaveGuard /> : <LeaveGuardDialog blocked={false} onStay={() => undefined} onLeave={() => undefined} />;
}

function useDirty(): { dirty: boolean; draftKept: boolean } {
  useSyncExternalStore(subscribeLeaveGuards, getLeaveGuardVersion, getLeaveGuardVersion);
  return { dirty: hasDirtyLeaveGuard(), draftKept: dirtyGuardsKeepDrafts() };
}

function RouterLeaveGuard() {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasDirtyLeaveGuard() && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );
  return (
    <LeaveGuardDialog
      blocked={blocker.state === 'blocked'}
      onStay={() => {
        if (blocker.state === 'blocked') blocker.reset();
      }}
      onLeave={() => {
        if (blocker.state === 'blocked') blocker.proceed();
      }}
    />
  );
}

function LeaveGuardDialog({ blocked, onStay, onLeave }: { blocked: boolean; onStay: () => void; onLeave: () => void }) {
  const { translate } = useApp();
  const { dirty, draftKept } = useDirty();
  const [anfrage, setAnfrage] = useState<((weiter: boolean) => void) | null>(null);
  const anfrageRef = useRef<((weiter: boolean) => void) | null>(null);

  // Abmelden und Betriebswechsel fragen über die Registrierung nach.
  useEffect(() => {
    setLeaveConfirmer(
      () =>
        new Promise<boolean>((resolve) => {
          anfrageRef.current?.(false);
          anfrageRef.current = resolve;
          setAnfrage(() => resolve);
        }),
    );
    return () => {
      setLeaveConfirmer(null);
      anfrageRef.current?.(false);
      anfrageRef.current = null;
    };
  }, []);

  // Neuladen und Schließen: die Rückfrage des Browsers (der Text darin ist nicht beeinflussbar).
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasDirtyLeaveGuard()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const beende = (weiter: boolean) => {
    const resolve = anfrageRef.current;
    anfrageRef.current = null;
    setAnfrage(null);
    resolve?.(weiter);
  };

  return (
    <SimpleConfirmDialog
      open={blocked || anfrage !== null}
      title={translate('leaveGuard.title')}
      message={translate(draftKept ? 'leaveGuard.textDraft' : 'leaveGuard.textLost')}
      confirmLabel={translate('leaveGuard.leave')}
      cancelLabel={translate('leaveGuard.stay')}
      confirmVariant="danger"
      confirmTestId="leave-guard-leave"
      cancelTestId="leave-guard-stay"
      dialogTestId="leave-guard-dialog"
      onConfirm={() => {
        onLeave();
        beende(true);
        return true;
      }}
      onCancel={() => {
        onStay();
        beende(false);
      }}
    />
  );
}
