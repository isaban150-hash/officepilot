import type { AppPersistedState } from '../../types/models';
import type { SyncEntityType, SyncOutboxOperation, SyncableEntity } from '../../types/sync';
import { listEntitiesByType } from './syncEntityRegistry';
import { enqueueSyncOutbox } from './syncOutboxService';
import { buildCompanyProfileContentKey } from '../workspace/workspaceStore';
import { buildVorgangCloudContentKey } from '../vorgang/vorgangCloudService';
import { buildCustomerCloudContentKey } from '../customer/customerCloudService';
import { buildVorgangNoteCloudContentKey } from '../vorgang/vorgangNoteCloudService';
import { buildTaskCloudContentKey } from '../task/taskCloudService';
import { buildDunningDocumentationCloudContentKey } from '../invoice/dunningDocumentationCloudService';
import { buildBusinessLetterCloudContentKey } from '../letter/businessLetterCloudService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { buildCloudEntityId } from '../workspace/workspaceSyncPayloadService';
import type { Customer, Task, Vorgang } from '../../types/models';
import type { VorgangNote } from '../../types/communication';
import type { BusinessLetter } from '../../types/businessLetter';
import type { InvoiceDunningDocumentation } from '../../types/dunningDocumentation';
import { isCloudSyncBlockedMockTaskId, isCloudSyncBlockedMockVorgangId } from '../storage/mockDataDetectionService';
import {
  buildBindingContentKey,
  buildDocumentFileContentKey,
  buildWorkResultContentKey,
  isCloudSyncBlockedMockInboxId,
  isCloudSyncedBindingKind,
} from '../document/intakeCloudSyncService';
import type { DocumentFileRef } from '../../types/documentFileRef';
import type { DocumentFileRepresentationBinding } from '../../types/documentFileRepresentationBinding';
import type { DocumentWorkResult } from '../../types/documentWorkResult';
import { buildExpenseContentKey, isCloudSyncBlockedMockExpenseId } from '../expense/expenseCloudSyncService';
import type { Expense } from '../../types/expense';

export const TRACKED_SYNC_ENTITY_TYPES: SyncEntityType[] = [
  'inbox_item',
  'document',
  'document_file',
  'document_file_binding',
  'document_work_result',
  'document_memory',
  'proof_memory',
  'memory_relation',
  'paper_register_entry',
  'mail_import',
  'task',
  'expense',
  'vorgang',
  'customer',
  'vorgang_note',
  'communication_event',
  'knowledge_fact',
  // CLOUD-DURABILITY-CORE-01D — Nachweis über eine übergebene Mahnung.
  'dunning_documentation',
  // BRIEFE-01B — ausgehende Geschaeftsschreiben.
  'business_letter',
];

export const TRACKED_CLOUD_SYNC_ENTITY_TYPES: SyncEntityType[] = [
  'workspace',
  'workspace_member',
  'workspace_settings',
  'company_setup',
  'company_profile',
];

interface EntitySyncFingerprint {
  version: number;
  deleted: boolean;
  updatedAt: string;
  contentKey: string;
}

interface TrackedEntityRef {
  entityType: SyncEntityType;
  entityId: string;
  fingerprint: EntitySyncFingerprint;
}

let trackedFingerprints: Map<string, EntitySyncFingerprint> | null = null;

function entityKey(entityType: SyncEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function stripSyncField(entity: SyncableEntity & { id: string }): Record<string, unknown> {
  const { sync: _sync, ...rest } = entity as unknown as Record<string, unknown>;
  return rest;
}

function buildContentKey(entity: SyncableEntity & { id: string }): string {
  return JSON.stringify(stripSyncField(entity));
}

function buildFingerprint(entity: SyncableEntity & { id: string }): EntitySyncFingerprint {
  const sync = entity.sync;
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey: buildContentKey(entity),
  };
}

/** Fachlicher Fingerabdruck — `sync` bleibt aussen vor, siehe `fingerprintChanged`. */
function buildCustomerFingerprint(customer: Customer): EntitySyncFingerprint {
  const sync = customer.sync;
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey: buildCustomerCloudContentKey(customer),
  };
}

/*
 * FINANZ-CORE-DURABILITY-01B — Content-Keys der Intake-Entitaeten: nur
 * fachliche Felder, keine Server-Metadaten (sonst wuerde jede zurueckgeschriebene
 * Version einen neuen Push ausloesen).
 */
function buildIntakeFingerprint(entityType: SyncEntityType, entity: SyncableEntity & { id: string }): EntitySyncFingerprint {
  const sync = entity.sync;
  const contentKey =
    entityType === 'document_file'
      ? buildDocumentFileContentKey(entity as unknown as DocumentFileRef)
      : entityType === 'document_file_binding'
        ? buildBindingContentKey(entity as unknown as DocumentFileRepresentationBinding)
        : buildWorkResultContentKey(entity as unknown as DocumentWorkResult);
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey,
  };
}

/* FINANZ-CORE-DURABILITY-01C — Zahlungen/Zahlstatus ausgeklammert: eine Zahlung ist kein Beleg-Push. */
function buildExpenseFingerprint(expense: Expense): EntitySyncFingerprint {
  const sync = expense.sync;
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey: buildExpenseContentKey(expense),
  };
}

/** CLOUD-DURABILITY-CORE-01D — fachlicher Fingerabdruck des Mahnnachweises. */
function buildDunningDocumentationFingerprint(
  documentation: InvoiceDunningDocumentation,
): EntitySyncFingerprint {
  const sync = documentation.sync;
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey: buildDunningDocumentationCloudContentKey(documentation),
  };
}

/**
 * CLOUD-DURABILITY-CORE-01C — fachlicher Fingerabdruck der Aufgabe.
 *
 * Ohne `sync` und ohne die abgeleiteten Legacy-Spiegel: Sonst meldete jede
 * zurückgeschriebene Serverversion eine Änderung, und der nächste Push erzeugte
 * die nächste Version.
 */
function buildTaskFingerprint(task: Task): EntitySyncFingerprint {
  const sync = task.sync;
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey: buildTaskCloudContentKey(task),
  };
}

/** CLOUD-DURABILITY-CORE-01B — fachlicher Fingerabdruck der Notiz, ohne `sync`. */
function buildVorgangNoteFingerprint(note: VorgangNote): EntitySyncFingerprint {
  const sync = note.sync;
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey: buildVorgangNoteCloudContentKey(note),
  };
}

/** BRIEFE-01B — fachlicher Fingerabdruck des Briefs, ohne `sync`. */
function buildBusinessLetterFingerprint(letter: BusinessLetter): EntitySyncFingerprint {
  const sync = letter.sync;
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey: buildBusinessLetterCloudContentKey(letter),
  };
}

function buildVorgangFingerprint(vorgang: Vorgang): EntitySyncFingerprint {
  const sync = vorgang.sync;
  return {
    version: sync?.version ?? 0,
    deleted: sync?.deleted ?? false,
    updatedAt: sync?.updatedAt ?? '',
    contentKey: buildVorgangCloudContentKey(vorgang),
  };
}

function collectTrackedEntities(state: AppPersistedState): Map<string, TrackedEntityRef> {
  const refs = new Map<string, TrackedEntityRef>();

  for (const entityType of TRACKED_SYNC_ENTITY_TYPES) {
    for (const entity of listEntitiesByType(state, entityType)) {
      // Vorschau/Thumbnail-Bindings sind lokal regenerierbar und werden nicht verfolgt.
      if (entityType === 'document_file_binding' && !isCloudSyncedBindingKind((entity as unknown as DocumentFileRepresentationBinding).kind)) {
        continue;
      }
      refs.set(entityKey(entityType, entity.id), {
        entityType,
        entityId: entity.id,
        fingerprint:
          entityType === 'vorgang'
            ? buildVorgangFingerprint(entity as Vorgang)
            : entityType === 'customer'
              ? buildCustomerFingerprint(entity as Customer)
              : entityType === 'document_file' || entityType === 'document_file_binding' || entityType === 'document_work_result'
                ? buildIntakeFingerprint(entityType, entity)
                : entityType === 'expense'
                  ? buildExpenseFingerprint(entity as Expense)
                  : entityType === 'vorgang_note'
                    ? buildVorgangNoteFingerprint(entity as unknown as VorgangNote)
                    : entityType === 'task'
                      ? buildTaskFingerprint(entity as Task)
                      : entityType === 'business_letter'
                        ? buildBusinessLetterFingerprint(entity as unknown as BusinessLetter)
                        : entityType === 'dunning_documentation'
                        ? buildDunningDocumentationFingerprint(
                            entity as unknown as InvoiceDunningDocumentation,
                          )
                        : buildFingerprint(entity),
      });
    }
  }

  const workspaceId = resolveCloudWorkspaceId(state);
  if (workspaceId) {
    if (state.workspace) {
      refs.set(entityKey('workspace', state.workspace.id), {
        entityType: 'workspace',
        entityId: state.workspace.id,
        fingerprint: buildFingerprint(state.workspace as SyncableEntity & { id: string }),
      });
    }
    if (state.workspaceSettings) {
      refs.set(entityKey('workspace_settings', state.workspaceSettings.workspaceId), {
        entityType: 'workspace_settings',
        entityId: state.workspaceSettings.workspaceId,
        fingerprint: buildFingerprint({
          ...state.workspaceSettings,
          id: state.workspaceSettings.workspaceId,
        } as SyncableEntity & { id: string }),
      });
    }
    for (const member of state.workspaceMembers ?? []) {
      const memberId = buildCloudEntityId('workspace_member', member.workspaceId, member.userId);
      refs.set(entityKey('workspace_member', memberId), {
        entityType: 'workspace_member',
        entityId: memberId,
        fingerprint: buildFingerprint({ ...member, id: memberId } as SyncableEntity & { id: string }),
      });
    }
    refs.set(entityKey('company_setup', workspaceId), {
      entityType: 'company_setup',
      entityId: workspaceId,
      fingerprint: {
        version: state.setupSync?.version ?? 0,
        deleted: state.setupSync?.deleted ?? false,
        updatedAt: state.setupSync?.updatedAt ?? '',
        contentKey: JSON.stringify(state.setup),
      },
    });
    if (state.companyProfile) {
      refs.set(entityKey('company_profile', workspaceId), {
        entityType: 'company_profile',
        entityId: workspaceId,
        fingerprint: {
          version: state.companyProfileSync?.version ?? 0,
          deleted: state.companyProfileSync?.deleted ?? false,
          updatedAt: state.companyProfileSync?.updatedAt ?? '',
          /*
           * COMPANY-PROFILE-CONTENT-KEY-CANONICAL-01B — kanonisch statt roh.
           *
           * Vorher stand hier ein blosser `JSON.stringify`. Er hing an der
           * Schlüsselreihenfolge und hielt ein fehlendes Feld für etwas
           * anderes als dasselbe Feld mit leerem Wert. Beides zusammen machte
           * aus jeder Schemaerweiterung eine Scheinänderung — gemessen am
           * Registerblock, der bei jedem bestehenden Profil einen Push
           * erzeugte, für den niemand etwas geändert hatte.
           *
           * `company_setup` bleibt bewusst unangetastet; ob dort dasselbe
           * gilt, ist eine eigene Frage.
           */
          contentKey: buildCompanyProfileContentKey(state.companyProfile),
        },
      });
    }
  }

  return refs;
}

function fingerprintChanged(
  previous: EntitySyncFingerprint,
  current: EntitySyncFingerprint,
  entityType?: SyncEntityType,
): boolean {
  /*
   * PRODUCT-FOUNDATION-03A-C1 — Kunden folgen demselben Schutz wie Vorgang und
   * Firmendaten: Eine zurückgeschriebene Serverversion ist keine fachliche
   * Änderung und darf keinen neuen Auftrag erzeugen, der die nächste Version
   * auslöst.
   */
  if (
    entityType === 'vorgang' ||
    entityType === 'customer' ||
    entityType === 'inbox_item' ||
    entityType === 'document' ||
    entityType === 'document_file' ||
    entityType === 'document_file_binding' ||
    entityType === 'document_work_result' ||
    entityType === 'expense' ||
    entityType === 'vorgang_note' ||
    entityType === 'task' ||
    entityType === 'business_letter' ||
    entityType === 'dunning_documentation'
  ) {
    return (
      previous.deleted !== current.deleted ||
      previous.contentKey !== current.contentKey
    );
  }
  /**
   * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02D — Firmendaten: eine reine
   * Server-Metaänderung (Version, Zeitstempel, Gerät, Workspace) ist keine
   * fachliche Änderung. Sonst erzeugt jede zurückgeschriebene Serverversion
   * einen neuen Auftrag — und damit einen Push, der die nächste Version
   * auslöst. Echte Inhaltsänderungen ändern den contentKey und werden erfasst.
   */
  if (entityType === 'company_setup' || entityType === 'company_profile') {
    return (
      previous.deleted !== current.deleted || previous.contentKey !== current.contentKey
    );
  }
  return (
    previous.version !== current.version ||
    previous.deleted !== current.deleted ||
    previous.updatedAt !== current.updatedAt ||
    previous.contentKey !== current.contentKey
  );
}

function resolveOperation(
  previous: EntitySyncFingerprint | undefined,
  current: EntitySyncFingerprint,
): SyncOutboxOperation {
  if (current.deleted && (!previous || !previous.deleted)) {
    return 'delete';
  }
  if (!previous) {
    return 'create';
  }
  return 'update';
}

function resolveVersion(fingerprint: EntitySyncFingerprint): number {
  return Math.max(1, fingerprint.version);
}

export function resetSyncChangeTrackerFromState(state: AppPersistedState): void {
  trackedFingerprints = new Map(
    [...collectTrackedEntities(state).entries()].map(([key, ref]) => [key, ref.fingerprint]),
  );
}

export function resetSyncChangeTrackerForTests(): void {
  trackedFingerprints = null;
}

export function trackPersistedChanges(state: AppPersistedState): void {
  const currentEntities = collectTrackedEntities(state);

  if (trackedFingerprints === null) {
    trackedFingerprints = new Map(
      [...currentEntities.entries()].map(([key, ref]) => [key, ref.fingerprint]),
    );
    return;
  }

  for (const [key, ref] of currentEntities.entries()) {
    const previous = trackedFingerprints.get(key);
    if (previous && !fingerprintChanged(previous, ref.fingerprint, ref.entityType)) {
      continue;
    }

    // Demo seed IDs must never enter a real workspace outbox (ID-only guard).
    if (ref.entityType === 'vorgang' && isCloudSyncBlockedMockVorgangId(ref.entityId)) {
      continue;
    }
    // 01B — Demo-Eingaenge (inbox-00N) und ihre Ergebnisse bleiben lokal.
    if ((ref.entityType === 'inbox_item' || ref.entityType === 'document_work_result') && isCloudSyncBlockedMockInboxId(ref.entityId)) {
      continue;
    }
    // 01C — Demo-Ausgaben (exp-00N) bleiben lokal.
    if (ref.entityType === 'expense' && isCloudSyncBlockedMockExpenseId(ref.entityId)) {
      continue;
    }
    // CLOUD-DURABILITY-CORE-01C — Demo-Aufgaben (t-001…t-003) bleiben lokal.
    if (ref.entityType === 'task' && isCloudSyncBlockedMockTaskId(ref.entityId)) {
      continue;
    }

    enqueueSyncOutbox({
      entityType: ref.entityType,
      entityId: ref.entityId,
      operation: resolveOperation(previous, ref.fingerprint),
      version: resolveVersion(ref.fingerprint),
    });
  }

  trackedFingerprints = new Map(
    [...currentEntities.entries()].map(([key, ref]) => [key, ref.fingerprint]),
  );
}

export function getSyncChangeTrackerSnapshotForTests(): Map<string, EntitySyncFingerprint> {
  return new Map(trackedFingerprints ?? []);
}

export function captureSyncChangeTrackerState(): Map<string, EntitySyncFingerprint> | null {
  return trackedFingerprints === null ? null : new Map(trackedFingerprints);
}

export function restoreSyncChangeTrackerState(
  snapshot: Map<string, EntitySyncFingerprint> | null,
): void {
  trackedFingerprints = snapshot === null ? null : new Map(snapshot);
}
