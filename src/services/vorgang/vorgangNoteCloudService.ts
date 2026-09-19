/**
 * CLOUD-DURABILITY-CORE-01B — Cloud-Anbindung der Vorgangsnotizen.
 *
 * Diese Datei trägt ausschliesslich Transport: Payload, Content-Key, Parsen der
 * Serverzeile, Merge und Backfill-Planung. Sie enthält **keine** Fachlogik —
 * Anlegen, Ändern, Löschen und Suchen bleiben unverändert in
 * `vorgangNoteService`, und dort wird weiterhin kein einziger Cloud-Aufruf
 * gemacht: Der Weg in die Cloud führt ausschliesslich über die vorhandene
 * Outbox (`withNewEntitySync` → Change-Tracker → `supabaseSyncAdapter`).
 *
 * Die Serverform stammt aus
 * `20260923120000_workspace_vorgang_notes_cloud.sql` und folgt dem
 * `workspace_customers`-Muster.
 */
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import {
  planLostAckAdoption,
  type LostAckAdoptionPlan,
  type LostAckRemoteRow,
  type LostAckSentWrite,
} from '../sync/syncLostAckAdoptionService';
import type { VorgangNote, VorgangNoteSource } from '../../types/communication';
import type { SyncMeta } from '../../types/sync';

/** Zeile aus `public.workspace_vorgang_notes` — exakt die Spalten der Migration. */
export interface WorkspaceVorgangNoteRow {
  id?: string;
  workspace_id: string;
  client_note_id: string;
  client_vorgang_id: string | null;
  payload: Record<string, unknown>;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at: string;
}

/** Fachlicher Cloud-Payload einer Notiz — ohne jede Cloud-Metainformation. */
export interface VorgangNoteCloudPayload {
  id: string;
  vorgangId: string;
  vorgangTitle: string;
  body: string;
  occurredAt: string;
  createdAt: string;
  source: VorgangNoteSource;
  tags?: string[];
  updatedAt?: string;
  linkedCommunicationEventId?: string;
  linkedInboxId?: string;
  pinned?: boolean;
}

const KNOWN_SOURCES: VorgangNoteSource[] = ['user', 'communication', 'assistant'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resolveSource(value: unknown): VorgangNoteSource {
  return KNOWN_SOURCES.includes(value as VorgangNoteSource) ? (value as VorgangNoteSource) : 'user';
}

/**
 * Ausdrückliche Allowlist statt Rest-Spread: Ein später ergänztes Feld soll
 * nicht unbemerkt in Cloud und Content-Key wandern. `sync` bleibt draussen —
 * `updatedAt` dagegen ist der **fachliche** Änderungszeitstempel und gehört
 * hinein, sonst bliebe eine Rücknahme auf einen früheren Text unerkannt.
 *
 * Die optionalen Felder reisen nur mit, wenn sie existieren. Damit ist der
 * Content-Key stabil: „Feld fehlt" und „Feld ist undefined" ergeben denselben
 * Schlüssel und lösen keinen Schein-Push aus.
 */
export function stripVorgangNoteForCloud(note: VorgangNote): VorgangNoteCloudPayload {
  const payload: VorgangNoteCloudPayload = {
    id: note.id,
    vorgangId: note.vorgangId,
    vorgangTitle: note.vorgangTitle,
    body: note.body,
    occurredAt: note.occurredAt,
    createdAt: note.createdAt,
    source: note.source,
  };
  if (note.tags && note.tags.length > 0) payload.tags = [...note.tags];
  if (isNonEmptyString(note.updatedAt)) payload.updatedAt = note.updatedAt;
  if (isNonEmptyString(note.linkedCommunicationEventId)) {
    payload.linkedCommunicationEventId = note.linkedCommunicationEventId;
  }
  if (isNonEmptyString(note.linkedInboxId)) payload.linkedInboxId = note.linkedInboxId;
  if (note.pinned === true) payload.pinned = true;
  return payload;
}

/**
 * Stabiler fachlicher Vergleichsschlüssel. Enthält bewusst keine `SyncMeta`:
 * Der Server schreibt nach jedem Push eine neue `row_version` zurück; flösse
 * sie hier ein, löste jede Rückschreibung den nächsten Push aus.
 */
export function buildVorgangNoteCloudContentKey(note: VorgangNote): string {
  return JSON.stringify(stripVorgangNoteForCloud(note));
}

/**
 * Push-Form nach dem Vorgangs-Muster: Identität, Vorgangsbezug, Nutzlast,
 * Grabstein-Flag.
 *
 * `vorgang_id` reist als eigener Schlüssel, weil die Serverzeile ihn als Spalte
 * führt — er ist die einzige Ordnung, über die ein zweites Gerät eine Notiz
 * ihrem Vorgang zuordnet, und muss auch am Grabstein erhalten bleiben.
 */
export function buildVorgangNoteCloudPushPayload(
  note: VorgangNote,
  deleted = false,
): Record<string, unknown> {
  return {
    note_id: note.id,
    vorgang_id: note.vorgangId,
    payload: stripVorgangNoteForCloud(note),
    deleted,
  };
}

/** Nur die deklarierten Felder werden übernommen — keine Serverspalten. */
export function parseVorgangNoteCloudPayload(
  payload: Record<string, unknown> | null,
): VorgangNoteCloudPayload | null {
  if (!payload) return null;
  const inner = (payload.payload as Record<string, unknown> | undefined) ?? payload;
  if (!inner || typeof inner !== 'object') return null;
  if (!isNonEmptyString(inner.id)) return null;
  if (!isNonEmptyString(inner.vorgangId)) return null;

  const parsed: VorgangNoteCloudPayload = {
    id: inner.id,
    vorgangId: inner.vorgangId,
    vorgangTitle: text(inner.vorgangTitle),
    body: text(inner.body),
    occurredAt: text(inner.occurredAt),
    createdAt: text(inner.createdAt),
    source: resolveSource(inner.source),
  };
  if (Array.isArray(inner.tags)) {
    const tags = inner.tags.filter(isNonEmptyString);
    if (tags.length > 0) parsed.tags = tags;
  }
  if (isNonEmptyString(inner.updatedAt)) parsed.updatedAt = inner.updatedAt;
  if (isNonEmptyString(inner.linkedCommunicationEventId)) {
    parsed.linkedCommunicationEventId = inner.linkedCommunicationEventId;
  }
  if (isNonEmptyString(inner.linkedInboxId)) parsed.linkedInboxId = inner.linkedInboxId;
  if (inner.pinned === true) parsed.pinned = true;
  return parsed;
}

export function mapWorkspaceVorgangNoteRow(row: WorkspaceVorgangNoteRow): {
  noteId: string;
  vorgangId: string | null;
  payload: VorgangNoteCloudPayload | null;
  rowVersion: number;
  deleted: boolean;
  updatedAt: string;
} | null {
  if (!isNonEmptyString(row.client_note_id)) return null;
  const parsed = parseVorgangNoteCloudPayload(row.payload);
  /*
   * Ein Grabstein trägt keinen Fachinhalt (die Serverzeile behält ihn zwar,
   * eine auf dem Server erzeugte Löschung eines nie gepushten Inhalts hätte
   * aber keinen). Er bleibt trotzdem gültig: Ohne ihn käme die Löschung auf
   * dem zweiten Gerät nie an.
   */
  if (!parsed && !row.deleted) return null;
  return {
    noteId: row.client_note_id,
    vorgangId: row.client_vorgang_id ?? parsed?.vorgangId ?? null,
    payload: parsed,
    rowVersion: Number(row.row_version),
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

function noteFromCloud(
  noteId: string,
  payload: VorgangNoteCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): VorgangNote {
  return {
    ...payload,
    id: noteId,
    sync: {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : undefined,
      deviceId,
      workspaceId,
    },
  };
}

/**
 * Zeilenweiser Merge nach `note.id`, aufgebaut auf der vorhandenen
 * `mergeSyncEntities`-Engine. Kein Feld-Merge, keine Last-Write-Wins-Regel:
 * Gleiche Version mit abweichendem Inhalt meldet einen Konflikt, statt eine
 * ungesynchronisierte lokale Änderung stillschweigend zu verwerfen.
 *
 * SYNC-DURABILITY-HARDENING-01G — `dirtyIds` sind die Kennungen, für die ein
 * **offener Sendeauftrag** in der Outbox liegt: lokale Arbeit, die der Server
 * noch nicht gesehen hat. Sie ist der Grund, warum der Pull nicht einfach der
 * höheren Serverversion folgen darf.
 *
 * `sync.version` ist ausschliesslich die zuletzt **bestätigte** Serverversion;
 * eine lokale Änderung erhöht sie nicht. Eine ungesendete Änderung sieht damit
 * aus wie ein unveränderter Datensatz — und wurde bisher von einer neueren
 * Serverfassung stillschweigend ersetzt. Ist die Entität offen, meldet der Merge
 * stattdessen einen Konflikt; der Aufrufer verwirft dann den gesamten
 * Merge-Vorschlag und die lokale Fassung bleibt stehen, bis der Push sie sendet.
 */
export function mergeVorgangNotesFromPull(
  localNotes: VorgangNote[],
  remoteRows: WorkspaceVorgangNoteRow[],
  deviceId: string,
  workspaceId: string,
  dirtyIds: ReadonlySet<string> = new Set(),
): { notes: VorgangNote[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localNotes.map((note) => [note.id, note]));

  for (const row of remoteRows) {
    const mapped = mapWorkspaceVorgangNoteRow(row);
    if (!mapped) continue;

    /*
     * Grabstein vor der Merge-Engine: Die Löschung hat auf dem anderen Gerät
     * stattgefunden und ist die jüngere Wahrheit. Die Notiz verschwindet hier
     * aus dem aktiven Bestand — und weil der Backfill Grabsteine als
     * vorhandene ID zählt, wird sie auch nicht wieder hochgeladen.
     */
    if (mapped.deleted) {
      /*
       * 01G — eine ungesendete lokale Änderung wird auch von einer Löschung
       * nicht stillschweigend mitgenommen. Der Grabstein bleibt die jüngere
       * Absicht des anderen Geräts, aber der Nutzer erfährt davon, statt seine
       * Arbeit zu verlieren.
       */
      if (dirtyIds.has(mapped.noteId) && byId.has(mapped.noteId)) {
        conflicts.push(`vorgang_note:${mapped.noteId}`);
        continue;
      }
      byId.delete(mapped.noteId);
      continue;
    }
    if (!mapped.payload) continue;

    const local = byId.get(mapped.noteId) ?? null;
    const remote = noteFromCloud(
      mapped.noteId,
      mapped.payload,
      mapped.rowVersion,
      mapped.updatedAt,
      false,
      deviceId,
      workspaceId,
    );

    if (!local) {
      byId.set(remote.id, remote);
      continue;
    }

    /*
     * Lokal gelöscht, remote noch aktiv: Der Grabstein wartet in der Outbox und
     * ist die jüngere Absicht. Die Cloud-Zeile darf ihn nicht wiederbeleben.
     */
    if (local.sync?.deleted === true) continue;

    /*
     * Gleiche Version: Nur ein abweichender **fachlicher** Inhalt ist ein
     * Konflikt. Stimmt er überein, wird lediglich die Serverversion
     * übernommen — ohne Push und ohne Konfliktmeldung.
     */
    if (local.sync && local.sync.version === mapped.rowVersion) {
      if (buildVorgangNoteCloudContentKey(local) === buildVorgangNoteCloudContentKey(remote)) {
        byId.set(remote.id, remote);
      } else {
        conflicts.push(`vorgang_note:${mapped.noteId}`);
      }
      continue;
    }

    /*
     * 01G/01G2 — offene lokale Änderung gegen eine abweichende Serverfassung.
     *
     * 01G meldete hier jeden Versionsunterschied als Konflikt. Die
     * Produktreproduktion zeigte den Preis: Nach einem verlorenen ACK trägt der
     * Server exakt **unsere** Fassung, nur mit höherer Version — ein Konflikt
     * wäre dort eine Falschmeldung, die den ganzen Merge blockiert.
     *
     * Entscheidend ist deshalb nicht die Zahl, sondern der Inhalt: Stimmt die
     * Serverfassung fachlich mit der lokalen überein, ist nichts strittig; die
     * bestätigte Version wird übernommen. Nur ein wirklich abweichender
     * Serverstand ist ein Konflikt — und dann bleibt die lokale Fassung stehen.
     */
    if (dirtyIds.has(mapped.noteId) && mapped.rowVersion !== (local.sync?.version ?? 0)) {
      if (buildVorgangNoteCloudContentKey(local) !== buildVorgangNoteCloudContentKey(remote)) {
        conflicts.push(`vorgang_note:${mapped.noteId}`);
        continue;
      }
      byId.set(remote.id, remote);
      continue;
    }

    const merged = mergeSyncEntities(local, remote, 'vorgang_note');
    if (merged.conflict) {
      conflicts.push(`vorgang_note:${mapped.noteId}`);
      continue;
    }

    const entity = merged.entity;
    if (entity) byId.set(entity.id, entity);
  }

  return { notes: [...byId.values()], conflicts };
}

/**
 * Altbestand — der einzige Weg, auf dem vor 01B entstandene Notizen in die
 * Cloud gelangen.
 *
 * Der Change-Tracker kann das nicht leisten: Beim Start wird der vorhandene
 * Zustand zur Basislinie, Bestandsnotizen gelten damit als unverändert und
 * werden nie eingereiht. Es entsteht trotzdem **keine** Sondermigration — die
 * geplanten IDs gehen durch dieselbe `enqueueSyncOutbox`-Tür wie jede normale
 * Änderung, und von dort durch denselben Push.
 *
 * Verglichen werden ausschliesslich IDs, und zwar gegen **alle** Remote-IDs
 * inklusive Grabsteine: Sonst lüde ein zweites Gerät eine anderswo gelöschte
 * Notiz wieder hoch.
 */
export function planVorgangNoteBackfill(
  localNotes: VorgangNote[],
  remoteRows: WorkspaceVorgangNoteRow[],
): string[] {
  const remoteIds = new Set(remoteRows.map((row) => row.client_note_id));
  return localNotes
    .filter((note) => !note.sync?.deleted)
    .filter((note) => !remoteIds.has(note.id))
    .map((note) => note.id);
}

/** Setzt nach erfolgreichem Push die Serverversion — ohne Fachdaten anzufassen. */
export function applyVorgangNotePushResultToState(
  notes: VorgangNote[],
  noteId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): VorgangNote[] {
  return notes.map((note) => {
    if (note.id !== noteId) return note;
    const sync: SyncMeta = {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : note.sync?.deletedAt,
      deviceId,
      workspaceId,
    };
    return { ...note, sync };
  });
}

/**
 * SYNC-DURABILITY-HARDENING-01G4 — Wiederanlauf nach verlorener Bestätigung.
 *
 * Notizen hingen bisher nicht an diesem Vertrag. Das war der schwerste der drei
 * Befunde: Ging die Bestätigung eines Anlegevorgangs verloren und arbeitete der
 * Nutzer danach weiter, wich der lokale Inhalt von der Serverzeile ab. Der
 * Merge meldete deshalb einen Konflikt, die bestätigte Basis blieb `0`, und der
 * nächste Push wurde vom Serververtrag abgewiesen — der Auftrag stand still,
 * und die Notiz erreichte die Cloud nie mehr.
 *
 * Die Bewertung selbst liegt in `planLostAckAdoption`; hier wird nur die
 * Serverzeile in die dort erwartete Form gebracht.
 */
export function planVorgangNoteLostAckAdoption(
  localNotes: VorgangNote[],
  remoteRows: WorkspaceVorgangNoteRow[],
  activeOutboxNoteIds: ReadonlySet<string>,
  sentWrites?: ReadonlyMap<string, LostAckSentWrite>,
): LostAckAdoptionPlan {
  const remotes = new Map<string, LostAckRemoteRow>();
  for (const row of remoteRows) {
    const mapped = mapWorkspaceVorgangNoteRow(row);
    if (!mapped) continue;
    remotes.set(mapped.noteId, {
      rowVersion: mapped.rowVersion,
      deleted: mapped.deleted,
      contentKey: mapped.payload
        ? buildVorgangNoteCloudContentKey(
            noteFromCloud(
              mapped.noteId,
              mapped.payload,
              mapped.rowVersion,
              mapped.updatedAt,
              false,
              '',
              '',
            ),
          )
        : undefined,
    });
  }
  return planLostAckAdoption(localNotes, remotes, activeOutboxNoteIds, {
    sentWrites,
    localContentKey: buildVorgangNoteCloudContentKey,
  });
}
