/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02O — rein lesende Prüfung des
 * Notfall-ZIP-Formats.
 *
 * Ausschließlich kleine, neutrale, synthetisch erzeugte ZIPs. Keine echte
 * Sicherung und keine persönlichen Daten. Jeder Fall prüft zusätzlich, dass
 * weder localStorage noch IndexedDB angefasst werden.
 */
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readValidatedEmergencyBackupFileBytes,
  validateEmergencyBackupZip,
} from './localScopeEmergencyImportValidateService';
import { computeBufferContentHash } from '../documentFileHashService';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import {
  DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
  DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
} from '../../types/documentWorkResult';
import type { DocumentWorkResult } from '../../types/documentWorkResult';
import type { DocumentFileLifecycleStatus, DocumentFileRef } from '../../types/documentFileRef';
import type { CompanyProfile, CompanySetup, InboxItem } from '../../types/models';

const WORKSPACE_ID = 'ws-emergency-01';
const STORAGE_KEY = `officepilot-state:workspace:${WORKSPACE_ID}`;
const SCOPE_KEY = `workspace:${WORKSPACE_ID}`;
const COMPANY = 'Beispiel Notfallbetrieb GmbH';
const NOW = '2026-08-18T09:00:00.000Z';

/** Zwei winzige, neutrale Binärinhalte — kein echter Dateiinhalt. */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a, 0x41]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42, 0x43]);

interface RefInput {
  id: string;
  mimeType: string;
  bytes: Uint8Array;
  hash: string;
  localDataKey: string;
  lifecycleStatus: DocumentFileLifecycleStatus;
  committedAt?: string;
  expiresAt?: string;
}

function buildFileRef(input: RefInput): DocumentFileRef {
  return {
    id: input.id,
    originalFileName: `${input.id}.bin`,
    mimeType: input.mimeType,
    fileSize: input.bytes.byteLength,
    contentHash: input.hash,
    storageType: 'indexeddb',
    localDataKey: input.localDataKey,
    createdAt: '2026-08-15T13:11:18.000Z',
    lifecycleStatus: input.lifecycleStatus,
    ...(input.committedAt ? { committedAt: input.committedAt } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
}

/** Vollständiges, typisiertes InboxItem — kein verkürztes Platzhalterobjekt. */
function buildInboxItem(): InboxItem {
  return {
    id: 'inbox-1',
    title: 'Beispielbeleg',
    documentType: 'eingangsrechnung',
    sender: 'Beispiel Lieferant',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'abheften',
    digitalFolder: { id: 'folder-1', name: 'Eingangsrechnungen', path: '/eingang' },
    paperFiling: { folderId: 'folder-1', register: 'A', label: 'Eingang' },
    status: 'neu',
    receivedAt: '2026-08-15T12:00:00.000Z',
    recognizedData: {},
    officePilotSuggestion: '',
    nextTaskLabel: '',
    securityHint: '',
  };
}

function buildManifestEntry(input: RefInput, path: string): Record<string, unknown> {
  return {
    fileRefId: input.id,
    storageType: 'indexeddb',
    mimeType: input.mimeType,
    expectedFileSize: input.bytes.byteLength,
    expectedContentHash: input.hash,
    recordFileSize: input.bytes.byteLength,
    recordContentHash: input.hash,
    recordCreatedAt: '2026-08-15T13:11:18.000Z',
    path,
    status: 'found',
  };
}

function buildWorkResult(): DocumentWorkResult {
  return {
    schemaVersion: DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
    inboxItemId: 'inbox-1',
    workspaceId: WORKSPACE_ID,
    analyzedAt: '2026-08-15T13:00:00.000Z',
    analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    sourceFingerprint: 'fp-1',
    businessInterpretation: null,
    specialistRefs: {
      hasContractIntelligence: false,
      hasContractOrderProposal: false,
      hasClassification: false,
      hasDocumentUnderstanding: false,
      companyRelevant: false,
    },
    overlay: [],
  };
}

function buildRawState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const setup: CompanySetup = {
    ...DEFAULT_SETUP,
    companyName: COMPANY,
    setupComplete: true,
    setupVersion: 1,
  };
  const companyProfile: CompanyProfile = { ...DEFAULT_COMPANY_PROFILE, companyName: COMPANY };
  return {
    version: STORAGE_VERSION,
    setup,
    companyProfile,
    workspace: { id: WORKSPACE_ID, name: COMPANY, ownerUserId: 'user-1' },
    syncClient: {
      deviceId: 'device-1',
      workspaceId: WORKSPACE_ID,
      serverWorkspaceId: WORKSPACE_ID,
      syncPolicy: 'cloud',
    },
    setupSync: { version: 2, updatedAt: NOW, deleted: false, deviceId: 'device-1', workspaceId: WORKSPACE_ID },
    companyProfileSync: {
      version: 2,
      updatedAt: NOW,
      deleted: false,
      deviceId: 'device-1',
      workspaceId: WORKSPACE_ID,
    },
    inboxItems: [buildInboxItem()],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    documentWorkResults: [buildWorkResult()],
    syncOutbox: [
      { id: 'ob-1', entityType: 'company_setup', entityId: WORKSPACE_ID, operation: 'update', version: 2, status: 'pending', retryCount: 0, queuedAt: NOW },
      { id: 'ob-2', entityType: 'company_profile', entityId: WORKSPACE_ID, operation: 'update', version: 2, status: 'pending', retryCount: 0, queuedAt: NOW },
      { id: 'ob-3', entityType: 'inbox_item', entityId: 'inbox-1', operation: 'update', version: 1, status: 'pending', retryCount: 0, queuedAt: NOW },
    ],
    savedAt: '2026-08-15T13:11:18.373Z',
    ...overrides,
  };
}

function buildManifest(entries: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    kind: 'officepilot-local-recovery-emergency',
    exportedAt: '2026-08-16T10:52:57.360Z',
    origin: 'http://127.0.0.1:5174',
    storageKey: STORAGE_KEY,
    scopeKey: SCOPE_KEY,
    entries,
    summary: {
      refs: entries.length,
      found: entries.filter((e) => e.status === 'found').length,
      missing: entries.filter((e) => e.status === 'missing').length,
      readError: entries.filter((e) => e.status === 'read_error').length,
      invalid: 0,
    },
    ...overrides,
  };
}

interface ZipInput {
  rawStateText?: string;
  manifest?: unknown;
  binaries?: { path: string; bytes: Uint8Array }[];
  extraFiles?: { path: string; content: string }[];
  omitRawState?: boolean;
  omitManifest?: boolean;
  omitReadme?: boolean;
  duplicateRawState?: boolean;
}

async function buildZip(input: ZipInput): Promise<Uint8Array> {
  const zip = new JSZip();
  if (!input.omitRawState) {
    zip.file('raw-state.json', input.rawStateText ?? JSON.stringify(buildRawState()));
  }
  if (!input.omitManifest) {
    zip.file('files-manifest.json', JSON.stringify(input.manifest ?? {}, null, 2));
  }
  if (!input.omitReadme) {
    zip.file('README.txt', 'OfficePilot — lokale Notfallsicherung\n');
  }
  for (const bin of input.binaries ?? []) {
    zip.file(bin.path, bin.bytes, { compression: 'STORE', binary: true });
  }
  for (const extra of input.extraFiles ?? []) {
    zip.file(extra.path, extra.content);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

/** Standardfall: PDF committed, PNG temp mit abgelaufenem expiresAt. */
async function buildStandardParts() {
  const pdfHash = await computeBufferContentHash(PDF_BYTES);
  const pngHash = await computeBufferContentHash(PNG_BYTES);
  const pdf: RefInput = {
    id: 'file-ref-pdf-1',
    mimeType: 'application/pdf',
    bytes: PDF_BYTES,
    hash: pdfHash,
    localDataKey: 'local-key-pdf',
    lifecycleStatus: 'committed',
    committedAt: '2026-08-15T13:05:00.000Z',
  };
  const png: RefInput = {
    id: 'file-ref-png-2',
    mimeType: 'image/png',
    bytes: PNG_BYTES,
    hash: pngHash,
    localDataKey: 'local-key-png',
    lifecycleStatus: 'temp',
    expiresAt: '2026-08-16T13:11:18.369Z',
  };
  return { pdf, png };
}

async function buildValidZip(
  mutate: (parts: {
    state: Record<string, unknown>;
    entries: Record<string, unknown>[];
    binaries: { path: string; bytes: Uint8Array }[];
    manifestOverrides: Record<string, unknown>;
  }) => void = () => {},
): Promise<Uint8Array> {
  const { pdf, png } = await buildStandardParts();
  const state = buildRawState({
    documentFileRefs: [buildFileRef(pdf), buildFileRef(png)],
  });
  const entries = [
    buildManifestEntry(pdf, 'files/file-1.bin'),
    buildManifestEntry(png, 'files/file-2.bin'),
  ];
  const binaries = [
    { path: 'files/file-1.bin', bytes: PDF_BYTES },
    { path: 'files/file-2.bin', bytes: PNG_BYTES },
  ];
  const manifestOverrides: Record<string, unknown> = {};
  mutate({ state, entries, binaries, manifestOverrides });
  return buildZip({
    rawStateText: JSON.stringify(state),
    manifest: buildManifest(entries, manifestOverrides),
    binaries,
  });
}

const errorCodes = (result: Awaited<ReturnType<typeof validateEmergencyBackupZip>>): string[] =>
  result.ok ? [] : result.errors.map((error) => error.code);

let setItem: ReturnType<typeof vi.spyOn>;
let removeItem: ReturnType<typeof vi.spyOn>;
let clear: ReturnType<typeof vi.spyOn>;
let openSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  setItem = vi.spyOn(Storage.prototype, 'setItem');
  removeItem = vi.spyOn(Storage.prototype, 'removeItem');
  clear = vi.spyOn(Storage.prototype, 'clear');
  openSpy =
    typeof indexedDB !== 'undefined' ? vi.spyOn(indexedDB, 'open') : null;
});

afterEach(() => {
  // Kein einziger Schreibzugriff — in jedem Fall dieser Datei.
  expect(setItem, 'localStorage.setItem').not.toHaveBeenCalled();
  expect(removeItem, 'localStorage.removeItem').not.toHaveBeenCalled();
  expect(clear, 'localStorage.clear').not.toHaveBeenCalled();
  if (openSpy) expect(openSpy, 'indexedDB.open').not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02O — Notfall-ZIP validieren', () => {
  it('V1: gültiges Notfall-ZIP wird angenommen', async () => {
    const zip = await buildValidZip();
    const result = await validateEmergencyBackupZip(zip, { now: NOW });

    expect(errorCodes(result)).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.bundle.workspaceId).toBe(WORKSPACE_ID);
    expect(result.bundle.storageKey).toBe(STORAGE_KEY);
    expect(result.bundle.scopeKey).toBe(SCOPE_KEY);
    expect(result.bundle.setupCompanyName).toBe(COMPANY);
    expect(result.bundle.profileCompanyName).toBe(COMPANY);
    expect(result.bundle.savedAt).toBe('2026-08-15T13:11:18.373Z');
    expect(result.bundle.origin).toBe('http://127.0.0.1:5174');
    expect(result.bundle.files.length).toBe(2);
    expect(result.bundle.recordCounts.documentFileRefs).toBe(2);
    expect(result.bundle.recordCounts.documentWorkResults).toBe(1);
  });

  it('V2: beide Dateien werden mit Pfad, Ref-ID, localDataKey und Hash ausgewiesen', async () => {
    const { pdf, png } = await buildStandardParts();
    const result = await validateEmergencyBackupZip(await buildValidZip(), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.bundle.files.map((file) => [file.fileRefId, file]));
    expect(byId.get(pdf.id)?.path).toBe('files/file-1.bin');
    expect(byId.get(pdf.id)?.localDataKey).toBe('local-key-pdf');
    expect(byId.get(pdf.id)?.sha256).toBe(pdf.hash);
    expect(byId.get(pdf.id)?.fileSize).toBe(PDF_BYTES.byteLength);
    expect(byId.get(png.id)?.path).toBe('files/file-2.bin');
    expect(byId.get(png.id)?.localDataKey).toBe('local-key-png');
    expect(byId.get(png.id)?.sha256).toBe(png.hash);
    expect(byId.get(png.id)?.mimeType).toBe('image/png');
  });

  it('V3: falsches kind wird abgelehnt', async () => {
    const zip = await buildValidZip(({ manifestOverrides }) => {
      manifestOverrides.kind = 'officepilot-backup';
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain('wrong_kind');
  });

  it('V4: unbekannte formatVersion wird abgelehnt', async () => {
    const zip = await buildValidZip(({ manifestOverrides }) => {
      manifestOverrides.formatVersion = 2;
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'unsupported_format_version',
    );
  });

  it('V5: fehlende raw-state.json wird abgelehnt', async () => {
    const zip = await buildZip({ omitRawState: true, manifest: buildManifest([]) });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'missing_raw_state',
    );
  });

  it('V6: fehlendes files-manifest.json wird abgelehnt', async () => {
    const zip = await buildZip({ omitManifest: true });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'missing_manifest',
    );
  });

  it('V7: fehlendes README.txt ist zulässig', async () => {
    const { pdf, png } = await buildStandardParts();
    const zip = await buildZip({
      omitReadme: true,
      rawStateText: JSON.stringify(
        buildRawState({ documentFileRefs: [buildFileRef(pdf), buildFileRef(png)] }),
      ),
      manifest: buildManifest([
        buildManifestEntry(pdf, 'files/file-1.bin'),
        buildManifestEntry(png, 'files/file-2.bin'),
      ]),
      binaries: [
        { path: 'files/file-1.bin', bytes: PDF_BYTES },
        { path: 'files/file-2.bin', bytes: PNG_BYTES },
      ],
    });
    const result = await validateEmergencyBackupZip(zip, { now: NOW });
    expect(errorCodes(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('V8: unbekannte Top-Level-Datei wird abgelehnt', async () => {
    const { pdf, png } = await buildStandardParts();
    const zip = await buildZip({
      rawStateText: JSON.stringify(
        buildRawState({ documentFileRefs: [buildFileRef(pdf), buildFileRef(png)] }),
      ),
      manifest: buildManifest([
        buildManifestEntry(pdf, 'files/file-1.bin'),
        buildManifestEntry(png, 'files/file-2.bin'),
      ]),
      binaries: [
        { path: 'files/file-1.bin', bytes: PDF_BYTES },
        { path: 'files/file-2.bin', bytes: PNG_BYTES },
      ],
      extraFiles: [{ path: 'notes.txt', content: 'x' }],
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'unknown_top_level_file',
    );
  });

  it('V9: unbekannte zusätzliche Binärdatei wird abgelehnt', async () => {
    const zip = await buildValidZip(({ binaries }) => {
      binaries.push({ path: 'files/file-3.bin', bytes: new Uint8Array([1, 2, 3]) });
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'unknown_binary_file',
    );
  });

  /**
   * JSZip normalisiert einen Traversal-Pfad bereits beim Schreiben, ein solcher
   * Eintrag kann im Archiv also gar nicht entstehen (er landet dann als
   * unbekannte Top-Level-Datei, siehe V8). Gefährlich bleibt der Fall, dass das
   * MANIFEST einen Traversal-Pfad behauptet — genau der wird hier geprüft.
   */
  it('V10: Pfad-Traversal im Manifest wird abgelehnt', async () => {
    const zip = await buildValidZip(({ entries }) => {
      entries[1]!.path = 'files/../../evil.bin';
    });
    const codes = errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }));
    expect(codes).toContain('unsafe_path');
  });

  it('V11: doppelter ZIP-Pfad im Manifest wird abgelehnt', async () => {
    const zip = await buildValidZip(({ entries }) => {
      entries[1]!.path = 'files/file-1.bin';
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'duplicate_manifest_path',
    );
  });

  it('V12: doppelte fileRefId wird abgelehnt', async () => {
    const { pdf } = await buildStandardParts();
    const zip = await buildValidZip(({ state, entries }) => {
      const refs = state.documentFileRefs as Record<string, unknown>[];
      refs[1]!.id = pdf.id;
      entries[1]!.fileRefId = pdf.id;
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'duplicate_file_ref_id',
    );
  });

  it('V13: doppelter localDataKey wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      const refs = state.documentFileRefs as Record<string, unknown>[];
      refs[1]!.localDataKey = refs[0]!.localDataKey;
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'duplicate_local_data_key',
    );
  });

  it('V14: Workspace-ID-Widerspruch wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      (state.syncClient as Record<string, unknown>).serverWorkspaceId = 'anderer-workspace';
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'workspace_id_mismatch',
    );
  });

  it('V15: Widerspruch zwischen storageKey und scopeKey wird abgelehnt', async () => {
    const zip = await buildValidZip(({ manifestOverrides }) => {
      manifestOverrides.scopeKey = 'workspace:fremder-scope';
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'workspace_id_mismatch',
    );
  });

  it('V16: ungültiger DocumentWorkResult wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      state.documentWorkResults = [{ ...buildWorkResult(), sourceFingerprint: '' }];
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'invalid_document_work_result',
    );
  });

  it('V17: ungültiger DocumentFileRef wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      const refs = state.documentFileRefs as Record<string, unknown>[];
      refs[1]!.lifecycleStatus = 'archiviert';
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'invalid_document_file_ref',
    );
  });

  it('V18: Manifeststatus missing wird abgelehnt', async () => {
    const zip = await buildValidZip(({ entries, binaries }) => {
      entries[1]!.status = 'missing';
      delete entries[1]!.path;
      binaries.splice(1, 1);
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'manifest_entry_not_found',
    );
  });

  it('V19: Manifeststatus read_error wird abgelehnt', async () => {
    const zip = await buildValidZip(({ entries, binaries }) => {
      entries[1]!.status = 'read_error';
      delete entries[1]!.path;
      binaries.splice(1, 1);
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'manifest_entry_not_found',
    );
  });

  it('V20: fehlende Binärdatei wird abgelehnt', async () => {
    const zip = await buildValidZip(({ binaries }) => {
      binaries.splice(1, 1);
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'missing_binary_file',
    );
  });

  it('V21: falsche Dateigröße wird abgelehnt', async () => {
    const zip = await buildValidZip(({ binaries }) => {
      binaries[1] = { path: 'files/file-2.bin', bytes: new Uint8Array([1, 2, 3]) };
    });
    const codes = errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }));
    expect(codes).toContain('file_size_mismatch');
  });

  it('V22: richtige Größe, falscher Inhalt wird abgelehnt', async () => {
    const zip = await buildValidZip(({ binaries }) => {
      const tampered = new Uint8Array(PNG_BYTES);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
      binaries[1] = { path: 'files/file-2.bin', bytes: tampered };
    });
    const codes = errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }));
    expect(codes).toContain('content_hash_mismatch');
    expect(codes).not.toContain('file_size_mismatch');
  });

  it('V23: MIME-Widerspruch zwischen Manifest und FileRef wird abgelehnt', async () => {
    const zip = await buildValidZip(({ entries }) => {
      entries[1]!.mimeType = 'application/pdf';
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'mime_type_mismatch',
    );
  });

  it('V24: Manifesteintrag ohne FileRef im Zustand wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      const refs = state.documentFileRefs as Record<string, unknown>[];
      refs.splice(1, 1);
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'manifest_entry_without_file_ref',
    );
  });

  it('V25: FileRef ohne Manifesteintrag wird abgelehnt', async () => {
    const zip = await buildValidZip(({ entries, binaries }) => {
      entries.splice(1, 1);
      binaries.splice(1, 1);
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'file_ref_without_manifest_entry',
    );
  });

  it('V26: ungültiges SHA-256-Format wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state, entries }) => {
      const refs = state.documentFileRefs as Record<string, unknown>[];
      refs[1]!.contentHash = 'zz';
      entries[1]!.expectedContentHash = 'zz';
      entries[1]!.recordContentHash = 'zz';
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'invalid_content_hash_format',
    );
  });

  it('V27: committed-Datei erzeugt keine Lifecycle-Warnung', async () => {
    const result = await validateEmergencyBackupZip(await buildValidZip(), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pdfWarnings = result.bundle.warnings.filter((w) => w.fileRefId === 'file-ref-pdf-1');
    expect(pdfWarnings).toEqual([]);
  });

  it('V28: nicht abgelaufene temp-Datei wird gewarnt, aber erhalten', async () => {
    const zip = await buildValidZip(({ state, entries }) => {
      void entries;
      const refs = state.documentFileRefs as Record<string, unknown>[];
      refs[1]!.expiresAt = '2026-09-01T00:00:00.000Z';
    });
    const result = await validateEmergencyBackupZip(zip, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const codes = result.bundle.warnings
      .filter((w) => w.fileRefId === 'file-ref-png-2')
      .map((w) => w.code);
    expect(codes).toContain('uncommitted_file');
    expect(codes).not.toContain('expired_temp_file');
    expect(result.bundle.requiresLifecycleDecision).toBe(true);
    expect(result.bundle.files.some((f) => f.fileRefId === 'file-ref-png-2')).toBe(true);
  });

  it('V29: abgelaufene temp-Datei wird gewarnt, aber erhalten', async () => {
    const result = await validateEmergencyBackupZip(await buildValidZip(), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const png = result.bundle.files.find((f) => f.fileRefId === 'file-ref-png-2');
    expect(png, 'abgelaufene Datei wurde entfernt').toBeTruthy();
    expect(png?.expired).toBe(true);
    expect(png?.lifecycleStatus).toBe('temp');
    expect(png?.expiresAt).toBe('2026-08-16T13:11:18.369Z');

    const codes = result.bundle.warnings
      .filter((w) => w.fileRefId === 'file-ref-png-2')
      .map((w) => w.code);
    expect(codes).toContain('expired_temp_file');
    expect(codes).toContain('uncommitted_file');
    expect(result.bundle.requiresLifecycleDecision).toBe(true);
  });

  it('V30: sourceRawText und sein SHA-256 sind stabil und unverändert', async () => {
    const { pdf, png } = await buildStandardParts();
    const rawText = JSON.stringify(
      buildRawState({ documentFileRefs: [buildFileRef(pdf), buildFileRef(png)] }),
    );
    const zip = await buildZip({
      rawStateText: rawText,
      manifest: buildManifest([
        buildManifestEntry(pdf, 'files/file-1.bin'),
        buildManifestEntry(png, 'files/file-2.bin'),
      ]),
      binaries: [
        { path: 'files/file-1.bin', bytes: PDF_BYTES },
        { path: 'files/file-2.bin', bytes: PNG_BYTES },
      ],
    });

    const expected = await computeBufferContentHash(new TextEncoder().encode(rawText));
    const first = await validateEmergencyBackupZip(zip, { now: NOW });
    const second = await validateEmergencyBackupZip(zip, { now: NOW });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.bundle.sourceRawText).toBe(rawText);
    expect(first.bundle.sourceRawTextSha256).toBe(expected);
    expect(second.bundle.sourceRawTextSha256).toBe(first.bundle.sourceRawTextSha256);
  });

  it('V31: syncOutbox wird angenommen, aber als zu verwerfen ausgewiesen', async () => {
    const result = await validateEmergencyBackupZip(await buildValidZip(), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.bundle.outboxMustBeDiscardedBeforeRestore).toBe(true);
    expect(result.bundle.outboxSummary.total).toBe(3);
    expect(result.bundle.outboxSummary.byStatus.pending).toBe(3);
    expect(result.bundle.outboxSummary.byEntityType.company_setup).toBe(1);
    expect(result.bundle.outboxSummary.byEntityType.company_profile).toBe(1);
    expect(result.bundle.outboxSummary.byEntityType.inbox_item).toBe(1);
    // Noch keine Bereinigung: der normalisierte Zustand behält die Einträge.
    expect(result.bundle.appState.syncOutbox?.length).toBe(3);
  });

  it('V32: das Ergebnis ist gegen spätere Änderungen der Eingabe versiegelt', async () => {
    const { pdf, png } = await buildStandardParts();
    const state = buildRawState({ documentFileRefs: [buildFileRef(pdf), buildFileRef(png)] });
    const zipBytes = await buildZip({
      rawStateText: JSON.stringify(state),
      manifest: buildManifest([
        buildManifestEntry(pdf, 'files/file-1.bin'),
        buildManifestEntry(png, 'files/file-2.bin'),
      ]),
      binaries: [
        { path: 'files/file-1.bin', bytes: PDF_BYTES },
        { path: 'files/file-2.bin', bytes: PNG_BYTES },
      ],
    });
    const result = await validateEmergencyBackupZip(zipBytes, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Eingabepuffer nachträglich verändern — das Ergebnis darf sich nicht ändern.
    const company = result.bundle.setupCompanyName;
    const hash = result.bundle.sourceRawTextSha256;
    zipBytes.fill(0);
    expect(result.bundle.setupCompanyName).toBe(company);
    expect(result.bundle.sourceRawTextSha256).toBe(hash);
    expect(() => {
      (result.bundle.files as unknown as unknown[]).push({});
    }).toThrow();
  });

  it('V33: unlesbares ZIP wird abgelehnt', async () => {
    const result = await validateEmergencyBackupZip(new Uint8Array([1, 2, 3, 4]), { now: NOW });
    expect(errorCodes(result)).toContain('invalid_zip');
  });

  it('V34: nicht unterstützte Datenversion wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      state.version = 99;
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'unsupported_state_version',
    );
  });

  it('V35: fehlendes companyProfile wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      delete state.companyProfile;
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'missing_company_profile',
    );
  });
});

/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02O1 — Beweislücken schliessen.
 *
 * JSZip normalisiert Pfade sowohl beim Schreiben als auch beim Laden. Für die
 * Angriffsfälle wird das Archiv deshalb byteweise selbst gebaut, damit im
 * echten Central Directory genau das steht, was geprüft werden soll.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface RawZipEntry {
  name: string;
  data: Uint8Array;
  /** Bewusst falsch deklarierbar — genau das prüfen die Limit-Tests. */
  declaredUncompressedSize?: number;
}

/** Minimaler STORE-ZIP-Schreiber ohne jede Pfadnormalisierung. */
function buildRawZip(entries: RawZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const usize = entry.declaredUncompressedSize ?? entry.data.byteLength;

    const local = new Uint8Array(30 + name.byteLength + entry.data.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.byteLength, true);
    lv.setUint32(22, usize, true);
    lv.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.byteLength, true);
    cv.setUint32(24, usize, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.byteLength;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

describe('OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02O1 — Beweise schliessen', () => {
  const encoder = new TextEncoder();

  async function rawZipParts() {
    const { pdf, png } = await buildStandardParts();
    const state = buildRawState({ documentFileRefs: [buildFileRef(pdf), buildFileRef(png)] });
    const manifest = buildManifest([
      buildManifestEntry(pdf, 'files/file-1.bin'),
      buildManifestEntry(png, 'files/file-2.bin'),
    ]);
    return {
      rawState: encoder.encode(JSON.stringify(state)),
      manifest: encoder.encode(JSON.stringify(manifest)),
    };
  }

  it('W1: echter doppelter Central-Directory-Pfad wird abgelehnt', async () => {
    const parts = await rawZipParts();
    const zip = buildRawZip([
      { name: 'raw-state.json', data: parts.rawState },
      { name: 'files-manifest.json', data: parts.manifest },
      { name: 'files/file-1.bin', data: PDF_BYTES },
      { name: 'files/file-1.bin', data: PNG_BYTES },
      { name: 'files/file-2.bin', data: PNG_BYTES },
    ]);
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'duplicate_zip_path',
    );
  });

  it('W2: unsicherer Originalpfad wird trotz JSZip-Normalisierung erkannt', async () => {
    const parts = await rawZipParts();
    const zip = buildRawZip([
      { name: 'raw-state.json', data: parts.rawState },
      { name: 'files-manifest.json', data: parts.manifest },
      { name: 'files/../files/file-1.bin', data: PDF_BYTES },
      { name: 'files/file-2.bin', data: PNG_BYTES },
    ]);
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain('unsafe_path');
  });

  it('W3: maxUncompressedBytes wird vor dem Entpacken erzwungen', async () => {
    const parts = await rawZipParts();
    const zip = buildRawZip([
      { name: 'raw-state.json', data: parts.rawState },
      { name: 'files-manifest.json', data: parts.manifest },
      { name: 'files/file-1.bin', data: PDF_BYTES, declaredUncompressedSize: 900 * 1024 * 1024 },
      { name: 'files/file-2.bin', data: PNG_BYTES },
    ]);
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'limit_exceeded',
    );
  });

  it('W4: maxCompressionRatio wird vor dem Entpacken erzwungen', async () => {
    const parts = await rawZipParts();
    const zip = buildRawZip([
      { name: 'raw-state.json', data: parts.rawState },
      { name: 'files-manifest.json', data: parts.manifest },
      // Winzige Datei, riesige behauptete Ausdehnung: klassische ZIP-Bombe.
      { name: 'files/file-1.bin', data: PDF_BYTES, declaredUncompressedSize: 40 * 1024 * 1024 },
      { name: 'files/file-2.bin', data: PNG_BYTES },
    ]);
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'limit_exceeded',
    );
  });

  it('W5: Binärpfad ausserhalb von files/file-N.bin wird abgelehnt', async () => {
    const { pdf, png } = await buildStandardParts();
    const zip = await buildZip({
      rawStateText: JSON.stringify(
        buildRawState({ documentFileRefs: [buildFileRef(pdf), buildFileRef(png)] }),
      ),
      manifest: buildManifest([
        buildManifestEntry(pdf, 'files/file-1.bin'),
        buildManifestEntry(png, 'files/anhang.bin'),
      ]),
      binaries: [
        { path: 'files/file-1.bin', bytes: PDF_BYTES },
        { path: 'files/anhang.bin', bytes: PNG_BYTES },
      ],
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'unknown_binary_file',
    );
  });

  it('W6: ungültiges UTF-8 in raw-state.json wird abgelehnt', async () => {
    const parts = await rawZipParts();
    const broken = new Uint8Array(parts.rawState);
    broken[5] = 0xff; // niemals gültiges UTF-8
    const zip = buildRawZip([
      { name: 'raw-state.json', data: broken },
      { name: 'files-manifest.json', data: parts.manifest },
      { name: 'files/file-1.bin', data: PDF_BYTES },
      { name: 'files/file-2.bin', data: PNG_BYTES },
    ]);
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'invalid_raw_state_encoding',
    );
  });

  it('W7: unvollständiges Setup wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      (state.setup as Record<string, unknown>).taxStatus = 'phantasiewert';
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'invalid_setup',
    );
  });

  it('W8: ungültiges CompanyProfile wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      delete (state.companyProfile as Record<string, unknown>).iban;
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'invalid_company_profile',
    );
  });

  it('W9: ungültiges InboxItem wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      (state.inboxItems as Record<string, unknown>[])[0]!.status = 'unbekannt';
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'invalid_inbox_item',
    );
  });

  it('W10: unvollständige specialistRefs im WorkResult werden abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      (state.documentWorkResults as Record<string, unknown>[])[0]!.specialistRefs = {
        hasClassification: true,
      };
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'invalid_document_work_result',
    );
  });

  it('W11: WorkResult eines fremden Workspace wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      (state.documentWorkResults as Record<string, unknown>[])[0]!.workspaceId =
        'fremder-workspace';
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'workspace_id_mismatch',
    );
  });

  it('W12: fehlendes Workspace-Identitätsfeld wird abgelehnt', async () => {
    const zip = await buildValidZip(({ state }) => {
      delete (state.syncClient as Record<string, unknown>).serverWorkspaceId;
    });
    expect(errorCodes(await validateEmergencyBackupZip(zip, { now: NOW }))).toContain(
      'missing_workspace_identity',
    );
  });

  it('W13: der Restore erhält ausschliesslich die geprüften Bytes', async () => {
    const zipBytes = await buildValidZip();
    const result = await validateEmergencyBackupZip(zipBytes, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = readValidatedEmergencyBackupFileBytes(result.bundle, 'file-ref-png-2');
    expect(first).not.toBeNull();
    expect(first!.byteLength).toBe(PNG_BYTES.byteLength);
    expect(await computeBufferContentHash(first!)).toBe(
      result.bundle.files.find((f) => f.fileRefId === 'file-ref-png-2')!.sha256,
    );

    // Weder die Eingabe noch ein veränderter Rückgabewert dürfen durchschlagen.
    first!.fill(0);
    zipBytes.fill(0);
    const second = readValidatedEmergencyBackupFileBytes(result.bundle, 'file-ref-png-2');
    expect(Array.from(second!)).toEqual(Array.from(PNG_BYTES));
  });

  it('W14: unbekannte FileRef-ID liefert keine Bytes', async () => {
    const result = await validateEmergencyBackupZip(await buildValidZip(), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readValidatedEmergencyBackupFileBytes(result.bundle, 'gibt-es-nicht')).toBeNull();
  });
});
