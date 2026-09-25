/**
 * FINANZ-SYNC-BLOCKER-01C — Kontierungen und Monatsabschlüsse aus der Cloud holen.
 *
 * 01B hat den Sendeweg repariert. Was blieb, war die andere Richtung: Beide
 * Lesefunktionen existierten am Server, die Kontierungs-Hülle sogar im Client —
 * nur rief sie niemand auf. Ein zweites Gerät oder eine frische Anmeldung sah
 * deshalb **keine** Kontierung und **keinen** Abschluss, obwohl beides in der
 * Cloud lag.
 *
 * Dieser Dienst ist der eine Ort, an dem der Pull beider Typen zusammenläuft:
 * holen, zusammenführen, in den Anwendungszustand legen. Er hängt im normalen
 * `pullChanges` des Supabase-Adapters — demselben Weg, den Anmeldung,
 * Arbeitsbereichswechsel und der Sync-Knopf nehmen. Kein Sonderpfad, keine
 * zweite Ladewelt.
 *
 * Der Zustand, den er zurückgibt, reist über den bestehenden
 * Persistenzkandidaten in `applySyncPullCandidateSafely`; dessen
 * `applyStateToStores` hydriert beide Kontierungsspeicher bereits seit 06A.
 */
import type { AppPersistedState } from '../../types/models';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncOutboxEntry } from '../../types/sync';
import {
  collectDirtyAccountingKeys,
  mergeAccountingFromPull,
  rpcPullWorkspaceAccountingAssignments,
  type AccountingCloudPull,
} from './accountingCloudSyncService';
import {
  collectDirtyAccountingPeriodKeys,
  mergeAccountingPeriodClosuresFromPull,
  rpcPullWorkspaceAccountingPeriodClosures,
  type AccountingPeriodCloudPull,
} from './accountingPeriodCloudSyncService';

export interface AccountingCloudPullBundle {
  assignments: AccountingCloudPull;
  closures: AccountingPeriodCloudPull;
}

/**
 * Beide Lesefunktionen in einem Zug.
 *
 * Nacheinander, nicht parallel: Schlägt die erste mit „Kein Zugriff" fehl, ist
 * es die Rollenregel und nicht ein Fehler — dann hat auch die zweite nichts zu
 * sagen, und ein paralleler Aufruf hätte nur eine zweite Fehlermeldung
 * erzeugt.
 */
export async function pullWorkspaceAccountingFromCloud(
  workspaceId: string,
  explicit?: SupabaseClient | null,
): Promise<AccountingCloudPullBundle> {
  const assignments = await rpcPullWorkspaceAccountingAssignments(workspaceId, explicit);
  const closures = await rpcPullWorkspaceAccountingPeriodClosures(workspaceId, explicit);
  return { assignments, closures };
}

export interface AccountingPullApplyResult {
  state: AppPersistedState;
  counts: { assignments: number; closures: number };
  /** `<entityType>:<id>` — dieselbe Form wie beim Ausgaben-Pull. */
  conflicts: string[];
}

/**
 * Den gezogenen Stand in den Anwendungszustand legen.
 *
 * Die Schutzregel ist in beiden Fällen dieselbe und kommt aus der Outbox: Wo
 * ein aktiver Sendeauftrag liegt, ist der lokale Stand neuer als alles, was die
 * Cloud dazu sagen kann. Er bleibt stehen und der Konflikt wird benannt — eine
 * verlorene Bestätigung wäre eine verlorene Zusage, eine überschriebene
 * Revision ein gefälschter Nachweis.
 */
export function applyAccountingPullToState(
  state: AppPersistedState,
  pull: AccountingCloudPullBundle,
  context: { deviceId: string; workspaceId: string; outbox: SyncOutboxEntry[] | undefined },
): AccountingPullApplyResult {
  const scope = { deviceId: context.deviceId, workspaceId: context.workspaceId };

  const assignmentMerge = mergeAccountingFromPull(
    state.accountingAssignments ?? [],
    pull.assignments,
    collectDirtyAccountingKeys(context.outbox),
    scope,
  );

  const closureMerge = mergeAccountingPeriodClosuresFromPull(
    state.accountingPeriodClosures ?? [],
    pull.closures,
    collectDirtyAccountingPeriodKeys(context.outbox),
    scope,
  );

  return {
    state: {
      ...state,
      accountingAssignments: assignmentMerge.assignments,
      accountingPeriodClosures: closureMerge.closures,
    },
    counts: {
      assignments:
        assignmentMerge.counts.added + assignmentMerge.counts.updated + assignmentMerge.counts.removed,
      closures: closureMerge.counts.added + closureMerge.counts.updated,
    },
    conflicts: [
      ...assignmentMerge.conflicts.map((id) => `accounting_assignment:${id}`),
      ...closureMerge.conflicts.map((id) => `accounting_period_closure:${id}`),
    ],
  };
}
