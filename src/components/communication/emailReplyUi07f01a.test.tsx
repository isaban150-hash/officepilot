/**
 * E-MAIL 07F-01A — sichtbare Teile: „Antworten" im Maildetail (genau einmal),
 * Antwort-Editor (vorbelegt, Signatur, Zitat, Kontext, ausdrückliche
 * Bestätigung, Abbrechen), Gesprächsverlauf (Detail eingehend/ausgehend),
 * Posteingang je Verlauf, Kunden-/Vorgangshistorie. Test-Doubles, kein Netz,
 * kein Versand.
 */
import { readFileSync } from 'node:fs';
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
import { hydrateCustomerStore } from '../../services/customerStoreService';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import * as cloud from '../../services/email/emailMessageCloudService';
import { parseEmailMessageRow } from '../../services/email/emailMessageCloudService';
import * as freeEmail from '../../services/email/freeEmailOrchestrator';
import { KommunikationInboundEmailPage } from '../../pages/KommunikationInboundEmailPage';
import { KommunikationEmailComposePage, type LoadReplySource } from '../../pages/KommunikationEmailComposePage';
import { KommunikationEmailDetailPage } from '../../pages/KommunikationEmailDetailPage';
import { InboxEmailList, groupInboxByThread } from './InboxEmailList';
import { CommunicationHistorySection } from './CommunicationHistorySection';
import { buildConversation } from './EmailConversation';
import type { CompanySetup, Customer, Vorgang } from '../../types/models';
import type { EmailMessage } from '../../types/emailMessage';

const WS = '00000000-0000-4000-8000-0000000f01a0';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const GREETING = 'Mit freundlichen Grüßen';

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const value = (id: string) => (q(id) as HTMLInputElement).value;
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function click(id: string, index = 0): Promise<void> {
  const target = qa(id)[index] ?? (document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null);
  await act(async () => { target!.click(); });
  await settle();
}
let lastLocation = '';
function LocationProbe() {
  const location = useLocation();
  lastLocation = `${location.pathname}${location.search}`;
  return null;
}
async function mount(node: ReactNode, path = '/', route = '*'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}><AuthProvider><AppProvider initialSetup={setup}><LocationProbe /><Routes><Route path={route} element={node} /><Route path="*" element={<p data-testid="navigated">elsewhere</p>} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}

function inbound(patch: Record<string, unknown> = {}): EmailMessage {
  return parseEmailMessageRow({
    id: 'in-1', workspace_id: WS, client_message_id: 'in:c:1', direction: 'inbound', provider: 'microsoft_graph', provider_message_id: 'p-1',
    mailbox_connection_id: 'conn-1', internet_message_id: '<a1@icloud.invalid>', from_address: 'saban_irmak@icloud.com', from_name: 'saban_irmak@icloud.com',
    to_recipients: ['schabi82@hotmail.de'], cc_recipients: [], bcc_recipients: [],
    subject: 'OfficeTakt 07E Testmail', body_text: 'Hallo,\n\ndas ist ein Test.', has_html: false, status: 'received',
    received_at: '2026-09-27T15:04:50.000Z', imported_at: '2026-09-27T15:05:00.000Z', created_at: '2026-09-27T15:05:00.000Z',
    attempt_number: 1, row_version: 1, customer_id: null, vorgang_id: null, assignment_status: 'needs_review', assignment_source: null,
    skipped_attachments: [], attachments: [], thread_id: 't-1', rfc_message_id: 'a1@icloud.invalid', references_ids: [], reply_to_addresses: [],
    ...patch,
  })!;
}

function outbound(patch: Record<string, unknown> = {}): EmailMessage {
  return parseEmailMessageRow({
    id: 'out-1', workspace_id: WS, client_message_id: 'em-1', direction: 'outbound', provider: 'brevo', provider_message_id: '<b1@relay.invalid>',
    to_recipients: ['saban_irmak@icloud.com'], cc_recipients: [], bcc_recipients: [], subject: 'Re: OfficeTakt 07E Testmail', body_text: 'Danke für die Nachricht.',
    sender_name: 'Betrieb', reply_to_email: 'info@betrieb.invalid', status: 'provider_accepted', provider_accepted_at: '2026-09-27T16:00:00.000Z',
    created_at: '2026-09-27T15:59:00.000Z', attempt_number: 1, row_version: 3, attachments: [],
    thread_id: 't-1', reply_to_message_id: 'in-1', in_reply_to: 'a1@icloud.invalid', references_ids: ['a1@icloud.invalid'], reply_to_addresses: [],
    ...patch,
  })!;
}

const replySource = (parent: EmailMessage, ownAddresses = ['schabi82@hotmail.de']): LoadReplySource => vi.fn(async () => ({ ok: true as const, parent, ownAddresses }));

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', legalForm: 'GmbH', email: 'info@betrieb.invalid' });
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-admin', createdAt: 'x', updatedAt: 'x', version: 1 },
    workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: 'x', updatedAt: 'x' }],
  });
  await loginAsDefaultAdmin();
  hydrateCustomerStore([
    { id: 'c-1', name: 'Kunde Eins GmbH', street: '', zip: '', city: 'Bielefeld', email: 'einkauf@kunde-a.invalid', createdAt: '2026-09-01T00:00:00.000Z' } as Customer,
  ]);
  hydrateVorgangStore([
    { id: 'v-1', title: 'Badsanierung Eins', customer: 'Kunde Eins GmbH', customerId: 'c-1', baustelle: '', status: 'aktiv', documents: [], tasks: [], photos: [], createdAt: '2026-09-01', updatedAt: '2026-09-01' } as unknown as Vorgang,
  ]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Netz im Test verboten'); });
});

afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled(); // kein Versand-/Netzaufruf
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  resetTestStores();
});

describe('07F-01A — „Antworten" im Maildetail', () => {
  it('genau eine Hauptaktion „Antworten"; führt in den Antwort-Editor dieser Nachricht; Einzelmail bleibt ruhige Einzelansicht', async () => {
    await mount(
      <KommunikationInboundEmailPage loadMessage={async () => ({ ok: true, message: inbound() })} loadThread={async () => ({ ok: true, messages: [inbound()] })} />,
      '/kommunikation/eingang/in-1', '/kommunikation/eingang/:id',
    );
    expect(qa('kommunikation-inbound-reply')).toHaveLength(1);
    expect(host.textContent?.match(/Antworten/g)).toHaveLength(1);
    expect(q('kommunikation-inbound-thread')).toBeNull();
    await click('kommunikation-inbound-reply');
    expect(lastLocation).toBe('/kommunikation/email/neu?antwortAuf=in-1');
  });

  it('ohne Cloud keine Antwort-Aktion', async () => {
    vi.mocked(supabaseLib.isSupabaseConfigured).mockReturnValue(false);
    await mount(
      <KommunikationInboundEmailPage loadMessage={async () => ({ ok: true, message: inbound() })} loadThread={async () => ({ ok: true, messages: [] })} />,
      '/kommunikation/eingang/in-1', '/kommunikation/eingang/:id',
    );
    expect(q('kommunikation-inbound-reply')).toBeNull();
  });

  it('Gesprächsverlauf: älteste zuerst, eingehend/ausgehend unterscheidbar, echter Versandstatus (kein „zugestellt"/„gelesen"), aktuelle Nachricht markiert', async () => {
    const reply = inbound({ id: 'in-2', provider_message_id: 'p-2', subject: 'AW: Re: OfficeTakt 07E Testmail', body_text: 'Danke zurück.', received_at: '2026-09-27T17:00:00.000Z', reply_to_message_id: 'out-1', in_reply_to: 'b1@relay.invalid' });
    const failedRetry = outbound({ id: 'out-2', client_message_id: 'em-2', status: 'failed', provider_message_id: null, provider_accepted_at: null, failed_at: '2026-09-27T18:00:00.000Z', error_category: 'provider', error_message_safe: 'Der Versanddienst hat den Auftrag nicht angenommen.', created_at: '2026-09-27T18:00:00.000Z', subject: 'Re: OfficeTakt 07E Testmail', reply_to_message_id: 'in-2' });
    const thread = [reply, inbound(), outbound(), failedRetry];
    await mount(
      <KommunikationInboundEmailPage loadMessage={async () => ({ ok: true, message: reply })} loadThread={async () => ({ ok: true, messages: thread })} />,
      '/kommunikation/eingang/in-2', '/kommunikation/eingang/:id',
    );
    expect(q('kommunikation-inbound-thread')).not.toBeNull();
    const items = qa('kommunikation-inbound-conversation-item');
    expect(items.map((item) => item.getAttribute('data-direction'))).toEqual(['inbound', 'outbound', 'inbound', 'outbound']);
    expect(items[0].textContent).toContain('Eingegangen');
    expect(items[0].textContent).toContain('Zu prüfen');
    expect(items[1].textContent).toContain('Gesendet');
    expect(items[1].textContent).toContain('An saban_irmak@icloud.com');
    expect(items[2].getAttribute('aria-current')).toBe('true');
    expect(items[2].querySelector('[data-testid="kommunikation-inbound-conversation-open"]')).toBeNull();
    expect(items[0].querySelector('[data-testid="kommunikation-inbound-conversation-open"]')?.getAttribute('href')).toBe('/kommunikation/eingang/in-1');
    expect(items[1].querySelector('[data-testid="kommunikation-inbound-conversation-open"]')?.getAttribute('href')).toBe('/kommunikation/email/out-1');
    expect(items[3].textContent).toContain('Der Versanddienst hat den Auftrag nicht angenommen.');
    const statuses = qa('kommunikation-inbound-conversation-status').map((node) => node.textContent ?? '');
    expect(statuses).toHaveLength(2);
    for (const text of statuses) expect(text).not.toMatch(/zugestellt|gelesen/i);
    // Betreff nur, wo er sich unterscheidet („Re:"/„AW:" zählen nicht).
    expect(qa('kommunikation-inbound-conversation-subject')).toHaveLength(0);
    // Text nie als HTML.
    expect(host.querySelector('.email-conversation script, .email-conversation b')).toBeNull();
    expect(qa('kommunikation-inbound-reply')).toHaveLength(1);
  });

  it('Neuversuche einer ausgehenden Mail erscheinen als EINE Nachricht mit Stand des letzten Versuchs', () => {
    const first = outbound({ id: 'o-a', status: 'failed', provider_message_id: null, provider_accepted_at: null, failed_at: 'x', error_category: 'provider' });
    const second = outbound({ id: 'o-b', client_message_id: 'em-b', retry_of_message_id: 'o-a', attempt_number: 2, status: 'provider_accepted' });
    const entries = buildConversation([inbound(), first, second]);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ attempts: 2, message: { id: 'o-b', status: 'provider_accepted' } });
  });
});

describe('07F-01A — Antwort-Editor', () => {
  it('reale Testmail: An = saban_irmak@icloud.com, „Re:" ohne Kette, Signatur, kompaktes Zitat, keine erfundene Zuordnung, Anhänge möglich', async () => {
    await mount(<KommunikationEmailComposePage loadReplySource={replySource(inbound())} />, '/kommunikation/email/neu?antwortAuf=in-1');
    expect(q('kommunikation-email-compose')?.querySelector('h1')?.textContent).toBe('Antworten');
    expect(value('free-email-to')).toBe('saban_irmak@icloud.com');
    expect(value('free-email-subject')).toBe('Re: OfficeTakt 07E Testmail');
    const body = value('free-email-body');
    expect(body.split(GREETING)).toHaveLength(2);
    expect(body).toContain('schrieb saban_irmak@icloud.com:\n> Hallo,\n>\n> das ist ein Test.');
    expect(body.indexOf(GREETING)).toBeLessThan(body.indexOf('> Hallo'));
    expect(value('free-email-customer')).toBe('');
    expect(value('free-email-vorgang')).toBe('');
    expect(q('kommunikation-reply-original-subject')?.textContent).toBe('OfficeTakt 07E Testmail');
    expect(q('kommunikation-reply-recipient-problem')).toBeNull();
    expect(q('free-email-attachments')).not.toBeNull();
    expect(q('free-email-send')?.textContent).toBe('Antwort prüfen und senden');
  });

  it('„AW: Re:"-Betreff normalisiert; Reply-To vor Von; Cc aus dem Original; Kunde/Vorgang per Kennung übernommen', async () => {
    const parent = inbound({ subject: 'AW: Re: Angebot Bad', from_address: 'versand@kunde-a.invalid', reply_to_addresses: ['einkauf@kunde-a.invalid'], cc_recipients: ['schabi82@hotmail.de', 'chef@kunde-a.invalid'], customer_id: 'c-1', vorgang_id: 'v-1', assignment_status: 'assigned', assignment_source: 'manual' });
    await mount(<KommunikationEmailComposePage loadReplySource={replySource(parent)} />, '/kommunikation/email/neu?antwortAuf=in-1');
    expect(value('free-email-subject')).toBe('Re: Angebot Bad');
    expect(value('free-email-to')).toBe('einkauf@kunde-a.invalid');
    expect(value('free-email-cc')).toBe('chef@kunde-a.invalid');
    expect(q('free-email-bcc')).not.toBeNull();
    expect(value('free-email-bcc')).toBe('');
    expect(value('free-email-customer')).toBe('c-1');
    expect(value('free-email-vorgang')).toBe('v-1');
  });

  it('eigene Firmenadresse als Absender → „An" leer mit klarem Hinweis (keine stille Fehladressierung)', async () => {
    await mount(<KommunikationEmailComposePage loadReplySource={replySource(inbound({ from_address: 'schabi82@hotmail.de' }))} />, '/kommunikation/email/neu?antwortAuf=in-1');
    expect(value('free-email-to')).toBe('');
    expect(q('kommunikation-reply-recipient-problem')?.textContent).toContain('eigenen Firmenadresse');
  });

  it('kein Senden ohne ausdrückliche Bestätigung; Abbrechen im Dialog sendet nicht; Bestätigen sendet genau einmal mit Antwortbezug', async () => {
    const send = vi.spyOn(freeEmail, 'sendFreeEmail').mockImplementation(async (draft) => ({ ok: true, action: 'sent', message: outbound({ id: 'out-9', reply_to_message_id: draft.replyToMessageId }), chain: [] }));
    await mount(<KommunikationEmailComposePage loadReplySource={replySource(inbound())} />, '/kommunikation/email/neu?antwortAuf=in-1');
    await click('free-email-send');
    expect(send).not.toHaveBeenCalled();
    const dialog = document.querySelector('[data-testid="kommunikation-reply-confirm"]');
    expect(dialog?.textContent).toContain('saban_irmak@icloud.com');
    expect(dialog?.textContent).toContain('Re: OfficeTakt 07E Testmail');
    await click('kommunikation-reply-confirm-cancel');
    expect(send).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="kommunikation-reply-confirm"]')).toBeNull();
    await click('free-email-send');
    await click('kommunikation-reply-confirm-send');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ replyToMessageId: 'in-1', to: 'saban_irmak@icloud.com', subject: 'Re: OfficeTakt 07E Testmail' });
    expect(lastLocation).toBe('/kommunikation/email/out-9');
  });

  it('Abbrechen/Verwerfen: nichts gesendet, Antwort-Entwurf gelöscht, zurück zur E-Mail; freier Entwurf bleibt', async () => {
    const send = vi.spyOn(freeEmail, 'sendFreeEmail');
    freeEmail.createFreeEmailDraft({ subject: 'Freier Entwurf' });
    await mount(<KommunikationEmailComposePage loadReplySource={replySource(inbound())} />, '/kommunikation/email/neu?antwortAuf=in-1');
    expect(value('free-email-subject')).toBe('Re: OfficeTakt 07E Testmail');
    expect(freeEmail.loadFreeEmailDraft(undefined, 'in-1')).not.toBeNull();
    await click('free-email-discard');
    expect(send).not.toHaveBeenCalled();
    expect(lastLocation).toBe('/kommunikation/eingang/in-1');
    expect(freeEmail.loadFreeEmailDraft(undefined, 'in-1')).toBeNull();
    expect(freeEmail.loadFreeEmailDraft()?.subject).toBe('Freier Entwurf');
  });

  it('Verlaufs-Migration noch nicht aktiv: Original über den 07E-Weg, eigene Postfachadresse bleibt ausgeschlossen', async () => {
    const thread = vi.spyOn(cloud, 'rpcGetEmailThread').mockResolvedValue({ ok: false, error: 'not_deployed' });
    const single = vi.spyOn(cloud, 'rpcGetInboundEmailMessage').mockResolvedValue({ ok: true, message: inbound({ thread_id: null }) });
    vi.spyOn(cloud, 'rpcListMailboxConnections').mockResolvedValue({ ok: true, connections: [] } as never);
    await mount(<KommunikationEmailComposePage />, '/kommunikation/email/neu?antwortAuf=in-1');
    expect(thread).toHaveBeenCalledWith({ workspaceId: WS, messageId: 'in-1' });
    expect(single).toHaveBeenCalledWith({ workspaceId: WS, messageId: 'in-1' });
    expect(value('free-email-to')).toBe('saban_irmak@icloud.com');
    expect(value('free-email-subject')).toBe('Re: OfficeTakt 07E Testmail');
  });

  it('Original nicht gefunden → klare Meldung, kein Editor', async () => {
    await mount(<KommunikationEmailComposePage loadReplySource={vi.fn(async () => ({ ok: true as const, parent: null, ownAddresses: [] }))} />, '/kommunikation/email/neu?antwortAuf=weg');
    expect(q('kommunikation-reply-missing')).not.toBeNull();
    expect(q('free-email-send')).toBeNull();
  });

  it('ohne Antwortbezug unverändert der 07D-Editor', async () => {
    const load = vi.fn();
    await mount(<KommunikationEmailComposePage loadReplySource={load as never} />, '/kommunikation/email/neu');
    expect(load).not.toHaveBeenCalled();
    expect(q('kommunikation-email-compose')?.querySelector('h1')?.textContent).toBe('Neue E-Mail');
    expect(q('kommunikation-reply-original')).toBeNull();
    expect(q('free-email-send')?.textContent).toBe('E-Mail senden');
  });
});

describe('07F-01A — Posteingang, Gesendet-Detail, Historie', () => {
  it('Posteingang je Verlauf: neueste eingehende Nachricht, Anzahl im Verlauf; unabhängige Mails bleiben getrennt', async () => {
    const reply = inbound({ id: 'in-2', provider_message_id: 'p-2', subject: 'AW: Re: OfficeTakt 07E Testmail', received_at: '2026-09-27T17:00:00.000Z' });
    const fwd = inbound({ id: 'in-3', provider_message_id: 'p-3', subject: 'Fwd: OfficeTakt 07E Testmail', thread_id: 't-3', received_at: '2026-09-27T15:57:51.000Z' });
    expect(groupInboxByThread([inbound(), reply, fwd, outbound()]).map((entry) => [entry.message.id, entry.count])).toEqual([['in-2', 2], ['in-3', 1]]);
    await mount(<InboxEmailList loadInbox={async () => ({ ok: true, messages: [inbound(), reply, fwd] })} loadConnections={async () => ({ ok: true, connections: [] })} />);
    const items = qa('kommunikation-inbox-item').map((item) => item.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('AW: Re: OfficeTakt 07E Testmail');
    expect(items[0]).toContain('2 Nachrichten im Verlauf');
    expect(items[1]).toContain('Fwd: OfficeTakt 07E Testmail');
    expect(items[1]).not.toContain('Nachrichten im Verlauf');
    // Ohne Thread-Kennung (Migration noch nicht aktiv): jede Nachricht einzeln.
    expect(groupInboxByThread([inbound({ thread_id: null }), inbound({ id: 'in-x', provider_message_id: 'p-x', thread_id: null })])).toHaveLength(2);
  });

  it('Gesendet-Detail einer Antwort zeigt den Verlauf', async () => {
    await mount(
      <KommunikationEmailDetailPage loadChain={async () => ({ ok: true, messages: [outbound()] })} loadThread={async () => ({ ok: true, messages: [inbound(), outbound()] })} />,
      '/kommunikation/email/out-1', '/kommunikation/email/:id',
    );
    const items = qa('kommunikation-email-detail-conversation-item');
    expect(items.map((item) => item.getAttribute('data-direction'))).toEqual(['inbound', 'outbound']);
    expect(items[1].getAttribute('aria-current')).toBe('true');
  });

  it('Antwort mit Kontext erscheint per Kennung in Kunden- und Vorgangshistorie', async () => {
    const answer = outbound({ customer_id: 'c-1', vorgang_id: 'v-1' });
    const loadEmails = vi.fn(async (target: { customerId?: string; vorgangId?: string }) => ({ ok: true as const, messages: target.customerId === 'c-1' || target.vorgangId === 'v-1' ? [answer] : [] }));
    for (const target of [{ customerId: 'c-1' }, { vorgangId: 'v-1' }]) {
      await mount(<CommunicationHistorySection target={target} testId="hist" load={async () => ({ ok: true, threads: [], incomplete: false }) as never} loadEmails={loadEmails} loadInbound={async () => ({ ok: true, messages: [] })} />);
      const rows = qa('hist-email-thread').map((row) => row.textContent ?? '');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain('Re: OfficeTakt 07E Testmail');
      await act(async () => root.unmount());
      document.body.innerHTML = '';
    }
    expect(loadEmails).toHaveBeenCalledWith({ customerId: 'c-1' });
    expect(loadEmails).toHaveBeenCalledWith({ vorgangId: 'v-1' });
    root = createRoot(document.createElement('div'));
  });

  it('Mobile: lange Adressen/Betreffe brechen um, keine Verbreiterung', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const block = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
    expect(block('.email-conversation__item')).toMatch(/min-width: 0;[\s\S]*overflow-wrap: anywhere;/);
    expect(block('.email-conversation__body')).toMatch(/white-space: pre-wrap;[\s\S]*overflow-wrap: anywhere;/);
    expect(block('.email-reply-original')).toMatch(/overflow-wrap: anywhere;/);
    expect(block('.email-conversation__head')).toMatch(/flex-wrap: wrap;/);
  });
});
