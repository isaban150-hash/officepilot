/**
 * EINRICHTUNG-01 (AP8; Verträge 1.29, 1.28; K6) — „Daten auf diesem Gerät“; Abschluss 22 zu WEISS E-13.
 *
 *   X-05.1  Anzeige: eigene Bestände (Betriebe, Größe, offene Änderungen), andere Konten nur als Anzahl
 *   E13.1   offene oder abgewiesene Aufträge sperren immer — auch für Inhaber mit vollständiger, aktueller Sicherung
 *           (eine Bestätigung gibt es nicht mehr)
 *   E13.2   abgeglichen heißt: in dieser Sitzung vollständiger Abgleich nachgewiesen und der Bestand seitdem unverändert
 *           (abgebrochener Abgleich, veralteter Nachweis)
 *   E13.3   Fehlerzustände sperren: unlesbarer Bestand, unlesbare Nebenablage, nicht prüfbare Entwurfsspeicher
 *   E13.4   unbestätigte und abgewiesene Rechnungszahlungen, Vermerke, Nachsicherungssperren, begonnene Freigaben
 *   E13.5   nie abgeglichene Daten: Kontobereich ohne Betrieb mit Geschäftsdaten, früherer Mailimport
 *   E13.6   Entwürfe nur auf diesem Gerät: Rechnungsentwurf ohne gespiegelten Stand, Upload, Kundenzuordnung, Versand,
 *           Einrichtung (Schlüssel über die echten Dienste gebildet)
 *   X-05.4  Ablauf: Nachricht an andere Tabs, exklusive Sperre, Prüfung, lokale Abmeldung, Prüfung, dann Entfernen;
 *           melden sich andere Tabs nicht ab, bleibt alles unverändert
 *   E13.7   direkte Aufrufe: `removeDeviceData` und `defaultDeviceRemove` prüfen selbst; ein Bestand, der erst bei der
 *           Abmeldung offen wird, wird nicht entfernt
 *   X-04    Eingabebestätigung mit dem angezeigten Wort; „Abbrechen“ sendet nichts
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import {
  browserExclusiveLock,
  defaultDeviceRemove,
  deviceDataFingerprint,
  deviceStorageKey,
  evaluateDeviceRemoval,
  getDeviceBackup,
  inspectDeviceData,
  recordDeviceBackup,
  recordDeviceSyncVerification,
  removeDeviceData,
  storedDeviceFingerprint,
  type DeviceRemovalDeps,
} from './deviceDataService';
import { readLocalAccountDrafts, type LocalAccountDrafts } from './localAccountDataService';
import { DeviceDataPage } from '../../pages/settings/DeviceDataPage';
import { SETTINGS_TARGET_PATHS } from '../../pages/settings/settingsHubConfig';
import * as supabaseLib from '../../lib/supabase';
import * as syncUi from '../../services/sync/syncUiService';
import { buildManualInvoiceDraft } from '../invoiceService';
import { createInvoiceDraftRecord, resetInvoiceDraftDurabilityDatabaseForTests } from '../invoice/invoiceDraftDurabilityService';
import { stripInvoiceDraftForCloud } from '../invoice/invoiceDraftCloudService';
import { markInvoicePaymentUnconfirmed } from '../invoice/invoicePaymentConfirmationStore';
import { seedInvoiceFinalizeIntentForTests } from '../invoice/invoiceFinalizeIntentService';
import { sendDraftStorageKey } from '../delivery/sendDocumentOrchestrator';
import { buildCustomerAssignmentDraftKey } from './customerAssignmentDraftService';
import { resolveSetupDraftBinding, writeSetupDraft } from '../setupDraftService';
import { resetUploadDraftStoreForTests, saveUploadDraftRecord, type UploadDraftRecord } from './uploadDraftIndexedDbService';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { resetTestStores } from '../../test/resetStores';
import { setActiveStorageScope } from './storageScopeService';
import type { SyncOutboxEntry } from '../../types/sync';
import type { SyncCoordinatorReport } from '../sync/syncCoordinator';

const U1 = '0a8a0000-0000-4000-8000-000000000001';
const U2 = '0a8a0000-0000-4000-8000-000000000002';
const WS1 = '0a8b0000-0000-4000-8000-000000000001';
const WS2 = '0a8b0000-0000-4000-8000-000000000002';
const GEPRUEFT: LocalAccountDrafts = { ok: true, invoiceDrafts: [], uploadDrafts: [] };

function eintrag(status: SyncOutboxEntry['status'], id = 'k1'): SyncOutboxEntry {
  return { id: `o-${id}-${status}`, entityType: 'customer', entityId: id, operation: 'update', version: 1, queuedAt: '2026-10-25T00:00:00.000Z', retryCount: 0, status, sequence: 1 } as SyncOutboxEntry;
}

function bestand(ws: string, user: string, extra: Record<string, unknown> = {}): string {
  const key = deviceStorageKey(ws, user, 'full');
  localStorage.setItem(key, JSON.stringify({ version: 6, savedAt: '2026-10-25T07:00:00.000Z', setup: {}, inboxItems: [], vorgaenge: [], tasks: [], workspace: { id: ws, name: `Betrieb ${ws.slice(-1)}` }, syncOutbox: [], ...extra }));
  return key;
}

function rolle(user: string, ws: string, role: 'owner' | 'admin' | 'member'): void {
  localStorage.setItem(`officetakt-workspace-access:${user}:${ws}`, JSON.stringify({ workspaceId: ws, userId: user, role, licenseState: 'effective', licenseEffective: true, confirmedAt: '2026-10-25T00:00:00.000Z' }));
}

/** Nachweis eines vollständigen Abgleichs für den gespeicherten Stand (wie „Abgleich jetzt prüfen“ ihn festhält). */
function nachweis(key: string, user = U1): void {
  recordDeviceSyncVerification({ userId: user, storageKey: key, fingerprint: storedDeviceFingerprint(key)!, verifiedAt: '2026-10-27T08:00:00.000Z' });
}

function gruende(user: string, drafts: LocalAccountDrafts | null = GEPRUEFT, live: { storageKey: string; state: object } | null = null) {
  return evaluateDeviceRemoval(user, { drafts, live }).affected.map((area) => `${area.workspaceId ?? 'konto'}:${area.reasons.join('+')}`);
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  await resetInvoiceDraftDurabilityDatabaseForTests();
  await resetUploadDraftStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setActiveStorageScope({ type: 'guest' });
});

describe('EINRICHTUNG-01 AP8 — Prüfregeln (1.29, K6; E-13)', { timeout: 30_000 }, () => {
  it('X-05.1: eigene Bestände mit offenen und abgewiesenen Änderungen; andere Konten nur als Anzahl', () => {
    bestand(WS1, U1, { syncOutbox: [eintrag('pending', 'a'), eintrag('failed', 'b'), eintrag('completed', 'c')] });
    bestand(WS2, U2);
    rolle(U1, WS1, 'owner');
    const inventar = inspectDeviceData(U1);
    expect(inventar.workspaces).toHaveLength(1);
    expect(inventar.workspaces[0]).toMatchObject({ workspaceId: WS1, name: 'Betrieb 1', openChanges: 1, rejectedChanges: 1, role: 'owner' });
    expect(inventar.accountArea).toBeNull();
    expect(inventar.otherAccounts).toBe(1);
    expect(JSON.stringify(inventar)).not.toContain(U2);
  });

  it('E13.1: offene oder abgewiesene Aufträge sperren — auch für Inhaber mit vollständiger, aktueller Sicherung', () => {
    const key = bestand(WS1, U1, { syncOutbox: [eintrag('pending')] });
    rolle(U1, WS1, 'owner');
    nachweis(key);
    recordDeviceBackup({ userId: U1, workspaceId: WS1, fileName: 'OfficeTakt_Sicherung_B_2026-10-27_08-00.zip', createdAt: '2026-10-27T08:00:00.000Z', complete: true, fingerprint: deviceDataFingerprint(JSON.parse(localStorage.getItem(key)!)) });
    expect(getDeviceBackup(U1, WS1)?.complete).toBe(true);
    const bewertung = evaluateDeviceRemoval(U1, { drafts: GEPRUEFT });
    expect(bewertung.allowed).toBe(false);
    expect(bewertung.affected[0]).toMatchObject({ workspaceId: WS1, reasons: ['unsynced'] });
    // Es gibt keinen Weg, eine Sicherung oder Bestätigung zu übergeben: Konto und Prüfeingaben, sonst nichts.
    expect(evaluateDeviceRemoval.length).toBe(2);

    for (const status of ['failed', 'blocked', 'error'] as const) {
      const k = bestand(WS1, U1, { syncOutbox: [eintrag(status)] });
      nachweis(k);
      expect(gruende(U1)).toEqual([`${WS1}:unsynced`]);
    }
  });

  it('E13.2: abgeglichen und nachgewiesen → erlaubt; ohne Nachweis (abgebrochener Abgleich) oder nach einer Änderung gesperrt', () => {
    const key = bestand(WS1, U1);
    expect(gruende(U1)).toEqual([`${WS1}:not_verified`]);
    nachweis(key);
    expect(evaluateDeviceRemoval(U1, { drafts: GEPRUEFT })).toEqual({ allowed: true, affected: [] });
    // Neuer Inhalt nach dem Nachweis (etwa ein Altbestand, der erst beim nächsten Abgleich eingereiht würde).
    bestand(WS1, U1, { customers: [{ id: 'c-neu', name: 'Neu GmbH' }] });
    expect(gruende(U1)).toEqual([`${WS1}:not_verified`]);
    // Der Nachweis eines anderen Kontos zählt nie.
    nachweis(key, U2);
    expect(gruende(U1)).toEqual([`${WS1}:not_verified`]);
  });

  it('E13.2: der laufende Stand zählt zusätzlich — offene Aufträge im Arbeitsspeicher sperren trotz sauberem Speicherstand', () => {
    const key = bestand(WS1, U1);
    nachweis(key);
    const live = { storageKey: key, state: { ...JSON.parse(localStorage.getItem(key)!), syncOutbox: [eintrag('pending', 'live')] } };
    expect(gruende(U1, GEPRUEFT, live)).toEqual([`${WS1}:unsynced`]);
  });

  it('E13.3: unlesbarer Bestand, unlesbare Nebenablage und nicht prüfbare Entwurfsspeicher sperren', () => {
    const key = deviceStorageKey(WS1, U1, 'full');
    localStorage.setItem(key, '{kaputt');
    expect(gruende(U1)).toEqual([`${WS1}:unreadable`]);

    localStorage.clear();
    const sauber = bestand(WS1, U1);
    nachweis(sauber);
    localStorage.setItem(`${sauber}:invoice-finalize-intents`, '{kaputt');
    expect(gruende(U1)).toEqual([`${WS1}:unreadable`]);

    localStorage.removeItem(`${sauber}:invoice-finalize-intents`);
    expect(gruende(U1, null)).toEqual(['konto:check_failed']);
    expect(gruende(U1, { ok: false, invoiceDrafts: [], uploadDrafts: [] })).toEqual(['konto:check_failed']);
    expect(gruende(U1)).toEqual([]);
  });

  it('E13.4: unbestätigte und abgewiesene Zahlungen, Vermerke, Sperren und begonnene Freigaben sperren', () => {
    const rechnung = (payments: unknown[], rejectedPayments: unknown[] = []) => ({
      invoiceEntries: [{ vorgangId: null, invoice: { id: 'inv-1', payments, rejectedPayments } }],
    });
    let key = bestand(WS1, U1, rechnung([{ id: 'p1', amount: 10, cloudBestaetigt: true }]));
    nachweis(key);
    expect(gruende(U1)).toEqual([]);
    key = bestand(WS1, U1, rechnung([{ id: 'p1', amount: 10 }]));
    nachweis(key);
    expect(gruende(U1)).toEqual([`${WS1}:unsynced`]);
    key = bestand(WS1, U1, rechnung([], [{ id: 'p2', amount: 5 }]));
    nachweis(key);
    expect(gruende(U1)).toEqual([`${WS1}:unsynced`]);

    // Nebenablagen über die echten Dienste geschrieben (gleiche Schlüssel wie im Betrieb).
    key = bestand(WS1, U1);
    nachweis(key);
    setActiveStorageScope({ type: 'workspace', workspaceId: WS1, account: { userId: U1, access: 'full' } });
    markInvoicePaymentUnconfirmed('inv-1', 'p1');
    expect(gruende(U1)).toEqual([`${WS1}:unsynced`]);
    localStorage.removeItem(`${key}:invoice-payment-unconfirmed`);
    expect(gruende(U1)).toEqual([]);
    seedInvoiceFinalizeIntentForTests({ workspaceId: WS1, vorgangId: 'v-1', clientInvoiceId: 'ci-1', contentFingerprint: 'f', createdAt: '2026-10-27T08:00:00.000Z' });
    expect(gruende(U1)).toEqual([`${WS1}:unsynced`]);
  });

  it('E13.5: Kontobereich ohne Betrieb mit Geschäftsdaten und früherer Mailimport werden nie abgeglichen', () => {
    const konto = `officepilot-state:user:${U1}`;
    localStorage.setItem(konto, JSON.stringify({ version: 6, setup: {}, inboxItems: [], vorgaenge: [], tasks: [], syncOutbox: [] }));
    expect(inspectDeviceData(U1).accountArea?.storageKey).toBe(konto);
    expect(gruende(U1)).toEqual([]);
    localStorage.setItem(konto, JSON.stringify({ version: 6, setup: {}, inboxItems: [], vorgaenge: [{ id: 'v-1' }], tasks: [], syncOutbox: [] }));
    expect(gruende(U1)).toEqual(['konto:local_only']);

    localStorage.removeItem(konto);
    const key = bestand(WS1, U1, { mailImports: [{ id: 'm-1', status: 'processed' }] });
    nachweis(key);
    expect(gruende(U1)).toEqual([`${WS1}:local_only`]);
  });

  it('E13.6: Rechnungsentwurf nur in IndexedDB sperrt, gespiegelt nicht; begonnene Freigabe und Upload-Entwurf sperren', async () => {
    const scope = `workspace:${WS1}:account:${U1}:full`;
    // Der Entwurfskern bildet den Bereich aus dem aktiven Konto (wie im Betrieb).
    setActiveStorageScope({ type: 'workspace', workspaceId: WS1, account: { userId: U1, access: 'full' } });
    const draft = buildManualInvoiceDraft(
      { billing: { name: 'Beispiel GmbH', contactPerson: '', street: 'Weg 1', zip: '10000', city: 'Beispielstadt', email: '', phone: '' } },
      { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' },
    );
    const created = await createInvoiceDraftRecord({ identity: { sourceScopeKey: scope, workspaceId: WS1, vorgangId: null, invoiceType: 'rechnung', draftId: draft.id }, draft, now: '2026-10-27T08:00:00.000Z' });
    expect(created.ok).toBe(true);
    let key = bestand(WS1, U1);
    nachweis(key);
    let drafts = await readLocalAccountDrafts(U1);
    expect(drafts).toMatchObject({ ok: true });
    expect(drafts.invoiceDrafts).toHaveLength(1);
    expect(await readLocalAccountDrafts(U2)).toEqual(GEPRUEFT);
    expect(gruende(U1, drafts)).toEqual([`${WS1}:draft`]);

    const sha = drafts.invoiceDrafts[0].draftSha256 as string;
    key = bestand(WS1, U1, { invoiceDrafts: [{ id: draft.id, vorgangId: null, invoiceType: 'rechnung', status: 'active', core: stripInvoiceDraftForCloud(draft), localLink: { draftSha256: sha, coreKey: 'x' } }] });
    nachweis(key);
    expect(gruende(U1, drafts)).toEqual([]);
    // Ein Konflikt im Spiegel heißt: der lokale Stand ist nicht sicher in der Cloud.
    key = bestand(WS1, U1, { invoiceDrafts: [{ id: draft.id, vorgangId: null, invoiceType: 'rechnung', status: 'active', core: stripInvoiceDraftForCloud(draft), localLink: { draftSha256: sha, coreKey: 'x' }, conflict: { kind: 'both_changed' } }] });
    nachweis(key);
    expect(gruende(U1, drafts)).toEqual([`${WS1}:draft`]);

    // Eine begonnene Freigabe (Ausgang unbekannt) sperrt unabhängig vom Spiegel.
    const finalizing = { ...drafts, invoiceDrafts: [{ ...drafts.invoiceDrafts[0], status: 'finalizing' }] };
    expect(gruende(U1, finalizing)).toEqual([`${WS1}:unsynced`]);
    const finalized = { ...drafts, invoiceDrafts: [{ ...drafts.invoiceDrafts[0], status: 'finalized' }] };
    expect(gruende(U1, finalized)).toEqual([]);

    await resetInvoiceDraftDurabilityDatabaseForTests();
    const upload = { id: 'u-1', schemaVersion: 1, scopeKey: scope, userId: U1, workspaceId: WS1, source: 'upload', createdAt: '2026-10-27T08:00:00.000Z', updatedAt: '2026-10-27T08:00:00.000Z', expiresAt: '2026-10-28T08:00:00.000Z' } as unknown as UploadDraftRecord;
    await saveUploadDraftRecord(upload);
    drafts = await readLocalAccountDrafts(U1);
    expect(drafts.invoiceDrafts).toHaveLength(0);
    expect(drafts.uploadDrafts).toHaveLength(1);
    const vor = evaluateDeviceRemoval(U1, { drafts, now: Date.parse('2026-10-27T12:00:00.000Z') });
    expect(vor.affected.map((area) => `${area.workspaceId}:${area.reasons.join('+')}`)).toEqual([`${WS1}:draft`]);
    // Abgelaufen (24 h): nicht mehr fortsetzbar, sperrt nicht.
    expect(evaluateDeviceRemoval(U1, { drafts, now: Date.parse('2026-10-29T08:00:00.000Z') })).toEqual({ allowed: true, affected: [] });
  });

  it('E13.6: Entwürfe von Kundenzuordnung, Versand und Einrichtung sperren (Schlüssel aus den echten Diensten)', () => {
    const key = bestand(WS1, U1);
    nachweis(key);
    setActiveStorageScope({ type: 'workspace', workspaceId: WS1, account: { userId: U1, access: 'full' } });
    const zuordnung = buildCustomerAssignmentDraftKey({ itemId: 'item-1' });
    localStorage.setItem(zuordnung, '{}');
    expect(gruende(U1)).toEqual([`${WS1}:draft`]);
    localStorage.removeItem(zuordnung);

    const versand = sendDraftStorageKey(`workspace:${WS1}:account:${U1}:full`, { kind: 'letter', clientDocumentId: 'd-1' });
    localStorage.setItem(versand, '{}');
    expect(gruende(U1)).toEqual([`${WS1}:draft`]);
    localStorage.removeItem(versand);

    writeSetupDraft(resolveSetupDraftBinding(U1, WS1), { stepIndex: 1, draft: {} as never, numericText: {} as never });
    expect(gruende(U1)).toEqual([`${WS1}:draft`]);
    expect(gruende(U2)).toEqual([]);
  });
});

describe('EINRICHTUNG-01 AP8 — Ablauf des Entfernens (1.29, K6; E-13)', { timeout: 30_000 }, () => {
  function deps(overrides: Partial<DeviceRemovalDeps> = {}): DeviceRemovalDeps & { schritte: string[] } {
    const schritte: string[] = [];
    return {
      schritte,
      broadcast: (message) => schritte.push(`nachricht:${message.userId}`),
      releaseOwnLock: () => schritte.push('sperre-frei'),
      reacquireOwnLock: () => schritte.push('sperre-wieder'),
      logoutLocal: async () => {
        schritte.push('abmelden');
      },
      exclusiveLock: async (name, _timeout, run) => {
        schritte.push(`exklusiv:${name}`);
        return { acquired: true, value: await run() };
      },
      remove: async () => {
        schritte.push('entfernen');
        return { storageKeys: 3, sessionKeys: 1, indexedDbRecords: 2, workspaces: [WS1] };
      },
      ...overrides,
    };
  }

  it('X-05.4: Nachricht, eigene Sperre frei, exklusive Sperre, dann abmelden und entfernen', async () => {
    nachweis(bestand(WS1, U1));
    const d = deps();
    const ergebnis = await removeDeviceData(U1, d);
    expect(ergebnis.ok).toBe(true);
    expect(d.schritte).toEqual([`nachricht:${U1}`, 'sperre-frei', `exklusiv:officetakt-account:${U1}`, 'abmelden', 'entfernen']);
  });

  it('X-05.4: melden sich andere Tabs nicht ab, bleibt alles unverändert (weiter angemeldet, nichts entfernt)', async () => {
    const d = deps({ exclusiveLock: async () => ({ acquired: false }) });
    expect(await removeDeviceData(U1, d)).toEqual({ ok: false, reason: 'other_tabs' });
    expect(d.schritte).not.toContain('abmelden');
    expect(d.schritte).not.toContain('entfernen');
    expect(d.schritte).toContain('sperre-wieder');
  });

  it('E13.7: direkter Aufruf mit offenen Aufträgen und Sicherung — gesperrt vor der Abmeldung, nichts entfernt', async () => {
    const key = bestand(WS1, U1, { syncOutbox: [eintrag('pending')] });
    rolle(U1, WS1, 'owner');
    nachweis(key);
    recordDeviceBackup({ userId: U1, workspaceId: WS1, fileName: 'neu.zip', createdAt: '2026-10-27T08:00:00.000Z', complete: true, fingerprint: storedDeviceFingerprint(key)! });
    const d = deps();
    const ergebnis = await removeDeviceData(U1, d);
    expect(ergebnis).toMatchObject({ ok: false, reason: 'blocked', loggedOut: false });
    expect(d.schritte).not.toContain('abmelden');
    expect(d.schritte).not.toContain('entfernen');
    expect(d.schritte).toContain('sperre-wieder');
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it('E13.7: der laufende Stand des aktiven Bestands sperrt auch im direkten Aufruf', async () => {
    const key = bestand(WS1, U1);
    nachweis(key);
    const d = deps({ live: () => ({ storageKey: key, state: { syncOutbox: [eintrag('pending', 'live')] } }) });
    expect(await removeDeviceData(U1, d)).toMatchObject({ ok: false, reason: 'blocked', loggedOut: false });
    expect(d.schritte).not.toContain('entfernen');
  });

  it('E13.7: wird der Bestand erst bei der Abmeldung offen, wird nach der Abmeldung nichts entfernt', async () => {
    const key = bestand(WS1, U1);
    nachweis(key);
    const d = deps({
      logoutLocal: async () => {
        bestand(WS1, U1, { syncOutbox: [eintrag('pending', 'spaet')] });
      },
    });
    expect(await removeDeviceData(U1, d)).toMatchObject({ ok: false, reason: 'blocked', loggedOut: true });
    expect(d.schritte).not.toContain('entfernen');
    expect(localStorage.getItem(key)).toContain('spaet');
  });

  it('E13.7: defaultDeviceRemove entfernt nie nicht abgeglichene Daten', async () => {
    const key = bestand(WS1, U1, { syncOutbox: [eintrag('failed')] });
    nachweis(key);
    await expect(defaultDeviceRemove(U1)).rejects.toThrow('device_data_unsynced');
    expect(localStorage.getItem(key)).not.toBeNull();
    bestand(WS1, U1);
    nachweis(key);
    await expect(defaultDeviceRemove(U1)).resolves.toMatchObject({ workspaces: [WS1] });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('ohne Web Locks wartet der Tab kurz und entfernt dann (dokumentierte Grenze)', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('navigator', {});
      const run = vi.fn(async () => 'ok');
      const lauf = browserExclusiveLock('x', 1000, run);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await lauf).toEqual({ acquired: true, value: 'ok' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EINRICHTUNG-01 AP8 — Seite „Daten auf diesem Gerät“ (1.29; E-13)', { timeout: 30_000 }, () => {
  let root: Root | null = null;
  let host: HTMLDivElement;

  async function render(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={[SETTINGS_TARGET_PATHS.device]}>
          <AuthProvider>
            <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
              <Routes>
                <Route path={SETTINGS_TARGET_PATHS.device} element={<DeviceDataPage />} />
              </Routes>
            </AppProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
    });
    await warten();
  }

  async function warten(): Promise<void> {
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
  }

  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const klick = async (id: string) => act(async () => (q(id) as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })));

  beforeEach(async () => {
    resetTestStores();
    resetAuthForTests();
    setActiveStorageScope({ type: 'guest' });
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    await loginAsDefaultAdmin();
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    document.body.innerHTML = '';
    resetTestStores();
  });

  it('X-05.2/X-04: abgeglichen und nachgewiesen → Entfernen erst nach Eingabe des Worts; „Abbrechen“ sendet nichts', async () => {
    const key = bestand(WS1, 'usr-admin');
    nachweis(key, 'usr-admin');
    await render();
    expect(q('device-data-workspace-' + WS1)).not.toBeNull();
    expect(q('device-data-ready')).not.toBeNull();
    const aktion = q('device-data-remove-action') as HTMLButtonElement;
    expect(aktion.disabled).toBe(false);
    await klick('device-data-remove-action');
    expect(q('device-data-remove-dialog')).not.toBeNull();
    expect((q('device-data-remove-confirm') as HTMLButtonElement).disabled).toBe(true);
    await klick('device-data-remove-cancel');
    expect(q('device-data-remove-dialog')).toBeNull();
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it('E13.1: offene Änderungen mit vollständiger Sicherung → gesperrt, Hinweis „ersetzt den Abgleich nicht“, keine Bestätigung', async () => {
    const key = bestand(WS1, 'usr-admin', { syncOutbox: [eintrag('pending')] });
    rolle('usr-admin', WS1, 'owner');
    nachweis(key, 'usr-admin');
    recordDeviceBackup({ userId: 'usr-admin', workspaceId: WS1, fileName: 'OfficeTakt_Sicherung_B.zip', createdAt: '2026-10-27T08:00:00.000Z', complete: true, fingerprint: storedDeviceFingerprint(key)! });
    await render();
    expect(q('device-data-remove')?.getAttribute('data-allowed')).toBe('false');
    expect(q(`device-data-affected-${WS1}`)?.getAttribute('data-block')).toBe('unsynced');
    expect(q(`device-data-backup-note-${WS1}`)?.textContent).toContain('OfficeTakt_Sicherung_B.zip');
    expect(q(`device-data-backup-confirm-${WS1}`)).toBeNull();
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(q('device-data-sync-link')?.getAttribute('href')).toBe(SETTINGS_TARGET_PATHS.sync);
    expect(q('device-data-backup-link')?.getAttribute('href')).toBe(SETTINGS_TARGET_PATHS.backup);
    expect((q('device-data-remove-action') as HTMLButtonElement).disabled).toBe(true);
  });

  it('E13.2: „Abgleich jetzt prüfen“ hält den Nachweis nur nach vollständigem Abgleich ohne offene Aufträge fest', async () => {
    const key = bestand(WS1, 'usr-admin');
    setActiveStorageScope({ type: 'workspace', workspaceId: WS1, account: { userId: 'usr-admin', access: 'full' } });
    const sauber = { errorCount: 0, conflictCount: 0, errors: [], conflicts: [], syncedEntities: [] } as unknown as SyncCoordinatorReport;
    const lauf = vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValueOnce({ ...sauber, errorCount: 1, errors: [{ outboxId: 'o', message: 'netz' }] } as SyncCoordinatorReport);
    await render();
    expect(q(`device-data-affected-${WS1}`)?.getAttribute('data-block')).toBe('not_verified');
    await klick('device-data-verify');
    await warten();
    expect(q('device-data-verify-result')?.getAttribute('data-state')).toBe('failed');
    expect((q('device-data-remove-action') as HTMLButtonElement).disabled).toBe(true);

    lauf.mockResolvedValueOnce(sauber);
    await klick('device-data-verify');
    await warten();
    expect(lauf).toHaveBeenCalledTimes(2);
    expect(q('device-data-verify-result')?.getAttribute('data-state')).toBe('ok');
    expect(q('device-data-ready')).not.toBeNull();
    expect((q('device-data-remove-action') as HTMLButtonElement).disabled).toBe(false);
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it('lokaler Betrieb: Bestand und Weg zur Sicherung, kein Entfernen', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    await render();
    expect(q('device-data-local')).not.toBeNull();
    expect(q('device-data-remove-action')).toBeNull();
  });
});
