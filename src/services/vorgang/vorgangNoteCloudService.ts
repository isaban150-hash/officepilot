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
 */
export function mergeVorgangNotesFromPull(
  localNotes: VorgangNote[],
  remoteRows: WorkspaceVorgangNoteRow[],
  deviceId: string,
  workspaceId: string,
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
