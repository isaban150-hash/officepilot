/**
 * EINRICHTUNG-01 (AP0, EIN-15; E6 vorgezogen für S-15.3) — Setup-Spiegel und Sprachwahl.
 *
 *   S-15.1  Firmenname und Steuerstatus ändern, dann die Sprache wechseln: Der Spiegel behält die neuen
 *           Werte, der zu synchronisierende `company_setup` trägt sie; nichts Altes wird zurückgeschrieben.
 *   S-15.2  Dasselbe nach einem Neuladen.
 *   S-15.3  Ein Mitglied wechselt die Sprache: kein `company_setup`-Auftrag, keine Firmenmutation.
 *
 * Gemessen an Produktionsfunktionen (Kontext, Speicher, Change-Tracker); kein Netz.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider, useApp } from './AppContext';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  getCachedSetup,
  persistAll,
} from '../services/persistenceService';
import { getActiveStorageKey, setActiveStorageScope } from '../services/storage/storageScopeService';
import { resetSyncChangeTrackerForTests } from '../services/sync/syncChangeTrackerService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../services/sync/syncOutboxService';
import { createSyncClient } from '../services/sync/syncClientService';
import { resetSyncCoordinatorForTests } from '../services/sync/syncCoordinator';
import { STORAGE_VERSION } from '../services/sync/syncMigrationService';
import { PERSONAL_UI_LANGUAGE_KEY_PREFIX } from '../services/auth/personalUiLanguage';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { resetTestStores } from '../test/resetStores';
import type { AppPersistedState } from '../types/models';

const WORKSPACE_ID = 'ws-ein01-spiegel';

function ausgangsstand(): AppPersistedState {
  return {
    version: STORAGE_VERSION,
    syncClient: { ...createSyncClient(), serverWorkspaceId: WORKSPACE_ID, workspaceId: WORKSPACE_ID },
    syncOutbox: [],
    setup: { ...DEFAULT_SETUP, companyName: 'Alt GmbH', taxStatus: 'standard_19', language: 'de', setupComplete: true, setupVersion: 1 },
    companyProfile: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Alt GmbH',
      defaultTaxStatus: 'standard_19',
      street: 'Musterstrasse 5',
      zip: '33602',
      city: 'Bielefeld',
    },
    setupSync: { version: 3, updatedAt: '2026-10-01T08:00:00.000Z', deleted: false, deviceId: 'd', workspaceId: WORKSPACE_ID },
    companyProfileSync: { version: 4, updatedAt: '2026-10-01T08:00:00.000Z', deleted: false, deviceId: 'd', workspaceId: WORKSPACE_ID },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    savedAt: '2026-10-01T08:00:00.000Z',
  } as unknown as AppPersistedState;
}

type Ctx = ReturnType<typeof useApp>;
let ctx: Ctx | null = null;
function Probe() {
  ctx = useApp();
  return <span data-testid="sprache">{ctx.language}</span>;
}

let container: HTMLDivElement;
let root: Root | null = null;

async function starte(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <AppProvider initialSetup={getCachedSetup()}>
        <Probe />
      </AppProvider>,
    );
  });
}

async function beende(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
}

function firmenauftraege(typ: 'company_setup' | 'company_profile') {
  return getSyncOutboxSnapshot().filter((entry) => entry.entityType === typ);
}

/** Ausgangslage in Stores, Speicher und Tracker-Baseline; leere Warteschlange. */
function grundlage(account: { userId: string; access: 'full' | 'member' }): void {
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID, account });
  applyStateToStores(ausgangsstand());
  persistAll();
  resetSyncOutboxForTests();
}

beforeEach(() => {
  localStorage.clear();
  resetTestStores();
  resetSyncOutboxForTests();
  resetSyncChangeTrackerForTests();
  resetSyncCoordinatorForTests();
  ctx = null;
});

afterEach(async () => {
  await beende();
  setActiveStorageScope({ type: 'guest' });
});

describe('EINRICHTUNG-01 AP0 — Setup-Spiegel (S-15)', () => {
  it('S-15.1: nach Namens- und Steueränderung schreibt weder Sprachwahl noch Setup-Aktualisierung alte Werte zurück', async () => {
    grundlage({ userId: 'usr-ein01-inhaber', access: 'full' });
    await starte();

    await act(async () => {
      expect(ctx!.updateCompanyProfile({ companyName: 'Neu GmbH', defaultTaxStatus: 'kleinunternehmer_19' }).success).toBe(true);
    });
    expect(getCachedSetup()).toMatchObject({ companyName: 'Neu GmbH', taxStatus: 'kleinunternehmer_19' });
    expect(ctx!.setup).toMatchObject({ companyName: 'Neu GmbH', taxStatus: 'kleinunternehmer_19' });
    expect(firmenauftraege('company_setup').length).toBeGreaterThan(0);

    // Sprachwahl im Cloud-Betrieb: je Person, das Setup des Betriebs bleibt.
    const setupVorSprache = JSON.stringify(getCachedSetup());
    const auftraegeVorSprache = firmenauftraege('company_setup').length;
    await act(async () => ctx!.updateLanguage('tr'));
    expect(ctx!.language).toBe('tr');
    expect(container.textContent).toBe('tr');
    expect(JSON.stringify(getCachedSetup())).toBe(setupVorSprache);
    expect(firmenauftraege('company_setup').length).toBe(auftraegeVorSprache);

    // Der Setup-Weg (z. B. Einrichtungsassistent) baut auf dem gespeicherten Setup auf.
    await act(async () => ctx!.updateSetup({ communicationChannel: 'email' }));
    const gespeichert = buildPersistedStateSnapshot().setup;
    expect(gespeichert).toMatchObject({ companyName: 'Neu GmbH', taxStatus: 'kleinunternehmer_19', language: 'de' });
    const imSpeicher = JSON.parse(localStorage.getItem(getActiveStorageKey()) ?? '{}') as AppPersistedState;
    expect(imSpeicher.setup).toMatchObject({ companyName: 'Neu GmbH', taxStatus: 'kleinunternehmer_19' });
  });

  it('S-15.1 (EIN-15): auch ein Sprachwechsel über das Setup schreibt den alten Namen nicht zurück', async () => {
    grundlage({ userId: 'usr-ein01-inhaber', access: 'full' });
    await starte();
    await act(async () => {
      expect(ctx!.updateCompanyProfile({ companyName: 'Neu GmbH', defaultTaxStatus: 'kleinunternehmer_19' }).success).toBe(true);
    });
    await act(async () => ctx!.updateSetup({ language: 'bg' }));
    expect(getCachedSetup()).toMatchObject({ companyName: 'Neu GmbH', taxStatus: 'kleinunternehmer_19', language: 'bg' });
    expect(buildPersistedStateSnapshot().setup).toMatchObject({ companyName: 'Neu GmbH', taxStatus: 'kleinunternehmer_19' });
  });

  it('S-15.2: nach einem Neuladen gilt dasselbe', async () => {
    grundlage({ userId: 'usr-ein01-inhaber', access: 'full' });
    await starte();
    await act(async () => {
      expect(ctx!.updateCompanyProfile({ companyName: 'Neu GmbH', defaultTaxStatus: 'kleinunternehmer_19' }).success).toBe(true);
    });
    await beende();

    // Neuladen: der gespeicherte Stand kommt aus dem Speicher zurück.
    const gespeichert = JSON.parse(localStorage.getItem(getActiveStorageKey()) ?? '{}') as AppPersistedState;
    resetTestStores();
    applyStateToStores(gespeichert);
    await starte();
    expect(ctx!.setup).toMatchObject({ companyName: 'Neu GmbH', taxStatus: 'kleinunternehmer_19' });
    await act(async () => ctx!.updateLanguage('tr'));
    await act(async () => ctx!.updateSetup({ language: 'bg' }));
    expect(buildPersistedStateSnapshot().setup).toMatchObject({ companyName: 'Neu GmbH', taxStatus: 'kleinunternehmer_19' });
  });

  it('S-15.3: ein Mitglied wechselt die Sprache ohne company_setup-Auftrag und ohne Firmenmutation', async () => {
    grundlage({ userId: 'usr-ein01-mitglied', access: 'member' });
    await starte();
    const setupVorher = JSON.stringify(getCachedSetup());
    const profilVorher = JSON.stringify(buildPersistedStateSnapshot().companyProfile);

    await act(async () => ctx!.updateLanguage('tr'));
    expect(ctx!.language).toBe('tr');
    expect(firmenauftraege('company_setup')).toEqual([]);
    expect(firmenauftraege('company_profile')).toEqual([]);
    expect(JSON.stringify(getCachedSetup())).toBe(setupVorher);
    expect(JSON.stringify(buildPersistedStateSnapshot().companyProfile)).toBe(profilVorher);
    expect(localStorage.getItem(`${PERSONAL_UI_LANGUAGE_KEY_PREFIX}usr-ein01-mitglied`)).toBe('tr');

    // Die Wahl gilt nach dem Neuladen weiter — nur für diese Person.
    await beende();
    await starte();
    expect(ctx!.language).toBe('tr');
    setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID, account: { userId: 'usr-ein01-andere', access: 'member' } });
    await beende();
    await starte();
    expect(ctx!.language).toBe('de');
  });
});
