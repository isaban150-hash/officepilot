/**
 * SYNC-DURABILITY-HARDENING-01G — der Sendeauftrag nach einem Lauf.
 *
 * Ein Synchronisationslauf schreibt an zwei Stellen an der Outbox:
 *
 *  * Der **Push** vermerkt in seiner eigenen Kopie, was gesendet, blockiert
 *    oder fehlgeschlagen ist. Diese Kopie erreicht den globalen Bestand nicht —
 *    `acknowledgeChanges` ist für Supabase bewusst leer.
 *  * Der **Pull** korrigiert im globalen Bestand: Er reiht Altbestand nach und
 *    setzt einen Auftrag neu an, dessen Bestätigung verloren ging
 *    (CREATE-RETRY-CONFLICT-02).
 *
 * Bisher gewann am Ende schlicht die Push-Kopie (`syncOutbox:
 * currentState.syncOutbox` im Koordinator). Damit verschwand jede Korrektur,
 * die der Pull an einem **bereits bekannten** Eintrag vorgenommen hatte — die
 * Wiederherstellung nach verlorener Bestätigung lief ins Leere, und der Auftrag
 * blieb blockiert.
 *
 * Diese Funktion ist die eine Stelle, an der beide Quellen zusammenkommen. Die
 * Regel folgt der Reihenfolge des Laufs — erst Push, dann Pull:
 *
 *  1. Was der Pull **neu** angelegt hat, kommt mit.
 *  2. Was der Pull an einem bekannten Eintrag **geändert** hat, gewinnt — der
 *     Pull lief zuletzt und hat den Serverstand gesehen.
 *  3. Alles andere trägt das Push-Ergebnis, denn nur dort steht, was der Server
 *     tatsächlich angenommen hat.
 *
 * Bewusst kein neuer Zustand und keine zweite Engine: Verglichen werden die
 * drei Stände, die der Koordinator ohnehin in der Hand hält.
 *
 * **Statussemantik (01G2), so wie sie im Supabase-Pfad tatsächlich entsteht:**
 *
 *  * `pending`   — wartet auf den nächsten Push.
 *  * `error`     — Push fehlgeschlagen, Wiederholung sinnvoll (Netz, Zeitüberlauf).
 *  * `blocked`   — Server hat einen Versionskonflikt gemeldet; erst der nächste
 *                  Pull kann die Lage klären.
 *  * `completed` — der Server hat den Schreibvorgang angenommen (auch als
 *                  Replay oder Dedupe-Antwort). Das ist eine **endgültige**
 *                  Aussage über genau diesen Auftrag.
 *  * `failed`    — im Supabase-Pfad nicht erzeugt; nur der Vollständigkeit halber.
 *
 * Daraus folgt die eine Ausnahme von „der Pull lief zuletzt": Ein bereits
 * abgeschlossener Auftrag fällt **nicht** auf `pending`/`blocked`/`error`
 * zurück. Der Pull arbeitet auf einem Bestand, der die Push-Ergebnisse dieses
 * Laufs noch nicht kennt; ohne diese Regel liefe ein erfolgreich gesendeter
 * Schreibvorgang endlos erneut. Neue fachliche Aufträge entstehen dagegen immer
 * mit eigener Kennung und sind davon nicht betroffen.
 */
import type { SyncOutboxEntry } from '../../types/sync';

export interface OutboxMergeInput {
  /** Stand vor Push und Pull. */
  prePull: readonly SyncOutboxEntry[];
  /** Ergebnis des Push (Status der gesendeten Aufträge). */
  afterPush: readonly SyncOutboxEntry[];
  /** Globaler Bestand nach dem Pull, inklusive seiner Korrekturen. */
  afterPull: readonly SyncOutboxEntry[];
}

/** Vergleicht die fachlich veränderlichen Felder eines Auftrags. */
function isSameEntry(a: SyncOutboxEntry | undefined, b: SyncOutboxEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.status === b.status &&
    a.version === b.version &&
    a.operation === b.operation &&
    a.retryCount === b.retryCount &&
    a.blockedReason === b.blockedReason &&
    /*
     * SYNC-DURABILITY-01G6 — der Sendenachweis gehört zum Auftrag.
     *
     * Ohne diesen Vergleich galten zwei Aufträge als gleich, von denen einer
     * einen Nachweis trug und der andere nicht. Hatte der Pull den Nachweis
     * gerade geklärt, gewann hier der ältere Stand aus dem Sendeweg — und nach
     * einem Neustart stand die aufgehobene Frage wieder offen.
     */
    a.sentContentKey === b.sentContentKey &&
    a.sentDeleted === b.sentDeleted &&
    a.sentAt === b.sentAt
  );
}

export function mergeOutboxAfterPull({
  prePull,
  afterPush,
  afterPull,
}: OutboxMergeInput): SyncOutboxEntry[] {
  const byIdBefore = new Map(prePull.map((entry) => [entry.id, entry]));
  const byIdPush = new Map(afterPush.map((entry) => [entry.id, entry]));
  const byIdPull = new Map(afterPull.map((entry) => [entry.id, entry]));

  const merged: SyncOutboxEntry[] = [];
  const seen = new Set<string>();

  for (const entry of afterPush) {
    seen.add(entry.id);
    const pulled = byIdPull.get(entry.id);
    if (!pulled) {
      // Der Pull kennt den Auftrag nicht mehr (z. B. bereinigt) — Push-Ergebnis gilt.
      merged.push(entry);
      continue;
    }
    const before = byIdBefore.get(entry.id);
    if (isSameEntry(before, pulled)) {
      // Der Pull hat nichts geändert — das Push-Ergebnis gilt.
      merged.push(entry);
      continue;
    }
    /*
     * 01G2 — Monotonie des Abschlusses: Was der Server angenommen hat, bleibt
     * angenommen. Der Pull kennt diese Antwort nicht und würde den Auftrag sonst
     * wieder als offen führen.
     */
    if (entry.status === 'completed' && pulled.status !== 'completed') {
      merged.push(entry);
      continue;
    }
    merged.push(pulled);
  }

  for (const entry of afterPull) {
    if (seen.has(entry.id)) continue;
    // Während des Laufs neu entstanden (Altbestand, Wiederanlauf).
    if (!byIdPush.has(entry.id)) merged.push(entry);
  }

  return merged;
}
