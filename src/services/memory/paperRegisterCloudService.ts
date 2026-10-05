/**
 * CLOUD-SYNC S1 — Cloud-Anbindung des Papierablage-Hakens.
 *
 * Diese Datei trägt ausschliesslich Transport: Payload, Inhaltsschlüssel,
 * Lesen der Serverzeile, Merge, Altbestand und Wiederanlauf nach verlorener
 * Bestätigung. **Keine** Fachlogik — Anlegen, Abheften und Löschen bleiben in
 * `officePilotMemoryService`, und dort wird kein einziger Cloud-Aufruf
 * gemacht: Der Weg in die Cloud führt über den Änderungsverfolger und die
 * vorhandene Warteschlange.
 *
 * Aufgebaut nach dem Muster von `businessLetterCloudService` — dieselbe
 * Versionssemantik, dieselbe Konfliktregel, derselbe Wiederanlauf aus 01G bis
 * 01G7. Bewusst keine zweite Sync-Architektur.
 */
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import {
  planLostAckAdoption,
  type LostAckAdoptionPlan,
  type LostAckRemoteRow,
  type LostAckSentWrite,
} from '../sync/syncLostAckAdoptionService';
import type { PaperRegisterEntry } from '../../types/memory';
import type { SyncMeta } from '../../types/sync';

/** Zeile aus `public.workspace_paper_register_entries` — exakt die Spalten der Migration. */
export interface WorkspacePaperRegisterEntryRow {
  id?: string;
  workspace_id: string;
  client_entry_id: string;
  client_document_id: string | null;
  payload: Record<string, unknown>;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at: string;
}

/** Fachlicher Cloud-Payload eines Eintrags — ohne jede Cloud-Metainformation. */
export interface PaperRegisterEntryCloudPayload {
  id: string;
  documentId: string;
  documentTitle: string;
  folderId: string;
  register: string;
  physicalFiled: boolean;
  createdAt: string;
  updatedAt: string;
  sourceInboxId?: string;
  filedAt?: string;
  filedByUser?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Ausdrückliche Allowlist statt Rest-Spread: Ein später ergänztes Feld soll
 * nicht unbemerkt in Cloud und Inhaltsschlüssel wandern. `sync` bleibt
 * draussen; `updatedAt` gehört hinein, weil es die **fachliche** Änderung
 * datiert.
 *
 * Optionale Felder reisen nur mit, wenn sie belegt sind. Damit ergeben „Feld
 * fehlt" und „Feld ist undefined" denselben Schlüssel und lösen keinen
 * Schein-Versand aus.
 */
export function stripPaperRegisterEntryForCloud(
  entry: PaperRegisterEntry,
): PaperRegisterEntryCloudPayload {
  const payload: PaperRegisterEntryCloudPayload = {
    id: entry.id,
    documentId: entry.documentId,
    documentTitle: text(entry.documentTitle),
    folderId: text(entry.folderId),
    register: text(entry.register),
    physicalFiled: entry.physicalFiled === true,
    createdAt: text(entry.createdAt),
    updatedAt: text(entry.updatedAt),
  };
  if (isNonEmptyString(entry.sourceInboxId)) payload.sourceInboxId = entry.sourceInboxId;
  if (isNonEmptyString(entry.filedAt)) payload.filedAt = entry.filedAt;
  if (isNonEmptyString(entry.filedByUser)) payload.filedByUser = entry.filedByUser;
  return payload;
}

/**
 * Stabiler fachlicher Vergleichsschlüssel. Enthält bewusst keine `SyncMeta`:
 * Der Server schreibt nach jedem Versand eine neue Version zurück; flösse sie
 * hier ein, löste jede Rückschreibung den nächsten Versand aus.
 */
export function buildPaperRegisterEntryCloudContentKey(entry: PaperRegisterEntry): string {
  return JSON.stringify(stripPaperRegisterEntryForCloud(entry));
}

/**
 * Versandform: Identität, Dokumentbezug und die Nutzlast. Der Bezug steht als
 * eigene Spalte, damit auch ein Grabstein seinem Dokument zugeordnet bleibt.
 */
export function buildPaperRegisterEntryCloudPushPayload(
  entry: PaperRegisterEntry,
  deleted = false,
): Record<string, unknown> {
  return {
    entry_id: entry.id,
    document_id: entry.documentId,
    payload: stripPaperRegisterEntryForCloud(entry),
    deleted,
  };
}

/** Nur die deklarierten Felder werden übernommen — keine Serverspalten. */
export function parsePaperRegisterEntryCloudPayload(
  payload: Record<string, unknown> | null,
): PaperRegisterEntryCloudPayload | null {
  if (!payload) return null;
  const inner = (payload.payload as Record<string, unknown> | undefined) ?? payload;
  if (!inner || typeof inner !== 'object') return null;
  if (!isNonEmptyString(inner.id) || !isNonEmptyString(inner.documentId)) return null;
  if (typeof inner.physicalFiled !== 'boolean') return null;

  const parsed: PaperRegisterEntryCloudPayload = {
    id: inner.id,
    documentId: inner.documentId,
    documentTitle: text(inner.documentTitle),
    folderId: text(inner.folderId),
    register: text(inner.register),
    physicalFiled: inner.physicalFiled,
    createdAt: text(inner.createdAt),
    updatedAt: text(inner.updatedAt),
  };
  if (isNonEmptyString(inner.sourceInboxId)) parsed.sourceInboxId = inner.sourceInboxId;
  if (isNonEmptyString(inner.filedAt)) parsed.filedAt = inner.filedAt;
  if (isNonEmptyString(inner.filedByUser)) parsed.filedByUser = inner.filedByUser;
  return parsed;
}

export function mapWorkspacePaperRegisterEntryRow(row: WorkspacePaperRegisterEntryRow): {
  entryId: string;
  documentId: string | null;
  payload: PaperRegisterEntryCloudPayload | null;
  rowVersion: number;
  deleted: boolean;
  updatedAt: string;
} | null {
  if (!isNonEmptyString(row.client_entry_id)) return null;
  const parsed = parsePaperRegisterEntryCloudPayload(row.payload);
  // Ein Grabstein ohne Fachinhalt bleibt gültig — ohne ihn käme die Löschung nie an.
  if (!parsed && !row.deleted) return null;
  return {
    entryId: row.client_entry_id,
    documentId: row.client_document_id ?? parsed?.documentId ?? null,
    payload: parsed,
    rowVersion: Number(row.row_version),
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

export function paperRegisterEntryFromCloud(
  entryId: string,
  payload: PaperRegisterEntryCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): PaperRegisterEntry {
  return {
    ...payload,
    id: entryId,
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
 * Zeilenweiser Merge nach `entry.id`, aufgebaut auf der vorhandenen
 * Merge-Engine. Kein Feldmerge, keine Last-Write-Wins-Regel.
 *
 * `dirtyIds` sind die Kennungen mit **offenem Sendeauftrag**: lokale Arbeit,
 * die der Server noch nicht gesehen hat. Verglichen wird dabei der fachliche
 * Inhalt, nicht die Versionszahl — nach einer verlorenen Bestätigung trägt der
 * Server unsere eigene Fassung mit höherer Version, und das ist kein Streit,
 * sondern die fehlende Bestätigung (01G2).
 */
export function mergePaperRegisterEntriesFromPull(
  localEntries: PaperRegisterEntry[],
  remoteRows: WorkspacePaperRegisterEntryRow[],
  deviceId: string,
  workspaceId: string,
  dirtyIds: ReadonlySet<string> = new Set(),
): { entries: PaperRegisterEntry[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localEntries.map((entry) => [entry.id, entry]));

  for (const row of remoteRows) {
    const mapped = mapWorkspacePaperRegisterEntryRow(row);
    if (!mapped) continue;

    if (mapped.deleted) {
      /*
       * Das Dokument wurde auf einem anderen Gerät gelöscht; der Grabstein ist
       * die jüngere Wahrheit. Eine ungesendete lokale Änderung wird davon aber
       * nicht stillschweigend mitgenommen (01G).
       */
      if (dirtyIds.has(mapped.entryId) && byId.has(mapped.entryId)) {
        conflicts.push(`paper_register_entry:${mapped.entryId}`);
        continue;
      }
      byId.delete(mapped.entryId);
      continue;
    }
    if (!mapped.payload) continue;

    const local = byId.get(mapped.entryId) ?? null;
    const remote = paperRegisterEntryFromCloud(
      mapped.entryId,
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

    // Lokal gelöscht, remote noch aktiv: Der Grabstein wartet und ist die jüngere Absicht.
    if (local.sync?.deleted === true) continue;

    /*
     * Gleiche Version: Nur ein abweichender **fachlicher** Inhalt ist ein
     * Streit. Stimmt er überein, wird lediglich die Serverversion übernommen.
     */
    if (local.sync && local.sync.version === mapped.rowVersion) {
      if (buildPaperRegisterEntryCloudContentKey(local) === buildPaperRegisterEntryCloudContentKey(remote)) {
        byId.set(remote.id, remote);
      } else {
        conflicts.push(`paper_register_entry:${mapped.entryId}`);
      }
      continue;
    }

    if (dirtyIds.has(mapped.entryId) && mapped.rowVersion !== (local.sync?.version ?? 0)) {
      if (buildPaperRegisterEntryCloudContentKey(local) !== buildPaperRegisterEntryCloudContentKey(remote)) {
        conflicts.push(`paper_register_entry:${mapped.entryId}`);
        continue;
      }
      byId.set(remote.id, remote);
      continue;
    }

    const merged = mergeSyncEntities(local, remote, 'paper_register_entry');
    if (merged.conflict) {
      conflicts.push(`paper_register_entry:${mapped.entryId}`);
      continue;
    }
    const entity = merged.entity;
    if (entity) byId.set(entity.id, entity);
  }

  return { entries: [...byId.values()], conflicts };
}

/**
 * Altbestand — der einzige Weg, auf dem vor S1 entstandene Einträge in die
 * Cloud gelangen.
 *
 * Der Änderungsverfolger kann das nicht leisten: Beim Start wird der vorhandene
 * Zustand zur Grundlinie, Bestandseinträge gelten damit als unverändert und
 * werden nie eingereiht. Verglichen wird ausschliesslich über Kennungen, und
 * zwar gegen **alle** Serverzeilen einschliesslich der Grabsteine — sonst lüde
 * ein zweites Gerät den Haken eines anderswo gelöschten Dokuments wieder hoch.
 */
export function planPaperRegisterEntryBackfill(
  localEntries: PaperRegisterEntry[],
  remoteRows: WorkspacePaperRegisterEntryRow[],
): string[] {
  const remoteIds = new Set(
    remoteRows
      .map((row) => row.client_entry_id)
      .filter((id): id is string => isNonEmptyString(id)),
  );
  return localEntries
    .filter((entry) => entry.sync?.deleted !== true)
    .filter((entry) => !remoteIds.has(entry.id))
    .map((entry) => entry.id);
}

/** Setzt nach erfolgreichem Versand die Serverversion — ohne Fachdaten anzufassen. */
export function applyPaperRegisterEntryPushResultToState(
  entries: PaperRegisterEntry[],
  entryId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): PaperRegisterEntry[] {
  return entries.map((entry) => {
    if (entry.id !== entryId) return entry;
    const sync: SyncMeta = {
      ...entry.sync,
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : entry.sync?.deletedAt,
      deviceId,
      workspaceId,
    };
    return { ...entry, sync };
  });
}

/**
 * SYNC-DURABILITY-HARDENING-01G4 bis 01G7 — Wiederanlauf nach verlorener
 * Bestätigung und nach einem Schreibvorgang, der den Server nie erreicht hat.
 *
 * Die Bewertung selbst liegt in `planLostAckAdoption`; hier wird nur die
 * Serverzeile in die dort erwartete Form gebracht.
 */
export function planPaperRegisterEntryLostAckAdoption(
  localEntries: PaperRegisterEntry[],
  remoteRows: WorkspacePaperRegisterEntryRow[],
  activeOutboxEntryIds: ReadonlySet<string>,
  sentWrites?: ReadonlyMap<string, LostAckSentWrite>,
): LostAckAdoptionPlan {
  const remotes = new Map<string, LostAckRemoteRow>();
  for (const row of remoteRows) {
    const mapped = mapWorkspacePaperRegisterEntryRow(row);
    if (!mapped) continue;
    remotes.set(mapped.entryId, {
      rowVersion: mapped.rowVersion,
      deleted: mapped.deleted,
      contentKey: mapped.payload
        ? buildPaperRegisterEntryCloudContentKey(
            paperRegisterEntryFromCloud(
              mapped.entryId,
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
  return planLostAckAdoption(localEntries, remotes, activeOutboxEntryIds, {
    sentWrites,
    localContentKey: buildPaperRegisterEntryCloudContentKey,
  });
}
