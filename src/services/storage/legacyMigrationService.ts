import type { AppPersistedState } from '../../types/models';
import type { StorageAccount, StorageScope } from './storageScopeService';
import {
  LEGACY_GLOBAL_STORAGE_KEY,
  buildLegacyQuarantineKey,
  buildStorageKey,
} from './storageScopeService';
import { stateContainsDefinitelyMockData } from './mockDataDetectionService';

export type LegacyMigrationOutcome =
  | { action: 'none' }
  | { action: 'migrated'; targetKey: string }
  | { action: 'quarantined'; quarantineKey: string };

function readRawStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRawStorage(key: string, raw: string): void {
  localStorage.setItem(key, raw);
}

function removeRawStorage(key: string): void {
  localStorage.removeItem(key);
}

export function legacyGlobalStateExists(): boolean {
  return readRawStorage(LEGACY_GLOBAL_STORAGE_KEY) !== null;
}

export function canAssignLegacyStateToScope(
  legacy: AppPersistedState,
  scope: StorageScope,
  userId?: string,
): boolean {
  if (stateContainsDefinitelyMockData(legacy) && scope.type !== 'guest') {
    return false;
  }

  if (scope.type === 'workspace') {
    /*
     * DOKUMENTE-01 N1 — der globale Altbestand stammt aus der Zeit vor jeder
     * Trennung und kann alles enthalten, was der Betrieb lokal hatte. Ein Konto
     * mit Mitgliedssicht bekommt ihn nie; er wandert in die Quarantäne.
     */
    if (scope.account?.access === 'member') return false;
    const workspaceId = scope.workspaceId;
    if (legacy.workspace?.id === workspaceId) return true;
    if (legacy.syncClient?.serverWorkspaceId === workspaceId) return true;
    if (legacy.workspace?.ownerUserId && userId && legacy.workspace.ownerUserId === userId) {
      return true;
    }
    return false;
  }

  if (scope.type === 'user') {
    if (!userId) return false;
    if (legacy.workspace?.ownerUserId === userId) return true;
    if (
      !legacy.workspace &&
      !legacy.syncClient?.serverWorkspaceId &&
      legacy.vorgaenge.length === 0 &&
      legacy.inboxItems.length === 0
    ) {
      return true;
    }
    return false;
  }

  return false;
}

export function quarantineLegacyGlobalState(): string | null {
  const raw = readRawStorage(LEGACY_GLOBAL_STORAGE_KEY);
  if (!raw) return null;

  const quarantineKey = buildLegacyQuarantineKey();
  writeRawStorage(quarantineKey, raw);
  removeRawStorage(LEGACY_GLOBAL_STORAGE_KEY);
  return quarantineKey;
}

export function tryMigrateLegacyGlobalState(
  scope: StorageScope,
  userId?: string,
): LegacyMigrationOutcome {
  /*
   * DOKUMENTE-01 N1 — ein Konto mit Mitgliedssicht fasst den globalen Altbestand
   * gar nicht an: Es übernimmt ihn nicht und schiebt ihn auch nicht in die
   * Quarantäne. So bleibt er für ein Konto mit voller Sicht liegen.
   */
  if (scope.type === 'workspace' && scope.account?.access === 'member') {
    return { action: 'none' };
  }

  const targetKey = buildStorageKey(scope);
  if (readRawStorage(targetKey)) {
    if (legacyGlobalStateExists()) {
      const quarantineKey = quarantineLegacyGlobalState();
      return quarantineKey ? { action: 'quarantined', quarantineKey } : { action: 'none' };
    }
    return { action: 'none' };
  }

  const legacyRaw = readRawStorage(LEGACY_GLOBAL_STORAGE_KEY);
  if (!legacyRaw) {
    return { action: 'none' };
  }

  let legacy: AppPersistedState;
  try {
    legacy = JSON.parse(legacyRaw) as AppPersistedState;
  } catch {
    const quarantineKey = quarantineLegacyGlobalState();
    return quarantineKey ? { action: 'quarantined', quarantineKey } : { action: 'none' };
  }

  if (!canAssignLegacyStateToScope(legacy, scope, userId)) {
    const quarantineKey = quarantineLegacyGlobalState();
    return quarantineKey ? { action: 'quarantined', quarantineKey } : { action: 'none' };
  }

  writeRawStorage(targetKey, legacyRaw);
  removeRawStorage(LEGACY_GLOBAL_STORAGE_KEY);
  return { action: 'migrated', targetKey };
}

export type UserScopeMigrationResult =
  /** Kein User-Zustand vorhanden — nichts zu tun. */
  | { action: 'none' }
  /** Kein Workspace-Zustand vorhanden: vollständig übernommen. */
  | { action: 'moved' }
  /** Workspace-Zustand war ohne Firmendaten: Firmendaten übernommen, Identität behalten. */
  | { action: 'merged' }
  /** Workspace hat echte Firmendaten, der User-Zustand nicht: Workspace bleibt. */
  | { action: 'kept_workspace' }
  /** Beide Seiten tragen echte, unterschiedliche Firmendaten. */
  | { action: 'conflict' }
  /** Schreiben oder Rücklesen fehlgeschlagen — beide Kopien bleiben. */
  | { action: 'write_failed' }
  /** DOKUMENTE-01 N1 — Konto ist nicht Inhaber und der User-Zustand trägt Geschäftsdaten: er bleibt liegen. */
  | { action: 'kept_user' };

function parseState(raw: string | null): AppPersistedState | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AppPersistedState;
  } catch {
    return null;
  }
}

/** Echte Firmendaten liegen vor, wenn Setup abgeschlossen ist oder ein Name gesetzt wurde. */
function hasRealCompanyData(state: AppPersistedState | null): boolean {
  if (!state) return false;
  const setup = state.setup;
  const profileName = state.companyProfile?.companyName?.trim() ?? '';
  return Boolean(setup?.setupComplete || setup?.companyName?.trim() || profileName);
}

function sameCompany(a: AppPersistedState, b: AppPersistedState): boolean {
  const nameA = (a.setup?.companyName ?? a.companyProfile?.companyName ?? '').trim();
  const nameB = (b.setup?.companyName ?? b.companyProfile?.companyName ?? '').trim();
  return nameA !== '' && nameA === nameB;
}

/** DOKUMENTE-01 N1 — trägt der Zustand Geschäftsdaten, nicht nur Einrichtung und Serveridentität? */
function hasBusinessEntities(state: AppPersistedState): boolean {
  const memory = state.officePilotMemory;
  return [
    state.documents,
    state.inboxItems,
    state.vorgaenge,
    state.tasks,
    state.invoiceEntries,
    state.uploadedDocuments,
    state.documentFileRefs,
    state.documentWorkResults,
    state.expenses,
    state.customers,
    state.vorgangNotes,
    state.businessLetters,
    state.offers,
    state.orderDrafts,
    state.invoiceDrafts,
    state.bankTransactions,
    state.communicationHistory,
    state.knowledgeFacts,
    state.employees,
    state.employeePayments,
    state.mailImports,
    memory?.documentMemories,
    memory?.proofMemories,
    memory?.paperRegisterEntries,
  ].some((list) => Array.isArray(list) && list.length > 0);
}

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B/01C — früher wurde die User-Kopie gelöscht,
 * sobald ein Workspace-Schlüssel existierte; ein leerer Workspace-Eintrag hat so
 * vollständige Firmendaten vernichtet.
 *
 * Jetzt gilt: nie ohne Ersatz löschen, den Workspace-Zustand nicht blind
 * überschreiben (Workspace- und Serveridentität bleiben erhalten) und bei zwei
 * echten, unterschiedlichen Beständen nichts anfassen.
 */
export function migrateUserScopeToWorkspaceScope(
  userId: string,
  workspaceId: string,
  /**
   * DOKUMENTE-01 N1 — der Nutzerbereich gehört genau diesem Konto: Ziel ist sein
   * Kontobestand, nicht der gemeinsame Betriebsschlüssel. Ohne Konto (alte Aufrufer,
   * Tests) bleibt es beim bisherigen Ziel.
   */
  account?: StorageAccount,
  /** DOKUMENTE-01 N1 — Inhaber des Betriebs laut Server; unbekannt heißt: nicht Inhaber. */
  ownerUserId?: string,
): UserScopeMigrationResult {
  const userKey = buildStorageKey({ type: 'user', userId });
  const workspaceKey = buildStorageKey(
    account ? { type: 'workspace', workspaceId, account } : { type: 'workspace', workspaceId, account: null },
  );

  const userRaw = readRawStorage(userKey);
  if (!userRaw) return { action: 'none' };

  const workspaceRaw = readRawStorage(workspaceKey);

  /*
   * DOKUMENTE-01 N1 — vor der Kontotrennung wanderte hier immer der Nutzerbereich
   * des Inhabers. Ein anderes Konto (Admin, Mitglied) bringt nur seine
   * Serveridentität aus der Provisionierung mit. Geschäftsdaten in seinem
   * Nutzerbereich (etwa ein alter globaler Bestand dieses Geräts oder ein eigener
   * früherer Betrieb) gehören nicht in diesen Betrieb. Sie bleiben unverändert
   * liegen, und auch die Einrichtung des Kontobestands wird nicht überschrieben.
   */
  if (account && account.userId !== ownerUserId) {
    const ownState = parseState(userRaw);
    if (!ownState || hasBusinessEntities(ownState)) return { action: 'kept_user' };
    if (workspaceRaw) return { action: 'kept_workspace' };
  }

  if (!workspaceRaw) {
    if (!writeAndVerify(workspaceKey, userRaw)) return { action: 'write_failed' };
    removeRawStorage(userKey);
    return { action: 'moved' };
  }

  const userState = parseState(userRaw);
  const workspaceState = parseState(workspaceRaw);
  if (!userState || !workspaceState) return { action: 'write_failed' };

  const userHasData = hasRealCompanyData(userState);
  const workspaceHasData = hasRealCompanyData(workspaceState);

  if (!userHasData) return { action: 'kept_workspace' };
  if (workspaceHasData && !sameCompany(userState, workspaceState)) {
    // Zwei echte, widersprüchliche Bestände: nichts überschreiben, nichts löschen.
    return { action: 'conflict' };
  }
  if (workspaceHasData) return { action: 'kept_workspace' };

  /**
   * Der Workspace-Eintrag ist leer: nur die Firmendaten übernehmen. Workspace,
   * Mitglieder, Einstellungen und der Sync-Client (serverWorkspaceId) bleiben,
   * damit die Serveridentität nicht verloren geht.
   */
  const merged: AppPersistedState = {
    ...workspaceState,
    setup: userState.setup,
    companyProfile: userState.companyProfile ?? workspaceState.companyProfile,
    savedAt: new Date().toISOString(),
  };

  if (!writeAndVerify(workspaceKey, JSON.stringify(merged))) return { action: 'write_failed' };
  // Die User-Kopie bleibt: sie kann weitere Bestände tragen, die hier nicht wandern.
  return { action: 'merged' };
}

/** Schreibt und liest zurück; erst danach gilt ein Zielzustand als gesichert. */
function writeAndVerify(key: string, raw: string): boolean {
  try {
    writeRawStorage(key, raw);
  } catch {
    return false;
  }
  return readRawStorage(key) === raw;
}
