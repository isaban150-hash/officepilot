/**
 * E-MAIL 07F-01B — sichtbarer Zustellstatus: Gesendet-Detail (Kopf, Versuch,
 * Hinweis, Zustellverlauf), Gesprächsverlauf, Gesendet-Liste, Kunden-/
 * Vorgangshistorie, Dokumentversand-Historie. Nie „gelesen"; kein neuer
 * Neuversuch-Knopf durch Zustellstatus. Test-Doubles, kein Netz, kein Versand.
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
import { parseDocumentDeliveryRow } from '../../services/delivery/documentDeliveryContract';
import { KommunikationEmailDetailPage } from '../../pages/KommunikationEmailDetailPage';
import { SentEmailList } from './SentEmailList';
import { CommunicationHistorySection } from './CommunicationHistorySection';
import { EmailConversation } from './EmailConversation';
import { DeliveryHistoryList } from '../invoice/DeliveryHistoryList';
import { useApp } from '../../context/AppContext';
import type { CompanySetup } from '../../types/models';
import type { EmailMessage } from '../../types/emailMessage';
import type { DocumentDelivery } from '../../types/documentDelivery';

const WS = '00000000-0000-4000-8000-0000000f01b0';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function mount(node: ReactNode, path = '/', route = '*'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}><AuthProvider><AppProvider initialSetup={setup}><Routes><Route path={route} element={node} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}

function outbound(patch: Record<string, unknown> = {}): EmailMessage {
  return parseEmailMessageRow({
    id: 'out-1', workspace_id: WS, client_message_id: 'em-1', direction: 'outbound', provider: 'brevo', provider_message_id: '<b1@relay.invalid>',
    to_recipients: ['saban_irmak@icloud.com'], cc_recipients: [], bcc_recipients: [], subject: 'Re: OfficeTakt 07E Testmail', body_text: 'Text',
    sender_name: 'Betrieb', reply_to_email: 'info@betrieb.invalid', status: 'provider_accepted', provider_accepted_at: '2026-09-28T09:41:08.000Z',
    created_at: '2026-09-28T09:41:00.000Z', attempt_number: 1, row_version: 3, attachments: [], thread_id: 't-1', references_ids: [], reply_to_addresses: [],
    customer_id: 'c-1', ...patch,
  })!;
}
function delivery(patch: Record<string, unknown> = {}): DocumentDelivery {
  return parseDocumentDeliveryRow({
    id: 'd-1', workspace_id: WS, client_delivery_id: 'cd-1', document_kind: 'invoice', linked_invoice_id: 'inv-1', recipient_email: 'kunde@kunde.invalid',
    subject: 'Rechnung RE-1', body_text: 'Text', provider: 'brevo', provider_message_id: '<d1@relay.invalid>', status: 'provider_accepted',
    requested_by: 'u', requested_at: '2026-09-28T09:00:00.000Z', provider_accepted_at: '2026-09-28T09:00:05.000Z', created_at: 'x', updated_at: 'x',
    row_version: 2, attempt_number: 1, customer_id: 'c-1', ...patch,
  })!;
}
const noEvents = async () => ({ ok: true as const, events: [] });

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
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  resetTestStores();
});

const detail = (message: EmailMessage, loadDeliveryEvents = noEvents) => (
  <KommunikationEmailDetailPage loadChain={async () => ({ ok: true, messages: [message] })} loadThread={async () => ({ ok: true, messages: [message] })} loadDeliveryEvents={loadDeliveryEvents} />
);

describe('07F-01B — Gesendet-Detail', () => {
  it('ohne Rückmeldung bleibt es bei „An E-Mail-Dienst übergeben" (kein Zustellverlauf)', async () => {
    await mount(detail(outbound()), '/kommunikation/email/out-1', '/kommunikation/email/:id');
    expect(q('kommunikation-email-detail-status')?.textContent).toBe('An E-Mail-Dienst übergeben');
    expect(q('kommunikation-email-detail-delivery-history')).toBeNull();
    expect(q('kommunikation-email-detail-state-hint')).toBeNull();
  });

  it('zugestellt: „Zugestellt" + Hinweis „nicht gelesen", Zustellverlauf aus den Rückmeldungen', async () => {
    const events = vi.fn(async () => ({ ok: true as const, events: [
      { state: 'accepted' as const, at: '2026-09-28T09:41:08.000Z', applied: true },
      { state: 'delivered' as const, at: '2026-09-28T09:41:10.000Z', applied: true },
    ] }));
    await mount(detail(outbound({ delivery_state: 'delivered', delivery_state_at: '2026-09-28T09:41:10.000Z' }), events), '/kommunikation/email/out-1', '/kommunikation/email/:id');
    expect(events).toHaveBeenCalledWith('out-1');
    expect(q('kommunikation-email-detail-status')?.textContent).toBe('Zugestellt');
    expect(q('kommunikation-email-detail-attempt-status')?.textContent).toBe('Zugestellt');
    expect(q('kommunikation-email-detail-state-hint')?.textContent).toBe('Vom Empfängerserver angenommen – das heißt nicht, dass die E-Mail gelesen wurde.');
    const rows = qa('kommunikation-email-detail-delivery-event').map((row) => row.textContent);
    expect(rows).toEqual(['28.09.2026, 11:41 · An E-Mail-Dienst übergeben', '28.09.2026, 11:41 · Zugestellt']);
    expect(q('kommunikation-email-detail-delivery-history')?.textContent).toContain('Öffnen oder Lesen wird nicht erfasst.');
  });

  it('verzögert / nicht zugestellt / abgelehnt / Spam-Beschwerde: klare Texte, kein automatischer oder neuer Neuversuch-Knopf', async () => {
    const cases: Array<[string, string, RegExp]> = [
      ['deferred', 'Zustellung verzögert', /versucht es selbst weiter – OfficeTakt sendet nicht zusätzlich/],
      ['bounced', 'Nicht zugestellt', /sendet nicht automatisch erneut – bitte Empfängeradresse prüfen/],
      ['rejected', 'Vom E-Mail-Dienst abgelehnt', /nicht zugestellt/],
      ['complained', 'Vom Empfänger als unerwünscht gemeldet', /als unerwünscht gemeldet/],
    ];
    for (const [state, label, hint] of cases) {
      await mount(detail(outbound({ delivery_state: state })), '/kommunikation/email/out-1', '/kommunikation/email/:id');
      expect(q('kommunikation-email-detail-status')?.textContent).toBe(label);
      expect(q('kommunikation-email-detail-state-hint')?.textContent).toMatch(hint);
      expect(q('kommunikation-email-detail-retry')).toBeNull();
      expect(q('kommunikation-email-detail-retry-uncertain')).toBeNull();
      await act(async () => root.unmount());
      document.body.innerHTML = '';
    }
    root = createRoot(document.createElement('div'));
  });

  it('fehlgeschlagener Versand behält „Erneut senden" (07D unverändert); ein Zustellstatus überdeckt ihn nie', async () => {
    await mount(detail(outbound({ status: 'failed', provider_message_id: null, provider_accepted_at: null, failed_at: 'x', error_category: 'provider', delivery_state: 'delivered' })), '/kommunikation/email/out-1', '/kommunikation/email/:id');
    expect(q('kommunikation-email-detail-status')?.textContent).toBe('Versand fehlgeschlagen');
    expect(q('kommunikation-email-detail-retry')).not.toBeNull();
  });
});

describe('07F-01B — Verlauf, Listen, Historie, Dokumentversand', () => {
  it('Gesprächsverlauf und Gesendet-Liste zeigen den Zustellstatus', async () => {
    const inbound = parseEmailMessageRow({ id: 'in-1', workspace_id: WS, client_message_id: 'in:1', direction: 'inbound', provider: 'microsoft_graph', provider_message_id: 'p', mailbox_connection_id: 'c', from_address: 'saban_irmak@icloud.com', to_recipients: ['schabi82@hotmail.de'], cc_recipients: [], bcc_recipients: [], subject: 'OfficeTakt 07E Testmail', body_text: 'x', status: 'received', received_at: '2026-09-27T15:04:50.000Z', imported_at: 'x', created_at: 'x', attempt_number: 1, row_version: 1, assignment_status: 'needs_review', attachments: [], thread_id: 't-1' })!;
    function Wrapper() {
      useApp();
      return <EmailConversation messages={[inbound, outbound({ delivery_state: 'delivered' })]} currentId="in-1" testId="conv" />;
    }
    await mount(<Wrapper />);
    expect(q('conv-status')?.textContent).toBe('Zugestellt');
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    await mount(<SentEmailList load={async () => ({ ok: true, messages: [outbound({ delivery_state: 'bounced' })] })} />);
    expect(host.textContent).toContain('Nicht zugestellt');
    expect(host.textContent).not.toMatch(/gelesen|geöffnet/i);
  });

  it('Kunden-/Vorgangshistorie: Dokumentversand und freie E-Mail mit Zustellstatus', async () => {
    const doc = delivery({ delivery_state: 'delivered' });
    await mount(
      <CommunicationHistorySection
        target={{ customerId: 'c-1' }}
        testId="hist"
        load={async () => ({ ok: true, threads: [{ id: doc.id, latest: doc, attempts: [doc] }], incomplete: false })}
        loadEmails={async () => ({ ok: true, messages: [outbound({ delivery_state: 'deferred' })] })}
        loadInbound={async () => ({ ok: true, messages: [] })}
      />,
    );
    expect(q('hist-thread')?.textContent).toContain('Zugestellt');
    expect(q('hist-email-thread')?.textContent).toContain('Zustellung verzögert');
  });

  it('Dokumentversand-Historie (07B): Status übergeben bleibt Datenwert, Anzeige „Zugestellt"/„Nicht zugestellt" mit Hinweis', async () => {
    function Harness({ deliveries }: { deliveries: DocumentDelivery[] }) {
      const { translate } = useApp();
      return <DeliveryHistoryList deliveries={deliveries} emptyKey={'delivery.history.empty' as never} translate={translate} />;
    }
    await mount(<Harness deliveries={[delivery({ delivery_state: 'bounced' }), delivery({ id: 'd-2', client_delivery_id: 'cd-2' })]} />);
    const items = qa('invoice-delivery-item');
    expect(items.map((item) => item.getAttribute('data-status'))).toEqual(['provider_accepted', 'provider_accepted']);
    expect(qa('invoice-delivery-status').map((node) => node.textContent)).toEqual(['Nicht zugestellt', 'An E-Mail-Dienst übergeben']);
    expect(items[0].querySelector('.badge--danger')).not.toBeNull();
    expect(q('invoice-delivery-state-hint')?.textContent).toMatch(/nicht automatisch erneut/);
    expect(qa('invoice-delivery-state-hint')).toHaveLength(1);
  });

  it('Mobile: Zustellverlauf bricht um', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const block = css.slice(css.indexOf('.email-delivery-history {'), css.indexOf('}', css.indexOf('.email-delivery-history {')));
    expect(block).toMatch(/min-width: 0;[\s\S]*overflow-wrap: anywhere;/);
  });
});
