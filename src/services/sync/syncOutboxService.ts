import { isBetaTestMode } from '../../config/betaTestMode';
import type {
  SyncEntityType,
  SyncOutboxEntry,
  SyncOutboxOperation,
  SyncOutboxStatus,
} from '../../types/sync';
import { generateUuid } from './syncMetaService';
import { getSyncClient } from './syncClientService';
import { isFinallyDeniedOutboxEntry } from './syncRoleDenial';

let outbox: SyncOutboxEntry[] = [];

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01C — der Hinweis „Cloud-Sicherung steht aus"
 * muss verschwinden, sobald die Übertragung geglückt ist. Dafür meldet die
 * Outbox jede Änderung; keine zweite Sync-Architektur, nur eine Benachrichtigung.
 */
type OutboxListener = () => void;
const outboxListeners = new Set<OutboxListener>();

export function subscribeSyncOutbox(listener: OutboxListener): () => void {
  outboxListeners.add(listener);
  return () => {
    outboxListeners.delete(listener);
  };
}

function notifyOutboxChanged(): void {
  for (const listener of [...outboxListeners]) listener();
}

const ACTIVE_OUTBOX_STATUSES: SyncOutboxStatus[] = ['pending', 'blocked', 'error'];

function resolveOutboxStatus(): SyncOutboxStatus {
  if (isBetaTestMode()) {
    return 'blocked';
  }
  return 'pending';
}

function mergeOutboxEntry(
  existing: SyncOutboxEntry,
  input: EnqueueSyncOutboxInput,
  status: SyncOutboxStatus,
): SyncOutboxEntry {
  return {
    ...existing,
    operation: input.operation,
    version: input.version,
    queuedAt: new Date().toISOString(),
    status: existing.status === 'error' ? 'pending' : status,
    retryCount: existing.status === 'error' ? 0 : existing.retryCount,
    blockedReason: status === 'blocked' ? existing.blockedReason ?? 'beta_mode' : undefined,
  };
}

export function hydrateSyncOutbox(entries: SyncOutboxEntry[]): void {
  outbox = entries.map((entry) => ({ ...entry }));
  notifyOutboxChanged();
}

export function getSyncOutboxSnapshot(): SyncOutboxEntry[] {
  return outbox.map((entry) => ({ ...entry }));
}

export function resetSyncOutboxForTests(entries: SyncOutboxEntry[] = []): void {
  outbox = entries.map((entry) => ({ ...entry }));
  notifyOutboxChanged();
}

export interface EnqueueSyncOutboxInput {
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOutboxOperation;
  version: number;
}

/**
 * Der Einreihungsweg für BEWUSSTE Nutzeraktionen: der Änderungsverfolger nach einer lokalen
 * Änderung, Fachdienste hinter einem Klick, „Meine Fassung behalten“.
 *
 * GO-LIVE-SECURITY-01 / KONTOSPERRE — eine bewusste neue Aktion löst eine endgültige
 * Berechtigungsabweisung derselben Entität ab: Der alte Auftrag gilt als erledigt (er wird
 * nie gesendet), der neue geht normal hinaus. Automatische Wege (Abgleich, Backfill,
 * Nachmeldung, Wiederaufnahme) nehmen `enqueueBackfillSyncOutbox` und lösen nichts ab.
 */
export function enqueueSyncOutbox(input: EnqueueSyncOutboxInput): SyncOutboxEntry {
  supersedeFinallyDeniedEntries(input.entityType, input.entityId);
  return enqueueOutboxEntry(input);
}

function supersedeFinallyDeniedEntries(entityType: SyncEntityType, entityId: string): void {
  let changed = false;
  outbox = outbox.map((entry) => {
    if (entry.entityType !== entityType || entry.entityId !== entityId || !isFinallyDeniedOutboxEntry(entry)) {
      return entry;
    }
    changed = true;
    return { ...entry, status: 'completed' as const };
  });
  if (changed) notifyOutboxChanged();
}

function enqueueOutboxEntry(input: EnqueueSyncOutboxInput): SyncOutboxEntry {
  const status = resolveOutboxStatus();
  const existingIndex = outbox.findIndex(
    (entry) =>
      entry.entityType === input.entityType &&
      entry.entityId === input.entityId &&
      ACTIVE_OUTBOX_STATUSES.includes(entry.status),
  );

  if (existingIndex >= 0) {
    const merged = mergeOutboxEntry(outbox[existingIndex], input, status);
    outbox = [merged, ...outbox.filter((_, index) => index !== existingIndex)];
    notifyOutboxChanged();
    return { ...merged };
  }

  const entry: SyncOutboxEntry = {
    id: generateUuid(),
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    version: input.version,
    queuedAt: new Date().toISOString(),
    retryCount: 0,
    status,
    blockedReason: isBetaTestMode() ? 'beta_mode' : undefined,
  };
  outbox = [entry, ...outbox];
  notifyOutboxChanged();
  return { ...entry };
}

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — true, solange Firmendaten noch nicht in
 * der Cloud liegen. Grundlage für den sichtbaren Hinweis „nur lokal gespeichert“.
 */
export function hasPendingCompanyCloudBackup(): boolean {
  return outbox.some(
    (entry) =>
      (entry.entityType === 'company_setup' || entry.entityType === 'company_profile') &&
      ACTIVE_OUTBOX_STATUSES.includes(entry.status),
  );
}

/**
 * REAL-DEVICE-CLOUD-COMPANY-IDENTICAL-COMPLETE-01 — schließt genau einen
 * gegenstandslosen Firmen-Auftrag ab: lokaler und Cloud-Payload sind bereits
 * identisch, es bleibt nur eine Versionshistorie.
 *
 * Bewusst eng: nur `company_setup`/`company_profile`, nur der übergebene
 * Workspace, und nur der Status `blocked`. `blocked` heißt, dass der letzte
 * Push an einem Versionskonflikt scheiterte und seither **keine** neue lokale
 * Inhaltsänderung kam — denn jede solche Änderung setzt den vorhandenen
 * aktiven Eintrag über `enqueueSyncOutbox`/`mergeOutboxEntry` wieder auf
 * `pending`. Damit kann ein neuerer lokaler Stand hier nicht verloren gehen.
 *
 * Kein „complete all blocked", keine local-only-Entitäten, kein Löschen.
 *
 * 01C — bewusst **seiteneffektfrei**: reine Transformation über ein übergebenes
 * Array. Kein Schreiben in `outbox`, kein `notifyOutboxChanged`, keine
 * Persistenz, keine Hydrierung. Das Ergebnis reist im Persisted-State-Kandidaten
 * und wird erst an der bestehenden Persistenzgrenze wirksam.
 */
export function completeIdenticalCompanyCloudOutboxEntry(
  entries: SyncOutboxEntry[],
  entityType: 'company_setup' | 'company_profile',
  entityId: string,
): { outbox: SyncOutboxEntry[]; completed: boolean } {
  const target = entries.find(
    (entry) =>
      entry.entityType === entityType && entry.entityId === entityId && entry.status === 'blocked',
  );
  if (!target) return { outbox: entries, completed: false };

  return {
    outbox: entries.map((entry) =>
      entry.id === target.id ? { ...entry, status: 'completed', blockedReason: undefined } : entry,
    ),
    completed: true,
  };
}

/**
 * SYNC-DURABILITY-01G5 — ein ungeklärter Sendenachweis je aktivem
 * Schreibvorgang.
 *
 * Der Nachweis beschreibt den fachlichen Stand, der gerade abgeschickt wird.
 * Er wird gebraucht, wenn die Bestätigung im Funkloch verschwindet: Nur an ihm
 * ist später erkennbar, ob die neuere Serverfassung der eigene Schreibvorgang
 * war oder die Arbeit eines anderen Geräts.
 *
 * Deshalb gilt: **Solange er ungeklärt ist, bleibt er stehen.** Würde ein
 * späterer Schreibvorgang ihn überschreiben, wäre die Serverfassung aus dem
 * ersten nie mehr zuzuordnen — der Auftrag bliebe für immer liegen. Aufgelöst
 * wird er allein durch die Klärung selbst (`clearOutboxSentProof`), nicht durch
 * neue Arbeit.
 */
export function recordOutboxSentProof(
  outboxId: string,
  proof: { sentContentKey?: string; sentDeleted: boolean },
): boolean {
  const entry = outbox.find((item) => item.id === outboxId);
  /*
   * SYNC-DURABILITY-01G6 — kein stilles Scheitern.
   *
   * Ist der Auftrag hier nicht auffindbar, gibt es nichts, woran ein Nachweis
   * haften könnte. Früher kehrte diese Funktion dann wortlos zurück und der
   * Sendeweg schickte trotzdem los — der Server wäre weiter als der Client
   * gewesen, ohne dass irgendetwas den eigenen Schreibvorgang später
   * wiedererkennbar macht. Der Aufrufer erfährt es jetzt.
   */
  if (!entry) return false;

  const ungeklaert =
    entry.status !== 'completed' &&
    entry.status !== 'failed' &&
    (entry.sentContentKey !== undefined || entry.sentDeleted !== undefined);
  // Ein noch ungeklärter Nachweis bleibt stehen — und er **ist** der Nachweis.
  if (ungeklaert) return true;

  outbox = outbox.map((item) =>
    item.id === outboxId ? { ...item, ...proof, sentAt: new Date().toISOString() } : item,
  );
  notifyOutboxChanged();
  return true;
}

/**
 * 01G5 — die Klärung hebt den Nachweis auf: Der Wiederanlauf hat entschieden,
 * ob die Serverfassung die eigene war. Danach beschreibt der Nachweis nichts
 * Offenes mehr und darf einem neuen Schreibvorgang weichen.
 */
export function clearOutboxSentProof(entityType: SyncEntityType, entityIds: string[]): void {
  if (entityIds.length === 0) return;
  const ids = new Set(entityIds);
  outbox = outbox.map((entry) =>
    entry.entityType === entityType && ids.has(entry.entityId)
      ? { ...entry, sentContentKey: undefined, sentDeleted: undefined, sentAt: undefined }
      : entry,
  );
  notifyOutboxChanged();
}

/** Die noch ungeklärten Sendenachweise eines Typs. */
export function getUnresolvedSentProofs(
  entityType: SyncEntityType,
): ReadonlyMap<string, { contentKey?: string; deleted: boolean }> {
  const proofs = new Map<string, { contentKey?: string; deleted: boolean }>();
  for (const entry of outbox) {
    if (entry.entityType !== entityType) continue;
    if (entry.status === 'completed' || entry.status === 'failed') continue;
    if (entry.sentContentKey === undefined && entry.sentDeleted === undefined) continue;
    proofs.set(entry.entityId, {
      contentKey: entry.sentContentKey,
      deleted: entry.sentDeleted === true,
    });
  }
  return proofs;
}

export function markOutboxEntriesCompleted(outboxIds: string[]): void {
  if (outboxIds.length === 0) return;
  const completedIds = new Set(outboxIds);
  outbox = outbox.map((entry) =>
    completedIds.has(entry.id) ? { ...entry, status: 'completed' } : entry,
  );
  notifyOutboxChanged();
}

/**
 * FINANZ-SYNC-BLOCKER-01B — ein Fehlschlag pro Auftrag, nicht einer fuer alle.
 *
 * Vorher bekam diese Funktion nur eine Liste von Kennungen und **einen**
 * Grund — den des ersten Fehlschlags. Zwei Folgen hatte das:
 *
 *   1. Jeder Auftrag trug denselben, oft fremden Grund. Die Sync-Seite konnte
 *      deshalb nur zaehlen, nicht benennen.
 *   2. Jeder Auftrag wurde auf `error` gesetzt — auch der, den der Adapter
 *      gerade als Versionskonflikt (`blocked`) eingestuft hatte. Der Konflikt
 *      verschwand damit still im Fehlertopf, und ein Retry haette ihn blind
 *      erneut gesendet.
 */
export interface OutboxFailureDetail {
  outboxId: string;
  message: string;
  retryable: boolean;
  /**
   * Was der Adapter entschieden hat: echter Fehler, Versionskonflikt oder — KONTOSPERRE —
   * endgültige Berechtigungsabweisung (`failed`, wird nie automatisch erneut gesendet).
   */
  status: 'error' | 'blocked' | 'failed';
}

export function markOutboxEntriesFailed(failures: OutboxFailureDetail[]): void {
  if (failures.length === 0) return;
  const byId = new Map(failures.map((failure) => [failure.outboxId, failure]));
  const failedAt = new Date().toISOString();
  outbox = outbox.map((entry) => {
    const failure = byId.get(entry.id);
    if (!failure) return entry;
    return {
      ...entry,
      status: failure.status,
      retryCount: entry.retryCount + 1,
      lastErrorMessage: failure.message,
      lastErrorAt: failedAt,
      lastErrorRetryable: failure.retryable,
    };
  });
  notifyOutboxChanged();
}

/**
 * FINANZ-SYNC-BLOCKER-01B — der Ausgang aus `blocked`.
 *
 * Ein blockierter Auftrag wartet auf eine Entscheidung, nicht auf einen
 * weiteren Versuch: Die Push-Schleife uebergeht ihn, und das Wiederholen
 * beruehrt nur `error`. Ist der Konflikt fachlich aufgeloest, muss der Auftrag
 * wieder sendbar werden — sonst haengt er fuer immer.
 *
 * Bewusst eng: genau ein Entitaetstyp, genau eine Kennung, und nur aus
 * `blocked` heraus. Kein „alles entsperren".
 */
/**
 * FINANZ-SYNC-BLOCKER-01F — der Gegenweg zu `releaseBlockedOutboxEntry`.
 *
 * Entscheidet sich der Nutzer für den Cloud-Wert, gibt es nichts mehr zu
 * senden. Den Auftrag dann wieder auf `pending` zu stellen, hiesse einen
 * gegenstandslosen Rest in der Warteschlange zu lassen, der beim nächsten Lauf
 * erneut auf denselben Konflikt liefe.
 *
 * Bewusst eng: genau ein Entitaetstyp, genau eine Kennung, und nur aus
 * `blocked` heraus.
 */
export function completeBlockedOutboxEntry(
  entityType: SyncEntityType,
  entityId: string,
): boolean {
  let completed = false;
  outbox = outbox.map((entry) => {
    if (entry.entityType !== entityType || entry.entityId !== entityId) return entry;
    if (entry.status !== 'blocked') return entry;
    completed = true;
    return {
      ...entry,
      status: 'completed',
      blockedReason: undefined,
      lastErrorMessage: undefined,
      lastErrorAt: undefined,
      lastErrorRetryable: undefined,
    };
  });
  if (completed) notifyOutboxChanged();
  return completed;
}

export function releaseBlockedOutboxEntry(
  entityType: SyncEntityType,
  entityId: string,
  version?: number,
): boolean {
  let released = false;
  outbox = outbox.map((entry) => {
    if (entry.entityType !== entityType || entry.entityId !== entityId) return entry;
    if (entry.status !== 'blocked') return entry;
    released = true;
    return {
      ...entry,
      status: 'pending',
      version: version ?? entry.version,
      blockedReason: undefined,
      lastErrorMessage: undefined,
      lastErrorAt: undefined,
      lastErrorRetryable: undefined,
    };
  });
  if (released) notifyOutboxChanged();
  return released;
}

/**
 * GO-LIVE-SECURITY-01 / KONTOSPERRE — ist die endgültige Berechtigungsabweisung das letzte
 * Wort zu dieser Entität? Maßgeblich ist der zuletzt eingereihte Auftrag: Hat eine bewusste
 * neue Aktion danach einen eigenen Auftrag erzeugt, gilt die alte Abweisung nicht mehr.
 * Netzwerkfehler und Lizenzabweisungen sind keine endgültige Abweisung.
 */
export function hasFinallyDeniedOutboxEntry(entityType: SyncEntityType, entityId: string): boolean {
  let neuester: SyncOutboxEntry | undefined;
  for (const entry of outbox) {
    if (entry.entityType !== entityType || entry.entityId !== entityId) continue;
    // Die Warteschlange führt Neues vorn; bei gleicher Zeit gewinnt der vordere Eintrag.
    if (!neuester || entry.queuedAt > neuester.queuedAt) neuester = entry;
  }
  return neuester !== undefined && isFinallyDeniedOutboxEntry(neuester);
}

/**
 * GO-LIVE-SECURITY-01 / KONTOSPERRE — der Einreihungsweg für JEDEN automatischen Weg:
 * Abgleich und Backfill (Altbestand, den die Cloud nicht kennt), Nachmeldung von
 * Betriebsdaten, Firmenprofil und Vorgängen, Wiederaufnahme nach verlorener Bestätigung.
 *
 * Eine während einer Sperre (oder ohne Mitgliedschaft/Rolle) endgültig abgewiesene Aktion
 * sieht für diese Wege genau so aus wie Altbestand — ohne diese Prüfung reihte der erste
 * erfolgreiche Abgleich nach dem Entsperren sie ohne neue Benutzeraktion wieder ein. Solange
 * die Abweisung das letzte Wort ist, entsteht deshalb kein Auftrag; erst eine bewusste neue
 * Änderung (über `enqueueSyncOutbox`) erzeugt einen neuen. Der Vertragstest
 * `backfillSperreGls01.test.ts` (V1/V2) hält fest, welche Stellen welchen Weg nehmen.
 */
export function enqueueBackfillSyncOutbox(input: EnqueueSyncOutboxInput): SyncOutboxEntry | null {
  if (hasFinallyDeniedOutboxEntry(input.entityType, input.entityId)) return null;
  return enqueueOutboxEntry(input);
}

/**
 * GO-LIVE-SECURITY-01 / KONTOSPERRE — automatische Schreiber ohne Nutzeraktion.
 *
 * Manche automatischen Abläufe ändern Fachdaten im Speicher, und erst der
 * Änderungsverfolger macht daraus einen Sendeauftrag: der Abgleich der
 * Überfälligkeitsaufgaben nach einem angewendeten Abzug und einmal täglich beim Start,
 * der Nachtrags-Abzug, der Rechnungsentwurfs-Spiegel beim Start. Für den Verfolger sähe
 * das aus wie eine Nutzeränderung — er hätte eine endgültige Abweisung abgelöst und die
 * Entität erneut gesendet. Diese Abläufe laufen deshalb in `runAutomaticSyncWrite`; der
 * Verfolger nimmt darin den gesperrten Weg (`enqueueBackfillSyncOutbox`). Bewusste
 * Nutzeraktionen laufen außerhalb und lösen eine Abweisung wie gewohnt ab.
 *
 * Synchron: Die Fachspeicher persistieren beim Schreiben (`persistAll` → Verfolger), der
 * Bereich umfasst also genau die Einreihungen dieses Ablaufs.
 */
let automaticWriteDepth = 0;

export function runAutomaticSyncWrite<T>(write: () => T): T {
  automaticWriteDepth += 1;
  try {
    return write();
  } finally {
    automaticWriteDepth -= 1;
  }
}

export function isAutomaticSyncWriteActive(): boolean {
  return automaticWriteDepth > 0;
}

export function isSyncOutboxEnabled(): boolean {
  return getSyncClient().syncPolicy !== 'disabled';
}
