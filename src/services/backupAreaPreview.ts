import { buildPersistedStateSnapshot } from './persistenceService';
import { getDocumentFileRefStoreSnapshot } from './documentFileStoreService';
import { getDocumentFileRepresentationBindingStoreSnapshot } from './documentFileRepresentationBindingStoreService';
import { buildBackupAreaCounts } from './backupAreaCounts';
import type { BackupAreaCounts } from '../types/backupExport';

/** All FileRefs in the store plus any binding targets (original + derived). */
export function collectRequiredBackupFileRefIds(): string[] {
  const ids = new Set<string>();
  for (const ref of getDocumentFileRefStoreSnapshot()) {
    ids.add(ref.id);
  }
  for (const binding of getDocumentFileRepresentationBindingStoreSnapshot()) {
    ids.add(binding.fileRefId);
  }
  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

/**
 * EINRICHTUNG-01 (AP7; 1.23) — die Zählung je Bereich vor dem Download: derselbe Bestand und dieselbe Funktion wie im
 * Manifest; „Dateien“ zählt hier die referenzierten Dateien.
 */
export function previewLocalBackupAreaCounts(): BackupAreaCounts {
  return buildBackupAreaCounts(buildPersistedStateSnapshot(), collectRequiredBackupFileRefIds().length);
}
