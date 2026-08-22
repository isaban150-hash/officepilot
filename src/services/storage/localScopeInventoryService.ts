/**
 * OFFICEPILOT-LOCAL-SCOPE-RECOVERY-01B — rein lesende Bestandsaufnahme der
 * OfficePilot-Kopien in der aktuell geöffneten Origin.
 *
 * Dieser Service schreibt NIEMALS: er benutzt ausschließlich localStorage.length,
 * localStorage.key(index) und localStorage.getItem(key). Kein setItem, kein
 * removeItem, kein clear, kein Scope-Wechsel, keine Normalisierung mit
 * Seiteneffekten, kein Netzwerk.
 *
 * Wichtig: localStorage ist an die Origin (Schema + Host + Port) gebunden. Daten
 * einer anderen IP-Adresse oder eines anderen Ports sind hier technisch nicht
 * lesbar — das wird auf der Seite auch so gesagt.
 */
import {
  LEGACY_GLOBAL_STORAGE_KEY,
  LEGACY_QUARANTINE_PREFIX,
  LEGACY_SETUP_KEY,
  STORAGE_KEY_PREFIX,
} from './storageScopeService';

export type LocalScopeCopyType =
  | 'legacy'
  | 'legacy_setup'
  | 'guest'
  | 'user'
  | 'workspace'
  | 'quarantine';

export interface LocalScopeCopy {
  storageKey: string;
  scopeType: LocalScopeCopyType;
  /** Scope-Kennung (User-ID bzw. Workspace-ID), soweit aus dem Schlüssel ableitbar. */
  scopeId?: string;
  valid: boolean;
  rawLength: number;
  setupCompanyName?: string;
  profileCompanyName?: string;
  setupComplete?: boolean;
  savedAt?: string;
  stateVersion?: number;
  serverWorkspaceId?: string;
  language?: string;
  industry?: string;
  taxStatus?: string;
  vorgangCount: number;
  documentCount: number;
  orderCount: number;
}

export interface LocalScopeInventory {
  origin: string;
  copies: LocalScopeCopy[];
}

/** Nur der reine Scope-Schlüssel zählt — Anhänge wie ":invoice-finalize-intents" nicht. */
function plainSegment(value: string): boolean {
  return value.length > 0 && !value.includes(':');
}

function classify(key: string): { type: LocalScopeCopyType; id?: string } | null {
  if (key === LEGACY_SETUP_KEY) return { type: 'legacy_setup' };
  if (key === LEGACY_GLOBAL_STORAGE_KEY) return { type: 'legacy' };
  if (key.startsWith(LEGACY_QUARANTINE_PREFIX)) {
    return { type: 'quarantine', id: key.slice(LEGACY_QUARANTINE_PREFIX.length) };
  }
  if (key === `${STORAGE_KEY_PREFIX}:guest`) return { type: 'guest' };
  if (key.startsWith(`${STORAGE_KEY_PREFIX}:user:`)) {
    const id = key.slice(`${STORAGE_KEY_PREFIX}:user:`.length);
    return plainSegment(id) ? { type: 'user', id } : null;
  }
  if (key.startsWith(`${STORAGE_KEY_PREFIX}:workspace:`)) {
    const id = key.slice(`${STORAGE_KEY_PREFIX}:workspace:`.length);
    return plainSegment(id) ? { type: 'workspace', id } : null;
  }
  return null;
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Liest alle Schlüssel der aktuellen Origin, ohne irgendetwas zu verändern. */
export function listLocalScopeStorageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && classify(key)) keys.push(key);
    }
  } catch {
    return keys;
  }
  return keys.sort();
}

function inspectCopy(storageKey: string): LocalScopeCopy {
  const classification = classify(storageKey) ?? { type: 'legacy' as LocalScopeCopyType };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    raw = null;
  }

  const base: LocalScopeCopy = {
    storageKey,
    scopeType: classification.type,
    scopeId: classification.id,
    valid: false,
    rawLength: raw?.length ?? 0,
    vorgangCount: 0,
    documentCount: 0,
    orderCount: 0,
  };

  if (!raw) return base;

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return base;
    parsed = value as Record<string, unknown>;
  } catch {
    // Beschädigte Kopie: bleibt sichtbar, wird aber als ungültig markiert.
    return base;
  }

  /**
   * OFFICEPILOT-LOCAL-SCOPE-RECOVERY-01D — officepilot-setup enthält direkt ein
   * CompanySetup, kein AppPersistedState mit untergeordnetem setup-Objekt. Der
   * Rohtext wird unverändert ausgewertet; keine Defaultwerte, die den echten
   * Inhalt verschleiern könnten (deshalb kein loadLegacySetup).
   */
  if (classification.type === 'legacy_setup') {
    const legacySetup = parsed as Record<string, unknown>;
    return {
      ...base,
      valid: true,
      setupCompanyName: optionalString(legacySetup.companyName),
      setupComplete: legacySetup.setupComplete === true,
      language: optionalString(legacySetup.language),
      industry: optionalString(legacySetup.industry),
      taxStatus: optionalString(legacySetup.taxStatus),
    };
  }

  const setup = (parsed.setup ?? {}) as Record<string, unknown>;
  const profile = (parsed.companyProfile ?? {}) as Record<string, unknown>;
  const syncClient = (parsed.syncClient ?? {}) as Record<string, unknown>;

  return {
    ...base,
    valid: true,
    setupCompanyName: optionalString(setup.companyName),
    profileCompanyName: optionalString(profile.companyName),
    setupComplete: setup.setupComplete === true,
    savedAt: optionalString(parsed.savedAt),
    stateVersion: typeof parsed.version === 'number' ? parsed.version : undefined,
    serverWorkspaceId: optionalString(syncClient.serverWorkspaceId),
    language: optionalString(setup.language),
    vorgangCount: countOf(parsed.vorgaenge),
    documentCount: countOf(parsed.documents),
    // „Aufträge“ liegen je nach Alter des Stands unter verschiedenen Feldern.
    orderCount:
      countOf(parsed.orders) + countOf(parsed.auftraege) + countOf(parsed.contractOrders),
  };
}

export function readLocalScopeInventory(): LocalScopeInventory {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return {
    origin,
    copies: listLocalScopeStorageKeys().map(inspectCopy),
  };
}

/** Unveränderter Rohtext einer Kopie — ausschließlich lesend. */
export function readLocalScopeRawCopy(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}
