/**
 * FINANZ-CORE-01A (systemische Gesamtnacharbeit, WEISS B21-C1) — die eindeutige Reihenfolge der Aufträge EINER Entität.
 *
 * Wer „den jüngsten Auftrag“ einer Entität braucht (endgültige Abweisung, Ablösung, erneutes Senden), darf weder der
 * Einreihungszeit allein noch der Position in der Warteschlange trauen:
 *  - `queuedAt` hat nur Millisekunden — zwei Einreihungen derselben Entität können gleich zählen;
 *  - die Position wechselt: `enqueueSyncOutbox` stellt Neues voran, das Zusammenführen eines Sync-Laufs
 *    (`mergeOutboxWithLocalChanges`) hängt während des Laufs eingereihte Aufträge hinten an.
 * Mit gleicher Millisekunde gewann deshalb ein älterer, erledigter Auftrag gegen die jüngere, endgültig abgewiesene
 * Zahlungsrücknahme — die Abweisung verschwand aus der Abschlusskontrolle (WEISS B21-C1).
 *
 * Maßgeblich ist darum die laufende Einreihungsnummer (`SyncOutboxEntry.sequence`, je Einreihung um eins höher). Fehlt
 * sie (Altbestand), entscheidet die Zeit; bei gleicher Zeit gilt ein endgültig abgewiesener Auftrag als jünger — eine
 * Abweisung verschwindet nie durch einen Gleichstand (lieber gesperrt als falsch frei; der vollständige Abzug klärt).
 */
import type { SyncOutboxEntry } from '../../types/sync';
import { isFinallyDeniedOutboxEntry } from './syncRoleDenial';

const hatNummer = (entry: SyncOutboxEntry): entry is SyncOutboxEntry & { sequence: number } =>
  typeof entry.sequence === 'number' && Number.isFinite(entry.sequence);

/**
 * Ist `a` jünger als `b` (zwei Aufträge derselben Entität aus derselben Warteschlange)? Eindeutig:
 *  1. tragen beide eine Einreihungsnummer, entscheidet sie;
 *  2. sonst die Einreihungszeit;
 *  3. bei gleicher Zeit ist ein Auftrag mit Nummer jünger als Altbestand ohne Nummer (er entstand danach);
 *  4. Altbestand mit gleicher Zeit: der endgültig abgewiesene gilt als jünger (fail-closed);
 *  5. zuletzt die Position — weiter vorn ist jünger (so reiht `enqueueSyncOutbox` ein).
 */
export function isNewerOutboxEntry(a: SyncOutboxEntry, aIndex: number, b: SyncOutboxEntry, bIndex: number): boolean {
  if (hatNummer(a) && hatNummer(b) && a.sequence !== b.sequence) return a.sequence > b.sequence;
  if (a.queuedAt !== b.queuedAt) return a.queuedAt > b.queuedAt;
  if (hatNummer(a) !== hatNummer(b)) return hatNummer(a);
  const aAbgewiesen = isFinallyDeniedOutboxEntry(a);
  if (aAbgewiesen !== isFinallyDeniedOutboxEntry(b)) return aAbgewiesen;
  return aIndex < bIndex;
}

/** Schlüssel einer Entität in der Warteschlange. */
export function outboxEntityKey(entry: Pick<SyncOutboxEntry, 'entityType' | 'entityId'>): string {
  return `${entry.entityType}:${entry.entityId}`;
}

/**
 * Der jüngste Auftrag je Entität (`<entityType>:<entityId>`) nach `isNewerOutboxEntry`, optional nur für Aufträge,
 * die `include` zulässt. Das Ergebnis hängt nicht von der Reihenfolge der Warteschlange ab, solange die Einträge
 * Nummern oder verschiedene Zeiten tragen.
 */
export function newestOutboxEntriesByEntity(
  outbox: readonly SyncOutboxEntry[] | undefined,
  include?: (entry: SyncOutboxEntry) => boolean,
): Map<string, SyncOutboxEntry> {
  const newest = new Map<string, { entry: SyncOutboxEntry; index: number }>();
  (outbox ?? []).forEach((entry, index) => {
    if (include && !include(entry)) return;
    const key = outboxEntityKey(entry);
    const previous = newest.get(key);
    if (!previous || isNewerOutboxEntry(entry, index, previous.entry, previous.index)) newest.set(key, { entry, index });
  });
  return new Map([...newest].map(([key, value]) => [key, value.entry]));
}

/** Die nächste Einreihungsnummer: höher als jede Nummer der Warteschlange. */
export function nextOutboxSequence(outbox: readonly SyncOutboxEntry[]): number {
  return outbox.reduce((max, entry) => (hatNummer(entry) && entry.sequence > max ? entry.sequence : max), 0) + 1;
}
