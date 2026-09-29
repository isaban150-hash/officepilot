/**
 * E-MAIL-07E — sichtbare Teile der eingehenden E-Mail: Posteingang (Liste,
 * „Zu prüfen", Postfachstatus, Abruf), Reiter, Detail (nur Text, Anhänge
 * aus dem privaten Eingangs-Bucket, nicht übernommene Anhänge), manuelle
 * Zuordnung und Kunden-/Vorgangshistorie. Test-Doubles, kein Netz, kein Versand.
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
import { hydrateCustomerStore } from '../../services/customerStoreService';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { parseEmailMessageRow } from '../../services/email/emailMessageCloudService';
import { KommunikationInboundEmailPage } from '../../pages/KommunikationInboundEmailPage';
import { EmailCenter } from './EmailCenter';
import { InboxEmailList } from './InboxEmailList';
import { CommunicationHistorySection } from './CommunicationHistorySection';
import type { CompanySetup, Customer, Vorgang } from '../../types/models';
import type { EmailMessage } from '../../types/emailMessage';

const WS = '00000000-0000-4000-8000-0000000007e0';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function click(id: string, index = 0): Promise<void> {
  await act(async () => { qa(id)[index]!.click(); });
  await settle();
}
async function select(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
let lastLocation = '';
function LocationProbe() {
  const location = useLocation();
  lastLocation = `${location.pathname}${location.search}`;
  return null;
}
async function mount(node: ReactNode, path = '/kommunikation', route = '*'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}><AuthProvider><AppProvider initialSetup={setup}><LocationProbe /><Routes><Route path={route} element={node} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}

function inbound(patch: Record<string, unknown> = {}): EmailMessage {
  return parseEmailMessageRow({
    id: 'in-1', workspace_id: WS, client_message_id: 'in:c:1', direction: 'inbound', provider: 'microsoft_graph', provider_message_id: 'p-1',
    mailbox_connection_id: 'conn-1', internet_message_id: '<a@x>', from_address: 'einkauf@kunde-a.invalid', from_name: 'Anna Einkauf',
    to_recipients: ['info@betrieb.invalid'], cc_recipients: ['chef@betrieb.invalid'], bcc_recipients: [],
    subject: 'Rückfrage Aufmaß', body_text: 'Guten Tag,\n\nanbei das Aufmaß.', has_html: false, status: 'received',
    received_at: '2026-09-27T08:15:00.000Z', imported_at: '2026-09-27T08:16:00.000Z', created_at: '2026-09-27T08:16:00.000Z',
    attempt_number: 1, row_version: 1, customer_id: 'c-1', vorgang_id: null, assignment_status: 'assigned', assignment_source: 'auto_sender',
    skipped_attachments: [], attachments: [],
    ...patch,
  })!;
}

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
  hydrateCustomerStore([
    { id: 'c-1', name: 'Kunde Eins GmbH', street: '', zip: '', city: 'Bielefeld', email: 'einkauf@kunde-a.invalid', createdAt: '2026-09-01T00:00:00.000Z' } as Customer,
    { id: 'c-2', name: 'Kunde Zwei', street: '', zip: '', city: 'Lemgo', email: '', createdAt: '2026-09-01T00:00:00.000Z' } as Customer,
  ]);
  hydrateVorgangStore([
    { id: 'v-1', title: 'Badsanierung Eins', customer: 'Kunde Eins GmbH', customerId: 'c-1', baustelle: '', status: 'aktiv', documents: [], tasks: [], photos: [], createdAt: '2026-09-01', updatedAt: '2026-09-01' } as unknown as Vorgang,
    { id: 'v-2', title: 'Dach Zwei', customer: 'Kunde Zwei', customerId: 'c-2', baustelle: '', status: 'aktiv', documents: [], tasks: [], photos: [], createdAt: '2026-09-01', updatedAt: '2026-09-01' } as unknown as Vorgang,
  ]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Netz im Test verboten'); });
});

afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled(); // AB: kein Versand-/Netzaufruf
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  resetTestStores();
});

describe('E-MAIL-07E — Posteingang', () => {
  it('U: Liste neueste zuerst mit Absender, Betreff, Kontext, Anhängen und „Zu prüfen"; Filter lädt nur zu Prüfendes', async () => {
    const older = inbound({ id: 'in-alt', subject: 'Alt', received_at: '2026-09-26T08:00:00.000Z' });
    const review = inbound({ id: 'in-review', subject: 'Unbekannt', from_address: 'neu@unbekannt.invalid', from_name: null, customer_id: null, assignment_status: 'needs_review', assignment_source: null, received_at: '2026-09-27T09:00:00.000Z',
      attachments: [{ position: 1, filename: 'Plan.pdf', mime_type: 'application/pdf', size_bytes: 10, sha256: 'a'.repeat(64), storage_path: `${WS}/${'a'.repeat(64)}.pdf`, storage_bucket: 'inbound-email-attachments' }] });
    const loadInbox = vi.fn(async (needsReviewOnly: boolean) => ({ ok: true as const, messages: needsReviewOnly ? [review] : [older, inbound(), review] }));
    await mount(<InboxEmailList loadInbox={loadInbox} loadConnections={async () => ({ ok: true, connections: [] })} />);
    const items = qa('kommunikation-inbox-item').map((item) => item.textContent ?? '');
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('Unbekannt');
    expect(items[0]).toContain('Von neu@unbekannt.invalid');
    expect(items[0]).toContain('Zu prüfen');
    expect(items[0]).toContain('1 Anhang');
    expect(items[1]).toContain('Anna Einkauf <einkauf@kunde-a.invalid>');
    expect(items[1]).toContain('Kunde Eins GmbH');
    expect(items[1]).toContain('Zugeordnet');
    expect(items[2]).toContain('Alt');
    expect(q('kommunikation-inbox-link')?.getAttribute('href')).toBe('/kommunikation/eingang/in-review');
    expect(q('kommunikation-mailbox-none')?.textContent).toContain('Noch kein Firmenpostfach verbunden');
    await click('kommunikation-inbox-filter-review');
    expect(loadInbox).toHaveBeenLastCalledWith(true);
    expect(qa('kommunikation-inbox-item')).toHaveLength(1);
  });

  it('Postfachstatus: Fehler in Alltagssprache, „Jetzt abrufen" meldet das Ergebnis', async () => {
    const sync = vi.fn(async () => ({ ok: true as const, action: 'synced' as const, imported: 3, failed: 0, more: true }));
    await mount(
      <InboxEmailList
        loadInbox={async () => ({ ok: true, messages: [] })}
        loadConnections={async () => ({ ok: true, connections: [{ id: 'conn-1', providerType: 'microsoft_graph', mailboxAddress: 'info@betrieb.invalid', status: 'error', errorCategory: 'rate_limited', hasCredentials: true }] })}
        sync={sync}
      />,
    );
    expect(q('kommunikation-mailbox-connection')?.textContent).toContain('info@betrieb.invalid');
    expect(q('kommunikation-mailbox-status')?.textContent).toBe('Abruf gestört');
    expect(q('kommunikation-mailbox-error')?.textContent).toBe('Der Postfach-Anbieter bittet um eine Pause. Der Abruf wird später fortgesetzt.');
    await click('kommunikation-mailbox-sync');
    expect(sync).toHaveBeenCalledWith('conn-1');
    expect(q('kommunikation-mailbox-notice')?.textContent).toBe('Abruf abgeschlossen: 3 neue E-Mails. Weitere E-Mails werden beim nächsten Abruf übernommen.');
  });

  it('Reiter: Posteingang Standard; „Gesendet" steht in der URL und zeigt nur ausgehende Mail', async () => {
    const outbound = parseEmailMessageRow({ id: 'out-1', workspace_id: WS, client_message_id: 'em-1', to_recipients: ['kunde@example.invalid'], cc_recipients: [], bcc_recipients: [], subject: 'Gesendete Mail', body_text: 'x', sender_name: 'B', reply_to_email: 'info@betrieb.invalid', provider: 'brevo', status: 'provider_accepted', provider_accepted_at: '2026-09-27T07:00:00Z', created_at: '2026-09-27T07:00:00Z', attempt_number: 1, row_version: 3, attachments: [] })!;
    await mount(
      <EmailCenter
        inbox={{ loadInbox: async () => ({ ok: true, messages: [inbound()] }), loadConnections: async () => ({ ok: true, connections: [] }) }}
        sent={{ load: async () => ({ ok: true, messages: [outbound, inbound()] }) }}
      />,
    );
    expect(q('kommunikation-email-tab-inbox')?.getAttribute('aria-selected')).toBe('true');
    expect(q('kommunikation-inbox')).not.toBeNull();
    expect(q('kommunikation-email-new')?.getAttribute('href')).toBe('/kommunikation/email/neu');
    await click('kommunikation-email-tab-sent');
    expect(lastLocation).toBe('/kommunikation?postfach=gesendet');
    expect(q('kommunikation-inbox')).toBeNull();
    expect(qa('kommunikation-email-sent-thread').map((row) => row.textContent)).toEqual([expect.stringContaining('Gesendete Mail')]);
  });
});

describe('E-MAIL-07E — Detail und Zuordnung', () => {
  it('V/Q/T/R: Kopf, Nachricht NUR als Text (kein HTML/Skript), Anhänge aus dem privaten Eingangs-Bucket, nicht übernommene Anhänge mit Grund', async () => {
    const message = inbound({
      body_text: 'Hallo <script>alert(1)</script> <img src=x onerror="alert(2)">',
      has_html: true,
      attachments: [{ position: 1, filename: 'Aufmass.pdf', original_filename: 'Aufmaß.pdf', mime_type: 'application/pdf', size_bytes: 2048, sha256: 'a'.repeat(64), storage_path: `${WS}/${'a'.repeat(64)}.pdf`, storage_bucket: 'inbound-email-attachments' }],
      skipped_attachments: [{ filename: 'rechnung.pdf.exe', mime_type: 'application/octet-stream', size_bytes: 5, reason: 'type_not_allowed' }],
    });
    const downloadAttachment = vi.fn(async () => ({ ok: false as const, error: 'missing' as const }));
    await mount(<KommunikationInboundEmailPage loadMessage={async () => ({ ok: true, message })} downloadAttachment={downloadAttachment} />, '/kommunikation/eingang/in-1', '/kommunikation/eingang/:id');
    expect(q('kommunikation-inbound-from')?.textContent).toBe('Anna Einkauf <einkauf@kunde-a.invalid>');
    expect(q('kommunikation-inbound-to')?.textContent).toBe('info@betrieb.invalid');
    expect(q('kommunikation-inbound-cc')?.textContent).toBe('chef@betrieb.invalid');
    expect(q('kommunikation-inbound-date')?.textContent).toMatch(/^27\.09\.2026, \d{2}:15$/);
    expect(q('kommunikation-inbound-body')?.textContent).toBe('Hallo <script>alert(1)</script> <img src=x onerror="alert(2)">');
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('[data-testid="kommunikation-inbound-body"] img')).toBeNull();
    expect(q('kommunikation-inbound-html-hint')).not.toBeNull();
    expect(q('kommunikation-inbound-skipped-item')?.textContent).toBe('rechnung.pdf.exe · Dateityp nicht unterstützt');
    await click('kommunikation-inbound-attachment-download');
    expect(downloadAttachment).toHaveBeenCalledWith({ storagePath: `${WS}/${'a'.repeat(64)}.pdf`, mimeType: 'application/pdf', storageBucket: 'inbound-email-attachments' });
    expect(q('kommunikation-inbound-attachment-error')?.textContent).toBe('Der Anhang „Aufmass.pdf" ist nicht mehr verfügbar.');
  });

  it('N/P: „Zu prüfen" mit Vorschlag; Vorgang setzt den Kunden; Kunde entfernen löst den Vorgang; Speichern sendet die Auswahl an den Server', async () => {
    const message = inbound({ customer_id: null, assignment_status: 'needs_review', assignment_source: null, suggested_vorgang_id: 'v-1', row_version: 4 });
    const assign = vi.fn(async (input: { messageId: string; customerId?: string; vorgangId?: string; expectedRowVersion: number }) => ({
      ok: true as const,
      message: inbound({ customer_id: input.customerId ?? null, vorgang_id: input.vorgangId ?? null, assignment_status: 'assigned', assignment_source: 'manual', assigned_at: '2026-09-27T10:00:00Z', row_version: 5 }),
    }));
    await mount(<KommunikationInboundEmailPage loadMessage={async () => ({ ok: true, message })} assign={assign} />, '/kommunikation/eingang/in-1', '/kommunikation/eingang/:id');
    expect(q('kommunikation-inbound-status')?.textContent).toBe('Zu prüfen');
    expect(q('kommunikation-inbound-review-hint')).not.toBeNull();
    expect(q('kommunikation-inbound-suggestion')?.textContent).toContain('Badsanierung Eins');
    // Vorschlag vorbelegt (noch nicht gespeichert): Vorgang v-1, Kunde daraus.
    expect((q('kommunikation-inbound-vorgang') as HTMLSelectElement).value).toBe('v-1');
    expect((q('kommunikation-inbound-customer') as HTMLSelectElement).value).toBe('c-1');
    expect((q('kommunikation-inbound-customer') as HTMLSelectElement).disabled).toBe(true);
    // Vorgang eines anderen Kunden → Kunde folgt.
    await select('kommunikation-inbound-vorgang', 'v-2');
    expect((q('kommunikation-inbound-customer') as HTMLSelectElement).value).toBe('c-2');
    // Vorgang lösen, dann Kunde entfernen → kein widersprüchlicher Vorgang bleibt.
    await select('kommunikation-inbound-vorgang', '');
    await select('kommunikation-inbound-customer', 'c-1');
    await select('kommunikation-inbound-vorgang', 'v-1');
    await select('kommunikation-inbound-vorgang', '');
    await select('kommunikation-inbound-customer', '');
    expect((q('kommunikation-inbound-vorgang') as HTMLSelectElement).value).toBe('');
    await select('kommunikation-inbound-vorgang', 'v-1');
    await click('kommunikation-inbound-assign-save');
    expect(assign).toHaveBeenCalledWith({ messageId: 'in-1', customerId: 'c-1', vorgangId: 'v-1', expectedRowVersion: 4 });
    expect(q('kommunikation-inbound-status')?.textContent).toBe('Zugeordnet');
    expect(q('kommunikation-inbound-assignment-source')?.textContent).toBe('Manuell bestätigt');
    expect(q('kommunikation-inbound-assigned-at')).not.toBeNull();
  });

  it('Serverablehnung (Widerspruch/veraltet) wird verständlich angezeigt, nichts geändert', async () => {
    const message = inbound();
    const assign = vi.fn(async () => ({ ok: false as const, error: 'context_conflict' as const }));
    await mount(<KommunikationInboundEmailPage loadMessage={async () => ({ ok: true, message })} assign={assign} />, '/kommunikation/eingang/in-1', '/kommunikation/eingang/:id');
    await select('kommunikation-inbound-customer', 'c-2');
    await click('kommunikation-inbound-assign-save');
    expect(q('kommunikation-inbound-assign-error')?.textContent).toBe('Kunde und Vorgang passen nicht zusammen.');
    expect(q('kommunikation-inbound-status')?.textContent).toBe('Zugeordnet');
  });

  it('nicht gefunden / nicht freigeschaltet: klare Meldung', async () => {
    await mount(<KommunikationInboundEmailPage loadMessage={async () => ({ ok: true, message: null })} />, '/kommunikation/eingang/x', '/kommunikation/eingang/:id');
    expect(q('kommunikation-inbound-not-found')).not.toBeNull();
    await act(async () => root.unmount());
    host.remove();
    await mount(<KommunikationInboundEmailPage loadMessage={async () => ({ ok: false, error: 'not_deployed' })} />, '/kommunikation/eingang/x', '/kommunikation/eingang/:id');
    expect(q('kommunikation-inbound-unavailable')?.textContent).toContain('noch nicht freigeschaltet');
  });
});

describe('E-MAIL-07E — Kunden-/Vorgangshistorie', () => {
  it('W/X/AA: eingehende Mail erscheint klar benannt, chronologisch mit Versand; je Quelle genau ein Ladeaufruf', async () => {
    const load = vi.fn(async () => ({ ok: true as const, threads: [], incomplete: false }));
    const loadEmails = vi.fn(async () => ({ ok: true as const, messages: [] }));
    const newer = inbound({ id: 'in-neu', subject: 'Neue Anfrage', received_at: '2026-09-27T12:00:00.000Z' });
    const loadInbound = vi.fn(async () => ({ ok: true as const, messages: [inbound(), newer, newer] }));
    await mount(<CommunicationHistorySection target={{ customerId: 'c-1' }} testId="kunden-email-history" load={load} loadEmails={loadEmails} loadInbound={loadInbound} />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(loadEmails).toHaveBeenCalledTimes(1);
    expect(loadInbound).toHaveBeenCalledTimes(1);
    expect(loadInbound).toHaveBeenCalledWith({ customerId: 'c-1' });
    const rows = qa('kunden-email-history-inbound-thread').map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(2); // Dublette aus der Quelle nur einmal
    expect(rows[0]).toContain('Neue Anfrage');
    expect(rows[0]).toContain('Eingehende E-Mail');
    expect(rows[0]).toContain('Von Anna Einkauf <einkauf@kunde-a.invalid>');
    expect(q('kunden-email-history-inbound-link')?.getAttribute('href')).toBe('/kommunikation/eingang/in-neu');
  });

  it('X: Vorgangshistorie fragt eingehende Mail mit dem Vorgang ab', async () => {
    const loadInbound = vi.fn(async () => ({ ok: true as const, messages: [inbound({ vorgang_id: 'v-1' })] }));
    await mount(<CommunicationHistorySection target={{ vorgangId: 'v-1' }} testId="vorgang-email-history" load={async () => ({ ok: true, threads: [], incomplete: false })} loadEmails={async () => ({ ok: true, messages: [] })} loadInbound={loadInbound} />);
    expect(loadInbound).toHaveBeenCalledWith({ vorgangId: 'v-1' });
    expect(qa('vorgang-email-history-inbound-thread')).toHaveLength(1);
  });
});
