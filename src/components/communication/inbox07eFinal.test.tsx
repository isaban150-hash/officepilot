/**
 * E-MAIL-07E — Finalisierung nach bestandenem realen Microsoft-Inbound-Test:
 * „Neue E-Mails" auf Heute, „Zum Posteingang" in den Einstellungen,
 * 10-s-Cooldown für „Jetzt abrufen" (Client + Server-Hilfe), keine
 * Diagnose-Requests mehr. Test-Doubles, kein Netz, kein Abruf, kein Versand.
 */
import { readFileSync } from 'node:fs';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
import { parseEmailMessageRow } from '../../services/email/emailMessageCloudService';
import { manualSyncCooldownRemaining, MANUAL_SYNC_COOLDOWN_SECONDS } from '../../../supabase/functions/_shared/inboundSyncCore';
import { HomeNewEmails, HOME_NEW_EMAILS_MAX } from '../home/HomeNewEmails';
import { InboxEmailList, inboundSenderLabel, MANUAL_SYNC_COOLDOWN_SECONDS as CLIENT_COOLDOWN } from './InboxEmailList';
import { MailboxSettingsSection } from './MailboxSettingsSection';
import type { CompanySetup } from '../../types/models';
import type { EmailMessage, MailboxConnection } from '../../types/emailMessage';

const WS = '00000000-0000-4000-8000-0000000007e9';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function mount(node: ReactNode, path = '/'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}><AuthProvider><AppProvider initialSetup={setup}><Routes><Route path="*" element={node} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}
function inbound(id: string, subject: string, receivedAt: string, status: 'needs_review' | 'assigned' = 'needs_review'): EmailMessage {
  return parseEmailMessageRow({
    id, workspace_id: WS, client_message_id: `in:${id}`, direction: 'inbound', provider: 'microsoft_graph', provider_message_id: `p-${id}`,
    mailbox_connection_id: 'conn-1', from_address: 'saban_irmak@icloud.invalid', from_name: null, to_recipients: ['schabi@hotmail.invalid'], cc_recipients: [], bcc_recipients: [],
    subject, body_text: 'x', has_html: false, status: 'received', received_at: receivedAt, imported_at: receivedAt, created_at: receivedAt,
    attempt_number: 1, row_version: 1, assignment_status: status, skipped_attachments: [], attachments: [],
  })!;
}
const connection: MailboxConnection = { id: 'conn-1', providerType: 'microsoft_graph', authMode: 'delegated', mailboxAddress: 'schabi@hotmail.invalid', status: 'connected', hasCredentials: true, mailboxSourceKind: 'folder', mailboxSourceName: 'OfficeTakt-Test' };

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
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await act(async () => root?.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  resetTestStores();
});

describe('E-MAIL-07E Finalisierung — „Neue E-Mails" auf Heute', () => {
  it('höchstens drei neueste mit Absender, Betreff, Zeit, „Zu prüfen"; „Alle ansehen" → /kommunikation; Zeile → Detail', async () => {
    const mails = [
      inbound('a', 'OfficeTakt 07E Testmail', '2026-09-27T15:04:50Z'),
      inbound('b', 'Fwd: OfficeTakt 07E Testmail', '2026-09-27T15:57:51Z'),
      inbound('c', 'Älter', '2026-09-20T08:00:00Z', 'assigned'),
      inbound('d', 'Noch älter', '2026-09-10T08:00:00Z', 'assigned'),
    ];
    await mount(<HomeNewEmails load={async () => ({ ok: true, messages: mails })} />);
    const rows = qa('home-new-emails-item');
    expect(HOME_NEW_EMAILS_MAX).toBe(3);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Fwd: OfficeTakt 07E Testmail');
    expect(rows[0].textContent).toContain('saban_irmak@icloud.invalid');
    expect(rows[0].textContent).toMatch(/27\.09\.2026, \d{2}:57/);
    expect(rows[0].textContent).toContain('Zu prüfen');
    expect(rows[2].textContent).toContain('Älter');
    expect(rows[0].getAttribute('href')).toBe('/kommunikation/eingang/b');
    expect(q('home-new-emails-all')?.getAttribute('href')).toBe('/kommunikation');
    expect(q('heute-section-new-emails')?.textContent).toContain('Neue E-Mails');
  });

  it('leer → ruhiger Hinweis; ohne Cloud → kein Feld; Fehler → Hinweis statt Absturz', async () => {
    await mount(<HomeNewEmails load={async () => ({ ok: true, messages: [] })} />);
    expect(q('home-new-emails-empty')?.textContent).toBe('Noch keine eingegangenen E-Mails.');
    await act(async () => root.unmount());
    await mount(<HomeNewEmails load={async () => ({ ok: false, error: 'cloud_only' })} />);
    expect(q('heute-section-new-emails')).toBeNull();
    await act(async () => root.unmount());
    await mount(<HomeNewEmails load={async () => ({ ok: false, error: 'server_unavailable' as never })} />);
    expect(q('home-new-emails-unavailable')?.textContent).toBe('Die E-Mails konnten gerade nicht geladen werden.');
  });

  it('Heute-Seite bindet das Feld ein (vor „Neu im Eingang")', () => {
    const source = readFileSync('src/pages/HeutePage.tsx', 'utf8');
    expect(source.indexOf('<HomeNewEmails />')).toBeGreaterThan(-1);
    expect(source.indexOf('<HomeNewEmails />')).toBeLessThan(source.indexOf('<HomeNewIntake />'));
  });
});

describe('E-MAIL-07E UI-Polish — Absender, Trennpunkt, Anführungszeichen', () => {
  it('zentraler Absender-Formatter: Name nur, wenn echt verschieden von der Adresse', () => {
    expect(inboundSenderLabel({ fromName: 'saban_irmak@icloud.com', fromAddress: 'saban_irmak@icloud.com' })).toBe('saban_irmak@icloud.com');
    expect(inboundSenderLabel({ fromName: ' "Saban_Irmak@iCloud.com" ', fromAddress: 'saban_irmak@icloud.com' })).toBe('saban_irmak@icloud.com');
    expect(inboundSenderLabel({ fromName: '<saban_irmak@icloud.com>', fromAddress: 'saban_irmak@icloud.com' })).toBe('saban_irmak@icloud.com');
    expect(inboundSenderLabel({ fromName: '', fromAddress: 'a@b.de' })).toBe('a@b.de');
    expect(inboundSenderLabel({ fromName: undefined, fromAddress: 'a@b.de' })).toBe('a@b.de');
    expect(inboundSenderLabel({ fromName: 'Max Mustermann', fromAddress: 'max@example.de' })).toBe('Max Mustermann <max@example.de>');
    expect(inboundSenderLabel({ fromName: 'Max Mustermann', fromAddress: undefined })).toBe('Max Mustermann');
    expect(inboundSenderLabel({ fromName: undefined, fromAddress: undefined })).toBe('—');
  });

  it('Heute, Posteingang, Historie und Detail nutzen denselben Formatter', () => {
    for (const file of ['src/components/home/HomeNewEmails.tsx', 'src/components/communication/CommunicationHistorySection.tsx', 'src/pages/KommunikationInboundEmailPage.tsx']) {
      expect(readFileSync(file, 'utf8')).toContain('inboundSenderLabel(message)');
    }
  });

  it('Heute: Absender mit Name = Adresse erscheint nur einmal', async () => {
    const mail = parseEmailMessageRow({
      id: 'x', workspace_id: WS, client_message_id: 'in:x', direction: 'inbound', provider: 'microsoft_graph', provider_message_id: 'p-x', mailbox_connection_id: 'conn-1',
      from_address: 'saban_irmak@icloud.com', from_name: 'saban_irmak@icloud.com', to_recipients: [], cc_recipients: [], bcc_recipients: [], subject: 'OfficeTakt 07E Testmail',
      body_text: 'x', has_html: false, status: 'received', received_at: '2026-09-27T15:04:50Z', imported_at: '2026-09-27T15:04:50Z', created_at: '2026-09-27T15:04:50Z',
      attempt_number: 1, row_version: 1, assignment_status: 'needs_review', skipped_attachments: [], attachments: [],
    })!;
    await mount(<HomeNewEmails load={async () => ({ ok: true, messages: [mail] })} />);
    const text = q('home-new-emails-item')?.textContent ?? '';
    expect(text).toContain('saban_irmak@icloud.com');
    expect(text).not.toContain('<saban_irmak@icloud.com>');
  });

  it('Firmenpostfach: Trennpunkt hängt am vorigen Abschnitt (kein „·" am Zeilenanfang möglich)', async () => {
    await mount(<InboxEmailList loadInbox={async () => ({ ok: true, messages: [] })} loadConnections={async () => ({ ok: true, connections: [{ ...connection, lastSuccessfulSyncAt: '2026-09-27T18:45:05Z' }] })} />, '/kommunikation');
    const segments = Array.from(host.querySelectorAll('[data-testid="kommunikation-mailbox-connection"] .inbox-email-list__segment')).map((el) => el.textContent ?? '');
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatch(/schabi@hotmail\.invalid ·$/);
    expect(segments[1]).toMatch(/^Verbunden ·$/);
    expect(segments[2]).toMatch(/^Zuletzt abgerufen: 27\.09\.2026, \d{2}:45$/);
    // Kein eigenständiger Trennpunkt-Knoten als Flex-Element.
    const li = host.querySelector('[data-testid="kommunikation-mailbox-connection"]')!;
    expect(Array.from(li.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').includes('·'))).toBe(false);
    expect(readFileSync('src/index.css', 'utf8')).toMatch(/\.inbox-email-list__segment \{\s*white-space: nowrap;/);
  });

  it('Filtertext mit korrektem deutschen Schlusszeichen (de/tr/bg)', async () => {
    await mount(<InboxEmailList loadInbox={async () => ({ ok: true, messages: [] })} loadConnections={async () => ({ ok: true, connections: [connection] })} />, '/kommunikation');
    expect(host.querySelector('.inbox-email-list__filter')?.textContent?.trim()).toBe('Nur „Zu prüfen“');
    for (const lang of ['de', 'tr', 'bg']) {
      const line = readFileSync(`src/i18n/locales/${lang}/inboundEmail.ts`, 'utf8').split('\n').find((l) => l.includes("'inboundEmail.inbox.filterReview'"))!;
      expect(line).toMatch(/„[^"“]+“'/);
    }
  });
});

describe('E-MAIL-07E Finalisierung — „Zum Posteingang" in den Einstellungen', () => {
  it('verbundenes Postfach → Link /kommunikation; getrennt → kein Link', async () => {
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [connection] })} />, '/einstellungen/kommunikation');
    expect(q('settings-mailbox-to-inbox')?.textContent).toBe('Zum Posteingang');
    expect(q('settings-mailbox-to-inbox')?.getAttribute('href')).toBe('/kommunikation');
    await act(async () => root.unmount());
    await mount(<MailboxSettingsSection loadConnections={async () => ({ ok: true, connections: [{ ...connection, status: 'disconnected', hasCredentials: false }] })} />, '/einstellungen/kommunikation');
    expect(q('settings-mailbox-to-inbox')).toBeNull();
  });
});

describe('E-MAIL-07E Finalisierung — Abruf-Cooldown', () => {
  it('Client: nach einem Abruf 10 s gesperrt mit Countdown, Doppelklick löst keinen zweiten Abruf aus', async () => {
    const sync = vi.fn(async () => ({ ok: true as const, action: 'synced' as const, imported: 0, failed: 0, more: false }));
    await mount(<InboxEmailList loadInbox={async () => ({ ok: true, messages: [] })} loadConnections={async () => ({ ok: true, connections: [connection] })} sync={sync} />, '/kommunikation');
    const button = () => q('kommunikation-mailbox-sync') as HTMLButtonElement;
    await act(async () => { button().click(); button().click(); });
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(CLIENT_COOLDOWN).toBe(10);
    expect(button().disabled).toBe(true);
    expect(q('kommunikation-mailbox-cooldown')?.textContent).toMatch(/Erneuter Abruf in (9|10) s möglich\./);
    await act(async () => { button().click(); });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(q('kommunikation-mailbox-notice')?.textContent).toBe('Abruf abgeschlossen: 0 neue E-Mails.');
  });

  it('Client: Server meldet Cooldown → Hinweis, gesperrt, kein Fehler', async () => {
    const sync = vi.fn(async () => ({ ok: true as const, action: 'cooldown' as const, retryAfterSeconds: 7 }));
    await mount(<InboxEmailList loadInbox={async () => ({ ok: true, messages: [] })} loadConnections={async () => ({ ok: true, connections: [connection] })} sync={sync} />, '/kommunikation');
    await act(async () => { (q('kommunikation-mailbox-sync') as HTMLButtonElement).click(); });
    await settle();
    expect(q('kommunikation-mailbox-notice')?.textContent).toBe('Bitte einen Moment warten, bevor erneut abgerufen wird.');
    expect((q('kommunikation-mailbox-sync') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Server: Restwartezeit seit letztem Versuch; Prüfung vor dem Abruf in sync-mailbox', () => {
    const now = Date.parse('2026-09-27T18:00:10Z');
    expect(MANUAL_SYNC_COOLDOWN_SECONDS).toBe(10);
    expect(manualSyncCooldownRemaining('2026-09-27T18:00:05Z', now)).toBe(5);
    expect(manualSyncCooldownRemaining('2026-09-27T18:00:00Z', now)).toBe(0);
    expect(manualSyncCooldownRemaining('2026-09-27T17:00:00Z', now)).toBe(0);
    expect(manualSyncCooldownRemaining(null, now)).toBe(0);
    expect(manualSyncCooldownRemaining('kaputt', now)).toBe(0);
    const source = readFileSync('supabase/functions/sync-mailbox/index.ts', 'utf8');
    expect(source.indexOf('manualSyncCooldownRemaining(')).toBeGreaterThan(-1);
    expect(source.indexOf('manualSyncCooldownRemaining(')).toBeLessThan(source.indexOf('await runInboundSync('));
    expect(source).toContain("action: 'cooldown'");
  });

  it('keine temporären Ordner-Diagnose-Requests mehr im Graph-Adapter', () => {
    const source = readFileSync('supabase/functions/_shared/inboundMailProvider.ts', 'utf8');
    expect(source).not.toMatch(/totalItemCount|diagnoseFolder|childFolderCount/);
    expect(source).toContain("GRAPH_DELTA_QUERY_VERSION = 'q3'");
  });
});
