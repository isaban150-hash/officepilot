/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P2 / 02P2A — Kern für Zielsicherung,
 * erneute Dateiprüfung und lokale Quarantäne.
 *
 * Grundsätze dieses Dienstes:
 *  - Der Zielbereich wird **nur gelesen**. Kein Schlüssel des Zielscopes wird
 *    je geschrieben oder gelöscht.
 *  - Der aktive Scope wird nie verwendet; jeder Zugriff nennt den Ziel- bzw.
 *    Quarantäneschlüssel ausdrücklich.
 *  - Quarantäne ist kein StorageScope: eigene localStorage-Präfixe, eigener
 *    Blob-Namensraum `quarantine:`, eigene eng begrenzte Blob-API.
 *  - Vor dem ersten Quarantäneblob steht ein persistenter staging-Marker.
 *    Nur `complete` bedeutet vollständige Quarantäne.
 *  - staging-Marker werden niemals automatisch gelöscht.
 *  - 02P2A: Sicherheitsgrundlage ist ausschließlich eine private, tief kopierte
 *    WeakMap-Bindung. Die öffentlich zurückgegebene Sitzung ist tief eingefroren
 *    und wird nie als Quelle für Vergleiche verwendet.
 */
import {
  deleteQuarantineBlob,
  listQuarantineBlobRecords,
  readQuarantineBlob,
  writeQuarantineBlob,
  type QuarantineBlobScopeKey,
} from './documentBlobIndexedDbService';
import {
  buildLocalScopeEmergencyBackup,
  readFileRefsFromRawState,
} from './localScopeEmergencyExportService';
import { buildScopeKeyFromStorageKey, readScopeBlobRecord } from './localScopeBlobInventoryService';
import { readLocalScopeRawCopy } from './localScopeInventoryService';
import {
  readValidatedEmergencyBackupFileBytes,
  validateEmergencyBackupZip,
} from './localScopeEmergencyImportValidateService';
import { computeBufferContentHash } from '../documentFileHashService';
import {
  QUARANTINE_FORMAT_VERSION,
  QUARANTINE_KIND,
  QUARANTINE_MARKER_PREFIX,
  buildQuarantineMarkerKey,
  buildQuarantineStateKey,
  type CleanupQuarantineResult,
  type PrepareTargetBackupDeps,
  type PrepareTargetBackupResult,
  type PreparedTargetBackupSession,
  type QuarantineDeps,
  type QuarantineFailure,
  type QuarantineFileEntry,
  type QuarantineMarker,
  type QuarantinePhase,
  type QuarantineResult,
  type QuarantineStateEnvelope,
  type TargetScopeSnapshot,
  type VerifiedTargetBackupSession,
  type VerifyReselectedResult,
} from '../../types/emergencyBackupQuarantine';
import type { ValidatedEmergencyBackupBundle } from '../../types/emergencyBackupValidate';

const WORKSPACE_SCOPE_PREFIX = 'workspace:';
/** Kleine, begrenzte Anzahl Versuche für ein freies Token. */
const TOKEN_ATTEMPTS = 5;

/* -------------------------------------------------------------------------- */
/* Private, nicht fälschbare Bindung                                          */
/* -------------------------------------------------------------------------- */

/**
 * Die öffentliche Sitzung ist nur ein Anzeigeobjekt. Sämtliche Vergleichswerte
 * liegen hier — tief kopiert, unveränderlich und ausschließlich über die
 * Objektidentität erreichbar. Eine nachgebaute oder veränderte Objektform kann
 * damit weder etwas vortäuschen noch etwas verschieben.
 */
interface PreparedRecord {
  sourceStorageKey: string;
  sourceScopeKey: string;
  workspaceId: string;
  archiveSha256: string;
  sourceRawTextSha256: string;
  exportedAt: string;
  files: QuarantineFileEntry[];
  targetSnapshot: TargetScopeSnapshot;
  savedAt?: string;
}

interface VerifiedRecord extends PreparedRecord {
  /** Rohtext der ERNEUT ausgewählten Sicherung — einzige Quelle der Hülle. */
  reselectedRawText: string;
  reselectedBundle: ValidatedEmergencyBackupBundle;
}

let preparedRecords = new WeakMap<PreparedTargetBackupSession, PreparedRecord>();
let verifiedRecords = new WeakMap<VerifiedTargetBackupSession, VerifiedRecord>();

export function resetQuarantineSessionsForTests(): void {
  preparedRecords = new WeakMap<PreparedTargetBackupSession, PreparedRecord>();
  verifiedRecords = new WeakMap<VerifiedTargetBackupSession, VerifiedRecord>();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Tiefes Einfrieren; typisierte Puffer werden ausgelassen. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof Blob) return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

export function buildQuarantineBlobScopeKey(token: string): QuarantineBlobScopeKey {
  return `quarantine:${token}`;
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function toBytes(input: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await input.arrayBuffer());
}

/**
 * Streng monoton, damit zwei unmittelbar aufeinanderfolgende Sicherungen
 * desselben Ziels nachweislich unterschiedliche Archive ergeben.
 */
let lastExportedAt = 0;
function nextExportedAtIso(): string {
  const now = Date.now();
  lastExportedAt = now > lastExportedAt ? now : lastExportedAt + 1;
  return new Date(lastExportedAt).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Ziel-Momentaufnahme                                                        */
/* -------------------------------------------------------------------------- */

export async function readTargetScopeSnapshot(
  storageKey: string,
  scopeKey: string,
): Promise<TargetScopeSnapshot | null> {
  const rawText = readLocalScopeRawCopy(storageKey);
  if (rawText === null) return null;

  const refs = readFileRefsFromRawState(rawText);
  if (refs === null) return null;

  const files: TargetScopeSnapshot['files'] = [];
  for (const ref of refs) {
    const fileRefId = typeof ref?.id === 'string' ? ref.id : '';
    if (!fileRefId) continue;
    if (ref?.storageType !== 'indexeddb') continue;

    const read = await readScopeBlobRecord(scopeKey, fileRefId);
    if (read.status !== 'ok' || !read.bytes) {
      files.push({ fileRefId, fileSize: -1, sha256: `unreadable:${read.status}` });
      continue;
    }
    files.push({
      fileRefId,
      fileSize: read.bytes.byteLength,
      sha256: await computeBufferContentHash(read.bytes),
    });
  }

  files.sort((a, b) => a.fileRefId.localeCompare(b.fileRefId));
  return { rawTextSha256: await computeBufferContentHash(textBytes(rawText)), files };
}

/** Momentaufnahme, wie sie sich aus dem validierten Bündel ergibt. */
function snapshotFromBundle(bundle: ValidatedEmergencyBackupBundle): TargetScopeSnapshot {
  return {
    rawTextSha256: bundle.sourceRawTextSha256,
    files: bundle.files
      .map((file) => ({
        fileRefId: file.fileRefId,
        fileSize: file.fileSize,
        sha256: file.sha256,
      }))
      .sort((a, b) => a.fileRefId.localeCompare(b.fileRefId)),
  };
}

function sameSnapshot(a: TargetScopeSnapshot | null, b: TargetScopeSnapshot | null): boolean {
  if (!a || !b) return false;
  if (a.rawTextSha256 !== b.rawTextSha256) return false;
  if (a.files.length !== b.files.length) return false;
  return a.files.every((file, index) => {
    const other = b.files[index]!;
    return (
      file.fileRefId === other.fileRefId &&
      file.fileSize === other.fileSize &&
      file.sha256 === other.sha256
    );
  });
}

function filesFromBundle(bundle: ValidatedEmergencyBackupBundle): QuarantineFileEntry[] {
  return bundle.files
    .map((file) => ({
      fileRefId: file.fileRefId,
      localDataKey: file.localDataKey,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
      sha256: file.sha256,
    }))
    .sort((a, b) => a.fileRefId.localeCompare(b.fileRefId));
}

function sameFileList(a: QuarantineFileEntry[], b: QuarantineFileEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((file, index) => {
    const other = b[index]!;
    return (
      file.fileRefId === other.fileRefId &&
      file.localDataKey === other.localDataKey &&
      file.mimeType === other.mimeType &&
      file.fileSize === other.fileSize &&
      file.sha256 === other.sha256
    );
  });
}

/* -------------------------------------------------------------------------- */
/* 1. Zielbackup vorbereiten — Dreifachbindung                                */
/* -------------------------------------------------------------------------- */

export async function prepareTargetBackupSession(
  storageKey: string,
  deps: PrepareTargetBackupDeps = {},
): Promise<PrepareTargetBackupResult> {
  const scopeKey = buildScopeKeyFromStorageKey(storageKey);
  if (!scopeKey || !scopeKey.startsWith(WORKSPACE_SCOPE_PREFIX)) {
    return { ok: false, reason: 'unsupported_target_key', detail: storageKey };
  }
  const workspaceId = scopeKey.slice(WORKSPACE_SCOPE_PREFIX.length);

  const rawText = readLocalScopeRawCopy(storageKey);
  if (rawText === null) return { ok: false, reason: 'target_missing', detail: storageKey };

  // (1) Zustand unmittelbar vor dem ZIP-Bau.
  deps.onStage?.('snapshot_before');
  const snapshotBefore = await readTargetScopeSnapshot(storageKey, scopeKey);
  if (!snapshotBefore) return { ok: false, reason: 'target_missing', detail: storageKey };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const exportedAt = nextExportedAtIso();
  const built = await buildLocalScopeEmergencyBackup({
    storageKey,
    rawText,
    origin,
    exportedAt,
    index: 0,
  });
  if (!built.ok || !built.blob || !built.filename) {
    return { ok: false, reason: 'backup_build_failed', detail: built.reason };
  }
  deps.onStage?.('zip_built');

  const zipBytes = await toBytes(built.blob);
  const archiveSha256 = await computeBufferContentHash(zipBytes);

  const validated = await validateEmergencyBackupZip(zipBytes);
  if (!validated.ok) {
    return {
      ok: false,
      reason: 'backup_invalid',
      errors: validated.errors.map((error) => error.code),
    };
  }
  deps.onStage?.('validated');

  // (2) Zustand, wie ihn das validierte Bündel bezeugt.
  const snapshotFromZip = snapshotFromBundle(validated.bundle);

  // (3) Zustand unmittelbar nach Bau und Validierung.
  deps.onStage?.('snapshot_after');
  const snapshotAfter = await readTargetScopeSnapshot(storageKey, scopeKey);

  /**
   * Alle drei müssen exakt übereinstimmen. Sonst wäre ein ZIP mit dem Zustand
   * eines anderen Zeitpunkts verbunden — genau das darf nie entstehen.
   */
  if (!sameSnapshot(snapshotBefore, snapshotFromZip) || !sameSnapshot(snapshotFromZip, snapshotAfter)) {
    return { ok: false, reason: 'target_changed', detail: 'Zielbereich während der Vorbereitung verändert' };
  }

  const files = filesFromBundle(validated.bundle);

  const record: PreparedRecord = {
    sourceStorageKey: storageKey,
    sourceScopeKey: scopeKey,
    workspaceId,
    archiveSha256,
    sourceRawTextSha256: validated.bundle.sourceRawTextSha256,
    exportedAt: validated.bundle.manifest.exportedAt,
    files: cloneJson(files),
    // Die Vergleichsgrundlage stammt aus dem BÜNDEL, nicht aus einem später
    // gelesenen Zielzustand.
    targetSnapshot: cloneJson(snapshotFromZip),
    savedAt: validated.bundle.savedAt,
  };
  deepFreeze(record);

  const session: PreparedTargetBackupSession = deepFreeze({
    sourceStorageKey: storageKey,
    sourceScopeKey: scopeKey,
    workspaceId,
    zipBlob: built.blob,
    archiveSha256,
    sourceRawTextSha256: validated.bundle.sourceRawTextSha256,
    files: cloneJson(files),
    bundle: validated.bundle,
    targetSnapshot: cloneJson(snapshotFromZip),
    suggestedFilename: built.filename,
  });

  preparedRecords.set(session, record);
  return { ok: true, session };
}

/* -------------------------------------------------------------------------- */
/* 2. Erneut ausgewählte Datei binden                                         */
/* -------------------------------------------------------------------------- */

export async function verifyReselectedTargetBackup(
  session: PreparedTargetBackupSession,
  reselected: Blob | ArrayBuffer | Uint8Array,
): Promise<VerifyReselectedResult> {
  // Ausschließlich die private Bindung entscheidet — nie die öffentlichen Felder.
  const record = preparedRecords.get(session);
  if (!record) return { ok: false, reason: 'unknown_session' };

  const bytes = await toBytes(reselected);
  const validated = await validateEmergencyBackupZip(bytes);
  if (!validated.ok) {
    return {
      ok: false,
      reason: 'invalid_backup',
      detail: validated.errors.map((error) => error.code).join(','),
    };
  }

  // Der Dateiname spielt keine Rolle — ausschließlich der Inhalt zählt.
  const archiveSha256 = await computeBufferContentHash(bytes);
  if (archiveSha256 !== record.archiveSha256) {
    return { ok: false, reason: 'archive_hash_mismatch' };
  }
  if (validated.bundle.sourceRawTextSha256 !== record.sourceRawTextSha256) {
    return { ok: false, reason: 'raw_state_hash_mismatch' };
  }
  if (
    validated.bundle.storageKey !== record.sourceStorageKey ||
    validated.bundle.scopeKey !== record.sourceScopeKey ||
    validated.bundle.workspaceId !== record.workspaceId ||
    validated.bundle.manifest.exportedAt !== record.exportedAt
  ) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  if (!sameFileList(filesFromBundle(validated.bundle), record.files)) {
    return { ok: false, reason: 'file_set_mismatch' };
  }

  const verifiedRecord: VerifiedRecord = {
    ...cloneJson(record),
    reselectedRawText: validated.bundle.sourceRawText,
    reselectedBundle: validated.bundle,
  };
  deepFreeze(verifiedRecord);

  const verified: VerifiedTargetBackupSession = deepFreeze({
    ...session,
    files: cloneJson(record.files),
    targetSnapshot: cloneJson(record.targetSnapshot),
    reselectedBundle: validated.bundle,
  });
  verifiedRecords.set(verified, verifiedRecord);
  return { ok: true, session: verified };
}

/* -------------------------------------------------------------------------- */
/* 3. Marker und Hülle                                                        */
/* -------------------------------------------------------------------------- */

function parseMarker(raw: string | null, expectedToken: string): QuarantineMarker | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as QuarantineMarker;
    if (parsed?.kind !== QUARANTINE_KIND) return null;
    if (parsed.formatVersion !== QUARANTINE_FORMAT_VERSION) return null;
    if (parsed.status !== 'staging' && parsed.status !== 'complete') return null;
    // Schlüssel und internes Token müssen zusammengehören.
    if (typeof parsed.token !== 'string' || parsed.token !== expectedToken) return null;
    if (!Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readQuarantineMarker(token: string): QuarantineMarker | null {
  try {
    return parseMarker(localStorage.getItem(buildQuarantineMarkerKey(token)), token);
  } catch {
    return null;
  }
}

/** Reine Inventur — es wird nichts gelöscht und nichts fortgesetzt. */
export function listQuarantineMarkers(): QuarantineMarker[] {
  const markers: QuarantineMarker[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(QUARANTINE_MARKER_PREFIX)) continue;
      const token = key.slice(QUARANTINE_MARKER_PREFIX.length);
      const marker = parseMarker(localStorage.getItem(key), token);
      if (marker) markers.push(marker);
    }
  } catch {
    return markers;
  }
  return markers.sort((a, b) => a.token.localeCompare(b.token));
}

function randomHex(byteLength: number): string {
  const random = new Uint8Array(byteLength);
  // Kein Math.random, keine reine Zeitkennung, kein randomUUID (nur in sicheren
  // Kontexten verfügbar — die App läuft über HTTP).
  crypto.getRandomValues(random);
  return Array.from(random)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hasSecureRandom(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function';
}

/** True, sobald Marker, Hülle oder ein Blob dieses Tokens bereits existieren. */
async function tokenIsTaken(token: string): Promise<boolean> {
  if (localStorage.getItem(buildQuarantineMarkerKey(token)) !== null) return true;
  if (localStorage.getItem(buildQuarantineStateKey(token)) !== null) return true;
  const blobs = await listQuarantineBlobRecords(buildQuarantineBlobScopeKey(token));
  return blobs.length > 0;
}

/* -------------------------------------------------------------------------- */
/* 4. Quarantäne erzeugen                                                     */
/* -------------------------------------------------------------------------- */

class QuarantineStepError extends Error {
  constructor(
    readonly reason: QuarantineFailure,
    detail?: string,
  ) {
    super(detail ?? String(reason));
  }
}

function sameEnvelope(actual: unknown, expected: QuarantineStateEnvelope): boolean {
  if (!actual || typeof actual !== 'object') return false;
  const value = actual as QuarantineStateEnvelope;
  return (
    value.kind === expected.kind &&
    value.formatVersion === expected.formatVersion &&
    value.token === expected.token &&
    value.sourceStorageKey === expected.sourceStorageKey &&
    value.sourceScopeKey === expected.sourceScopeKey &&
    value.workspaceId === expected.workspaceId &&
    value.savedAt === expected.savedAt &&
    value.rawText === expected.rawText &&
    value.archiveSha256 === expected.archiveSha256 &&
    value.sourceRawTextSha256 === expected.sourceRawTextSha256 &&
    value.quarantinedAt === expected.quarantinedAt &&
    Array.isArray(value.files) &&
    sameFileList(value.files, expected.files)
  );
}

function sameMarker(actual: QuarantineMarker | null, expected: QuarantineMarker): boolean {
  if (!actual) return false;
  return (
    actual.kind === expected.kind &&
    actual.formatVersion === expected.formatVersion &&
    actual.token === expected.token &&
    actual.status === expected.status &&
    actual.sourceStorageKey === expected.sourceStorageKey &&
    actual.sourceScopeKey === expected.sourceScopeKey &&
    actual.workspaceId === expected.workspaceId &&
    actual.archiveSha256 === expected.archiveSha256 &&
    actual.sourceRawTextSha256 === expected.sourceRawTextSha256 &&
    actual.createdAt === expected.createdAt &&
    actual.completedAt === expected.completedAt &&
    sameFileList(actual.files, expected.files) &&
    sameSnapshot(actual.targetSnapshot ?? null, expected.targetSnapshot ?? null)
  );
}

export async function createTargetQuarantine(
  session: VerifiedTargetBackupSession,
  deps: QuarantineDeps = {},
): Promise<QuarantineResult> {
  // Sicherheitsquelle ist ausschließlich die private Bindung.
  const record = verifiedRecords.get(session);
  if (!record) return { ok: false, reason: 'unknown_session' };

  if (!hasSecureRandom()) return { ok: false, reason: 'insecure_random' };

  const existing = listQuarantineMarkers().find(
    (marker) => marker.status === 'staging' && marker.sourceStorageKey === record.sourceStorageKey,
  );
  if (existing) {
    return { ok: false, reason: 'staging_exists', existingToken: existing.token };
  }

  const reasonForPhase = (phase: QuarantinePhase): QuarantineFailure => {
    switch (phase) {
      case 'staging_marker':
      case 'complete_marker':
      case 'verify_complete_marker':
        return 'marker_failed';
      case 'write_envelope':
      case 'read_back_envelope':
        return 'envelope_failed';
      case 'read_back_blob':
      case 'final_verify':
        return 'blob_verify_failed';
      default:
        return 'blob_write_failed';
    }
  };

  const step = (phase: QuarantinePhase, index?: number): void => {
    deps.onPhase?.(phase, index);
    if (deps.failAtPhase === phase && (deps.failAtIndex === undefined || deps.failAtIndex === index)) {
      throw new QuarantineStepError(reasonForPhase(phase), `injected_${phase}`);
    }
  };

  // Zielbereich vollständig erneut prüfen — vor dem ersten Schreibzugriff.
  deps.onPhase?.('recheck_target');
  const beforeSnapshot = await readTargetScopeSnapshot(
    record.sourceStorageKey,
    record.sourceScopeKey,
  );
  if (!sameSnapshot(beforeSnapshot, record.targetSnapshot)) {
    return { ok: false, reason: 'target_changed', detail: 'vor Beginn' };
  }

  // --- Freies Token suchen, ohne je etwas zu überschreiben -----------------
  let token = '';
  try {
    for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
      const candidate = `q-${record.archiveSha256.slice(0, 16)}-${randomHex(8)}`;
      if (!(await tokenIsTaken(candidate))) {
        token = candidate;
        break;
      }
    }
  } catch {
    return { ok: false, reason: 'insecure_random' };
  }
  if (!token) return { ok: false, reason: 'token_collision' };

  const createdAt = deps.now ?? new Date().toISOString();
  const markerKey = buildQuarantineMarkerKey(token);
  const stateKey = buildQuarantineStateKey(token);
  const quarantineScopeKey = buildQuarantineBlobScopeKey(token);

  const marker: QuarantineMarker = {
    kind: QUARANTINE_KIND,
    formatVersion: QUARANTINE_FORMAT_VERSION,
    token,
    status: 'staging',
    sourceStorageKey: record.sourceStorageKey,
    sourceScopeKey: record.sourceScopeKey,
    workspaceId: record.workspaceId,
    archiveSha256: record.archiveSha256,
    sourceRawTextSha256: record.sourceRawTextSha256,
    files: cloneJson(record.files),
    createdAt,
  };

  const expectedEnvelope: QuarantineStateEnvelope = {
    kind: QUARANTINE_KIND,
    formatVersion: QUARANTINE_FORMAT_VERSION,
    token,
    sourceStorageKey: record.sourceStorageKey,
    sourceScopeKey: record.sourceScopeKey,
    workspaceId: record.workspaceId,
    savedAt: record.savedAt,
    // Ausschließlich der Rohtext der ERNEUT ausgewählten Sicherung — niemals
    // ein später erneut gelesener Zielzustand.
    rawText: record.reselectedRawText,
    archiveSha256: record.archiveSha256,
    sourceRawTextSha256: record.sourceRawTextSha256,
    files: cloneJson(record.files),
    quarantinedAt: createdAt,
  };

  let markerWritten = false;

  try {
    step('staging_marker');
    localStorage.setItem(markerKey, JSON.stringify(marker));
    markerWritten = true;

    // --- Blobs schreiben und einzeln zurücklesen --------------------------
    for (let index = 0; index < record.files.length; index += 1) {
      const file = record.files[index]!;
      step('write_blob', index);

      const bytes = readValidatedEmergencyBackupFileBytes(record.reselectedBundle, file.fileRefId);
      if (!bytes) throw new QuarantineStepError('blob_write_failed', file.fileRefId);

      await writeQuarantineBlob({
        scopeKey: quarantineScopeKey,
        fileRefId: file.fileRefId,
        bytes,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        contentHash: file.sha256,
        createdAt,
      });

      step('read_back_blob', index);
      const readBack = await readQuarantineBlob(quarantineScopeKey, file.fileRefId);
      if (
        !readBack ||
        readBack.bytes.byteLength !== file.fileSize ||
        (await computeBufferContentHash(readBack.bytes)) !== file.sha256
      ) {
        throw new QuarantineStepError('blob_verify_failed', file.fileRefId);
      }
    }

    // --- Hülle ------------------------------------------------------------
    step('write_envelope');
    localStorage.setItem(stateKey, JSON.stringify(expectedEnvelope));

    step('read_back_envelope');
    const storedEnvelope = localStorage.getItem(stateKey);
    if (!storedEnvelope) throw new QuarantineStepError('envelope_failed', 'not_readable');
    if (!sameEnvelope(JSON.parse(storedEnvelope) as unknown, expectedEnvelope)) {
      throw new QuarantineStepError('envelope_failed', 'mismatch');
    }

    // --- Abschlussprüfung vor complete ------------------------------------
    step('final_verify');
    for (const file of record.files) {
      const again = await readQuarantineBlob(quarantineScopeKey, file.fileRefId);
      if (
        !again ||
        again.bytes.byteLength !== file.fileSize ||
        (await computeBufferContentHash(again.bytes)) !== file.sha256
      ) {
        throw new QuarantineStepError('blob_verify_failed', `final:${file.fileRefId}`);
      }
    }

    // Die Hülle wird unmittelbar vor complete vollständig erneut geprüft.
    const envelopeAgain = localStorage.getItem(stateKey);
    if (!envelopeAgain || !sameEnvelope(JSON.parse(envelopeAgain) as unknown, expectedEnvelope)) {
      throw new QuarantineStepError('envelope_failed', 'final_mismatch');
    }

    // Der Zielbereich wird unmittelbar vor dem Umschalten nochmals vollständig
    // geprüft — eine parallele Änderung darf niemals unbemerkt complete werden.
    const afterSnapshot = await readTargetScopeSnapshot(
      record.sourceStorageKey,
      record.sourceScopeKey,
    );
    if (!sameSnapshot(afterSnapshot, record.targetSnapshot)) {
      throw new QuarantineStepError('target_changed', 'während der Kopie');
    }

    // --- complete in einem einzelnen Schreibvorgang ------------------------
    step('complete_marker');
    const completeMarker: QuarantineMarker = {
      ...marker,
      files: cloneJson(record.files),
      status: 'complete',
      completedAt: createdAt,
      targetSnapshot: cloneJson(record.targetSnapshot),
    };
    localStorage.setItem(markerKey, JSON.stringify(completeMarker));

    step('verify_complete_marker');
    const storedMarker = readQuarantineMarker(token);
    if (!sameMarker(storedMarker, completeMarker)) {
      throw new QuarantineStepError('marker_failed', 'complete_mismatch');
    }

    return {
      ok: true,
      token,
      markerKey,
      stateKey,
      quarantineScopeKey,
      marker: storedMarker!,
    };
  } catch (error) {
    const reason =
      error instanceof QuarantineStepError ? error.reason : ('blob_write_failed' as const);
    const detail = error instanceof Error ? error.message : undefined;

    if (deps.simulateHardAbort) {
      // Harter Abbruch: nichts bereinigen, damit staging-Marker und bereits
      // geschriebene Daten erkennbar bleiben.
      return { ok: false, reason, detail, token: markerWritten ? token : undefined };
    }

    const cleanedUp = await cleanupOwnQuarantine(quarantineScopeKey, stateKey, markerKey);
    return { ok: false, reason, detail, token: markerWritten ? token : undefined, cleanedUp };
  }
}

/**
 * Bereinigt ausschließlich Daten des eigenen Tokens: zuerst die Hülle, dann
 * die eigenen Quarantäneblobs mit Rückprüfung auf null, zuletzt den Marker.
 * Zielbereich, Guest-, User- und Workspace-Daten werden nie berührt.
 */
async function cleanupOwnQuarantine(
  quarantineScopeKey: QuarantineBlobScopeKey,
  stateKey: string,
  markerKey: string,
): Promise<boolean> {
  try {
    localStorage.removeItem(stateKey);
    const records = await listQuarantineBlobRecords(quarantineScopeKey);
    for (const entry of records) {
      await deleteQuarantineBlob(quarantineScopeKey, entry.fileRefId);
    }
    if ((await listQuarantineBlobRecords(quarantineScopeKey)).length > 0) return false;
    localStorage.removeItem(markerKey);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* 5. Ausdrückliche Bereinigung                                               */
/* -------------------------------------------------------------------------- */

export async function cleanupStagingQuarantine(token: string): Promise<CleanupQuarantineResult> {
  const marker = readQuarantineMarker(token);
  if (!marker) return { ok: false, reason: 'not_found', detail: token };
  if (marker.status !== 'staging') return { ok: false, reason: 'not_staging', detail: marker.status };

  const quarantineScopeKey = buildQuarantineBlobScopeKey(token);
  const markerKey = buildQuarantineMarkerKey(token);
  const stateKey = buildQuarantineStateKey(token);

  let deletedBlobs = 0;
  try {
    localStorage.removeItem(stateKey);
    const records = await listQuarantineBlobRecords(quarantineScopeKey);
    for (const entry of records) {
      await deleteQuarantineBlob(quarantineScopeKey, entry.fileRefId);
      deletedBlobs += 1;
    }
    if ((await listQuarantineBlobRecords(quarantineScopeKey)).length > 0) {
      return { ok: false, reason: 'blob_delete_failed', detail: token };
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'blob_delete_failed',
      detail: error instanceof Error ? error.message : token,
    };
  }

  localStorage.removeItem(markerKey);
  if (readQuarantineMarker(token)) {
    return { ok: false, reason: 'marker_delete_failed', detail: token };
  }
  return { ok: true, token, deletedBlobs };
}
