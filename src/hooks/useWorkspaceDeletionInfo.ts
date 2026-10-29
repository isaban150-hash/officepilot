import { useSyncExternalStore } from 'react';
import {
  getActiveWorkspaceAccessRecord,
  getWorkspaceAccessVersion,
  subscribeWorkspaceAccess,
} from '../services/workspace/workspaceAccessService';

/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.26) — Löschantrag des aktiven Betriebs, wie der Server ihn zuletzt bestätigt hat:
 * beantragt (Wartefrist, mit frühestem Ausführungsdatum) oder in Ausführung. Reaktiv wie die Zugriffsauskunft.
 */
export interface WorkspaceDeletionInfo {
  pending: boolean;
  inProgress: boolean;
  executeAfter: string | null;
}

const NONE: WorkspaceDeletionInfo = { pending: false, inProgress: false, executeAfter: null };

export function readWorkspaceDeletionInfo(): WorkspaceDeletionInfo {
  const record = getActiveWorkspaceAccessRecord();
  if (!record?.deletionPending) return NONE;
  return { pending: true, inProgress: record.deletionInProgress === true, executeAfter: record.deletionExecuteAfter ?? null };
}

export function useWorkspaceDeletionInfo(): WorkspaceDeletionInfo {
  useSyncExternalStore(subscribeWorkspaceAccess, getWorkspaceAccessVersion, getWorkspaceAccessVersion);
  return readWorkspaceDeletionInfo();
}

/** Datum für Hinweise (Tag, ohne Uhrzeit); unbekannt → Gedankenstrich. */
export function formatDeletionDate(value: string | null, language: string): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '—';
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  return new Date(parsed).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
}
