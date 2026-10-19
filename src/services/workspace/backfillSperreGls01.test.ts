/**
 * GO-LIVE-SECURITY-01 / KONTOSPERRE — automatische Nachmelde- und Backfill-Wege reihen
 * keine endgültig abgewiesene Aktion erneut ein.
 *
 * WEISS-Befund: In `workspaceProvisioningService.ts` meldeten drei automatische Wege nach dem
 * Entsperren ohne neue Benutzeraktion erneut einen Auftrag an, obwohl derselbe Auftrag zuvor
 * endgültig wegen fehlender Berechtigung abgewiesen war:
 *   - Betriebsdaten (`company_setup`, die Cloud kennt kein Setup),
 *   - Firmenprofil (`company_profile`, die Cloud kennt kein Profil),
 *   - Vorgänge (`vorgang`, die Cloud kennt keinen Vorgang).
 *
 * Geprüft mit den echten Modulen (mergeRemoteWorkspacePullIntoState, SupabaseSyncAdapter, RPC gemockt):
 *   W1–W3  der WEISS-Befund je Weg (Abgleich nach dem Entsperren reiht nichts neu ein; zulässiger
 *          Backfill anderer Vorgänge bleibt),
 *   U1–U5  Unterscheidung: Netzwerkfehler und Lizenzabweisung bleiben wiederholbar, eine bewusste
 *          neue Aktion löst die alte Abweisung ab und geht durch,
 *   A1–A3  vollständiger Ablauf je Weg: Sperren → Aktion abgewiesen → Entsperren → automatischer
 *          Abgleich → kein neuer Auftrag → bewusste neue Aktion → erfolgreich,
 *   V1     Vertrag über das ganze Repository: automatische Wege nutzen nur den gesperrten
 *          Einreihungsweg; der ungesperrte bleibt bewussten Nutzeraktionen vorbehalten.
 *
 * Kein Netzwerk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { AppPersistedState, Vorgang } from '../../types/models';
import type { SyncEntityType, SyncOutboxEntry } from '../../types/sync';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { applyStateToStores, buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { mergeRemoteWorkspacePullIntoState } from './workspaceProvisioningService';
import * as workspaceCloudService from './workspaceCloudService';
import { WorkspaceCloudError } from './workspaceCloudService';
import {
  enqueueBackfillSyncOutbox,
  enqueueSyncOutbox,
  getSyncOutboxSnapshot,
  hasFinallyDeniedOutboxEntry,
  resetSyncOutboxForTests,
} from '../sync/syncOutboxService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { resetSyncChangeTrackerForTests, resetSyncChangeTrackerFromState } from '../sync/syncChangeTrackerService';
import { SupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import * as supabaseLib from '../../lib/supabase';

const WS = 'ws-backfill-sperre';
const DEVICE = 'device-backfill-sperre';
const GESPERRT = 'Kein Zugriff auf Workspace';
const LIZENZ = 'finance_license_expired: Lizenz ist abgelaufen';
const BETRIEB = 'Beispiel Sperrbetrieb GmbH';

function eintrag(
  entityType: SyncEntityType,
  entityId: string,
  overrides: Partial<SyncOutboxEntry> = {},
): SyncOutboxEntry {
  return {
    id: `out-${entityType}-${entityId}`,
    entityType,
    entityId,
    operation: 'create',
    version: 1,
    queuedAt: '2026-10-11T08:00:00.000Z',
    retryCount: 1,
    status: 'failed',
    lastErrorMessage: GESPERRT,
    lastErrorAt: '2026-10-11T08:00:05.000Z',
    lastErrorRetryable: false,
    ...overrides,
  };
}

function vorgang(id: string, title: string): Vorgang {
  return { ...createTestVorgang({ id }), title } as Vorgang;
}

/** Ein echter lokaler Betrieb: Setup, Profil, zwei Vorgänge — die Cloud kennt noch nichts davon. */
function lokalerBetrieb(): AppPersistedState {
  return {
    ...buildPersistedStateSnapshot(),
    setup: { ...DEFAULT_SETUP, companyName: BETRIEB, industry: 'Sanitär', taxStatus: 'kleinunternehmer_19', setupComplete: true, setupVersion: 1 },
    companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: BETRIEB, street: 'Musterweg 5', iban: 'DE89370400440532013000' },
    vorgaenge: [vorgang('vorgang-sperre-1', 'Badsanierung Sperrprobe'), vorgang('vorgang-sperre-2', 'Heizung Altbestand')],
    syncClient: { ...createSyncClient(), deviceId: DEVICE, workspaceId: WS, serverWorkspaceId: WS, syncPolicy: 'cloud_ready' },
  } as AppPersistedState;
}

/** Abzug einer Cloud, die (noch) weder Setup noch Profil noch Vorgänge kennt. */
function leererAbzug() {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: [],
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

/** Einen Abzug übernehmen wie die App (Speicher setzen, Vergleichsbasis neu legen). */
function abgleichen(): void {
  const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), leererAbzug());
  applyStateToStores({ ...merged.state, syncOutbox: getSyncOutboxSnapshot() });
  resetSyncChangeTrackerFromState(buildPersistedStateSnapshot());
}

const offen = (entityType: SyncEntityType, entityId?: string) =>
  getSyncOutboxSnapshot().filter(
    (entry) =>
      entry.entityType === entityType &&
      (entityId === undefined || entry.entityId === entityId) &&
      (entry.status === 'pending' || entry.status === 'error' || entry.status === 'blocked'),
  );

beforeEach(() => {
  localStorage.clear();
  resetTestStores();
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WS, serverWorkspaceId: WS, syncPolicy: 'cloud_ready' });
  applyStateToStores(lokalerBetrieb());
  resetSyncChangeTrackerFromState(buildPersistedStateSnapshot());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* W — der WEISS-Befund, je Weg                                        */
/* ------------------------------------------------------------------ */

describe('W — der Abgleich nach dem Entsperren reiht keine endgültig abgewiesene Aktion neu ein', () => {
  it('W1 Betriebsdaten: die Cloud kennt kein Setup — kein neuer company_setup-Auftrag', () => {
    resetSyncOutboxForTests([eintrag('company_setup', WS)]);
    abgleichen();
    expect(offen('company_setup')).toEqual([]);
    expect(getSyncOutboxSnapshot().find((entry) => entry.entityType === 'company_setup')?.status).toBe('failed');
  });

  it('W2 Firmenprofil: die Cloud kennt kein Profil — kein neuer company_profile-Auftrag', () => {
    resetSyncOutboxForTests([eintrag('company_profile', WS)]);
    abgleichen();
    expect(offen('company_profile')).toEqual([]);
    expect(getSyncOutboxSnapshot().find((entry) => entry.entityType === 'company_profile')?.status).toBe('failed');
  });

  it('W3 Vorgänge: die Cloud kennt keinen Vorgang — der abgewiesene bleibt draußen, der zulässige wird nachgemeldet', () => {
    resetSyncOutboxForTests([eintrag('vorgang', 'vorgang-sperre-1')]);
    abgleichen();
    expect(offen('vorgang', 'vorgang-sperre-1')).toEqual([]);
    expect(offen('vorgang', 'vorgang-sperre-2')).toEqual([expect.objectContaining({ operation: 'create', status: 'pending' })]);
  });

  it('W4 auch eine abgewiesene Änderung oder Löschung wird nicht wiederbelebt (Fehlertext account_blocked)', () => {
    resetSyncOutboxForTests([
      eintrag('company_profile', WS, { operation: 'update', lastErrorMessage: 'account_blocked: Konto ist gesperrt' }),
      eintrag('vorgang', 'vorgang-sperre-1', { operation: 'delete', lastErrorMessage: 'Keine Schreibberechtigung' }),
    ]);
    abgleichen();
    expect(offen('company_profile')).toEqual([]);
    expect(offen('vorgang', 'vorgang-sperre-1')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* U — Unterscheidung                                                  */
/* ------------------------------------------------------------------ */

describe('U — Netzwerkfehler, Lizenz und bewusste Aktion bleiben, wie sie sind', () => {
  it('U1 ein vorübergehender Netzwerkfehler bleibt sendbar; der Nachmeldeweg hält ihn offen', () => {
    resetSyncOutboxForTests([eintrag('company_profile', WS, { status: 'error', lastErrorMessage: 'Failed to fetch', lastErrorRetryable: true })]);
    abgleichen();
    expect(offen('company_profile')).toEqual([expect.objectContaining({ status: 'pending' })]);
  });

  it('U2 eine Lizenzabweisung bleibt wie vereinbart wiederholbar (nach Lizenzverlängerung)', () => {
    resetSyncOutboxForTests([eintrag('vorgang', 'vorgang-sperre-1', { status: 'error', lastErrorMessage: LIZENZ, lastErrorRetryable: true })]);
    abgleichen();
    expect(offen('vorgang', 'vorgang-sperre-1')).toEqual([expect.objectContaining({ status: 'pending' })]);
  });

  it('U3 eine bewusste neue Aktion löst die alte Abweisung ab: neuer Auftrag, alter erledigt', () => {
    const alt = eintrag('company_profile', WS);
    resetSyncOutboxForTests([alt]);
    const neu = enqueueSyncOutbox({ entityType: 'company_profile', entityId: WS, operation: 'update', version: 1 });
    expect(neu.id).not.toBe(alt.id);
    expect(neu.status).toBe('pending');
    expect(getSyncOutboxSnapshot().find((entry) => entry.id === alt.id)?.status).toBe('completed');
    expect(hasFinallyDeniedOutboxEntry('company_profile', WS)).toBe(false);
  });

  it('U4 die Sperre gilt nur, solange die Abweisung das letzte Wort ist', () => {
    const alt = eintrag('vorgang', 'vorgang-sperre-1');
    resetSyncOutboxForTests([alt]);
    expect(hasFinallyDeniedOutboxEntry('vorgang', 'vorgang-sperre-1')).toBe(true);
    expect(enqueueBackfillSyncOutbox({ entityType: 'vorgang', entityId: 'vorgang-sperre-1', operation: 'create', version: 1 })).toBeNull();
    // Ein neuerer offener Auftrag (bewusste Aktion) darf von automatischen Wegen weiter angepasst werden
    // — etwa durch die Wiederaufnahme nach verlorener Bestätigung.
    const neuer = eintrag('vorgang', 'vorgang-sperre-1', { id: 'out-neu', status: 'pending', queuedAt: '2026-10-11T09:00:00.000Z', lastErrorMessage: undefined, lastErrorRetryable: undefined });
    resetSyncOutboxForTests([neuer, alt]);
    expect(hasFinallyDeniedOutboxEntry('vorgang', 'vorgang-sperre-1')).toBe(false);
    expect(enqueueBackfillSyncOutbox({ entityType: 'vorgang', entityId: 'vorgang-sperre-1', operation: 'update', version: 2 })?.id).toBe('out-neu');
  });

  it('U5 Lizenz- und Netzwerkfehler sperren keinen automatischen Weg', () => {
    resetSyncOutboxForTests([
      eintrag('company_setup', WS, { status: 'error', lastErrorMessage: LIZENZ, lastErrorRetryable: true }),
      eintrag('vorgang', 'vorgang-sperre-1', { status: 'failed', lastErrorMessage: 'Failed to fetch' }),
    ]);
    expect(hasFinallyDeniedOutboxEntry('company_setup', WS)).toBe(false);
    expect(hasFinallyDeniedOutboxEntry('vorgang', 'vorgang-sperre-1')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* A — vollständiger Ablauf am echten Sendeweg                        */
/* ------------------------------------------------------------------ */

function server() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  const upsert = vi.spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity');
  const adapter = new SupabaseSyncAdapter(null);
  vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue({});
  return {
    upsert,
    /** Upserts genau dieser Entität (Typ + Kennung im Aufruf); andere, zulässige Nachmeldungen zählen nicht. */
    aufrufe: (entityType: SyncEntityType, entityId: string) =>
      upsert.mock.calls.filter((call) => call[1] === entityType && JSON.stringify(call).includes(entityId)),
    gesperrt() {
      upsert.mockRejectedValue(new WorkspaceCloudError(GESPERRT, 'rls', false));
    },
    frei() {
      upsert.mockImplementation(async () => ({ rowVersion: 1, payload: {}, entityId: null, deduped: false }));
    },
    async lauf() {
      persistAll();
      return adapter.pushChanges({ deviceId: DEVICE, workspaceId: WS, state: buildPersistedStateSnapshot(), outbox: getSyncOutboxSnapshot() });
    },
  };
}

const ABLAEUFE: { name: string; entityType: SyncEntityType; entityId: string }[] = [
  { name: 'A1 Betriebsdaten', entityType: 'company_setup', entityId: WS },
  { name: 'A2 Firmenprofil', entityType: 'company_profile', entityId: WS },
  { name: 'A3 Vorgang', entityType: 'vorgang', entityId: 'vorgang-sperre-1' },
];

describe('A — Sperren → abgewiesen → Entsperren → Abgleich → kein neuer Auftrag → bewusste Aktion → erfolgreich', () => {
  for (const ablauf of ABLAEUFE) {
    it(`${ablauf.name}`, async () => {
      const s = server();
      // Die Aktion (wie vom Änderungsverfolger eingereiht) — nur dieser eine Auftrag liegt an.
      resetSyncOutboxForTests([]);
      const aktion = enqueueSyncOutbox({ entityType: ablauf.entityType, entityId: ablauf.entityId, operation: 'create', version: 1 });

      // Sperre: endgültig abgewiesen.
      s.gesperrt();
      await s.lauf();
      expect(getSyncOutboxSnapshot().find((entry) => entry.id === aktion.id)).toMatchObject({ status: 'failed', lastErrorMessage: GESPERRT });
      expect(s.aufrufe(ablauf.entityType, ablauf.entityId)).toHaveLength(1);

      // Entsperrt: automatischer Abgleich (Cloud kennt nichts) und automatische Läufe — kein neuer Auftrag, kein Versand.
      s.frei();
      abgleichen();
      expect(offen(ablauf.entityType, ablauf.entityId)).toEqual([]);
      await s.lauf();
      await s.lauf();
      expect(s.aufrufe(ablauf.entityType, ablauf.entityId)).toHaveLength(1);

      // Bewusste neue Aktion: neuer Auftrag, er geht durch.
      const neu = enqueueSyncOutbox({ entityType: ablauf.entityType, entityId: ablauf.entityId, operation: 'update', version: 1 });
      expect(neu.id).not.toBe(aktion.id);
      const ergebnis = await s.lauf();
      expect(ergebnis.completedOutboxIds).toContain(neu.id);
      expect(s.aufrufe(ablauf.entityType, ablauf.entityId)).toHaveLength(2);
    });
  }
});

/* ------------------------------------------------------------------ */
/* V — Vertrag über das ganze Repository                               */
/* ------------------------------------------------------------------ */

/**
 * Der ungesperrte Einreihungsweg `enqueueSyncOutbox` ist bewussten Nutzeraktionen vorbehalten
 * (Änderungsverfolger nach einer lokalen Änderung, Fachdienste hinter einem Klick, „Meine Fassung
 * behalten"). Jeder automatische Weg — Abgleich, Backfill, Nachmeldung, Wiederaufnahme — nimmt
 * `enqueueBackfillSyncOutbox`. Neue Aufrufstellen müssen hier bewusst eingetragen werden.
 */
const BEWUSSTE_AUFRUFSTELLEN: Record<string, number> = {
  'src/services/sync/syncChangeTrackerService.ts': 1,
  'src/services/accounting/accountingAssignmentService.ts': 1,
  'src/services/accounting/accountingPeriodService.ts': 1,
  'src/services/accounting/accountingSettingsService.ts': 1,
  'src/services/employee/employeePaymentService.ts': 1,
  'src/services/employee/employeeService.ts': 1,
  'src/services/expensePaymentService.ts': 3,
  'src/services/order/orderDraftService.ts': 1,
  'src/services/orderAmendmentService.ts': 1,
  // FINANZ-CORE-01A (INV-10) — einzige automatische Ausnahme, bewusst eng: der Archivverweis einer
  // freigegebenen Angebotskopie, die der Abgleich als verlustbehaftet erkannt und durch den Serverbeleg ersetzt
  // hat, wird genau einmal neu gesendet (löst die endgültige Abweisung des alten Auftrags ab). Andere
  // abgewiesene Aktionen holt kein automatischer Weg nach (inventurPaket3Fc01a A3–A5).
  'src/services/workspace/workspaceProvisioningService.ts': 1,
  // Definition und der gesperrte Weg selbst; dazu FINANZ-CORE-01A (Bericht 20) „Bewusst erneut senden“
  // (`resendFinallyDeniedOutboxEntry`, nur vom Knopf der Sync-Seite über `resendFinallyDeniedEntryFromUi` erreichbar):
  // eine bewusste Nutzeraktion, die eine endgültige Abweisung einer Mitarbeiterzahlung/Kontierung ablöst.
  'src/services/sync/syncOutboxService.ts': 2,
};

function quelltexte(dir: string, liste: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const voll = path.join(dir, name);
    if (fs.statSync(voll).isDirectory()) {
      if (name === 'test' || name === 'testWorld' || name === 'node_modules') continue;
      quelltexte(voll, liste);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      liste.push(voll);
    }
  }
  return liste;
}

describe('V — Vertrag: automatische Wege nehmen nur den gesperrten Einreihungsweg', () => {
  it('V1 ungesperrtes enqueueSyncOutbox( nur an den bewussten Aufrufstellen', () => {
    const wurzel = path.join(process.cwd(), 'src');
    const gefunden: Record<string, number> = {};
    for (const datei of quelltexte(wurzel)) {
      const text = fs.readFileSync(datei, 'utf8');
      const anzahl = (text.match(/\benqueueSyncOutbox\(/g) ?? []).length;
      if (anzahl > 0) gefunden[path.relative(process.cwd(), datei).split(path.sep).join('/')] = anzahl;
    }
    expect(gefunden).toEqual(BEWUSSTE_AUFRUFSTELLEN);
    // Eigene Zeitgrenze: V1 liest jede Quelldatei unter src (ohne Cache, neben anderen Dateien im Satz bis 6,5 s;
    // einzeln 2,7 s). Eine Zeitüberschreitung hier sagt nichts über den Vertrag aus — die Zusicherung bleibt dieselbe.
  }, 30_000);

  it('V2 die bekannten automatischen Wege nutzen den gesperrten Einreihungsweg', () => {
    const lies = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
    const provisioning = lies('src/services/workspace/workspaceProvisioningService.ts');
    // 15 Backfill-Schleifen + Betriebsdaten + Firmenprofil + Vorgänge + Wiederaufnahme nach verlorener Bestätigung.
    expect((provisioning.match(/\benqueueBackfillSyncOutbox\(/g) ?? []).length).toBe(19);
    expect(lies('src/services/sync/supabaseSyncAdapter.ts')).toMatch(/\benqueueBackfillSyncOutbox\(/);
    expect(lies('src/services/document/intakeCloudBackfillService.ts')).toMatch(/\benqueueBackfillSyncOutbox\(/);
  });
});
