/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02B — reine Konflikterkennung zwischen
 * lokalem Workspace-Bestand und Cloud-Stand.
 *
 * Keine Speziallogik für einzelne Firmen. Die Funktionen lesen nur: kein
 * Hydrieren, kein Scope-Wechsel, kein persistAll, kein Netzwerk.
 */
import type { AppPersistedState } from '../../types/models';
import {
  buildLegacyWorkspaceStorageKey,
  buildStorageKey,
  type StorageAccount,
} from '../storage/storageScopeService';

export interface LocalCompanyCandidate {
  storageKey: string;
  companyName: string;
  profileCompanyName: string;
  setupComplete: boolean;
  savedAt?: string;
  /** Roher Zustand — unverändert, ausschließlich zum Lesen. */
  state: AppPersistedState;
  rawText: string;
}

export interface CloudCompanySnapshot {
  setupCompanyName: string;
  profileCompanyName: string;
  setupRowVersion: number;
  companyProfileRowVersion: number;
}

export interface CompanyConflictInfo {
  localCompanyName: string;
  cloudCompanyName: string;
  localSavedAt?: string;
  localSetupComplete: boolean;
  cloudSetupRowVersion: number;
  cloudProfileRowVersion: number;
  /** Intern für den bestätigten Weg, nicht für die Oberfläche. */
  workspaceId: string;
  storageKey: string;
  /**
   * DOKUMENTE-01 N1 — das Konto, dessen lokaler Bestand verglichen wurde. Die
   * Auflösung liest denselben Bestand; ohne Konto den Altbestand wie bisher.
   */
  account?: StorageAccount | null;
}

/** Robuster Namensvergleich: Rand, Groß-/Kleinschreibung und Unicode-Form. */
export function normalizeCompanyName(value: string | undefined): string {
  if (!value) return '';
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function readRaw(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/**
 * DOKUMENTE-01 N1 — welcher lokale Betriebsbestand für dieses Konto gilt: sein
 * Kontobestand; fehlt er, mit voller Sicht der Altbestand bzw. der eigene
 * Mitgliedsbestand — genau die, die der Bereichswechsel übernimmt
 * (`prepareWorkspaceAccountStore`). Ohne Konto der Altbestand wie bisher.
 */
export function resolveLocalWorkspaceStorageKey(
  workspaceId: string,
  account?: StorageAccount | null,
): string {
  if (!account) return buildLegacyWorkspaceStorageKey(workspaceId);
  const accountKey = buildStorageKey({ type: 'workspace', workspaceId, account });
  if (readRaw(accountKey) !== null || account.access !== 'full') return accountKey;
  const legacyKey = buildLegacyWorkspaceStorageKey(workspaceId);
  if (readRaw(legacyKey) !== null) return legacyKey;
  const memberKey = buildStorageKey({
    type: 'workspace',
    workspaceId,
    account: { userId: account.userId, access: 'member' },
  });
  return readRaw(memberKey) !== null ? memberKey : accountKey;
}

/**
 * Liest den lokalen Workspace-Bestand direkt aus dem Speicher — ohne
 * Normalisierung mit Seiteneffekten und ohne den aktiven Scope zu berühren.
 */
export function readLocalCompanyCandidate(
  workspaceId: string,
  account?: StorageAccount | null,
): LocalCompanyCandidate | null {
  const storageKey = resolveLocalWorkspaceStorageKey(workspaceId, account);
  const rawText = readRaw(storageKey);
  if (!rawText) return null;

  let parsed: AppPersistedState;
  try {
    const value: unknown = JSON.parse(rawText);
    if (!value || typeof value !== 'object') return null;
    parsed = value as AppPersistedState;
  } catch {
    return null;
  }

  const companyName = parsed.setup?.companyName?.trim() ?? '';
  const profileCompanyName = parsed.companyProfile?.companyName?.trim() ?? '';
  if (!companyName && !profileCompanyName) return null;

  return {
    storageKey,
    companyName,
    profileCompanyName,
    setupComplete: parsed.setup?.setupComplete === true,
    savedAt: parsed.savedAt,
    state: parsed,
    rawText,
  };
}

/** Echte Firmendaten heißt: abgeschlossene Einrichtung mit gesetztem Namen. */
export function isRealLocalCompany(candidate: LocalCompanyCandidate | null): boolean {
  if (!candidate) return false;
  return candidate.setupComplete && Boolean(candidate.companyName || candidate.profileCompanyName);
}

/**
 * Konflikt liegt vor, wenn beide Seiten eine echte Firma tragen und sich Setup-
 * oder Profilname unterscheiden. Setup und Profil werden getrennt geprüft.
 */
export function detectCompanyConflict(
  candidate: LocalCompanyCandidate | null,
  cloud: CloudCompanySnapshot,
  workspaceId: string,
): CompanyConflictInfo | null {
  if (!isRealLocalCompany(candidate) || !candidate) return null;

  const cloudSetup = normalizeCompanyName(cloud.setupCompanyName);
  const cloudProfile = normalizeCompanyName(cloud.profileCompanyName);
  if (!cloudSetup && !cloudProfile) return null;

  const localSetup = normalizeCompanyName(candidate.companyName);
  const localProfile = normalizeCompanyName(candidate.profileCompanyName || candidate.companyName);

  const setupDiffers = Boolean(cloudSetup) && Boolean(localSetup) && cloudSetup !== localSetup;
  const profileDiffers =
    Boolean(cloudProfile) && Boolean(localProfile) && cloudProfile !== localProfile;
  if (!setupDiffers && !profileDiffers) return null;

  return {
    localCompanyName: candidate.companyName || candidate.profileCompanyName,
    cloudCompanyName: cloud.setupCompanyName || cloud.profileCompanyName,
    localSavedAt: candidate.savedAt,
    localSetupComplete: candidate.setupComplete,
    cloudSetupRowVersion: cloud.setupRowVersion,
    cloudProfileRowVersion: cloud.companyProfileRowVersion,
    workspaceId,
    storageKey: candidate.storageKey,
  };
}

/** Baut den Cloud-Ausschnitt aus einer bereits gelesenen Pull-Antwort. */
export function buildCloudCompanySnapshot(pull: {
  setupPayload: Record<string, unknown> | null;
  companyProfilePayload: Record<string, unknown> | null;
  setupRowVersion: number;
  companyProfileRowVersion: number;
}): CloudCompanySnapshot {
  const setupName = pull.setupPayload?.companyName;
  const profileName = pull.companyProfilePayload?.companyName;
  return {
    setupCompanyName: typeof setupName === 'string' ? setupName.trim() : '',
    profileCompanyName: typeof profileName === 'string' ? profileName.trim() : '',
    setupRowVersion: pull.setupRowVersion,
    companyProfileRowVersion: pull.companyProfileRowVersion,
  };
}
