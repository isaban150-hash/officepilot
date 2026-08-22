/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02O — rein lesende Validierung einer
 * Notfall-ZIP aus `buildLocalScopeEmergencyBackup`.
 *
 * Diese Datei schreibt nichts: kein localStorage, kein IndexedDB, kein Store,
 * keine Navigation, kein Netzwerk. Sie beantwortet ausschließlich die Frage,
 * ob eine Sicherung unverfälscht und in sich widerspruchsfrei ist.
 *
 * Wiederverwendet bewusst die vorhandenen Bausteine — es gibt weder eine
 * zweite ZIP-Bibliothek noch eine zweite Hash-Implementierung:
 *   - JSZip
 *   - isSafeBackupZipPath und BACKUP_VALIDATE_LIMITS aus der Backup-Prüfung
 *   - normalizeBackupAppStateVersionReadOnly (Versionstor ohne Seiteneffekt)
 *   - computeBufferContentHash (SHA-256 mit reiner JS-Rückfallebene)
 *   - buildScopeKeyFromStorageKey aus der Notfall-Inventur
 *   - isValidDocumentWorkResultEntry aus dem Work-Result-Store
 */
import JSZip from 'jszip';
import {
  isSafeBackupZipPath,
  normalizeBackupAppStateVersionReadOnly,
} from '../backupValidateService';
import { BACKUP_VALIDATE_LIMITS } from '../../types/backupValidate';
import { computeBufferContentHash } from '../documentFileHashService';
import { isValidDocumentWorkResultEntry } from '../documentWorkResultStoreService';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { buildScopeKeyFromStorageKey } from './localScopeBlobInventoryService';
import { DOCUMENT_FILE_LIFECYCLE_STATUSES } from '../../types/documentFileRef';
import {
  EMERGENCY_BACKUP_KIND,
  EMERGENCY_BACKUP_SUPPORTED_FORMAT_VERSION,
  EMERGENCY_ZIP_FILES_PREFIX,
  EMERGENCY_ZIP_MANIFEST_PATH,
  EMERGENCY_ZIP_RAW_STATE_PATH,
  EMERGENCY_ZIP_README_PATH,
  type EmergencyBackupManifestEntryV1,
  type EmergencyBackupManifestV1,
  type EmergencyBackupOutboxSummary,
  type EmergencyBackupRecordCounts,
  type EmergencyBackupValidationError,
  type EmergencyBackupValidationErrorCode,
  type EmergencyBackupValidationOptions,
  type EmergencyBackupValidationResult,
  type EmergencyBackupValidationWarning,
  type ValidatedEmergencyBackupBundle,
  type ValidatedEmergencyBackupFile,
} from '../../types/emergencyBackupValidate';
import type { AppPersistedState } from '../../types/models';
import type { DocumentFileLifecycleStatus } from '../../types/documentFileRef';

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Das Notfallformat vergibt ausschließlich neutrale, laufend nummerierte Pfade. */
const EMERGENCY_BINARY_PATH = /^files\/file-[1-9][0-9]*\.bin$/;
/**
 * Unterhalb dieser Größe ist ein hohes Kompressionsverhältnis harmlos (winzige
 * JSON-Dateien komprimieren sehr gut). Darüber gilt es als ZIP-Bombe.
 */
const RATIO_GUARD_MIN_UNCOMPRESSED = 1024 * 1024;

interface RawZipEntryInfo {
  /** Name exakt so, wie er im Central Directory steht — ohne jede Normalisierung. */
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

/**
 * Liest die Einträge des Central Directory selbst.
 *
 * Notwendig, weil JSZip Pfade sowohl beim Schreiben als auch beim Laden
 * normalisiert: ein Eintrag `files/../../evil.bin` oder ein zweiter Eintrag
 * mit identischem Namen wäre über die JSZip-Ansicht nicht mehr sichtbar.
 * Zusätzlich liefert das Verzeichnis die deklarierten Größen — damit lassen
 * sich die Limits erzwingen, BEVOR irgendetwas entpackt wird.
 *
 * Gibt `null` zurück, wenn die Struktur nicht sicher gelesen werden kann
 * (auch bei ZIP64, das dieses Format nie erzeugt).
 */
export function readZipCentralDirectory(bytes: Uint8Array): RawZipEntryInfo[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = 22;
  if (bytes.byteLength < minEocd) return null;

  let eocd = -1;
  const earliest = Math.max(0, bytes.byteLength - minEocd - 0xffff);
  for (let i = bytes.byteLength - minEocd; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  // ZIP64-Marker: dieses Format erzeugt so etwas nie — nicht raten, ablehnen.
  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    return null;
  }
  if (centralOffset + centralSize > bytes.byteLength) return null;

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: RawZipEntryInfo[] = [];
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.byteLength) return null;
    if (view.getUint32(cursor, true) !== 0x02014b50) return null;
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > bytes.byteLength) return null;

    let name: string;
    try {
      name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    } catch {
      return null;
    }
    entries.push({ name, compressedSize, uncompressedSize });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Versiegelt das Ergebnis, damit spätere Eingabeänderungen es nicht berühren. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  // Typed Arrays lassen sich nicht einfrieren — sie liegen ohnehin nicht im Bündel.
  if (ArrayBuffer.isView(value)) return value;
  for (const inner of Object.values(value as Record<string, unknown>)) {
    deepFreeze(inner);
  }
  return Object.freeze(value);
}

/**
 * Die geprüften Bytes liegen bewusst NICHT im Bündel, sondern hier daneben.
 *
 * Damit gilt für jeden späteren Restore-Sprint eine harte Regel: er liest die
 * ZIP nie erneut, sondern holt die Bytes ausschließlich über
 * `readValidatedEmergencyBackupFileBytes`. Nur diese Bytes wurden gegen Größe
 * und SHA-256 geprüft; alles andere wäre ungeprüftes Material.
 */
const validatedBytesByBundle = new WeakMap<
  ValidatedEmergencyBackupBundle,
  Map<string, Uint8Array>
>();

/**
 * Liefert eine frische Kopie der geprüften Bytes einer Datei — oder `null`,
 * wenn die Datei nicht Teil dieses validierten Bündels ist. Jede Kopie ist
 * eigenständig: ein veränderter Rückgabewert wirkt nie zurück.
 */
export function readValidatedEmergencyBackupFileBytes(
  bundle: ValidatedEmergencyBackupBundle,
  fileRefId: string,
): Uint8Array | null {
  const stored = validatedBytesByBundle.get(bundle)?.get(fileRefId);
  return stored ? new Uint8Array(stored) : null;
}

class ErrorBag {
  private readonly errors: EmergencyBackupValidationError[] = [];

  add(
    code: EmergencyBackupValidationErrorCode,
    extra: Omit<EmergencyBackupValidationError, 'code'> = {},
  ): void {
    this.errors.push({ code, ...extra });
  }

  get any(): boolean {
    return this.errors.length > 0;
  }

  get list(): EmergencyBackupValidationError[] {
    return this.errors;
  }
}

function toBytes(input: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> | Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return input.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

/** Nur `found`-Einträge tragen Daten; alles andere ist nicht importfähig. */
function parseManifest(
  raw: unknown,
  bag: ErrorBag,
): EmergencyBackupManifestV1 | null {
  if (!isPlainObject(raw)) {
    bag.add('invalid_manifest', { detail: 'Manifest ist kein Objekt' });
    return null;
  }
  if (raw.kind !== EMERGENCY_BACKUP_KIND) {
    bag.add('wrong_kind', { detail: String(raw.kind ?? '') });
    return null;
  }
  if (raw.formatVersion !== EMERGENCY_BACKUP_SUPPORTED_FORMAT_VERSION) {
    bag.add('unsupported_format_version', { detail: String(raw.formatVersion ?? '') });
    return null;
  }
  for (const key of ['exportedAt', 'origin', 'storageKey', 'scopeKey'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).length === 0) {
      bag.add('invalid_manifest', { detail: key });
      return null;
    }
  }
  if (!Array.isArray(raw.entries) || !isPlainObject(raw.summary)) {
    bag.add('invalid_manifest', { detail: 'entries/summary' });
    return null;
  }

  const entries: EmergencyBackupManifestEntryV1[] = [];
  for (const entry of raw.entries) {
    if (!isPlainObject(entry) || typeof entry.status !== 'string') {
      bag.add('invalid_manifest', { detail: 'Eintrag ohne Status' });
      return null;
    }
    entries.push(cloneJson(entry) as unknown as EmergencyBackupManifestEntryV1);
  }

  return cloneJson({
    formatVersion: EMERGENCY_BACKUP_SUPPORTED_FORMAT_VERSION,
    kind: EMERGENCY_BACKUP_KIND,
    exportedAt: raw.exportedAt as string,
    origin: raw.origin as string,
    storageKey: raw.storageKey as string,
    scopeKey: raw.scopeKey as string,
    entries,
    summary: raw.summary as EmergencyBackupManifestV1['summary'],
  });
}

interface RefShape {
  id: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  storageType: string;
  localDataKey: string;
  createdAt: string;
  lifecycleStatus: DocumentFileLifecycleStatus;
  committedAt?: string;
  expiresAt?: string;
}

function parseFileRef(value: unknown): RefShape | null {
  if (!isPlainObject(value)) return null;
  const stringFields = [
    'id',
    'originalFileName',
    'mimeType',
    'contentHash',
    'storageType',
    'localDataKey',
    'createdAt',
  ] as const;
  for (const field of stringFields) {
    if (typeof value[field] !== 'string' || (value[field] as string).length === 0) return null;
  }
  if (typeof value.fileSize !== 'number' || !Number.isInteger(value.fileSize) || value.fileSize < 0) {
    return null;
  }
  if (value.storageType !== 'indexeddb' && value.storageType !== 'local_data_url') return null;
  if (
    typeof value.lifecycleStatus !== 'string' ||
    !(DOCUMENT_FILE_LIFECYCLE_STATUSES as readonly string[]).includes(value.lifecycleStatus)
  ) {
    return null;
  }
  for (const optional of ['committedAt', 'expiresAt'] as const) {
    if (value[optional] !== undefined && typeof value[optional] !== 'string') return null;
  }
  return value as unknown as RefShape;
}

const TAX_STATUS = [
  'standard_19',
  'standard_7',
  'kleinunternehmer_19',
  'reverse_charge_13b',
  'tax_free',
  'unclear',
];
const MATERIAL_STANDARD = ['auftraggeber', 'betrieb', 'gemischt', 'unclear'];
const APP_LANGUAGES = ['de', 'tr', 'bg', 'ro', 'ru'];
const COMMUNICATION_CHANNELS = ['email', 'whatsapp', 'letter'];
const DOCUMENT_TYPES = [
  'eingangsrechnung',
  'kundenauftrag',
  'ausgangsrechnung',
  'behoerde',
  'brief',
  'foto',
  'sonstiges',
];
const INBOX_PRIORITIES = ['niedrig', 'mittel', 'hoch', 'kritisch'];
const INBOX_STATUSES = ['neu', 'geprueft', 'abgelegt', 'spaeter_klaeren'];
const RECOMMENDED_ACTIONS = [
  'zuordnen',
  'abheften',
  'rechnung_vorbereiten',
  'archivieren',
  'klaeren',
  'zahlung_pruefen',
  'auftrag_annehmen',
  'steuerberater_vorbereiten',
  'entsorgen',
];

function isEnum(value: unknown, allowed: string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

function hasStrings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}

/** Vollständige Feldprüfung des CompanySetup — kein bloßer Objekttest. */
function isValidCompanySetup(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.companyName !== 'string' || !value.companyName.trim()) return false;
  if (typeof value.industry !== 'string') return false;
  if (!isEnum(value.taxStatus, TAX_STATUS)) return false;
  if (!isEnum(value.materialStandard, MATERIAL_STANDARD)) return false;
  if (!isEnum(value.language, APP_LANGUAGES)) return false;
  if (typeof value.setupComplete !== 'boolean') return false;
  if (typeof value.setupVersion !== 'number' || !Number.isFinite(value.setupVersion)) return false;
  if (!isEnum(value.communicationChannel, COMMUNICATION_CHANNELS)) return false;
  return true;
}

function isValidCompanyProfile(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const required = [
    'companyName',
    'legalForm',
    'street',
    'zip',
    'city',
    'country',
    'contactPerson',
    'phone',
    'email',
    'website',
    'taxNumber',
    'vatId',
    'bankName',
    'iban',
    'bic',
    'defaultPaymentTerms',
    'defaultSkonto',
    'invoiceFooterNotes',
  ];
  if (!hasStrings(value, required)) return false;
  if (!value.companyName || typeof value.companyName !== 'string' || !value.companyName.trim()) {
    return false;
  }
  if (typeof value.defaultPaymentDays !== 'number' || !Number.isFinite(value.defaultPaymentDays)) {
    return false;
  }
  for (const [field, type] of [
    ['skontoEnabled', 'boolean'],
    ['skontoPercent', 'number'],
    ['skontoDays', 'number'],
    ['managingDirector', 'string'],
    ['taxFreeNotice', 'string'],
    ['logoDataUrl', 'string'],
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== type) return false;
  }
  return true;
}

function isValidInboxItem(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!hasStrings(value, ['id', 'title', 'sender', 'receivedAt'])) return false;
  if (!value.id) return false;
  if (!isEnum(value.documentType, DOCUMENT_TYPES)) return false;
  if (!isEnum(value.priority, INBOX_PRIORITIES)) return false;
  if (!isEnum(value.status, INBOX_STATUSES)) return false;
  if (!isEnum(value.recommendedAction, RECOMMENDED_ACTIONS)) return false;
  if (value.deadline !== null && typeof value.deadline !== 'string') return false;
  if (!isPlainObject(value.digitalFolder) || !hasStrings(value.digitalFolder, ['id', 'name', 'path'])) {
    return false;
  }
  if (
    !isPlainObject(value.paperFiling) ||
    !hasStrings(value.paperFiling, ['folderId', 'register', 'label'])
  ) {
    return false;
  }
  if (!isPlainObject(value.recognizedData)) return false;
  if (Object.values(value.recognizedData).some((entry) => typeof entry !== 'string')) return false;
  if (!hasStrings(value, ['officePilotSuggestion', 'nextTaskLabel', 'securityHint'])) return false;
  return true;
}

/**
 * Ergänzt `isValidDocumentWorkResultEntry`: jener prüft `specialistRefs` und
 * `overlay` nur auf ihren Typ, nicht auf ihren Feldbestand.
 */
function hasValidWorkResultDetails(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const refs = entry.specialistRefs;
  if (!isPlainObject(refs)) return false;
  for (const flag of [
    'hasContractIntelligence',
    'hasContractOrderProposal',
    'hasClassification',
    'hasDocumentUnderstanding',
    'companyRelevant',
  ]) {
    if (typeof refs[flag] !== 'boolean') return false;
  }
  if (!Array.isArray(entry.overlay)) return false;
  for (const overlay of entry.overlay) {
    if (!isPlainObject(overlay)) return false;
    if (typeof overlay.slotId !== 'string' || !overlay.slotId) return false;
    if (!isEnum(overlay.status, ['user_confirmed', 'user_corrected', 'discarded'])) return false;
    if (typeof overlay.updatedAt !== 'string') return false;
  }
  return true;
}

function buildOutboxSummary(state: AppPersistedState): EmergencyBackupOutboxSummary {
  const entries = Array.isArray(state.syncOutbox) ? state.syncOutbox : [];
  const byStatus: Record<string, number> = {};
  const byEntityType: Record<string, number> = {};
  for (const entry of entries as { status?: string; entityType?: string }[]) {
    const status = typeof entry?.status === 'string' ? entry.status : 'unknown';
    const entityType = typeof entry?.entityType === 'string' ? entry.entityType : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byEntityType[entityType] = (byEntityType[entityType] ?? 0) + 1;
  }
  return { total: entries.length, byStatus, byEntityType };
}

function buildRecordCounts(state: AppPersistedState): EmergencyBackupRecordCounts {
  return {
    inboxItems: state.inboxItems?.length ?? 0,
    vorgaenge: state.vorgaenge?.length ?? 0,
    tasks: state.tasks?.length ?? 0,
    documents: state.documents?.length ?? 0,
    expenses: state.expenses?.length ?? 0,
    documentFileRefs: state.documentFileRefs?.length ?? 0,
    documentWorkResults: (state as { documentWorkResults?: unknown[] }).documentWorkResults?.length ?? 0,
  };
}

/**
 * Prüft eine Notfall-ZIP vollständig im Speicher. Gibt entweder ein
 * versiegeltes Bündel oder die gesammelte Liste aller Verstöße zurück.
 */
export async function validateEmergencyBackupZip(
  zipInput: Blob | ArrayBuffer | Uint8Array,
  options: EmergencyBackupValidationOptions = {},
): Promise<EmergencyBackupValidationResult> {
  const bag = new ErrorBag();
  const checkedAt = options.now ?? new Date().toISOString();

  let zipBytes: Uint8Array;
  try {
    zipBytes = await toBytes(zipInput);
  } catch {
    return { ok: false, errors: [{ code: 'invalid_zip' }] };
  }

  if (zipBytes.byteLength <= 0) return { ok: false, errors: [{ code: 'invalid_zip' }] };
  if (zipBytes.byteLength > BACKUP_VALIDATE_LIMITS.maxZipBytes) {
    return { ok: false, errors: [{ code: 'too_large' }] };
  }

  // --- Struktur: zuerst das echte Central Directory, ohne JSZip -------------
  const rawEntries = readZipCentralDirectory(zipBytes);
  if (!rawEntries) return { ok: false, errors: [{ code: 'invalid_zip' }] };

  const seen = new Map<string, number>();
  const binaryPaths: string[] = [];
  let declaredUncompressed = 0;

  for (const raw of rawEntries) {
    const name = raw.name;
    declaredUncompressed += raw.uncompressedSize;

    // Verzeichniseinträge tragen keine Daten; nur files/ ist vorgesehen.
    if (name.endsWith('/')) {
      if (name !== EMERGENCY_ZIP_FILES_PREFIX) bag.add('unknown_top_level_file', { path: name });
      continue;
    }
    if (!isSafeBackupZipPath(name)) {
      bag.add('unsafe_path', { path: name });
      continue;
    }
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if ((seen.get(name) ?? 0) > 1) {
      bag.add('duplicate_zip_path', { path: name });
      continue;
    }
    if (
      name === EMERGENCY_ZIP_RAW_STATE_PATH ||
      name === EMERGENCY_ZIP_MANIFEST_PATH ||
      name === EMERGENCY_ZIP_README_PATH
    ) {
      continue;
    }
    // Strikt das Notfallmuster: files/file-N.bin, nichts sonst.
    if (EMERGENCY_BINARY_PATH.test(name)) {
      binaryPaths.push(name);
      continue;
    }
    if (name.startsWith(EMERGENCY_ZIP_FILES_PREFIX)) {
      bag.add('unknown_binary_file', { path: name });
      continue;
    }
    bag.add('unknown_top_level_file', { path: name });
  }

  /**
   * Limits werden aus den DEKLARIERTEN Größen erzwungen — vor dem Entpacken.
   * Ein Archiv, das 900 MB behauptet, darf nie erst ausgepackt werden.
   */
  if (declaredUncompressed > BACKUP_VALIDATE_LIMITS.maxUncompressedBytes) {
    bag.add('limit_exceeded', { detail: 'maxUncompressedBytes' });
  }
  const ratio = zipBytes.byteLength > 0 ? declaredUncompressed / zipBytes.byteLength : Infinity;
  if (
    ratio > BACKUP_VALIDATE_LIMITS.maxCompressionRatio &&
    declaredUncompressed > RATIO_GUARD_MIN_UNCOMPRESSED
  ) {
    bag.add('limit_exceeded', { detail: 'maxCompressionRatio' });
  }
  if (binaryPaths.length > BACKUP_VALIDATE_LIMITS.maxFileCount) {
    bag.add('limit_exceeded', { detail: 'maxFileCount' });
  }

  if (!seen.has(EMERGENCY_ZIP_RAW_STATE_PATH)) bag.add('missing_raw_state');
  if (!seen.has(EMERGENCY_ZIP_MANIFEST_PATH)) bag.add('missing_manifest');
  /**
   * README.txt ist ausdrücklich optional: es ist reine Prosa ohne Daten. Eine
   * Sicherung, aus der es entfernt wurde, bleibt vollständig — sie deshalb
   * abzulehnen würde Daten kosten, ohne irgendetwas zu schützen.
   */
  if (bag.any) return { ok: false, errors: bag.list };

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBytes);
  } catch {
    return { ok: false, errors: [{ code: 'invalid_zip' }] };
  }

  /**
   * Die JSZip-Ansicht muss exakt dem Central Directory entsprechen. Weicht sie
   * ab, hat JSZip normalisiert — dann ist das Archiv nicht eindeutig lesbar.
   */
  const jsZipNames = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
  if (jsZipNames.length !== seen.size || jsZipNames.some((name) => !seen.has(name))) {
    return { ok: false, errors: [{ code: 'unsafe_path', detail: 'Pfadabweichung zum Verzeichnis' }] };
  }

  // --- Manifest und Rohtext ------------------------------------------------
  const rawStateBytes = await zip.file(EMERGENCY_ZIP_RAW_STATE_PATH)!.async('uint8array');
  const manifestText = await zip.file(EMERGENCY_ZIP_MANIFEST_PATH)!.async('string');
  /**
   * Fatal decodieren: ein stillschweigend eingesetztes Ersatzzeichen würde den
   * Rohtext verändern und den späteren Hashvergleich wertlos machen.
   */
  let sourceRawText: string;
  try {
    sourceRawText = new TextDecoder('utf-8', { fatal: true }).decode(rawStateBytes);
  } catch {
    return { ok: false, errors: [{ code: 'invalid_raw_state_encoding' }] };
  }
  const sourceRawTextSha256 = await computeBufferContentHash(rawStateBytes);

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestText) as unknown;
  } catch {
    return { ok: false, errors: [{ code: 'invalid_manifest', detail: 'kein gültiges JSON' }] };
  }
  const manifest = parseManifest(manifestRaw, bag);
  if (!manifest) return { ok: false, errors: bag.list };

  let parsedState: unknown;
  try {
    parsedState = JSON.parse(sourceRawText) as unknown;
  } catch {
    return { ok: false, errors: [{ code: 'invalid_raw_state', detail: 'kein gültiges JSON' }] };
  }
  if (
    isPlainObject(parsedState) &&
    typeof parsedState.version === 'number' &&
    (parsedState.version < 1 || parsedState.version > STORAGE_VERSION)
  ) {
    return { ok: false, errors: [{ code: 'unsupported_state_version', detail: String(parsedState.version) }] };
  }
  const appState = normalizeBackupAppStateVersionReadOnly(parsedState);
  if (!appState) {
    return { ok: false, errors: [{ code: 'invalid_raw_state' }] };
  }

  // --- Workspace-Identität durchgängig -------------------------------------
  const derivedScopeKey = buildScopeKeyFromStorageKey(manifest.storageKey);
  if (!derivedScopeKey || !derivedScopeKey.startsWith('workspace:')) {
    return { ok: false, errors: [{ code: 'unsupported_scope', detail: manifest.scopeKey }] };
  }
  const workspaceId = derivedScopeKey.slice('workspace:'.length);
  if (manifest.scopeKey !== derivedScopeKey) {
    bag.add('workspace_id_mismatch', { detail: `scopeKey ${manifest.scopeKey}` });
  }

  /**
   * Pflichtfelder: fehlen sie, ist die Zugehörigkeit des Bestands nicht belegt.
   * Genau dieser Fall darf nie in einen Restore laufen.
   */
  const requiredIdentity: [string, unknown][] = [
    ['workspace.id', appState.workspace?.id],
    ['syncClient.workspaceId', appState.syncClient?.workspaceId],
    ['syncClient.serverWorkspaceId', appState.syncClient?.serverWorkspaceId],
  ];
  for (const [label, value] of requiredIdentity) {
    if (typeof value !== 'string' || !value) {
      bag.add('missing_workspace_identity', { detail: label });
    } else if (value !== workspaceId) {
      bag.add('workspace_id_mismatch', { detail: `${label}: ${value}` });
    }
  }

  // Vorhandene Sync-Meta muss ihren Workspace ebenfalls benennen.
  for (const [label, meta] of [
    ['setupSync', appState.setupSync],
    ['companyProfileSync', appState.companyProfileSync],
    ['workspaceSettings', appState.workspaceSettings],
  ] as const) {
    if (!meta) continue;
    const value = (meta as { workspaceId?: unknown }).workspaceId;
    if (typeof value !== 'string' || !value) {
      bag.add('missing_workspace_identity', { detail: `${label}.workspaceId` });
    } else if (value !== workspaceId) {
      bag.add('workspace_id_mismatch', { detail: `${label}.workspaceId: ${value}` });
    }
  }
  for (const member of appState.workspaceMembers ?? []) {
    if (member.workspaceId && member.workspaceId !== workspaceId) {
      bag.add('workspace_id_mismatch', { detail: `workspaceMember: ${member.workspaceId}` });
    }
  }

  // --- Fachliche Gültigkeit des Rohzustands --------------------------------
  const setupCompanyName = appState.setup?.companyName?.trim() ?? '';
  if (!appState.setup) {
    bag.add('missing_setup');
  } else if (!isValidCompanySetup(appState.setup)) {
    bag.add('invalid_setup');
  }

  const profileCompanyName = appState.companyProfile?.companyName?.trim() ?? '';
  if (!appState.companyProfile) {
    bag.add('missing_company_profile');
  } else if (!isValidCompanyProfile(appState.companyProfile)) {
    bag.add('invalid_company_profile');
  }

  (appState.inboxItems ?? []).forEach((item, index) => {
    if (!isValidInboxItem(item)) bag.add('invalid_inbox_item', { detail: `Index ${index}` });
  });

  const workResults = (appState as { documentWorkResults?: unknown[] }).documentWorkResults ?? [];
  workResults.forEach((entry, index) => {
    if (!isValidDocumentWorkResultEntry(entry) || !hasValidWorkResultDetails(entry)) {
      bag.add('invalid_document_work_result', { detail: `Index ${index}` });
      return;
    }
    // Ein Analyseergebnis aus einem fremden Workspace darf nie mitwandern.
    const resultWorkspaceId = (entry as { workspaceId?: unknown }).workspaceId;
    if (
      resultWorkspaceId !== undefined &&
      resultWorkspaceId !== null &&
      resultWorkspaceId !== workspaceId
    ) {
      bag.add('workspace_id_mismatch', {
        detail: `documentWorkResults[${index}].workspaceId: ${String(resultWorkspaceId)}`,
      });
    }
  });

  const refs: RefShape[] = [];
  const refIds = new Set<string>();
  const localDataKeys = new Set<string>();
  (appState.documentFileRefs ?? []).forEach((value, index) => {
    const ref = parseFileRef(value);
    if (!ref) {
      bag.add('invalid_document_file_ref', { detail: `Index ${index}` });
      return;
    }
    if (refIds.has(ref.id)) {
      bag.add('duplicate_file_ref_id', { fileRefId: ref.id });
      return;
    }
    refIds.add(ref.id);
    // FileRef-ID und localDataKey werden getrennt geprüft.
    if (localDataKeys.has(ref.localDataKey)) {
      bag.add('duplicate_local_data_key', { fileRefId: ref.id, detail: ref.localDataKey });
      return;
    }
    localDataKeys.add(ref.localDataKey);
    refs.push(ref);
  });

  // --- Manifesteinträge gegen FileRefs --------------------------------------
  const warnings: EmergencyBackupValidationWarning[] = [];
  const entryByRefId = new Map<string, EmergencyBackupManifestEntryV1>();
  const manifestPaths = new Set<string>();

  for (const entry of manifest.entries) {
    if (typeof entry.fileRefId !== 'string' || !entry.fileRefId) {
      bag.add('invalid_manifest', { detail: 'Eintrag ohne fileRefId' });
      continue;
    }
    if (entryByRefId.has(entry.fileRefId)) {
      bag.add('duplicate_manifest_file_ref_id', { fileRefId: entry.fileRefId });
      continue;
    }
    entryByRefId.set(entry.fileRefId, entry);

    if (entry.status !== 'found') {
      bag.add('manifest_entry_not_found', { fileRefId: entry.fileRefId, detail: entry.status });
      continue;
    }
    if (typeof entry.path !== 'string' || !entry.path.startsWith(EMERGENCY_ZIP_FILES_PREFIX)) {
      bag.add('invalid_manifest', { fileRefId: entry.fileRefId, detail: 'Pfad fehlt' });
      continue;
    }
    if (!isSafeBackupZipPath(entry.path)) {
      bag.add('unsafe_path', { fileRefId: entry.fileRefId, path: entry.path });
      continue;
    }
    if (manifestPaths.has(entry.path)) {
      bag.add('duplicate_manifest_path', { fileRefId: entry.fileRefId, path: entry.path });
      continue;
    }
    manifestPaths.add(entry.path);
    if (Array.isArray(entry.mismatches) && entry.mismatches.length > 0) {
      warnings.push({
        code: 'manifest_reported_mismatch',
        fileRefId: entry.fileRefId,
        detail: entry.mismatches.join(','),
      });
    }
  }

  for (const path of binaryPaths) {
    if (!manifestPaths.has(path)) bag.add('unknown_binary_file', { path });
  }
  for (const entry of entryByRefId.values()) {
    if (entry.status === 'found' && !refIds.has(entry.fileRefId!)) {
      bag.add('manifest_entry_without_file_ref', { fileRefId: entry.fileRefId });
    }
  }

  // --- Binärdaten wirklich prüfen -------------------------------------------
  const files: ValidatedEmergencyBackupFile[] = [];
  const verifiedBytes = new Map<string, Uint8Array>();

  for (const ref of refs) {
    if (ref.storageType === 'local_data_url') {
      warnings.push({ code: 'legacy_local_data_url_file', fileRefId: ref.id });
      continue;
    }
    const entry = entryByRefId.get(ref.id);
    if (!entry) {
      bag.add('file_ref_without_manifest_entry', { fileRefId: ref.id });
      continue;
    }
    if (entry.status !== 'found' || typeof entry.path !== 'string') continue;

    if (entry.storageType !== ref.storageType) {
      bag.add('storage_type_mismatch', { fileRefId: ref.id });
    }
    if (entry.mimeType !== ref.mimeType) {
      bag.add('mime_type_mismatch', { fileRefId: ref.id, detail: 'Manifest gegen FileRef' });
    }
    if (entry.expectedFileSize !== ref.fileSize || entry.recordFileSize !== ref.fileSize) {
      bag.add('file_size_mismatch', { fileRefId: ref.id, detail: 'Manifest gegen FileRef' });
    }
    for (const hash of [ref.contentHash, entry.expectedContentHash, entry.recordContentHash]) {
      if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
        bag.add('invalid_content_hash_format', { fileRefId: ref.id });
        break;
      }
    }
    if (entry.expectedContentHash !== ref.contentHash || entry.recordContentHash !== ref.contentHash) {
      bag.add('content_hash_mismatch', { fileRefId: ref.id, detail: 'Manifest gegen FileRef' });
    }

    const zipEntry = zip.file(entry.path);
    if (!zipEntry) {
      bag.add('missing_binary_file', { fileRefId: ref.id, path: entry.path });
      continue;
    }
    const bytes = await zipEntry.async('uint8array');
    const actualSize = bytes.byteLength;
    const actualHash = await computeBufferContentHash(bytes);

    if (actualSize !== ref.fileSize) {
      bag.add('file_size_mismatch', { fileRefId: ref.id, detail: 'tatsächliche Bytes' });
    } else if (actualHash !== ref.contentHash) {
      // Größe stimmt, Inhalt nicht — genau der gefährliche Fall.
      bag.add('content_hash_mismatch', { fileRefId: ref.id, detail: 'tatsächliche Bytes' });
    } else {
      // Nur nachgerechnete Bytes stehen einem späteren Restore zur Verfügung.
      verifiedBytes.set(ref.id, new Uint8Array(bytes));
    }

    const expired =
      typeof ref.expiresAt === 'string' &&
      !Number.isNaN(Date.parse(ref.expiresAt)) &&
      Date.parse(ref.expiresAt) <= Date.parse(checkedAt);

    if (ref.lifecycleStatus !== 'committed') {
      warnings.push({ code: 'uncommitted_file', fileRefId: ref.id, detail: ref.lifecycleStatus });
    }
    if (ref.lifecycleStatus === 'trashed') {
      warnings.push({ code: 'trashed_file', fileRefId: ref.id });
    }
    if (expired) {
      warnings.push({ code: 'expired_temp_file', fileRefId: ref.id, detail: ref.expiresAt });
    }

    files.push({
      fileRefId: ref.id,
      localDataKey: ref.localDataKey,
      path: entry.path,
      mimeType: ref.mimeType,
      fileSize: actualSize,
      sha256: actualHash,
      storageType: ref.storageType,
      originalFileName: ref.originalFileName,
      createdAt: ref.createdAt,
      lifecycleStatus: ref.lifecycleStatus,
      ...(ref.committedAt ? { committedAt: ref.committedAt } : {}),
      ...(ref.expiresAt ? { expiresAt: ref.expiresAt } : {}),
      expired,
    });
  }

  if (bag.any) return { ok: false, errors: bag.list };

  const bundle: ValidatedEmergencyBackupBundle = {
    sourceRawText,
    sourceRawTextSha256,
    appState: cloneJson(appState),
    workspaceId,
    setupCompanyName,
    profileCompanyName,
    savedAt: appState.savedAt,
    origin: manifest.origin,
    storageKey: manifest.storageKey,
    scopeKey: manifest.scopeKey,
    manifest,
    files,
    recordCounts: buildRecordCounts(appState),
    outboxSummary: buildOutboxSummary(appState),
    warnings,
    requiresLifecycleDecision: warnings.some(
      (warning) =>
        warning.code === 'uncommitted_file' ||
        warning.code === 'expired_temp_file' ||
        warning.code === 'trashed_file',
    ),
    outboxMustBeDiscardedBeforeRestore: true,
  };

  const sealed = deepFreeze(bundle);
  validatedBytesByBundle.set(sealed, verifiedBytes);
  return { ok: true, bundle: sealed };
}
