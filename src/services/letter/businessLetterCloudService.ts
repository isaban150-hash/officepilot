/**
 * BRIEFE-01B — Cloud-Anbindung der Geschäftsschreiben.
 *
 * Diese Datei trägt ausschliesslich Transport: Payload, Inhaltsschlüssel,
 * Lesen der Serverzeile, Merge, Altbestand und Wiederanlauf nach verlorener
 * Bestätigung. **Keine** Fachlogik — Anlegen, Ändern, Fertigstellen und
 * Löschen bleiben in `businessLetterService`, und dort wird kein einziger
 * Cloud-Aufruf gemacht: Der Weg in die Cloud führt über den Änderungsverfolger
 * und die vorhandene Warteschlange.
 *
 * Aufgebaut nach dem Muster von `vorgangNoteCloudService` — dieselbe
 * Versionssemantik, dieselbe Konfliktregel, derselbe Wiederanlauf aus
 * 01G bis 01G7. Bewusst keine zweite Sync-Architektur.
 */
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import {
  planLostAckAdoption,
  type LostAckAdoptionPlan,
  type LostAckRemoteRow,
  type LostAckSentWrite,
} from '../sync/syncLostAckAdoptionService';
import type {
  BusinessLetter,
  BusinessLetterRecipient,
  BusinessLetterStatus,
} from '../../types/businessLetter';
import { BUSINESS_LETTER_STATUSES } from '../../types/businessLetter';
import type { CompanyProfile } from '../../types/models';
import type { SyncMeta } from '../../types/sync';

/** Zeile aus `public.workspace_business_letters` — exakt die Spalten der Migration. */
export interface WorkspaceBusinessLetterRow {
  id?: string;
  workspace_id: string;
  client_letter_id: string;
  client_customer_id: string | null;
  client_vorgang_id: string | null;
  status: string | null;
  payload: Record<string, unknown>;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at: string;
}

/** Fachlicher Cloud-Payload eines Briefs — ohne jede Cloud-Metainformation. */
export interface BusinessLetterCloudPayload {
  id: string;
  workspaceId: string;
  subject: string;
  body: string;
  letterDate: string;
  recipient: BusinessLetterRecipient;
  status: BusinessLetterStatus;
  createdAt: string;
  customerId?: string;
  vorgangId?: string;
  companySnapshot?: CompanyProfile;
  documentId?: string;
  updatedAt?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resolveStatus(value: unknown): BusinessLetterStatus {
  return BUSINESS_LETTER_STATUSES.includes(value as BusinessLetterStatus)
    ? (value as BusinessLetterStatus)
    : 'draft';
}

function stripRecipient(recipient: BusinessLetterRecipient): BusinessLetterRecipient {
  const out: BusinessLetterRecipient = {
    name: recipient.name,
    street: recipient.street,
    zip: recipient.zip,
    city: recipient.city,
  };
  if (isNonEmptyString(recipient.company)) out.company = recipient.company;
  if (isNonEmptyString(recipient.country)) out.country = recipient.country;
  return out;
}

function parseRecipient(value: unknown): BusinessLetterRecipient {
  const raw = (value ?? {}) as Record<string, unknown>;
  const out: BusinessLetterRecipient = {
    name: text(raw.name),
    street: text(raw.street),
    zip: text(raw.zip),
    city: text(raw.city),
  };
  if (isNonEmptyString(raw.company)) out.company = raw.company;
  if (isNonEmptyString(raw.country)) out.country = raw.country;
  return out;
}

/**
 * Ausdrückliche Allowlist statt Rest-Spread: Ein später ergänztes Feld soll
 * nicht unbemerkt in Cloud und Inhaltsschlüssel wandern. `sync` bleibt
 * draussen; `updatedAt` gehört hinein, weil es die **fachliche** Änderung
 * datiert — ohne sie bliebe eine Rücknahme auf einen früheren Text unerkannt.
 *
 * Optionale Felder reisen nur mit, wenn sie belegt sind. Damit ergeben „Feld
 * fehlt" und „Feld ist undefined" denselben Schlüssel und lösen keinen
 * Schein-Versand aus.
 */
export function stripBusinessLetterForCloud(letter: BusinessLetter): BusinessLetterCloudPayload {
  const payload: BusinessLetterCloudPayload = {
    id: letter.id,
    workspaceId: letter.workspaceId,
    subject: letter.subject,
    body: letter.body,
    letterDate: letter.letterDate,
    recipient: stripRecipient(letter.recipient),
    status: letter.status,
    createdAt: letter.createdAt,
  };
  if (isNonEmptyString(letter.customerId)) payload.customerId = letter.customerId;
  if (isNonEmptyString(letter.vorgangId)) payload.vorgangId = letter.vorgangId;
  if (letter.companySnapshot) payload.companySnapshot = letter.companySnapshot;
  if (isNonEmptyString(letter.documentId)) payload.documentId = letter.documentId;
  if (isNonEmptyString(letter.updatedAt)) payload.updatedAt = letter.updatedAt;
  return payload;
}

/**
 * Stabiler fachlicher Vergleichsschlüssel. Enthält bewusst keine `SyncMeta`:
 * Der Server schreibt nach jedem Versand eine neue Version zurück; flösse sie
 * hier ein, löste jede Rückschreibung den nächsten Versand aus.
 */
export function buildBusinessLetterCloudContentKey(letter: BusinessLetter): string {
  return JSON.stringify(stripBusinessLetterForCloud(letter));
}

/**
 * Versandform: Identität, die serverseitig geführten Merkmale und die Nutzlast.
 *
 * `client_customer_id`, `client_vorgang_id` und `status` stehen als eigene
 * Spalten, weil der Server danach filtert und ordnet; alles Übrige bleibt
 * Payload. Beim Grabstein reist der Bezug mit, sonst verlöre die Serverzeile
 * ihre Zuordnung.
 */
export function buildBusinessLetterCloudPushPayload(
  letter: BusinessLetter,
  deleted = false,
): Record<string, unknown> {
  return {
    letter_id: letter.id,
    customer_id: letter.customerId ?? null,
    vorgang_id: letter.vorgangId ?? null,
    status: letter.status,
    payload: stripBusinessLetterForCloud(letter),
    deleted,
  };
}

/** Nur die deklarierten Felder werden übernommen — keine Serverspalten. */
export function parseBusinessLetterCloudPayload(
  payload: Record<string, unknown> | null,
): BusinessLetterCloudPayload | null {
  if (!payload) return null;
  const inner = (payload.payload as Record<string, unknown> | undefined) ?? payload;
  if (!inner || typeof inner !== 'object') return null;
  if (!isNonEmptyString(inner.id)) return null;

  const parsed: BusinessLetterCloudPayload = {
    id: inner.id,
    workspaceId: text(inner.workspaceId),
    subject: text(inner.subject),
    body: text(inner.body),
    letterDate: text(inner.letterDate),
    recipient: parseRecipient(inner.recipient),
    status: resolveStatus(inner.status),
    createdAt: text(inner.createdAt),
  };
  if (isNonEmptyString(inner.customerId)) parsed.customerId = inner.customerId;
  if (isNonEmptyString(inner.vorgangId)) parsed.vorgangId = inner.vorgangId;
  if (inner.companySnapshot && typeof inner.companySnapshot === 'object') {
    parsed.companySnapshot = inner.companySnapshot as CompanyProfile;
  }
  if (isNonEmptyString(inner.documentId)) parsed.documentId = inner.documentId;
  if (isNonEmptyString(inner.updatedAt)) parsed.updatedAt = inner.updatedAt;
  return parsed;
}

export function mapWorkspaceBusinessLetterRow(row: WorkspaceBusinessLetterRow): {
  letterId: string;
  customerId: string | null;
  vorgangId: string | null;
  payload: BusinessLetterCloudPayload | null;
  rowVersion: number;
  deleted: boolean;
  updatedAt: string;
} | null {
  if (!isNonEmptyString(row.client_letter_id)) return null;
  const parsed = parseBusinessLetterCloudPayload(row.payload);
  // Ein Grabstein ohne Fachinhalt bleibt gültig — ohne ihn käme die Löschung nie an.
  if (!parsed && !row.deleted) return null;
  return {
    letterId: row.client_letter_id,
    customerId: row.client_customer_id ?? parsed?.customerId ?? null,
    vorgangId: row.client_vorgang_id ?? parsed?.vorgangId ?? null,
    payload: parsed,
    rowVersion: Number(row.row_version),
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

export function businessLetterFromCloud(
  letterId: string,
  payload: BusinessLetterCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): BusinessLetter {
  return {
    ...payload,
    id: letterId,
    workspaceId: payload.workspaceId || workspaceId,
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
 * Zeilenweiser Merge nach `letter.id`, aufgebaut auf der vorhandenen
 * Merge-Engine. Kein Feldmerge, keine Last-Write-Wins-Regel.
 *
 * `dirtyIds` sind die Kennungen mit **offenem Sendeauftrag**: lokale Arbeit,
 * die der Server noch nicht gesehen hat. Sie ist der Grund, warum der Pull
 * nicht einfach der höheren Serverversion folgen darf. Verglichen wird dabei
 * der fachliche Inhalt, nicht die Versionszahl — nach einer verlorenen
 * Bestätigung trägt der Server unsere eigene Fassung mit höherer Version, und
 * das ist kein Streit, sondern die fehlende Bestätigung (01G2).
 */
export function mergeBusinessLettersFromPull(
  localLetters: BusinessLetter[],
  remoteRows: WorkspaceBusinessLetterRow[],
  deviceId: string,
  workspaceId: string,
  dirtyIds: ReadonlySet<string> = new Set(),
): { letters: BusinessLetter[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localLetters.map((letter) => [letter.id, letter]));

  for (const row of remoteRows) {
    const mapped = mapWorkspaceBusinessLetterRow(row);
    if (!mapped) continue;

    if (mapped.deleted) {
      /*
       * Die Löschung hat auf dem anderen Gerät stattgefunden und ist die
       * jüngere Wahrheit. Eine ungesendete lokale Änderung wird davon aber
       * nicht stillschweigend mitgenommen (01G).
       */
      if (dirtyIds.has(mapped.letterId) && byId.has(mapped.letterId)) {
        conflicts.push(`business_letter:${mapped.letterId}`);
        continue;
      }
      byId.delete(mapped.letterId);
      continue;
    }
    if (!mapped.payload) continue;

    const local = byId.get(mapped.letterId) ?? null;
    const remote = businessLetterFromCloud(
      mapped.letterId,
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
      if (buildBusinessLetterCloudContentKey(local) === buildBusinessLetterCloudContentKey(remote)) {
        byId.set(remote.id, remote);
      } else {
        conflicts.push(`business_letter:${mapped.letterId}`);
      }
      continue;
    }

    if (dirtyIds.has(mapped.letterId) && mapped.rowVersion !== (local.sync?.version ?? 0)) {
      if (
        buildBusinessLetterCloudContentKey(local) !== buildBusinessLetterCloudContentKey(remote)
      ) {
        conflicts.push(`business_letter:${mapped.letterId}`);
        continue;
      }
      byId.set(remote.id, remote);
      continue;
    }

    const merged = mergeSyncEntities(local, remote, 'business_letter');
    if (merged.conflict) {
      conflicts.push(`business_letter:${mapped.letterId}`);
      continue;
    }
    const entity = merged.entity;
    if (entity) byId.set(entity.id, entity);
  }

  return { letters: [...byId.values()], conflicts };
}

/**
 * Altbestand — der einzige Weg, auf dem vor dieser Anbindung entstandene
 * Briefe in die Cloud gelangen.
 *
 * Der Änderungsverfolger kann das nicht leisten: Beim Start wird der vorhandene
 * Zustand zur Grundlinie, Bestandsbriefe gelten damit als unverändert und
 * werden nie eingereiht. Verglichen wird ausschliesslich über Kennungen, und
 * zwar gegen **alle** Serverzeilen einschliesslich der Grabsteine — sonst lüde
 * ein zweites Gerät einen anderswo gelöschten Brief wieder hoch.
 */
export function planBusinessLetterBackfill(
  localLetters: BusinessLetter[],
  remoteRows: WorkspaceBusinessLetterRow[],
): string[] {
  const remoteIds = new Set(
    remoteRows
      .map((row) => row.client_letter_id)
      .filter((id): id is string => isNonEmptyString(id)),
  );
  return localLetters
    .filter((letter) => letter.sync?.deleted !== true)
    .filter((letter) => !remoteIds.has(letter.id))
    .map((letter) => letter.id);
}

/** Setzt nach erfolgreichem Versand die Serverversion — ohne Fachdaten anzufassen. */
export function applyBusinessLetterPushResultToState(
  letters: BusinessLetter[],
  letterId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): BusinessLetter[] {
  return letters.map((letter) => {
    if (letter.id !== letterId) return letter;
    const sync: SyncMeta = {
      ...letter.sync,
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : letter.sync?.deletedAt,
      deviceId,
      workspaceId,
    };
    return { ...letter, sync };
  });
}

/**
 * SYNC-DURABILITY-HARDENING-01G4 bis 01G7 — Wiederanlauf nach verlorener
 * Bestätigung und nach einem Schreibvorgang, der den Server nie erreicht hat.
 *
 * Die Bewertung selbst liegt in `planLostAckAdoption`; hier wird nur die
 * Serverzeile in die dort erwartete Form gebracht.
 */
export function planBusinessLetterLostAckAdoption(
  localLetters: BusinessLetter[],
  remoteRows: WorkspaceBusinessLetterRow[],
  activeOutboxLetterIds: ReadonlySet<string>,
  sentWrites?: ReadonlyMap<string, LostAckSentWrite>,
): LostAckAdoptionPlan {
  const remotes = new Map<string, LostAckRemoteRow>();
  for (const row of remoteRows) {
    const mapped = mapWorkspaceBusinessLetterRow(row);
    if (!mapped) continue;
    remotes.set(mapped.letterId, {
      rowVersion: mapped.rowVersion,
      deleted: mapped.deleted,
      contentKey: mapped.payload
        ? buildBusinessLetterCloudContentKey(
            businessLetterFromCloud(
              mapped.letterId,
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
  return planLostAckAdoption(localLetters, remotes, activeOutboxLetterIds, {
    sentWrites,
    localContentKey: buildBusinessLetterCloudContentKey,
  });
}
