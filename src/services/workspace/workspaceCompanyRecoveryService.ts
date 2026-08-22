/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02B — bestätigte Übernahme der lokalen
 * Firmendaten in denselben Workspace.
 *
 * Genau zwei Entitäten, genau die gerade gelesenen Serverversionen, keine
 * Vorab-Erhöhung lokaler Sync-Meta, kein zweites ensure_personal_workspace,
 * niemals inbox_item. Dokumente, Dateireferenzen und IndexedDB bleiben
 * unberührt. Es wird keine zweite Sync-Architektur gebaut: der Upsert läuft
 * über dieselbe RPC-Funktion wie der reguläre Push.
 */
import {
  buildCompanyProfileCloudPayload,
  buildCompanySetupCloudPayload,
  rpcPullWorkspaceSyncState,
  rpcUpsertWorkspaceSyncEntity,
} from './workspaceCloudService';
import {
  buildCloudCompanySnapshot,
  readLocalCompanyCandidate,
  normalizeCompanyName,
  type CompanyConflictInfo,
} from './workspaceCompanyConflictService';

export type CompanyRecoveryOutcome =
  | { status: 'applied'; setupRowVersion: number; profileRowVersion: number }
  | {
      status: 'partial';
      setupRowVersion?: number;
      profileRowVersion?: number;
      failed: string[];
      persistFailed?: boolean;
    }
  | { status: 'changed'; conflict: CompanyConflictInfo }
  | { status: 'failed'; message?: string };

export interface CompanyRecoveryInput {
  workspaceId: string;
  /** Firmenname und Speicherzeitpunkt, wie sie dem Nutzer angezeigt wurden. */
  confirmedCompanyName: string;
  confirmedSavedAt?: string;
  /** Cloud-Versionen, die dem Nutzer angezeigt wurden. */
  confirmedCloudSetupRowVersion: number;
  confirmedCloudProfileRowVersion: number;
  /** Cloud-Firmenname, wie er angezeigt wurde — Rückfall bei fehlgeschlagenem Kontroll-Pull. */
  confirmedCloudCompanyName?: string;
  /** Vollständiger Rohtext, wie er beim Anzeigen des Konflikts galt. */
  confirmedRawText: string;
  /** Bereits erfolgreich übertragene Entitäten dieses Vorgangs samt Serverversion. */
  alreadyApplied?: { setupRowVersion?: number; profileRowVersion?: number };
}

/**
 * Schreibt den Erfolg in den gespeicherten Workspace-Zustand: betroffene
 * Outbox-Einträge auf completed, Sync-Meta auf die Serverantwort. Nur diese
 * Felder werden angefasst — Dokumente, Refs, Inbox und alles Übrige bleiben
 * unverändert, und es wird kein Scope gewechselt.
 */
function finalizeWorkspaceScopeAfterRecovery(
  storageKey: string,
  applied: { setupRowVersion?: number; profileRowVersion?: number },
): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    return false;
  }
  if (!raw) return false;

  try {
    const state = JSON.parse(raw) as Record<string, unknown>;
    const outbox = Array.isArray(state.syncOutbox) ? (state.syncOutbox as Record<string, unknown>[]) : [];
    const nowIso = new Date().toISOString();

    state.syncOutbox = outbox.map((entry) => {
      const entityType = entry.entityType;
      const done =
        (entityType === 'company_setup' && applied.setupRowVersion !== undefined) ||
        (entityType === 'company_profile' && applied.profileRowVersion !== undefined);
      return done ? { ...entry, status: 'completed' } : entry;
    });

    if (applied.setupRowVersion !== undefined && state.setupSync && typeof state.setupSync === 'object') {
      state.setupSync = { ...(state.setupSync as object), version: applied.setupRowVersion, updatedAt: nowIso };
    }
    if (
      applied.profileRowVersion !== undefined &&
      state.companyProfileSync &&
      typeof state.companyProfileSync === 'object'
    ) {
      state.companyProfileSync = {
        ...(state.companyProfileSync as object),
        version: applied.profileRowVersion,
        updatedAt: nowIso,
      };
    }

    const serialized = JSON.stringify(state);
    localStorage.setItem(storageKey, serialized);
    // Erst nach erfolgreichem Rücklesen gilt die Verbuchung als gesichert.
    return localStorage.getItem(storageKey) === serialized;
  } catch {
    // Fehler wird nicht verschluckt: der Aufrufer meldet ihn sichtbar.
    return false;
  }
}

/**
 * Prüft unmittelbar vor dem Push erneut lokal und in der Cloud. Hat sich etwas
 * verschoben, wird nichts gesendet und der neue Stand zurückgemeldet.
 */
export async function applyConfirmedLocalCompany(
  input: CompanyRecoveryInput,
): Promise<CompanyRecoveryOutcome> {
  const candidate = readLocalCompanyCandidate(input.workspaceId);
  if (!candidate) return { status: 'failed', message: 'local_candidate_missing' };

  /**
   * OFFICEPILOT-…-02B-K2 — ein bereits erfolgreicher Serverstand wird zuerst
   * lokal verbucht. Erst wenn das zurückgelesen werden konnte, darf die nächste
   * Entität überhaupt gesendet werden.
   */
  const pending = input.alreadyApplied ?? {};
  const hasPendingProgress =
    typeof pending.setupRowVersion === 'number' || typeof pending.profileRowVersion === 'number';

  /**
   * OFFICEPILOT-…-02B-K1 — der bestätigte Stand ist exakt gebunden: jede
   * Änderung am Rohtext (Setup, Profil, savedAt, Outbox, Dokumente) führt zu
   * 'changed' und zu null Upserts.
   */
  if (candidate.rawText !== input.confirmedRawText) {
    // Echten Cloud-Stand nachlesen, damit keine leeren Platzhalter erscheinen.
    // Kein erfundener Leerwert: ohne frische Antwort gilt der bestätigte Stand.
    let freshCloud = {
      setupCompanyName: input.confirmedCloudCompanyName ?? '',
      profileCompanyName: input.confirmedCloudCompanyName ?? '',
      setupRowVersion: input.confirmedCloudSetupRowVersion,
      companyProfileRowVersion: input.confirmedCloudProfileRowVersion,
    };
    try {
      freshCloud = buildCloudCompanySnapshot(await rpcPullWorkspaceSyncState(input.workspaceId));
    } catch {
      // Ohne Cloud-Antwort bleiben die zuletzt bekannten Werte stehen.
    }
    return {
      status: 'changed',
      conflict: buildConflictInfo(candidate, freshCloud, input.workspaceId),
    };
  }

  if (
    normalizeCompanyName(candidate.companyName) !== normalizeCompanyName(input.confirmedCompanyName)
  ) {
    return { status: 'failed', message: 'local_changed' };
  }

  /**
   * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02B-K2 — ein bereits erfolgreicher
   * Serverstand wird zuerst lokal verbucht. Erst wenn das zurückgelesen werden
   * konnte, darf die nächste Entität überhaupt gesendet werden. Die Prüfung des
   * gebundenen Rohtexts steht bewusst davor, damit der eigene Schreibvorgang
   * nicht als fremde Änderung gilt.
   */
  if (hasPendingProgress && !finalizeWorkspaceScopeAfterRecovery(candidate.storageKey, pending)) {
    return { status: 'partial', ...pending, failed: [], persistFailed: true };
  }

  let pull;
  try {
    pull = await rpcPullWorkspaceSyncState(input.workspaceId);
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : 'pull_failed' };
  }

  const cloud = buildCloudCompanySnapshot(pull);
  const alreadyApplied = input.alreadyApplied ?? {};
  const setupDone = typeof alreadyApplied.setupRowVersion === 'number';
  const profileDone = typeof alreadyApplied.profileRowVersion === 'number';

  /**
   * Hat sich der Cloud-Stand seit der Anzeige verändert, wird nichts gesendet.
   * Die bereits in diesem Vorgang übertragene Entität ist davon ausgenommen —
   * ihre höhere Version stammt aus dem eigenen erfolgreichen Upsert.
   */
  const setupMoved = !setupDone && cloud.setupRowVersion !== input.confirmedCloudSetupRowVersion;
  const profileMoved =
    !profileDone && cloud.companyProfileRowVersion !== input.confirmedCloudProfileRowVersion;
  if (setupMoved || profileMoved) {
    return {
      status: 'changed',
      conflict: {
        localCompanyName: candidate.companyName || candidate.profileCompanyName,
        cloudCompanyName: cloud.setupCompanyName || cloud.profileCompanyName,
        localSavedAt: candidate.savedAt,
        localSetupComplete: candidate.setupComplete,
        cloudSetupRowVersion: cloud.setupRowVersion,
        cloudProfileRowVersion: cloud.companyProfileRowVersion,
        workspaceId: input.workspaceId,
        storageKey: candidate.storageKey,
      },
    };
  }

  /**
   * Serverversionen müssen positive ganze Zahlen sein — p_row_version 0 würde
   * die Konfliktprüfung im SQL überspringen und darf nie gesendet werden.
   */
  const needsSetup = !setupDone;
  const needsProfile = !profileDone && Boolean(candidate.state.companyProfile);
  if (
    (needsSetup && !isUsableRowVersion(cloud.setupRowVersion)) ||
    (needsProfile && !isUsableRowVersion(cloud.companyProfileRowVersion))
  ) {
    return { status: 'failed', message: 'invalid_row_version' };
  }

  const results: { setupRowVersion?: number; profileRowVersion?: number } = {
    setupRowVersion: alreadyApplied.setupRowVersion,
    profileRowVersion: alreadyApplied.profileRowVersion,
  };
  const failed: string[] = [];

  if (needsSetup) {
    try {
      const pushed = await rpcUpsertWorkspaceSyncEntity(
        input.workspaceId,
        'company_setup',
        buildCompanySetupCloudPayload(candidate.state.setup),
        cloud.setupRowVersion,
      );
      if (!isUsableRowVersion(pushed.rowVersion)) {
        // Ungültige Antwort gilt nicht als Erfolg: nichts verbuchen, nichts weiter senden.
        return {
          status: 'partial',
          ...results,
          failed: ['company_setup'],
        };
      }
      results.setupRowVersion = pushed.rowVersion;
      if (!finalizeWorkspaceScopeAfterRecovery(candidate.storageKey, results)) {
        // Servererfolg steht, lokale Verbuchung nicht: hier abbrechen.
        return { status: 'partial', ...results, failed, persistFailed: true };
      }
    } catch {
      failed.push('company_setup');
    }
  }

  if (needsProfile) {
    try {
      const pushed = await rpcUpsertWorkspaceSyncEntity(
        input.workspaceId,
        'company_profile',
        buildCompanyProfileCloudPayload(candidate.state.companyProfile!),
        cloud.companyProfileRowVersion,
      );
      if (!isUsableRowVersion(pushed.rowVersion)) {
        /**
         * Der Setup-Fortschritt bleibt erhalten: er wurde bereits verbucht und
         * darf beim nächsten Versuch nicht erneut gesendet werden.
         */
        return {
          status: 'partial',
          ...results,
          failed: ['company_profile'],
        };
      }
      results.profileRowVersion = pushed.rowVersion;
    } catch {
      failed.push('company_profile');
    }
  }

  const persisted = finalizeWorkspaceScopeAfterRecovery(candidate.storageKey, results);

  if (failed.length > 0 || !persisted) {
    return {
      status: 'partial',
      ...results,
      failed,
      ...(persisted ? {} : { persistFailed: true }),
    };
  }

  return {
    status: 'applied',
    setupRowVersion: results.setupRowVersion ?? cloud.setupRowVersion,
    profileRowVersion: results.profileRowVersion ?? cloud.companyProfileRowVersion,
  };
}

function isUsableRowVersion(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function buildConflictInfo(
  candidate: { companyName: string; profileCompanyName: string; savedAt?: string; setupComplete: boolean; storageKey: string },
  cloud: { setupCompanyName: string; profileCompanyName: string; setupRowVersion: number; companyProfileRowVersion: number },
  workspaceId: string,
): CompanyConflictInfo {
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
