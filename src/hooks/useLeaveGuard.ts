import { useCallback, useEffect, useRef } from 'react';
import { registerLeaveGuard, type LeaveGuardHandle } from '../services/navigation/leaveGuardRegistry';

/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.27) — ein Formular mit ungespeicherten Änderungen meldet sich beim Verlassen-Schutz an.
 *
 * `draftKept`: Die Eingaben bleiben als Entwurf erhalten (Wiederaufnahme), sonst gehen sie verloren — das sagt der Text
 * der Rückfrage. `release()` vor einer Navigation nach erfolgreichem Speichern: keine Rückfrage.
 */
export function useLeaveGuard(dirty: boolean, draftKept = false): { release: () => void } {
  const handle = useRef<LeaveGuardHandle | null>(null);

  useEffect(() => {
    const eigen = registerLeaveGuard();
    handle.current = eigen;
    return () => {
      eigen.dispose();
      if (handle.current === eigen) handle.current = null;
    };
  }, []);

  // Läuft nach der Anmeldung (Reihenfolge der Effekte), auch nach dem erneuten Einhängen unter StrictMode.
  useEffect(() => {
    handle.current?.update(dirty, draftKept);
  }, [dirty, draftKept]);

  const release = useCallback(() => handle.current?.release(), []);
  return { release };
}
