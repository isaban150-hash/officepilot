/**
 * E-MAIL-07E-MSA — Postfach-Bereich unter Einstellungen → Kommunikation:
 * „Microsoft-Postfach verbinden" / „Mit Microsoft verbinden", Status (nicht
 * verbunden / verbunden / neu verbinden), Adresse, letzter Abruf, Fehler,
 * „Verbindung trennen", Rückkehr von Microsoft (verbunden / Fehler /
 * anderes Konto bestätigen). Kein Passwortfeld. Test-Doubles, kein Netz,
 * keine Microsoft-Anmeldung.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { resetTestStores } from '../../test/resetStores';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../../services/persistenceService';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { CommunicationSettingsPage } from '../../pages/settings/CommunicationSettingsPage';
import { CONNECTABLE_PROVIDERS, MailboxSettingsSection, mailboxDisplayState } from './MailboxSettingsSection';
import type { CompanySetup } from '../../types/models';
import type { MailboxConnection } from '../../types/emailMessage';

const WS = '00000000-0000-4000-8000-00000000a501';
const STATE_ID = '00000000-0000-4000-8000-0000000057a1';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function click(id: string): Promise<void> {
  await act(async () => { q(id)!.click(); });
  await settle();
}
async function type(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(id: string): Promise<void> {
  await act(async () => { (q(id) as HTMLFormElement).requestSubmit(); });
  await settle();
}
let lastLocation = '';
function LocationProbe() {
  const location = useLocation();
  lastLocation = `${location.pathname}${location.search}`;
  return null;
}
async function mount(node: ReactNode, path = '/einstellungen/kommunikation'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}><AuthProvider><AppProvider initialSetup={setup}><LocationProbe /><Routes><Route path="*" element={node} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}

const delegated = (patch: Partial<MailboxConnection> = {}): MailboxConnection => ({
  id: 'conn-1', providerType: 'microsoft_graph', authMode: 'delegated', mailboxAddress: 'schabi82@hotmail.de', status: 'connected', hasCredentials: true,
  mailboxSourceKind: 'folder', mailboxSourceName: 'OfficeTakt-Test', importFrom: '2026-09-27T00:00:00.000Z', lastSuccessfulSyncAt: '2026-09-27T18:13:00.000Z', ...patch,
});

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', email: 'info@betrieb.invalid' });
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-admin', createdAt: 'x', updatedAt: 'x', version: 1 },
    workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: 'x', updatedAt: 'x' }],
  });
  await loginAsDefaultAdmin();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Netz im Test verboten'); });
});

afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled(); // kein Netz, keine Microsoft-Anmeldung, kein Versand
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  resetTestStores();
});

describe('E-MAIL-07E-MSA — Postfach in den Einstellungen', () => {
  it('nicht verbunden → „Microsoft-Postfach verbinden" → Formular ohne Passwortfeld → „Mit Microsoft verbinden" leitet zu Microsoft', async () => {
    const start = vi.fn(async () => ({ ok: true as const, authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?state=x' }));
    const navigate = vi.fn();
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [] })} start={start} navigate={navigate} />);
    expect(q('settings-mailbox-none')?.textContent).toContain('Nicht verbunden');
    expect(q('settings-mailbox-open')?.textContent).toBe('Microsoft-Postfach verbinden');
    await click('settings-mailbox-open');
    expect(host.querySelectorAll('input[type="password"]').length).toBe(0);
    // Kein Eingabefeld/Label fragt ein Passwort ab; der Text sagt nur, dass OfficeTakt es nie erhält.
    expect(Array.from(host.querySelectorAll('label, input, select')).some((el) => /passwort|password/i.test(`${el.textContent} ${el.getAttribute('name') ?? ''} ${el.getAttribute('autocomplete') ?? ''}`))).toBe(false);
    expect(q('settings-mailbox-section')?.textContent).toContain('erhält nie Ihr Passwort');
    // 07E-MSA-FIX1: Importordner fest „OfficeTakt-Test“ — kein Eingabefeld, nichts anderes wählbar.
    expect(q('settings-mailbox-folder-fixed')?.textContent).toBe('OfficeTakt-Test');
    expect(q('settings-mailbox-folder-input')).toBeNull();
    expect(q('settings-mailbox-connect')?.textContent).toBe('Mit Microsoft verbinden');
    expect(q('settings-mailbox-permissions')?.textContent).toContain('Kein Senden');

    // Ungültige Adresse → kein Start.
    await type('settings-mailbox-address-input', 'kein-at');
    await submit('settings-mailbox-form');
    expect(start).not.toHaveBeenCalled();
    expect(q('settings-mailbox-form-error')?.textContent).toContain('gültige E-Mail-Adresse');

    await type('settings-mailbox-address-input', 'schabi82@hotmail.de');
    await submit('settings-mailbox-form');
    expect(start).toHaveBeenCalledWith({ provider: 'microsoft_graph', expectedAddress: 'schabi82@hotmail.de', sourceName: 'OfficeTakt-Test', importDays: 0 });
    expect(navigate).toHaveBeenCalledWith('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?state=x');
  });

  it('Start-Fehler in Alltagssprache (Server nicht eingerichtet)', async () => {
    const navigate = vi.fn();
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [] })} start={async () => ({ ok: false, error: 'oauth_not_configured' })} navigate={navigate} />);
    await click('settings-mailbox-open');
    await type('settings-mailbox-address-input', 'schabi82@hotmail.de');
    await submit('settings-mailbox-form');
    expect(q('settings-mailbox-form-error')?.textContent).toBe('Die Microsoft-Anbindung ist auf dem Server noch nicht eingerichtet.');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('verbunden: Adresse, Status, Ordner, Zeitraum, letzter Abruf; Trennen nur nach Bestätigung, E-Mails bleiben', async () => {
    let connections = [delegated()];
    const disconnect = vi.fn(async () => {
      connections = [delegated({ status: 'disconnected', hasCredentials: false })];
      return true;
    });
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: true, connections })} disconnect={disconnect} />);
    expect(q('settings-mailbox-address')?.textContent).toBe('schabi82@hotmail.de');
    expect(q('settings-mailbox-state')?.getAttribute('data-state')).toBe('connected');
    expect(q('settings-mailbox-state')?.textContent).toContain('Verbunden');
    expect(q('settings-mailbox-folder')?.textContent).toBe('OfficeTakt-Test');
    expect(q('settings-mailbox-import-from')?.textContent).toMatch(/^27\.09\.2026, \d{2}:00$/);
    // Postfach schon verbunden → kein zweiter „verbinden"-Knopf.
    expect(q('settings-mailbox-open')).toBeNull();
    expect(q('settings-mailbox-last-sync')?.textContent).toMatch(/^27\.09\.2026, \d{2}:13$/);
    await click('settings-mailbox-disconnect');
    expect(q('settings-mailbox-disconnect-dialog')?.textContent).toContain('Bereits übernommene E-Mails und Kundendaten bleiben erhalten');
    await click('settings-mailbox-disconnect-cancel');
    expect(disconnect).not.toHaveBeenCalled();
    await click('settings-mailbox-disconnect');
    await click('settings-mailbox-disconnect-confirm');
    expect(disconnect).toHaveBeenCalledWith('conn-1');
    expect(q('settings-mailbox-notice')?.textContent).toContain('Die Verbindung wurde getrennt');
    expect(q('settings-mailbox-state')?.getAttribute('data-state')).toBe('disconnected');
    expect(q('settings-mailbox-state')?.textContent).toContain('Nicht verbunden');
    // Wiederverbinden möglich (Adresse/Ordner vorbelegt).
    await click('settings-mailbox-reconnect');
    expect((q('settings-mailbox-address-input') as HTMLInputElement).value).toBe('schabi82@hotmail.de');
  });

  it('„neu verbinden": abgelaufene Anmeldung (invalid_grant) wird als solche gezeigt', async () => {
    expect(mailboxDisplayState(delegated({ status: 'error', errorCategory: 'reauthorize' }))).toBe('reconnect');
    expect(mailboxDisplayState(delegated({ hasCredentials: false }))).toBe('reconnect');
    expect(mailboxDisplayState(delegated({ status: 'error', errorCategory: 'network' }))).toBe('error');
    expect(mailboxDisplayState(delegated({ status: 'disconnected' }))).toBe('disconnected');
    expect(mailboxDisplayState({ ...delegated({ authMode: 'application', hasCredentials: false }) })).toBe('connected');
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [delegated({ status: 'error', errorCategory: 'reauthorize' })] })} />);
    expect(q('settings-mailbox-state')?.textContent).toContain('Neu verbinden');
    expect(q('settings-mailbox-error')?.textContent).toBe('Die Verbindung zum Postfach muss neu autorisiert werden.');
    expect(q('settings-mailbox-reconnect')).not.toBeNull();
  });

  it('Rückkehr von Microsoft: verbunden bzw. Fehler als Hinweis; Parameter werden aus der URL entfernt', async () => {
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [delegated()] })} />, '/einstellungen/kommunikation?postfach=verbunden');
    expect(q('settings-mailbox-notice')?.textContent).toBe('Das Microsoft-Postfach ist verbunden.');
    expect(lastLocation).toBe('/einstellungen/kommunikation');
    await act(async () => root.unmount());
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [] })} />, '/einstellungen/kommunikation?postfach=fehler&grund=consent_denied');
    expect(q('settings-mailbox-notice')?.textContent).toBe('Die Zustimmung bei Microsoft wurde abgelehnt. Es wurde nichts verbunden.');
    await act(async () => root.unmount());
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [] })} />, '/einstellungen/kommunikation?postfach=fehler&grund=%3Cscript%3E');
    expect(q('settings-mailbox-notice')?.textContent).toBe('Die Verbindung mit Microsoft ist nicht zustande gekommen. Bitte erneut versuchen.');
  });

  it('anderes Konto: erkannte Adresse wird gezeigt; nichts verbunden, bis bestätigt — Bestätigen oder Verwerfen', async () => {
    const pending = { stateId: STATE_ID, providerType: 'microsoft_graph' as const, reason: 'address_mismatch' as const, expectedAddress: 'schabi82@hotmail.de', detectedAddress: 'anderes@outlook.com', sourceKind: 'folder' as const, sourceName: 'OfficeTakt-Test', pendingUntil: '2026-09-27T10:15:00Z' };
    const loadPending = vi.fn(async () => pending);
    const resolvePending = vi.fn(async () => ({ ok: true }));
    await mount(
      <MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [] })} loadPending={loadPending} resolvePending={resolvePending} />,
      `/einstellungen/kommunikation?postfach=bestaetigen&oauth=${STATE_ID}`,
    );
    expect(loadPending).toHaveBeenCalledWith(STATE_ID);
    expect(q('settings-mailbox-pending-text')?.textContent).toBe('Erwartet war schabi82@hotmail.de, angemeldet hat sich aber anderes@outlook.com. Soll dieses Konto verbunden werden?');
    expect(resolvePending).not.toHaveBeenCalled();
    await click('settings-mailbox-pending-cancel');
    expect(resolvePending).toHaveBeenCalledWith(STATE_ID, 'cancel');
    expect(q('settings-mailbox-pending')).toBeNull();
    expect(q('settings-mailbox-notice')?.textContent).toBe('Die Verbindung wurde nicht hergestellt.');
    expect(lastLocation).toBe('/einstellungen/kommunikation');

    await act(async () => root.unmount());
    await mount(
      <MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [] })} loadPending={loadPending} resolvePending={resolvePending} />,
      `/einstellungen/kommunikation?postfach=bestaetigen&oauth=${STATE_ID}`,
    );
    await click('settings-mailbox-pending-confirm');
    expect(resolvePending).toHaveBeenLastCalledWith(STATE_ID, 'confirm');
    expect(q('settings-mailbox-notice')?.textContent).toBe('Das Microsoft-Postfach ist verbunden.');

    // Abgelaufen / manipulierte Kennung → nur Hinweis, keine Abfrage mit fremder Kennung.
    await act(async () => root.unmount());
    const none = vi.fn(async () => null);
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [] })} loadPending={none} />, '/einstellungen/kommunikation?postfach=bestaetigen&oauth=kaputt');
    expect(none).not.toHaveBeenCalled();
    expect(q('settings-mailbox-notice')?.textContent).toContain('abgelaufen');
  });

  it('Einstellungsseite enthält den Postfach-Bereich; ohne Cloud nur Hinweis; kein Passwortfeld auf der Seite', async () => {
    vi.mocked(supabaseLib.isSupabaseConfigured).mockReturnValue(false);
    await mount(<CommunicationSettingsPage />);
    expect(q('settings-mailbox-section')).not.toBeNull();
    expect(q('settings-mailbox-unavailable')?.textContent).toBe('Die Postfach-Anbindung ist mit Cloud-Anbindung verfügbar.');
    expect(host.querySelectorAll('input[type="password"]').length).toBe(0);
    expect(q('settings-communication-page')).not.toBeNull();
  });

  it('07E-PF: providerneutrale Anzeige — Gmail (vorbereitet) mit Label-Wortlaut; Kontowechsel wird als solcher erklärt; nur Microsoft wählbar', async () => {
    expect(CONNECTABLE_PROVIDERS).toEqual(['microsoft_graph']);
    const gmail = delegated({ id: 'conn-g', providerType: 'google_gmail', mailboxAddress: 'pilot@gmail.invalid', mailboxSourceKind: 'label', mailboxSourceName: 'OfficeTakt' });
    const pending = { stateId: STATE_ID, providerType: 'google_gmail' as const, reason: 'account_changed' as const, expectedAddress: 'pilot@gmail.invalid', detectedAddress: 'pilot@gmail.invalid', sourceKind: 'label' as const, sourceName: 'OfficeTakt', pendingUntil: '2026-09-27T10:15:00Z' };
    await mount(
      <MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [gmail] })} loadPending={async () => pending} />,
      `/einstellungen/kommunikation?postfach=bestaetigen&oauth=${STATE_ID}`,
    );
    const item = q('settings-mailbox-connection')?.textContent ?? '';
    expect(item).toContain('Gelesenes Label');
    expect(item).toContain('OfficeTakt');
    expect(item).toContain('Google-Konto');
    expect(q('settings-mailbox-pending-text')?.textContent).toBe('Unter pilot@gmail.invalid hat sich ein anderes Konto angemeldet als bisher verbunden. Soll dieses Konto übernommen werden?');
    expect(q('settings-mailbox-pending')?.textContent).toContain('Gelesen würde nur das Label „OfficeTakt".');
  });

  it('Server noch ohne Postfach-Funktionen: ehrlicher Hinweis, kein Verbinden-Knopf', async () => {
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: false, error: 'not_deployed' })} />);
    expect(q('settings-mailbox-unavailable')?.textContent).toBe('Die Microsoft-Anbindung ist in dieser Umgebung noch nicht freigeschaltet.');
    expect(q('settings-mailbox-open')).toBeNull();
  });
});
