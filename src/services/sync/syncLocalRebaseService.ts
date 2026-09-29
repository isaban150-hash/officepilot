/**
 * SYNC-AUTOMATIK-01A — lokale Änderungen, die **während** eines Sync-Laufs
 * gespeichert wurden, gehen beim Anwenden des Ergebnisses nicht verloren.
 *
 * Der Lauf rechnet auf dem Stand, der bei seinem Start galt (`base`). Zwischen
 * Start und Anwenden liegen Netzwerk-`await`s; speichert der Nutzer in diesem
 * Fenster, trägt der Speicher (`local`) einen neueren Stand als der Kandidat
 * (`candidate`). Bisher ersetzte der Kandidat den Speicher vollständig — die
 * neue Eingabe verschwand lautlos, und weil ihr Sendeauftrag im selben Zug als
 * erledigt galt, kam sie auch nie in die Cloud.
 *
 * Hier wird dreiseitig zusammengeführt, pro Entität:
 *
 *   - Hat sich lokal nichts geändert, gilt der Kandidat.
 *   - Hat der Lauf die Entität nicht berührt, gilt der lokale Stand.
 *   - Hat der Lauf **nur Sync-Metadaten** geändert (Serverversion nach dem
 *     eigenen Push, Cloud-Pfad einer Datei), wird die lokale Änderung auf diese
 *     Metadaten gesetzt. Der nächste Push trägt damit die richtige Version.
 *   - Hat der Lauf auch **Inhalt** geändert (Cloud-Änderung eines anderen
 *     Geräts) und lokal wurde ebenfalls geändert, bleibt der lokale Stand
 *     vollständig — **mit seiner alten Version**. Der Server prüft diese exakt
 *     und meldet einen Konflikt; nie ein stilles Überschreiben in eine der
 *     beiden Richtungen (kein Last-Write-Wins).
 *
 * Sendeaufträge: Wurde ein Auftrag während des Laufs erneut eingereiht (neue
 * Änderung an derselben Entität), darf das Push-Ergebnis „erledigt" ihn nicht
 * schliessen — gesendet wurde der ältere Inhalt. Er bleibt offen.
 *
 * Der Dienst ist rein: keine Speicher, kein Netz, keine Persistenz.
 */
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

/** Felder, die ein Sync-Lauf an einer Entität setzen darf, ohne dass es eine Inhaltsänderung ist. */
const META_KEYS = new Set(['sync', 'cloud', 'version', 'updatedAt', 'pendingKeys']);

/** Vom Rebase ausgenommen: Kennung des Speicherformats, Geräteidentität, Outbox (eigene Regel), Zeitstempel. */
const SKIPPED_TOP_LEVEL_KEYS = new Set(['version', 'syncClient', 'syncOutbox', 'savedAt']);

/** Schlüssel-Wert-Bestände, die pro Schlüssel zusammengeführt werden. */
const RECORD_TOP_LEVEL_KEYS = new Set(['documentFileBlobs']);

/** Objekte, deren Felder eigenständige Sammlungen sind. */
const NESTED_COLLECTION_TOP_LEVEL_KEYS = new Set(['officePilotMemory']);

export interface LocalRebaseResult {
  state: AppPersistedState;
  /** Entitäten, deren lokale Änderung aus dem Lauf-Fenster übernommen wurde. */
  preservedLocalChanges: number;
  /** Davon: lokal und im Lauf inhaltlich geändert — der Server entscheidet per Version. */
  contentConflicts: number;
  /** Sendeaufträge, die trotz Push-Erfolg offen bleiben, weil neuer Inhalt wartet. */
  reopenedOutboxEntries: number;
}

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strukturgleichheit; ein fehlender Schlüssel und `undefined` gelten als gleich. */
export function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!isDeepEqual(a[index], b[index])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!isDeepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function laterTimestamp(a: unknown, b: unknown): unknown {
  if (typeof a === 'string' && typeof b === 'string') return a >= b ? a : b;
  return a ?? b;
}

function assign(target: Plain, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

interface MergeOutcome {
  value: unknown;
  /** Lokal geändert und übernommen. */
  preserved: boolean;
  conflict: boolean;
}

/** Sync-Metadaten (`sync`, `cloud`): Serverfelder aus dem Lauf, lokale Tombstone-Felder bleiben. */
function mergeMetaObject(base: unknown, local: unknown, candidate: unknown): unknown {
  if (isDeepEqual(local, base)) return candidate;
  if (isDeepEqual(candidate, base) || isDeepEqual(local, candidate)) return local;
  if (!isPlainObject(local) || !isPlainObject(candidate)) return candidate;
  const b = isPlainObject(base) ? base : {};
  const result: Plain = { ...local };
  for (const key of new Set([...Object.keys(candidate), ...Object.keys(b)])) {
    if (isDeepEqual(candidate[key], b[key])) continue;
    if (isDeepEqual(local[key], b[key])) {
      assign(result, key, candidate[key]);
    } else if (key === 'updatedAt' || key === 'deletedAt' || key === 'uploadedAt') {
      assign(result, key, laterTimestamp(local[key], candidate[key]));
    } else if (key === 'version') {
      // Die Version kennt nur der Server — lokal wird sie nie hochgezählt.
      assign(result, key, candidate[key]);
    }
    // alles andere: die lokale Angabe bleibt
  }
  return result;
}

/**
 * Eine Entität dreiseitig zusammenführen. Konflikt heisst: Der Lauf hat Inhalt
 * geändert, und lokal wurde ebenfalls geändert — dann bleibt der lokale Stand
 * unverändert, einschliesslich seiner Version.
 */
function mergeEntity(base: unknown, local: unknown, candidate: unknown): MergeOutcome {
  if (isDeepEqual(local, base)) return { value: candidate, preserved: false, conflict: false };
  if (isDeepEqual(candidate, base)) return { value: local, preserved: true, conflict: false };
  if (isDeepEqual(local, candidate)) return { value: candidate, preserved: false, conflict: false };
  if (!isPlainObject(base) || !isPlainObject(local) || !isPlainObject(candidate)) {
    return { value: local, preserved: true, conflict: true };
  }

  const changedByRun = [...new Set([...Object.keys(candidate), ...Object.keys(base)])].filter(
    (key) => !isDeepEqual(candidate[key], base[key]),
  );
  if (changedByRun.some((key) => !META_KEYS.has(key))) {
    return { value: local, preserved: true, conflict: true };
  }

  const result: Plain = { ...local };
  for (const key of changedByRun) {
    if (isDeepEqual(local[key], base[key])) {
      assign(result, key, candidate[key]);
    } else if (key === 'sync' || key === 'cloud') {
      assign(result, key, mergeMetaObject(base[key], local[key], candidate[key]));
    } else if (key === 'updatedAt') {
      assign(result, key, laterTimestamp(local[key], candidate[key]));
    } else if (key === 'version') {
      assign(result, key, candidate[key]);
    }
    // pendingKeys: beide geändert → die lokale Absicht bleibt stehen
  }
  return { value: result, preserved: true, conflict: false };
}

function identityOf(item: unknown): string | null {
  if (!isPlainObject(item)) return null;
  if (typeof item.id === 'string' && item.id) return `id:${item.id}`;
  if (typeof item.inboxItemId === 'string' && item.inboxItemId) return `inbox:${item.inboxItemId}`;
  if (typeof item.documentId === 'string' && typeof item.kind === 'string') {
    return `binding:${item.documentId}|${item.kind}|${typeof item.part === 'string' ? item.part : ''}`;
  }
  if (typeof item.workspaceId === 'string' && typeof item.userId === 'string') {
    return `member:${item.workspaceId}:${item.userId}`;
  }
  return null;
}

function indexCollection(items: unknown[]): Map<string, unknown> | null {
  const byId = new Map<string, unknown>();
  for (const item of items) {
    const id = identityOf(item);
    if (id === null || byId.has(id)) return null;
    byId.set(id, item);
  }
  return byId;
}

interface Tally {
  preserved: number;
  conflicts: number;
}

function mergeCollection(base: unknown, local: unknown, candidate: unknown, tally: Tally): unknown {
  if (isDeepEqual(local, base)) return candidate;
  if (isDeepEqual(candidate, base) || isDeepEqual(local, candidate)) {
    if (!isDeepEqual(local, candidate)) tally.preserved += 1;
    return local;
  }
  const b = Array.isArray(base) ? base : [];
  const l = Array.isArray(local) ? local : [];
  const c = Array.isArray(candidate) ? candidate : [];
  const baseById = indexCollection(b);
  const localById = indexCollection(l);
  const candidateById = indexCollection(c);
  if (!baseById || !localById || !candidateById) {
    // Ohne eindeutige Kennungen kein Teilmerge: der lokale Stand bleibt.
    tally.preserved += 1;
    tally.conflicts += 1;
    return local;
  }

  const result: unknown[] = [];
  for (const item of l) {
    const id = identityOf(item)!;
    const baseItem = baseById.get(id);
    if (!candidateById.has(id)) {
      // Lokal neu → bleibt. War es schon vorher da und der Lauf hat es entfernt, gilt die lokale Änderung nur, wenn es eine gibt.
      if (baseItem === undefined || !isDeepEqual(item, baseItem)) {
        result.push(item);
        tally.preserved += 1;
      }
      continue;
    }
    const outcome = mergeEntity(baseItem, item, candidateById.get(id));
    if (outcome.preserved) tally.preserved += 1;
    if (outcome.conflict) tally.conflicts += 1;
    result.push(outcome.value);
  }
  for (const item of c) {
    const id = identityOf(item)!;
    if (localById.has(id)) continue;
    const baseItem = baseById.get(id);
    // Lokal entfernt und im Lauf unverändert → bleibt entfernt; sonst gewinnt nichts still.
    if (baseItem !== undefined && isDeepEqual(item, baseItem)) continue;
    result.push(item);
  }
  return result;
}

function mergeRecord(base: unknown, local: unknown, candidate: unknown, tally: Tally): unknown {
  if (isDeepEqual(local, base)) return candidate;
  const b = isPlainObject(base) ? base : {};
  const l = isPlainObject(local) ? local : {};
  const c = isPlainObject(candidate) ? candidate : {};
  const result: Plain = { ...c };
  for (const key of new Set([...Object.keys(l), ...Object.keys(b)])) {
    if (isDeepEqual(l[key], b[key])) continue;
    tally.preserved += 1;
    if (!isDeepEqual(c[key], b[key]) && !isDeepEqual(c[key], l[key])) tally.conflicts += 1;
    assign(result, key, l[key]);
  }
  return result;
}

function mergeNestedCollections(base: unknown, local: unknown, candidate: unknown, tally: Tally): unknown {
  if (isDeepEqual(local, base)) return candidate;
  const b = isPlainObject(base) ? base : {};
  const l = isPlainObject(local) ? local : {};
  const c = isPlainObject(candidate) ? candidate : {};
  const result: Plain = { ...c };
  for (const key of new Set([...Object.keys(l), ...Object.keys(c), ...Object.keys(b)])) {
    const merged = Array.isArray(l[key]) || Array.isArray(c[key])
      ? mergeCollection(b[key], l[key], c[key], tally)
      : mergeTopLevelValue(b[key], l[key], c[key], tally);
    assign(result, key, merged);
  }
  return result;
}

function mergeTopLevelValue(base: unknown, local: unknown, candidate: unknown, tally: Tally): unknown {
  if (Array.isArray(local) || Array.isArray(candidate)) {
    return mergeCollection(base, local, candidate, tally);
  }
  const outcome = mergeEntity(base, local, candidate);
  if (outcome.preserved) tally.preserved += 1;
  if (outcome.conflict) tally.conflicts += 1;
  return outcome.value;
}

/** Wurde dieser Auftrag nach dem Laufstart erneut eingereiht? */
function wasRequeuedDuringRun(baseEntry: SyncOutboxEntry | undefined, localEntry: SyncOutboxEntry): boolean {
  if (!baseEntry) return false;
  return (
    baseEntry.queuedAt !== localEntry.queuedAt ||
    baseEntry.version !== localEntry.version ||
    baseEntry.operation !== localEntry.operation
  );
}

/**
 * Die Outbox: Für bekannte Aufträge ist der Kandidat der neuere Stand (Push-
 * Ergebnisse). Ausnahme: im Lauf-Fenster erneut eingereiht — dann bleibt der
 * Auftrag offen. Aufträge, die der Kandidat nicht kennt, kommen dazu.
 */
export function mergeOutboxWithLocalChanges(
  baseOutbox: SyncOutboxEntry[],
  localOutbox: SyncOutboxEntry[],
  candidateOutbox: SyncOutboxEntry[],
): { outbox: SyncOutboxEntry[]; reopened: number } {
  const baseById = new Map(baseOutbox.map((entry) => [entry.id, entry]));
  const localById = new Map(localOutbox.map((entry) => [entry.id, entry]));
  const candidateIds = new Set(candidateOutbox.map((entry) => entry.id));
  let reopened = 0;

  const merged = candidateOutbox.map((candidateEntry) => {
    const localEntry = localById.get(candidateEntry.id);
    if (!localEntry || !wasRequeuedDuringRun(baseById.get(candidateEntry.id), localEntry)) {
      return candidateEntry;
    }
    const keepsBetaBlock = localEntry.status === 'blocked' && localEntry.blockedReason === 'beta_mode';
    if (candidateEntry.status !== 'pending') reopened += 1;
    const confirmed = candidateEntry.status === 'completed';
    return {
      ...candidateEntry,
      operation: localEntry.operation,
      version: localEntry.version,
      queuedAt: localEntry.queuedAt,
      status: keepsBetaBlock ? 'blocked' : 'pending',
      blockedReason: keepsBetaBlock ? localEntry.blockedReason : undefined,
      retryCount: confirmed ? 0 : candidateEntry.retryCount,
      // Der bestätigte Sendenachweis beschreibt den älteren Inhalt, nicht den wartenden.
      sentContentKey: confirmed ? undefined : candidateEntry.sentContentKey,
      sentDeleted: confirmed ? undefined : candidateEntry.sentDeleted,
      sentAt: confirmed ? undefined : candidateEntry.sentAt,
    } satisfies SyncOutboxEntry;
  });

  const addedDuringRun = localOutbox.filter((entry) => !candidateIds.has(entry.id));
  return { outbox: [...merged, ...addedDuringRun], reopened };
}

/**
 * Den Kandidaten eines Laufs auf den inzwischen neueren lokalen Stand setzen.
 * `base` ist der Stand beim Laufstart, `local` der aktuelle Speicher.
 */
export function rebaseSyncCandidateOntoLocalChanges(input: {
  base: AppPersistedState;
  local: AppPersistedState;
  candidate: AppPersistedState;
}): LocalRebaseResult {
  const { base, local, candidate } = input;
  const tally: Tally = { preserved: 0, conflicts: 0 };
  const next: Plain = { ...(candidate as unknown as Plain) };
  const b = base as unknown as Plain;
  const l = local as unknown as Plain;
  const c = candidate as unknown as Plain;

  for (const key of new Set([...Object.keys(l), ...Object.keys(c), ...Object.keys(b)])) {
    if (SKIPPED_TOP_LEVEL_KEYS.has(key)) continue;
    let merged: unknown;
    if (RECORD_TOP_LEVEL_KEYS.has(key)) merged = mergeRecord(b[key], l[key], c[key], tally);
    else if (NESTED_COLLECTION_TOP_LEVEL_KEYS.has(key)) merged = mergeNestedCollections(b[key], l[key], c[key], tally);
    else merged = mergeTopLevelValue(b[key], l[key], c[key], tally);
    assign(next, key, merged);
  }

  const outbox = mergeOutboxWithLocalChanges(
    base.syncOutbox ?? [],
    local.syncOutbox ?? [],
    candidate.syncOutbox ?? [],
  );
  next.syncOutbox = outbox.outbox;

  return {
    state: next as unknown as AppPersistedState,
    preservedLocalChanges: tally.preserved,
    contentConflicts: tally.conflicts,
    reopenedOutboxEntries: outbox.reopened,
  };
}
