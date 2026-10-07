/**
 * CLOUD-SYNC S6 — ein Takt für Ansichten mit Auftrags- oder Nachtragsentwürfen.
 *
 * Er schlägt an, sobald lokal gespeichert wurde, sich die Warteschlange
 * bewegt oder ein Sync-Lauf seinen Status ändert — genau die Momente, in denen
 * ein Abzug einen Entwurf verändert, einen Konflikt vermerkt oder ein Ende
 * meldet. Die Ansicht liest danach ihren Entwurf neu; nichts wird hier
 * entschieden. Dieselben Quellen wie beim Rechnungsentwurf (S5).
 */
import { useEffect, useState } from 'react';
import { subscribeLocalMutations } from '../persistenceService';
import { subscribeSyncOutbox } from '../sync/syncOutboxService';
import { subscribeAutomaticSyncStatus } from '../sync/syncSchedulerRuntime';

export function useDraftCloudTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    const bump = () => {
      if (active) setTick((value) => value + 1);
    };
    const stopMutations = subscribeLocalMutations(bump);
    const stopOutbox = subscribeSyncOutbox(bump);
    // Der Status meldet sich beim Anmelden sofort einmal — das ist kein Ereignis.
    let first = true;
    const stopStatus = subscribeAutomaticSyncStatus(() => {
      if (first) {
        first = false;
        return;
      }
      bump();
    });
    return () => {
      active = false;
      stopMutations();
      stopOutbox();
      stopStatus();
    };
  }, []);
  return tick;
}
