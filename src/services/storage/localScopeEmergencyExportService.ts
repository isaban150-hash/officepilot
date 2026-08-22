/**
 * OFFICEPILOT-LOCAL-SCOPE-BLOB-RECOVERY-01B — baut die Notfall-ZIP aus dem
 * unveränderten localStorage-Rohtext und den Dateien genau dieses Scopes.
 *
 * Reiner Export: kein Wiederherstellen, kein Übernehmen, kein Zusammenführen,
 * kein Sync. Es wird nichts geschrieben — weder localStorage noch IndexedDB.
 */
import JSZip from 'jszip';
import {
  buildScopeKeyFromStorageKey,
  readScopeBlobRecord,
  type ScopeBlobReadStatus,
} from './localScopeBlobInventoryService';

export const EMERGENCY_BACKUP_FORMAT_VERSION = 1;

export type EmergencyFileStatus =
  | 'found'
  | 'missing'
  | 'read_error'
  | 'invalid_ref'
  | 'embedded_in_raw_state'
  | 'duplicate_ref';

export interface EmergencyFileEntry {
  fileRefId?: string;
  storageType?: string;
  mimeType?: string;
  /** Aus dem Ref übernommen, unverändert. */
  expectedFileSize?: number;
  expectedContentHash?: string;
  /** Aus dem IndexedDB-Datensatz übernommen, unverändert. */
  recordFileSize?: number;
  recordContentHash?: string;
  recordCreatedAt?: string;
  path?: string;
  status: EmergencyFileStatus;
  /** Abweichungen werden gemeldet, nie korrigiert. */
  mismatches?: string[];
  duplicateOf?: string;
  errorMessage?: string;
}

export interface EmergencyFileManifest {
  formatVersion: number;
  kind: 'officepilot-local-recovery-emergency';
  exportedAt: string;
  origin: string;
  storageKey: string;
  scopeKey: string;
  entries: EmergencyFileEntry[];
  summary: {
    refs: number;
    found: number;
    missing: number;
    readError: number;
    invalid: number;
  };
}

export interface EmergencyExportResult {
  ok: boolean;
  blob?: Blob;
  filename?: string;
  manifest?: EmergencyFileManifest;
  reason?: 'no_raw_state' | 'unsupported_scope' | 'build_failed';
}

interface RawRef {
  id?: unknown;
  storageType?: unknown;
  mimeType?: unknown;
  fileSize?: unknown;
  contentHash?: unknown;
  localDataKey?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Neutraler, sicherer Pfad — niemals fileRefId oder Originaldateiname. */
function buildFilePath(index: number): string {
  return `files/file-${index}.bin`;
}

export function buildEmergencyZipFilename(scopeKey: string, index: number): string {
  const scopeType = scopeKey.split(':')[0] ?? 'scope';
  return `officepilot-notfall-${scopeType}-${index + 1}.zip`;
}

/** Liest die documentFileRefs aus genau diesem Rohzustand. */
export function readFileRefsFromRawState(rawText: string): RawRef[] | null {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object') return null;
    const refs = (parsed as { documentFileRefs?: unknown }).documentFileRefs;
    return Array.isArray(refs) ? (refs as RawRef[]) : [];
  } catch {
    return null;
  }
}

function legacyBytesFromRawState(rawText: string, localDataKey?: string): string | undefined {
  if (!localDataKey) return undefined;
  try {
    const parsed = JSON.parse(rawText) as { documentFileBlobs?: Record<string, unknown> };
    const value = parsed.documentFileBlobs?.[localDataKey];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function statusFromRead(status: ScopeBlobReadStatus): EmergencyFileStatus {
  if (status === 'ok') return 'found';
  if (status === 'missing' || status === 'database_missing' || status === 'store_missing') {
    return 'missing';
  }
  return 'read_error';
}

export interface BuildEmergencyBackupInput {
  storageKey: string;
  rawText: string;
  origin: string;
  exportedAt: string;
  /** Laufende Nummer der Kopie in der Anzeige — nur für den Dateinamen. */
  index: number;
}

export async function buildLocalScopeEmergencyBackup(
  input: BuildEmergencyBackupInput,
): Promise<EmergencyExportResult> {
  const scopeKey = buildScopeKeyFromStorageKey(input.storageKey);
  if (!scopeKey) return { ok: false, reason: 'unsupported_scope' };

  const refs = readFileRefsFromRawState(input.rawText);
  if (refs === null) return { ok: false, reason: 'no_raw_state' };

  try {
    const zip = new JSZip();
    // Exakt der unveränderte Rohtext — kein Parse/Stringify-Umweg.
    zip.file('raw-state.json', input.rawText);

    const entries: EmergencyFileEntry[] = [];
    const pathByRefId = new Map<string, string>();
    let fileIndex = 0;

    for (const ref of refs) {
      const fileRefId = optionalString(ref?.id);
      const storageType = optionalString(ref?.storageType);
      const base: EmergencyFileEntry = {
        fileRefId,
        storageType,
        mimeType: optionalString(ref?.mimeType),
        expectedFileSize: optionalNumber(ref?.fileSize),
        expectedContentHash: optionalString(ref?.contentHash),
        status: 'invalid_ref',
      };

      if (!fileRefId) {
        entries.push(base);
        continue;
      }

      const alreadyExported = pathByRefId.get(fileRefId);
      if (alreadyExported) {
        entries.push({ ...base, status: 'duplicate_ref', duplicateOf: alreadyExported });
        continue;
      }

      if (storageType === 'local_data_url') {
        const embedded = legacyBytesFromRawState(input.rawText, optionalString(ref?.localDataKey));
        entries.push({
          ...base,
          status: embedded ? 'embedded_in_raw_state' : 'missing',
        });
        continue;
      }

      const read = await readScopeBlobRecord(scopeKey, fileRefId);
      if (read.status !== 'ok' || !read.bytes) {
        entries.push({
          ...base,
          status: statusFromRead(read.status),
          errorMessage: read.errorMessage,
        });
        continue;
      }

      fileIndex += 1;
      const path = buildFilePath(fileIndex);
      // STORE statt Deflate: PDFs und Bilder sind bereits komprimiert.
      zip.file(path, read.bytes, { compression: 'STORE', binary: true });
      pathByRefId.set(fileRefId, path);

      const mismatches: string[] = [];
      if (
        base.expectedFileSize !== undefined &&
        read.meta?.fileSize !== undefined &&
        base.expectedFileSize !== read.meta.fileSize
      ) {
        mismatches.push('fileSize');
      }
      if (
        base.expectedContentHash &&
        read.meta?.contentHash &&
        base.expectedContentHash !== read.meta.contentHash
      ) {
        mismatches.push('contentHash');
      }
      if (read.bytes.byteLength !== (read.meta?.fileSize ?? read.bytes.byteLength)) {
        mismatches.push('recordBytes');
      }

      entries.push({
        ...base,
        status: 'found',
        path,
        recordFileSize: read.meta?.fileSize,
        recordContentHash: read.meta?.contentHash,
        recordCreatedAt: read.meta?.createdAt,
        ...(mismatches.length > 0 ? { mismatches } : {}),
      });
    }

    const manifest: EmergencyFileManifest = {
      formatVersion: EMERGENCY_BACKUP_FORMAT_VERSION,
      kind: 'officepilot-local-recovery-emergency',
      exportedAt: input.exportedAt,
      origin: input.origin,
      storageKey: input.storageKey,
      scopeKey,
      entries,
      summary: {
        refs: refs.length,
        found: entries.filter((entry) => entry.status === 'found').length,
        missing: entries.filter((entry) => entry.status === 'missing').length,
        readError: entries.filter((entry) => entry.status === 'read_error').length,
        invalid: entries.filter(
          (entry) => entry.status === 'invalid_ref' || entry.status === 'duplicate_ref',
        ).length,
      },
    };

    zip.file('files-manifest.json', JSON.stringify(manifest, null, 2));
    zip.file(
      'README.txt',
      [
        'OfficePilot — lokale Notfallsicherung',
        '',
        `Herkunft (Origin): ${input.origin}`,
        `Bereich (Scope):   ${scopeKey}`,
        `Speicherschlüssel: ${input.storageKey}`,
        `Erstellt am:       ${input.exportedAt}`,
        '',
        'raw-state.json enthält den lokalen Zustandsdatensatz unverändert.',
        'files/ enthält die Dateien genau dieses Bereichs, Byte für Byte.',
        'files-manifest.json listet jede Datei samt Status; fehlende Dateien stehen dort.',
        '',
        'Es wurde nichts übernommen, nichts zusammengeführt und nichts synchronisiert.',
        'Diese Sicherung verändert weder die App noch die Cloud.',
      ].join('\n'),
    );

    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
    return {
      ok: true,
      blob,
      filename: buildEmergencyZipFilename(scopeKey, input.index),
      manifest,
    };
  } catch {
    return { ok: false, reason: 'build_failed' };
  }
}
