/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4C — gemeinsame Serialisierung
 * für Abläufe, die Cloud-Lesung **und** anschließende lokale Persistenz
 * umfassen.
 *
 * Der Dienst importiert bewusst nichts: weder Coordinator noch Persistenz,
 * Invoice- oder UI-Dienste. Er kennt nur `() => Promise<T>`.
 *
 * **Nur tablokal.** Zwei Tabs besitzen getrennte Modulinstanzen; diese Queue
 * ist ausdrücklich **kein** tabübergreifender Schutz.
 *
 * Keine verschachtelte Anforderung: ein Callback darf `runQueuedSyncOperation`
 * nicht erneut aufrufen — er würde auf sich selbst warten.
 */

/** Kette der bereits eingereihten Läufe; Fehler brechen sie nie ab. */
let queueTail: Promise<void> = Promise.resolve();

/**
 * Nachweis eines **aktuell laufenden** Queue-Laufs. Das Kennzeichen ist ein
 * modulprivates Symbol — die Lease ist außerhalb dieses Moduls weder
 * erzeugbar noch fälschbar.
 */
const SYNC_OPERATION_LEASE = Symbol('officepilot-sync-operation-lease');

export interface SyncOperationLease {
  readonly [SYNC_OPERATION_LEASE]: true;
}

/**
 * Nur die tatsächlich laufenden Leases. Eine gespeicherte Lease verliert ihre
 * Wirkung, sobald ihr Callback beendet ist — eine Typmarke allein würde das
 * nicht leisten.
 */
const activeLeases = new WeakSet<SyncOperationLease>();

export function isActiveSyncOperationLease(lease: unknown): lease is SyncOperationLease {
  if (typeof lease !== 'object' || lease === null) return false;
  return activeLeases.has(lease as SyncOperationLease);
}

export function runQueuedSyncOperation<T>(
  operation: (lease: SyncOperationLease) => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    const lease = Object.freeze({ [SYNC_OPERATION_LEASE]: true }) as SyncOperationLease;
    activeLeases.add(lease);
    try {
      return await operation(lease);
    } finally {
      // Nach Erfolg **und** nach einem Wurf ist die Lease ungültig.
      activeLeases.delete(lease);
    }
  };

  /*
   * FIFO: Der Callback startet erst, wenn der vorherige Lauf vollständig
   * beendet ist — einschließlich seiner Persistenz. Snapshots entstehen
   * dadurch erst beim tatsächlichen Start, nicht beim Einreihen.
   */
  const start = queueTail.then(run, run);
  // Die Kette läuft auch nach einem Wurf weiter; niemand erbt ein Ergebnis.
  queueTail = start.then(
    () => undefined,
    () => undefined,
  );
  return start;
}

export function resetSyncOperationQueueForTests(): void {
  queueTail = Promise.resolve();
}
