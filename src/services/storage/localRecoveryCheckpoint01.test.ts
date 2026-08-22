/**
 * MOBILE-SAFE-RESUME-01B — Wiederaufsetzpunkt für /local-recovery/import.
 *
 * Ausschließlich synthetische Werte. Der Punkt darf nur sichere Kennwerte
 * tragen; jede Bestätigung und jeder Inhalt bleibt draußen.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLocalRecoveryCheckpoint,
  isValidLocalRecoveryCheckpoint,
  LOCAL_RECOVERY_CHECKPOINT_KEY,
  matchLocalRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  writeLocalRecoveryCheckpoint,
  type WriteLocalRecoveryCheckpointInput,
} from './localRecoveryCheckpointService';

const SOURCE_SHA = 'a'.repeat(64);
const ARCHIVE_SHA = 'b'.repeat(64);
const SAVED_AT = '2026-08-22T10:00:00.000Z';

function input(
  overrides: Partial<WriteLocalRecoveryCheckpointInput> = {},
): WriteLocalRecoveryCheckpointInput {
  return {
    stage: 'download_triggered',
    sourceStorageKey: 'officepilot-state:workspace:ws-test-1',
    sourceScopeKey: 'workspace:ws-test-1',
    workspaceId: 'ws-test-1',
    companyName: 'Beispiel Betrieb GmbH',
    sourceRawTextSha256: SOURCE_SHA,
    archiveSha256: ARCHIVE_SHA,
    suggestedFilename: 'officepilot-sicherung.zip',
    targetSavedAt: SAVED_AT,
    now: '2026-08-22T10:05:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('01B — Wiederaufsetzpunkt speichert nur sichere Kennwerte', () => {
  it('C1: schreiben und lesen liefert denselben Punkt', () => {
    const written = writeLocalRecoveryCheckpoint(input());
    expect(written).not.toBeNull();

    const read = readLocalRecoveryCheckpoint();
    expect(read).toEqual(written);
    expect(read?.stage).toBe('download_triggered');
    expect(read?.archiveSha256).toBe(ARCHIVE_SHA);
    expect(read?.targetSavedAt).toBe(SAVED_AT);
  });

  it('C2: der Rohtext enthält keine Bestätigung, keinen Inhalt und keinen Pfad', () => {
    writeLocalRecoveryCheckpoint(input());
    const raw = localStorage.getItem(LOCAL_RECOVERY_CHECKPOINT_KEY) ?? '';
    expect(raw.length).toBeGreaterThan(0);

    for (const forbidden of [
      'zipBlob',
      'blob',
      'acknowledged',
      'confirm',
      'quarantine',
      'filePath',
      'downloadPath',
      'token',
      'password',
      'anonKey',
    ]) {
      expect(raw.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }

    // Genau die erlaubten Schlüssel — nichts darüber hinaus.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'archiveSha256',
        'companyName',
        'kind',
        'savedAt',
        'sourceRawTextSha256',
        'sourceScopeKey',
        'sourceStorageKey',
        'stage',
        'suggestedFilename',
        'targetSavedAt',
        'version',
        'workspaceId',
      ].sort(),
    );
  });

  it('C3: unsichere Stufen werden nicht gespeichert', () => {
    for (const stage of [
      'reselect_confirmed',
      'quarantining',
      'quarantine_complete',
      'inventory',
      '',
    ]) {
      localStorage.clear();
      const written = writeLocalRecoveryCheckpoint(
        input({ stage: stage as never }),
      );
      expect(written, stage).toBeNull();
      expect(localStorage.getItem(LOCAL_RECOVERY_CHECKPOINT_KEY), stage).toBeNull();
    }
  });

  it('C4: unvollständige oder beschädigte Punkte gelten als nicht vorhanden', () => {
    const broken: Array<[string, Partial<WriteLocalRecoveryCheckpointInput>]> = [
      ['ohne Speicherschlüssel', { sourceStorageKey: '' }],
      ['ohne Workspace', { workspaceId: '' }],
      ['ungültige Zielprüfsumme', { sourceRawTextSha256: 'xyz' }],
      ['ungültige Archivprüfsumme', { archiveSha256: 'zzz' }],
      ['ohne Dateiname', { suggestedFilename: '' }],
    ];
    for (const [label, overrides] of broken) {
      localStorage.clear();
      expect(writeLocalRecoveryCheckpoint(input(overrides)), label).toBeNull();
    }

    localStorage.setItem(LOCAL_RECOVERY_CHECKPOINT_KEY, '{kaputt');
    expect(readLocalRecoveryCheckpoint()).toBeNull();

    localStorage.setItem(LOCAL_RECOVERY_CHECKPOINT_KEY, JSON.stringify({ kind: 'fremd' }));
    expect(readLocalRecoveryCheckpoint()).toBeNull();
    expect(isValidLocalRecoveryCheckpoint({ kind: 'fremd' })).toBe(false);
  });

  it('C5: ein veränderter Zielbestand verwirft den Punkt', () => {
    const checkpoint = writeLocalRecoveryCheckpoint(input());
    expect(checkpoint).not.toBeNull();

    const unveraendert = matchLocalRecoveryCheckpoint({
      checkpoint,
      targets: [{ storageKey: checkpoint!.sourceStorageKey, savedAt: SAVED_AT }],
    });
    expect(unveraendert.ok).toBe(true);

    const spaeterGespeichert = matchLocalRecoveryCheckpoint({
      checkpoint,
      targets: [
        { storageKey: checkpoint!.sourceStorageKey, savedAt: '2026-08-22T11:00:00.000Z' },
      ],
    });
    expect(spaeterGespeichert.ok).toBe(false);
    if (!spaeterGespeichert.ok) expect(spaeterGespeichert.reason).toBe('target_changed');

    const andererFingerprint = matchLocalRecoveryCheckpoint({
      checkpoint,
      targets: [
        {
          storageKey: checkpoint!.sourceStorageKey,
          savedAt: SAVED_AT,
          rawTextSha256: 'c'.repeat(64),
        },
      ],
    });
    expect(andererFingerprint.ok).toBe(false);
    if (!andererFingerprint.ok) expect(andererFingerprint.reason).toBe('target_changed');

    const verschwunden = matchLocalRecoveryCheckpoint({ checkpoint, targets: [] });
    expect(verschwunden.ok).toBe(false);
    if (!verschwunden.ok) expect(verschwunden.reason).toBe('target_missing');

    const fehlend = matchLocalRecoveryCheckpoint({ checkpoint: null, targets: [] });
    expect(fehlend.ok).toBe(false);
    if (!fehlend.ok) expect(fehlend.reason).toBe('missing');
  });

  it('C6: entfernen löscht den Punkt vollständig', () => {
    writeLocalRecoveryCheckpoint(input());
    expect(readLocalRecoveryCheckpoint()).not.toBeNull();
    clearLocalRecoveryCheckpoint();
    expect(readLocalRecoveryCheckpoint()).toBeNull();
    expect(localStorage.getItem(LOCAL_RECOVERY_CHECKPOINT_KEY)).toBeNull();
  });
});
