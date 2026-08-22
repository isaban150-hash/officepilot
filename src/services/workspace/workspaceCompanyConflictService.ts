/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02B — reine Konflikterkennung zwischen
 * lokalem Workspace-Bestand und Cloud-Stand.
 *
 * Keine Speziallogik für einzelne Firmen. Die Funktionen lesen nur: kein
 * Hydrieren, kein Scope-Wechsel, kein persistAll, kein Netzwerk.
 */
import type { AppPersistedState } from '../../types/models';
import { buildStorageKey } from '../storage/storageScopeService';

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
 * Liest den lokalen Workspace-Bestand direkt aus dem Speicher — ohne
 * Normalisierung mit Seiteneffekten und ohne den aktiven Scope zu berühren.
 */
export function readLocalCompanyCandidate(workspaceId: string): LocalCompanyCandidate | null {
  const storageKey = buildStorageKey({ type: 'workspace', workspaceId });
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
