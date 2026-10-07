/**
 * CLOUD-SYNC S3 — Cloud-Anbindung des bestätigten Wissens.
 *
 * Diese Datei trägt ausschliesslich Transport: Payload, Inhaltsschlüssel,
 * Lesen der Serverzeile, Abgleich, Altbestand und Wiederanlauf nach verlorener
 * Bestätigung. **Keine** Fachlogik — Anlegen, Ändern, Aktivieren und Löschen
 * bleiben in `knowledgeService`, und dort wird kein Cloud-Aufruf gemacht: Der
 * Weg in die Cloud führt über den Änderungsverfolger und die vorhandene
 * Warteschlange.
 *
 * Ein Wissenseintrag ist veränderbar und kann gelöscht werden. Aufgebaut
 * deshalb nach dem Muster von `vorgangNoteCloudService` und
 * `paperRegisterCloudService` (S1) — dieselbe Versionssemantik, dieselbe
 * Konfliktregel, derselbe Wiederanlauf aus 01G bis 01G7. Bewusst keine zweite
 * Sync-Architektur.
 */
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import {
  planLostAckAdoption,
  type LostAckAdoptionPlan,
  type LostAckRemoteRow,
  type LostAckSentWrite,
} from '../sync/syncLostAckAdoptionService';
import type {
  KnowledgeCategory,
  KnowledgeFact,
  KnowledgeScope,
  KnowledgeSourceType,
} from '../../types/knowledge';
import type { SyncMeta } from '../../types/sync';

/** Zeile aus `public.workspace_knowledge_facts` — exakt die Spalten der Migration. */
export interface WorkspaceKnowledgeFactRow {
  id?: string;
  workspace_id: string;
  client_fact_id: string;
  scope: string | null;
  scope_id: string | null;
  category: string | null;
  active: boolean;
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
export interface KnowledgeFactCloudPayload {
  id: string;
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  key: string;
  value: string;
  displayText: string;
  sourceType: KnowledgeSourceType;
  confirmedAt: string;
  createdAt: string;
  active: boolean;
  scopeId?: string;
  scopeLabel?: string;
  sourceId?: string;
  updatedAt?: string;
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
 * datiert. Optionale Felder reisen nur mit, wenn sie belegt sind.
 */
export function stripKnowledgeFactForCloud(fact: KnowledgeFact): KnowledgeFactCloudPayload {
  const payload: KnowledgeFactCloudPayload = {
    id: fact.id,
    scope: fact.scope,
    category: fact.category,
    key: fact.key,
    value: fact.value,
    displayText: fact.displayText,
    sourceType: fact.sourceType,
    confirmedAt: text(fact.confirmedAt),
    createdAt: text(fact.createdAt),
    active: fact.active === true,
  };
  if (isNonEmptyString(fact.scopeId)) payload.scopeId = fact.scopeId;
  if (isNonEmptyString(fact.scopeLabel)) payload.scopeLabel = fact.scopeLabel;
  if (isNonEmptyString(fact.sourceId)) payload.sourceId = fact.sourceId;
  if (isNonEmptyString(fact.updatedAt)) payload.updatedAt = fact.updatedAt;
  return payload;
}

/**
 * Stabiler fachlicher Vergleichsschlüssel. Enthält bewusst keine `SyncMeta`:
 * Der Server schreibt nach jedem Versand eine neue Version zurück; flösse sie
 * hier ein, löste jede Rückschreibung den nächsten Versand aus.
 */
export function buildKnowledgeFactCloudContentKey(fact: KnowledgeFact): string {
  return JSON.stringify(stripKnowledgeFactForCloud(fact));
}

/** Versandform: Kennung, Scope, Nutzlast und — beim Löschen — der Grabstein. */
export function buildKnowledgeFactCloudPushPayload(
  fact: KnowledgeFact,
  deleted = false,
): Record<string, unknown> {
  return {
    fact_id: fact.id,
    scope: fact.scope,
    payload: stripKnowledgeFactForCloud(fact),
    deleted,
  };
}

/** Nur die deklarierten Felder werden übernommen — keine Serverspalten. */
export function parseKnowledgeFactCloudPayload(
  payload: Record<string, unknown> | null,
): KnowledgeFactCloudPayload | null {
  if (!payload) return null;
  const inner = (payload.payload as Record<string, unknown> | undefined) ?? payload;
  if (!inner || typeof inner !== 'object') return null;
  if (
    !isNonEmptyString(inner.id) ||
    !isNonEmptyString(inner.scope) ||
    !isNonEmptyString(inner.key) ||
    !isNonEmptyString(inner.value) ||
    !isNonEmptyString(inner.displayText) ||
    typeof inner.active !== 'boolean'
  ) {
    return null;
  }

  const parsed: KnowledgeFactCloudPayload = {
    id: inner.id,
    scope: inner.scope as KnowledgeScope,
    category: (isNonEmptyString(inner.category) ? inner.category : 'other') as KnowledgeCategory,
    key: inner.key,
    value: inner.value,
    displayText: inner.displayText,
    sourceType: (isNonEmptyString(inner.sourceType) ? inner.sourceType : 'user') as KnowledgeSourceType,
    confirmedAt: text(inner.confirmedAt),
    createdAt: text(inner.createdAt),
    active: inner.active,
  };
  if (isNonEmptyString(inner.scopeId)) parsed.scopeId = inner.scopeId;
  if (isNonEmptyString(inner.scopeLabel)) parsed.scopeLabel = inner.scopeLabel;
  if (isNonEmptyString(inner.sourceId)) parsed.sourceId = inner.sourceId;
  if (isNonEmptyString(inner.updatedAt)) parsed.updatedAt = inner.updatedAt;
  return parsed;
}

export function mapWorkspaceKnowledgeFactRow(row: WorkspaceKnowledgeFactRow): {
  factId: string;
  payload: KnowledgeFactCloudPayload | null;
  rowVersion: number;
  deleted: boolean;
  updatedAt: string;
} | null {
  if (!isNonEmptyString(row.client_fact_id)) return null;
  const parsed = parseKnowledgeFactCloudPayload(row.payload);
  // Ein Grabstein ohne Fachinhalt bleibt gültig — ohne ihn käme die Löschung nie an.
  if (!parsed && !row.deleted) return null;
  return {
    factId: row.client_fact_id,
    payload: parsed,
    rowVersion: Number(row.row_version),
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

export function knowledgeFactFromCloud(
  factId: string,
  payload: KnowledgeFactCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): KnowledgeFact {
  return {
    ...payload,
    id: factId,
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
 * Zeilenweiser Abgleich nach `fact.id`, aufgebaut auf der vorhandenen
 * Merge-Engine. Kein Feldmerge, keine Last-Write-Wins-Regel.
 *
 * `dirtyIds` sind die Kennungen mit **offenem Sendeauftrag**: lokale Arbeit,
 * die der Server noch nicht gesehen hat. Verglichen wird der fachliche Inhalt,
 * nicht die Versionszahl — nach einer verlorenen Bestätigung trägt der Server
 * unsere eigene Fassung mit höherer Version, und das ist kein Streit, sondern
 * die fehlende Bestätigung (01G2).
 */
export function mergeKnowledgeFactsFromPull(
  localFacts: KnowledgeFact[],
  remoteRows: WorkspaceKnowledgeFactRow[],
  deviceId: string,
  workspaceId: string,
  dirtyIds: ReadonlySet<string> = new Set(),
): { facts: KnowledgeFact[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localFacts.map((fact) => [fact.id, fact]));

  for (const row of remoteRows) {
    const mapped = mapWorkspaceKnowledgeFactRow(row);
    if (!mapped) continue;

    if (mapped.deleted) {
      /*
       * Der Eintrag wurde auf einem anderen Gerät gelöscht; der Grabstein ist
       * die jüngere Wahrheit. Eine ungesendete lokale Änderung wird davon aber
       * nicht stillschweigend mitgenommen (01G).
       */
      if (dirtyIds.has(mapped.factId) && byId.has(mapped.factId)) {
        conflicts.push(`knowledge_fact:${mapped.factId}`);
        continue;
      }
      byId.delete(mapped.factId);
      continue;
    }
    if (!mapped.payload) continue;

    const local = byId.get(mapped.factId) ?? null;
    const remote = knowledgeFactFromCloud(
      mapped.factId,
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

    if (local.sync && local.sync.version === mapped.rowVersion) {
      if (buildKnowledgeFactCloudContentKey(local) === buildKnowledgeFactCloudContentKey(remote)) {
        byId.set(remote.id, remote);
      } else {
        conflicts.push(`knowledge_fact:${mapped.factId}`);
      }
      continue;
    }

    if (dirtyIds.has(mapped.factId) && mapped.rowVersion !== (local.sync?.version ?? 0)) {
      if (buildKnowledgeFactCloudContentKey(local) !== buildKnowledgeFactCloudContentKey(remote)) {
        conflicts.push(`knowledge_fact:${mapped.factId}`);
        continue;
      }
      byId.set(remote.id, remote);
      continue;
    }

    const merged = mergeSyncEntities(local, remote, 'knowledge_fact');
    if (merged.conflict) {
      conflicts.push(`knowledge_fact:${mapped.factId}`);
      continue;
    }
    if (merged.entity) byId.set(merged.entity.id, merged.entity);
  }

  return { facts: [...byId.values()], conflicts };
}

/**
 * Altbestand — der einzige Weg, auf dem vor S3 entstandenes Wissen in die
 * Cloud gelangt. Verglichen wird ausschliesslich über Kennungen, und zwar
 * gegen **alle** Serverzeilen einschliesslich der Grabsteine — sonst lüde ein
 * zweites Gerät einen anderswo gelöschten Eintrag wieder hoch. Auch
 * deaktivierte Einträge reisen mit: Sie sind eine Nutzerentscheidung.
 */
export function planKnowledgeFactBackfill(
  localFacts: KnowledgeFact[],
  remoteRows: WorkspaceKnowledgeFactRow[],
): string[] {
  const remoteIds = new Set(
    remoteRows
      .map((row) => row.client_fact_id)
      .filter((id): id is string => isNonEmptyString(id)),
  );
  return localFacts
    .filter((fact) => fact.sync?.deleted !== true)
    .filter((fact) => !remoteIds.has(fact.id))
    .map((fact) => fact.id);
}

/** Setzt nach erfolgreichem Versand die Serverversion — ohne Fachdaten anzufassen. */
export function applyKnowledgeFactPushResultToState(
  facts: KnowledgeFact[],
  factId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): KnowledgeFact[] {
  return facts.map((fact) => {
    if (fact.id !== factId) return fact;
    const sync: SyncMeta = {
      ...fact.sync,
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : fact.sync?.deletedAt,
      deviceId,
      workspaceId,
    };
    return { ...fact, sync };
  });
}

/**
 * SYNC-DURABILITY-HARDENING-01G4 bis 01G7 — Wiederanlauf nach verlorener
 * Bestätigung und nach einem Schreibvorgang, der den Server nie erreicht hat.
 * Die Bewertung selbst liegt in `planLostAckAdoption`.
 */
export function planKnowledgeFactLostAckAdoption(
  localFacts: KnowledgeFact[],
  remoteRows: WorkspaceKnowledgeFactRow[],
  activeOutboxFactIds: ReadonlySet<string>,
  sentWrites?: ReadonlyMap<string, LostAckSentWrite>,
): LostAckAdoptionPlan {
  const remotes = new Map<string, LostAckRemoteRow>();
  for (const row of remoteRows) {
    const mapped = mapWorkspaceKnowledgeFactRow(row);
    if (!mapped) continue;
    remotes.set(mapped.factId, {
      rowVersion: mapped.rowVersion,
      deleted: mapped.deleted,
      contentKey: mapped.payload
        ? buildKnowledgeFactCloudContentKey(
            knowledgeFactFromCloud(mapped.factId, mapped.payload, mapped.rowVersion, mapped.updatedAt, false, '', ''),
          )
        : undefined,
    });
  }
  return planLostAckAdoption(localFacts, remotes, activeOutboxFactIds, {
    sentWrites,
    localContentKey: buildKnowledgeFactCloudContentKey,
  });
}
