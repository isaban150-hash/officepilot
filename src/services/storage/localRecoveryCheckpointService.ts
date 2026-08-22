/**
 * MOBILE-SAFE-RESUME-01B — eng begrenzter Wiederaufnahmepunkt für den sicheren
 * Ablauf unter `/local-recovery/import`.
 *
 * Hintergrund: der ZIP-Download verwirft auf dem iPhone regelmäßig die Seite.
 * Der elfstufige Ablauf lag ausschließlich in React-`useState` und begann
 * danach von vorne — die Quarantäne war auf dem Telefon nicht abschließbar.
 *
 * Dieser Dienst speichert **ausschließlich sichere Kennwerte**, mit denen der
 * Ablauf an einer klar benannten Stelle fortgesetzt werden kann:
 *
 *  - ausgewählter Speicherschlüssel und Scope-Schlüssel
 *  - Workspace-Kennung und Firmenname
 *  - Fingerprint des Zielbestands (`sourceRawTextSha256`) und Zeitstempel
 *  - erwarteter SHA-256-Wert der vorbereiteten Sicherung
 *  - Dateiname der Sicherung
 *  - Ablaufstufe **höchstens** `download_triggered`
 *
 * Ausdrücklich **nicht** gespeichert werden: Blob- oder ZIP-Inhalt, der
 * Dateipfad des Downloads, Checkboxen, die Quarantänebestätigung, eine
 * laufende Quarantäne, bereits ausgelöste Schreiboperationen,
 * Cloud-Zugangsdaten sowie allgemeine Anwendungs- oder Firmendaten.
 *
 * Der Dienst schreibt nichts an Fachdaten, wechselt keinen Scope, startet
 * keinen Sync und ruft weder Cloud noch Quarantäne auf. Er ist origin-lokal:
 * ein anderer Port oder Host besitzt seinen eigenen `localStorage`.
 */

export const LOCAL_RECOVERY_CHECKPOINT_KEY = 'officepilot-local-recovery-import-checkpoint';
export const LOCAL_RECOVERY_CHECKPOINT_VERSION = 1 as const;

/** Höchste sichere Stufe. Alles darüber ist eine Bestätigung und wird nie gespeichert. */
export type LocalRecoveryCheckpointStage = 'prepared_validated' | 'download_triggered';

export interface LocalRecoveryCheckpoint {
  kind: 'officepilot-local-recovery-import-checkpoint';
  version: typeof LOCAL_RECOVERY_CHECKPOINT_VERSION;
  stage: LocalRecoveryCheckpointStage;
  /** Ausgewählter lokaler Speicherschlüssel des Zielbestands. */
  sourceStorageKey: string;
  sourceScopeKey: string;
  workspaceId: string;
  companyName: string;
  /** Fingerprint des Zielbestands zum Zeitpunkt der Vorbereitung. */
  sourceRawTextSha256: string;
  /** Erwartete Prüfsumme der vorbereiteten Sicherungsdatei. */
  archiveSha256: string;
  suggestedFilename: string;
  /** Gespeicherter Ausgangszeitpunkt des Zielbestands. */
  targetSavedAt: string | null;
  savedAt: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSupportedStage(value: unknown): value is LocalRecoveryCheckpointStage {
  return value === 'prepared_validated' || value === 'download_triggered';
}

/** Strenge Formprüfung — ein unvollständiger Punkt gilt als nicht vorhanden. */
export function isValidLocalRecoveryCheckpoint(
  value: unknown,
): value is LocalRecoveryCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as LocalRecoveryCheckpoint;
  if (candidate.kind !== 'officepilot-local-recovery-import-checkpoint') return false;
  if (candidate.version !== LOCAL_RECOVERY_CHECKPOINT_VERSION) return false;
  if (!isSupportedStage(candidate.stage)) return false;
  if (!isNonEmptyString(candidate.sourceStorageKey)) return false;
  if (!isNonEmptyString(candidate.sourceScopeKey)) return false;
  if (!isNonEmptyString(candidate.workspaceId)) return false;
  if (typeof candidate.companyName !== 'string') return false;
  if (!isNonEmptyString(candidate.sourceRawTextSha256)) return false;
  if (!SHA256_HEX.test(candidate.sourceRawTextSha256)) return false;
  if (!isNonEmptyString(candidate.archiveSha256)) return false;
  if (!SHA256_HEX.test(candidate.archiveSha256)) return false;
  if (!isNonEmptyString(candidate.suggestedFilename)) return false;
  if (candidate.targetSavedAt !== null && !isNonEmptyString(candidate.targetSavedAt)) {
    return false;
  }
  if (!isNonEmptyString(candidate.savedAt)) return false;
  return true;
}

export function readLocalRecoveryCheckpoint(): LocalRecoveryCheckpoint | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LOCAL_RECOVERY_CHECKPOINT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isValidLocalRecoveryCheckpoint(parsed) ? parsed : null;
}

export type WriteLocalRecoveryCheckpointInput = Omit<
  LocalRecoveryCheckpoint,
  'kind' | 'version' | 'savedAt'
> & { now?: string };

/** Schreibt genau einen Punkt. Ein ungültiger Eingang wird nicht gespeichert. */
export function writeLocalRecoveryCheckpoint(
  input: WriteLocalRecoveryCheckpointInput,
): LocalRecoveryCheckpoint | null {
  const { now, ...rest } = input;
  const checkpoint: LocalRecoveryCheckpoint = {
    kind: 'officepilot-local-recovery-import-checkpoint',
    version: LOCAL_RECOVERY_CHECKPOINT_VERSION,
    ...rest,
    savedAt: now ?? new Date().toISOString(),
  };
  if (!isValidLocalRecoveryCheckpoint(checkpoint)) return null;

  try {
    localStorage.setItem(LOCAL_RECOVERY_CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } catch {
    return null;
  }
  return checkpoint;
}

export function clearLocalRecoveryCheckpoint(): void {
  try {
    localStorage.removeItem(LOCAL_RECOVERY_CHECKPOINT_KEY);
  } catch {
    // Ohne Speicher gibt es nichts zu entfernen.
  }
}

export type LocalRecoveryCheckpointMatch =
  | { ok: true; checkpoint: LocalRecoveryCheckpoint }
  | { ok: false; reason: 'missing' | 'target_missing' | 'target_changed' };

/**
 * Prüft, ob der Punkt noch zum tatsächlich vorhandenen Zielbestand gehört.
 * Weicht der Fingerprint ab, hat sich der lokale Bestand seit der Sicherung
 * verändert — der Punkt wird verworfen und der Ablauf beginnt neu.
 */
export function matchLocalRecoveryCheckpoint(input: {
  checkpoint: LocalRecoveryCheckpoint | null;
  targets: ReadonlyArray<{ storageKey: string; rawTextSha256?: string; savedAt?: string }>;
}): LocalRecoveryCheckpointMatch {
  const { checkpoint, targets } = input;
  if (!checkpoint) return { ok: false, reason: 'missing' };

  const target = targets.find((entry) => entry.storageKey === checkpoint.sourceStorageKey);
  if (!target) return { ok: false, reason: 'target_missing' };

  /*
   * Zwei unabhängige Merkmale. Der Fingerprint ist der stärkere; liegt er im
   * Inventar nicht vor, entscheidet der gespeicherte Ausgangszeitpunkt. Weicht
   * eines von beiden ab, hat sich der Zielbestand seit der Sicherung geändert.
   */
  if (
    typeof target.rawTextSha256 === 'string' &&
    target.rawTextSha256 !== checkpoint.sourceRawTextSha256
  ) {
    return { ok: false, reason: 'target_changed' };
  }
  if ((target.savedAt ?? null) !== checkpoint.targetSavedAt) {
    return { ok: false, reason: 'target_changed' };
  }

  return { ok: true, checkpoint };
}
