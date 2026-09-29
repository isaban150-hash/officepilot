/**
 * E-MAIL 07F-01C — Antwortentwurf im Antwort-Editor: nur im Antwortmodus,
 * Ladezustand, Einsetzen vor Signatur/Zitat, Bearbeiten, Neu vorbereiten mit
 * Bestätigung, Grenze 3, Verwerfen, Platzhalter-Versandsperre, Fehler, bereits
 * beantwortet, deterministische Felder unverändert, kein Versand ohne
 * Bestätigung. Test-Doubles, kein Netz, kein Versand.
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
import { parseEmailMessageRow } from '../../services/email/emailMessageCloudService';
import * as freeEmail from '../../services/email/freeEmailOrchestrator';
import { KommunikationEmailComposePage, type LoadReplySource, type PrepareReplyDraft } from '../../pages/KommunikationEmailComposePage';
import type { CompanySetup, Customer, Vorgang } from '../../types/models';
import type { EmailMessage } from '../../types/emailMessage';
import type { EmailReplyDraftResult } from '../../services/email/emailReplyAiService';

const WS = '00000000-0000-4000-8000-0000000f01c0';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const GREETING = 'Mit freundlichen Grüßen';
const REPLY_PATH = '/kommunikation/email/neu?antwortAuf=in-1';

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => (host.querySelector(`[data-testid="${id}"]`) ?? document.querySelector(`[data-testid="${id}"]`)) as HTMLElement | null;
const qa = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const value = (id: string) => (q(id) as HTMLInputElement).value;
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function click(id: string): Promise<void> {
  await act(async () => { q(id)!.click(); });
  await settle();
}
async function type(id: string, text: string): Promise<void> {
  const el = q(id) as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
let lastLocation = '';
function LocationProbe() {
  const location = useLocation();
  lastLocation = `${location.pathname}${location.search}`;
  return null;
}
async function mount(node: ReactNode, path = REPLY_PATH): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}><AuthProvider><AppProvider initialSetup={setup}><LocationProbe /><Routes><Route path="/kommunikation/email/neu" element={node} /><Route path="*" element={<p data-testid="navigated">x</p>} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}

function inbound(patch: Record<string, unknown> = {}): EmailMessage {
  return parseEmailMessageRow({
    id: 'in-1', workspace_id: WS, client_message_id: 'in:1', direction: 'inbound', provider: 'microsoft_graph', provider_message_id: 'p-1', mailbox_connection_id: 'c',
    from_address: 'saban_irmak@icloud.com', from_name: 'saban_irmak@icloud.com', to_recipients: ['schabi82@hotmail.de'], cc_recipients: ['kollege@kunde.invalid'], bcc_recipients: [],
    subject: 'OfficeTakt 07E Testmail', body_text: 'Hallo,\n\nwann können Sie mit den Arbeiten beginnen?', has_html: false, status: 'received',
    received_at: '2026-09-27T15:04:50.000Z', imported_at: 'x', created_at: 'x', attempt_number: 1, row_version: 1, assignment_status: 'assigned', assignment_source: 'manual',
    customer_id: 'c-1', vorgang_id: 'v-1', attachments: [], thread_id: 't-1', rfc_message_id: 'a1@icloud.invalid', references_ids: [], reply_to_addresses: [],
    ...patch,
  })!;
}
function outbound(): EmailMessage {
  return parseEmailMessageRow({
    id: 'out-1', workspace_id: WS, client_message_id: 'em-1', direction: 'outbound', provider: 'brevo', provider_message_id: '<b@relay.invalid>', to_recipients: ['saban_irmak@icloud.com'],
    cc_recipients: [], bcc_recipients: [], subject: 'Re: OfficeTakt 07E Testmail', body_text: 'x', sender_name: 'Betrieb', reply_to_email: 'info@betrieb.invalid', status: 'provider_accepted',
    provider_accepted_at: '2026-09-28T09:41:08.000Z', created_at: '2026-09-28T09:41:00.000Z', attempt_number: 1, row_version: 3, attachments: [], thread_id: 't-1',
  })!;
}
const source = (thread?: EmailMessage[]): LoadReplySource => async () => ({ ok: true, parent: inbound(), ownAddresses: ['schabi82@hotmail.de'], thread: thread ?? [inbound()] });
const draftOf = () => freeEmail.loadFreeEmailDraft(undefined, 'in-1')!;

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
  hydrateCustomerStore([{ id: 'c-1', name: 'Kunde Eins GmbH', street: '', zip: '', city: 'X', email: 'saban_irmak@icloud.com', createdAt: '2026-09-01T00:00:00.000Z' } as Customer]);
  hydrateVorgangStore([{ id: 'v-1', title: 'Badsanierung Eins', customer: 'Kunde Eins GmbH', customerId: 'c-1', baustelle: '', status: 'aktiv', documents: [], tasks: [], photos: [], createdAt: '2026-09-01', updatedAt: '2026-09-01' } as unknown as Vorgang]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Netz im Test verboten'); });
});

afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled(); // 40/41: kein send-email, keine Nachricht angelegt
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  resetTestStores();
});

describe('07F-01C — Antwortentwurf im Antwort-Editor', () => {
  it('25: Aktion nur im Antwortmodus, nicht bei freier neuer E-Mail', async () => {
    await mount(<KommunikationEmailComposePage loadReplySource={source()} prepareReplyDraft={vi.fn()} />, '/kommunikation/email/neu');
    expect(q('kommunikation-reply-ai-generate')).toBeNull();
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    await mount(<KommunikationEmailComposePage loadReplySource={source()} prepareReplyDraft={vi.fn()} />);
    expect(q('kommunikation-reply-ai-generate')?.textContent).toBe('Antwortentwurf vorbereiten');
    expect(q('kommunikation-reply-ai-remaining')?.textContent).toBe('Noch 3 von 3 Vorschlägen');
  });

  it('26–30, 43–47: Ladezustand; Text vor Signatur/Zitat (je genau einmal); editierbar; deterministische Felder unverändert; kein Versand', async () => {
    let resolve!: (value: EmailReplyDraftResult) => void;
    const prepare: PrepareReplyDraft = vi.fn(() => new Promise<EmailReplyDraftResult>((r) => { resolve = r; }));
    const send = vi.spyOn(freeEmail, 'sendFreeEmail');
    await mount(<KommunikationEmailComposePage loadReplySource={source()} prepareReplyDraft={prepare} />);
    const before = draftOf();
    await click('kommunikation-reply-ai-generate');
    expect(prepare).toHaveBeenCalledWith({ parent: expect.objectContaining({ id: 'in-1' }), thread: [expect.objectContaining({ id: 'in-1' })] });
    expect(q('kommunikation-reply-ai-loading')?.textContent).toContain('Es wird nichts gesendet.');
    expect(q('kommunikation-reply-ai-generate')?.hasAttribute('disabled')).toBe(true);
    expect((q('free-email-send') as HTMLButtonElement).disabled).toBe(true);
    expect(q('free-email-body')?.closest('fieldset')?.hasAttribute('disabled')).toBe(true);
    await act(async () => { resolve({ ok: true, body: 'Guten Tag,\n\nvielen Dank für Ihre Nachricht.', placeholders: [] }); });
    await settle();
    const body = value('free-email-body');
    expect(body.startsWith('Guten Tag,\n\nvielen Dank für Ihre Nachricht.\n\n')).toBe(true);
    expect(body.split(GREETING)).toHaveLength(2);
    expect(body.split('schrieb saban_irmak@icloud.com:')).toHaveLength(2);
    expect(body.indexOf('vielen Dank')).toBeLessThan(body.indexOf(GREETING));
    expect(body.indexOf(GREETING)).toBeLessThan(body.indexOf('> Hallo'));
    const after = draftOf();
    expect({ to: after.to, cc: after.cc, bcc: after.bcc, subject: after.subject, customerId: after.customerId, vorgangId: after.vorgangId, replyToMessageId: after.replyToMessageId, clientMessageId: after.clientMessageId })
      .toEqual({ to: before.to, cc: before.cc, bcc: before.bcc, subject: before.subject, customerId: before.customerId, vorgangId: before.vorgangId, replyToMessageId: before.replyToMessageId, clientMessageId: before.clientMessageId });
    expect(after).toMatchObject({ to: 'saban_irmak@icloud.com', cc: 'kollege@kunde.invalid', subject: 'Re: OfficeTakt 07E Testmail', customerId: 'c-1', vorgangId: 'v-1', replyToMessageId: 'in-1', aiGenerations: 1 });
    expect(q('kommunikation-reply-ai-review')).not.toBeNull();
    await type('free-email-body', `${body}\nEigene Ergänzung`);
    expect(draftOf().bodyText.endsWith('Eigene Ergänzung')).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('31–33: Neu vorbereiten ersetzt den KI-Text; nach eigener Änderung erst nach Bestätigung; höchstens 3 Generierungen', async () => {
    let n = 0;
    const prepare: PrepareReplyDraft = vi.fn(async () => ({ ok: true as const, body: `Vorschlag ${++n}`, placeholders: [] }));
    await mount(<KommunikationEmailComposePage loadReplySource={source()} prepareReplyDraft={prepare} />);
    await click('kommunikation-reply-ai-generate');
    expect(q('kommunikation-reply-ai-generate')?.textContent).toBe('Neu vorbereiten');
    await click('kommunikation-reply-ai-generate');
    expect(value('free-email-body').startsWith('Vorschlag 2\n\n')).toBe(true);
    expect(value('free-email-body')).not.toContain('Vorschlag 1');
    // Eigene Änderung → Bestätigung; Abbrechen ändert nichts.
    await type('free-email-body', value('free-email-body').replace('Vorschlag 2', 'Vorschlag 2 – von mir angepasst'));
    await click('kommunikation-reply-ai-generate');
    expect(q('kommunikation-reply-ai-overwrite')).not.toBeNull();
    expect(prepare).toHaveBeenCalledTimes(2);
    await click('kommunikation-reply-ai-overwrite-cancel');
    expect(value('free-email-body')).toContain('von mir angepasst');
    await click('kommunikation-reply-ai-generate');
    await click('kommunikation-reply-ai-overwrite-confirm');
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(value('free-email-body').startsWith('Vorschlag 3\n\n')).toBe(true);
    expect(value('free-email-body').split(GREETING)).toHaveLength(2);
    // Grenze erreicht.
    expect(q('kommunikation-reply-ai-generate')?.hasAttribute('disabled')).toBe(true);
    expect(q('kommunikation-reply-ai-limit')).not.toBeNull();
    expect(q('kommunikation-reply-ai-remaining')?.textContent).toBe('Noch 0 von 3 Vorschlägen');
  });

  it('34: Entwurf verwerfbar — nichts gesendet, zurück zur E-Mail', async () => {
    const send = vi.spyOn(freeEmail, 'sendFreeEmail');
    await mount(<KommunikationEmailComposePage loadReplySource={source()} prepareReplyDraft={async () => ({ ok: true, body: 'Vorschlag', placeholders: [] })} />);
    await click('kommunikation-reply-ai-generate');
    await click('free-email-discard');
    expect(lastLocation).toBe('/kommunikation/eingang/in-1');
    expect(freeEmail.loadFreeEmailDraft(undefined, 'in-1')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('35–37, 42: Platzhalter sichtbar und sperren den Versand; normale Klammern nicht; danach normaler Versand nur über den Bestätigungsdialog', async () => {
    const send = vi.spyOn(freeEmail, 'sendFreeEmail').mockImplementation(async () => ({ ok: false, error: 'server_unavailable' }));
    await mount(<KommunikationEmailComposePage loadReplySource={source()} prepareReplyDraft={async () => ({ ok: true, body: 'Wir können ab [Termin ergänzen] beginnen. Kosten: [Betrag prüfen].', placeholders: ['[Termin ergänzen]', '[Betrag prüfen]'] })} />);
    await click('kommunikation-reply-ai-generate');
    expect(qa('kommunikation-reply-ai-placeholder').map((node) => node.textContent)).toEqual(['[Termin ergänzen]', '[Betrag prüfen]']);
    await click('free-email-send');
    expect(q('free-email-error')?.textContent).toContain('offene Platzhalter');
    expect(q('kommunikation-reply-confirm')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    // Platzhalter ersetzen; eine normale Klammer bleibt erlaubt.
    await type('free-email-body', value('free-email-body').replace('[Termin ergänzen]', 'dem 5.10.').replace('[Betrag prüfen]', 'siehe Angebot [1]'));
    expect(q('kommunikation-reply-ai-placeholders')).toBeNull();
    await click('free-email-send');
    expect(q('free-email-error')).toBeNull();
    expect(q('kommunikation-reply-confirm')).not.toBeNull();
    expect(send).not.toHaveBeenCalled();
    await click('kommunikation-reply-confirm-send');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ replyToMessageId: 'in-1', to: 'saban_irmak@icloud.com', subject: 'Re: OfficeTakt 07E Testmail' });
  });

  it('38: KI-Fehler lässt den manuellen Editor und eigenen Text unverändert nutzbar', async () => {
    await mount(<KommunikationEmailComposePage loadReplySource={source()} prepareReplyDraft={async () => ({ ok: false, error: 'timeout' })} />);
    await type('free-email-body', `Mein eigener Text\n\n${value('free-email-body').trimStart()}`);
    const manual = value('free-email-body');
    // Eigener Text → vor dem Überschreiben Bestätigung, dann Fehler: Text bleibt.
    await click('kommunikation-reply-ai-generate');
    await click('kommunikation-reply-ai-overwrite-confirm');
    expect(q('kommunikation-reply-ai-error')?.textContent).toBe('Der Vorschlag hat zu lange gedauert. Ihr Text bleibt unverändert.');
    expect(value('free-email-body')).toBe(manual);
    expect(q('free-email-body')?.closest('fieldset')?.hasAttribute('disabled')).toBe(false);
    expect((q('free-email-send') as HTMLButtonElement).disabled).toBe(false);
    for (const [error, text] of [['guard_rejected', 'ungeprüfte Angaben'], ['rate_limited', 'zu viele Vorschläge'], ['unsuitable_automated', 'automatische Nachricht'], ['unavailable', 'nicht verfügbar']] as const) {
      await act(async () => root.unmount());
      document.body.innerHTML = '';
      localStorage.clear();
      await mount(<KommunikationEmailComposePage loadReplySource={source()} prepareReplyDraft={async () => ({ ok: false, error })} />);
      await click('kommunikation-reply-ai-generate');
      expect(q('kommunikation-reply-ai-error')?.textContent).toContain(text);
    }
  });

  it('39: bereits beantwortet → Hinweis, Generierung weiter möglich', async () => {
    await mount(<KommunikationEmailComposePage loadReplySource={source([inbound(), outbound()])} prepareReplyDraft={async () => ({ ok: true, body: 'Vorschlag', placeholders: [] })} />);
    expect(q('kommunikation-reply-ai-answered')?.textContent).toBe('Auf diese E-Mail wurde im Verlauf bereits geantwortet.');
    expect(q('kommunikation-reply-ai-generate')?.hasAttribute('disabled')).toBe(false);
  });

  it('48: Mobile — Aktion und Platzhalterliste brechen um', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const block = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
    expect(block('.email-reply-ai')).toMatch(/min-width: 0;[\s\S]*overflow-wrap: anywhere;/);
    expect(block('.email-reply-ai__actions')).toMatch(/flex-wrap: wrap;/);
    expect(block('.email-reply-ai__placeholders')).toMatch(/overflow-wrap: anywhere;/);
  });
});
