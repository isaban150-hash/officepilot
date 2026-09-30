/**
 * EINGANG-01B — sichtbare Teile: „In Eingang übernehmen" auf der Mail-Detailseite
 * (T15) und die Mail-Herkunft im Eingang (T16). Test-Doubles für Mail-Laden und
 * Übernahme; kein Netz, kein Versand.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { loginAsDefaultAdmin, resetAuthForTests } from '../test/authFixtures';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import * as supabaseLib from '../lib/supabase';
import * as persistence from '../services/persistenceService';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import { hydrateInboxStore } from '../services/inboxService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { parseEmailMessageRow } from '../services/email/emailMessageCloudService';
import type { EmailAttachmentIntakeResult } from '../services/email/emailAttachmentIntakeService';
import { KommunikationInboundEmailPage } from './KommunikationInboundEmailPage';
import { EingangDetailPage } from './EingangDetailPage';
import type { CompanySetup, InboxItem } from '../types/models';
import type { EmailMessage } from '../types/emailMessage';

const WS = '00000000-0000-4000-8000-0000000001b1';
const SHA = 'b'.repeat(64);
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
let lastLocation = '';
function LocationProbe() {
  const location = useLocation();
  lastLocation = `${location.pathname}${location.search}`;
  return null;
}
async function mount(node: ReactNode, path: string, route: string): Promise<void> {
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            <LocationProbe />
            <Routes>
              <Route path={route} element={node} />
              <Route path="*" element={<span data-testid="elsewhere" />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

function attachment(id: string | null, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(id ? { id } : {}),
    position: 1, filename: 'rechnung.pdf', mime_type: 'application/pdf', size_bytes: 2048, sha256: SHA,
    storage_path: `${WS}/${SHA}.pdf`, storage_bucket: 'inbound-email-attachments', ...patch,
  };
}

function inbound(attachments: Record<string, unknown>[]): EmailMessage {
  return parseEmailMessageRow({
    id: 'msg-ui', workspace_id: WS, client_message_id: 'in:c:ui', direction: 'inbound', provider: 'microsoft_graph', provider_message_id: 'p-ui',
    mailbox_connection_id: 'conn-1', internet_message_id: '<ui@x>', from_address: 'buchhaltung@lieferant.invalid', from_name: 'Baustoff Meyer GmbH',
    to_recipients: ['info@betrieb.invalid'], cc_recipients: [], bcc_recipients: [], subject: 'Rechnung', body_text: 'Anbei.', has_html: false,
    status: 'received', received_at: '2026-09-27T08:15:00.000Z', imported_at: '2026-09-27T08:16:00.000Z', created_at: '2026-09-27T08:16:00.000Z',
    attempt_number: 1, row_version: 1, customer_id: null, vorgang_id: null, assignment_status: 'needs_review', assignment_source: null,
    skipped_attachments: [], attachments,
  })!;
}

const MESSAGE_ROWS = [
  attachment('att-pdf'),
  attachment('att-docx', { position: 2, filename: 'liste.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  attachment('att-big', { position: 3, filename: 'plan.pdf', size_bytes: 12 * 1024 * 1024 }),
  attachment(null, { position: 4, filename: 'alt.pdf' }),
];

async function mountMail(importAttachment: (...args: never[]) => Promise<EmailAttachmentIntakeResult>, rows = MESSAGE_ROWS) {
  const message = inbound(rows);
  await mount(
    <KommunikationInboundEmailPage
      loadMessage={async () => ({ ok: true, message })}
      loadThread={async () => ({ ok: true, messages: [] })}
      downloadAttachment={async () => ({ ok: false, error: 'network' })}
      importAttachment={importAttachment as never}
    />,
    '/kommunikation/eingang/msg-ui',
    '/kommunikation/eingang/:id',
  );
  return message;
}

function rows(): HTMLElement[] {
  return qa('kommunikation-inbound-attachment-row');
}
function within(row: HTMLElement, id: string): HTMLElement | null {
  return row.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
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
  hydrateInboxStore([]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Netz im Test verboten'); });
});

afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  resetTestStores();
});

describe('EINGANG-01B — Mail-Detail: In Eingang übernehmen (T15)', () => {
  it('Knopf nur bei geeignetem Anhang; Öffnen/Herunterladen bleiben; >10 MB mit Hinweis; ohne Server-ID nichts', async () => {
    await mountMail(vi.fn());
    const [pdf, docx, big, noId] = rows();
    expect(within(pdf!, 'kommunikation-inbound-intake')?.textContent).toBe('In Eingang übernehmen');
    expect(within(pdf!, 'kommunikation-inbound-attachment-open')).not.toBeNull();
    expect(within(pdf!, 'kommunikation-inbound-attachment-download')).not.toBeNull();
    expect(within(docx!, 'kommunikation-inbound-intake')).toBeNull();
    expect(within(docx!, 'kommunikation-inbound-attachment-download')).not.toBeNull();
    expect(within(big!, 'kommunikation-inbound-intake')).toBeNull();
    expect(within(big!, 'kommunikation-inbound-intake-too-large')?.textContent).toContain('10 MB');
    expect(within(big!, 'kommunikation-inbound-attachment-download')).not.toBeNull();
    expect(within(noId!, 'kommunikation-inbound-intake')).toBeNull();
  });

  it('Busy sperrt alle Anhangsknöpfe; Erfolg navigiert zum neuen Eingang', async () => {
    let resolve!: (value: EmailAttachmentIntakeResult) => void;
    const importAttachment = vi.fn(() => new Promise<EmailAttachmentIntakeResult>((done) => { resolve = done; }));
    const message = await mountMail(importAttachment);

    await act(async () => { within(rows()[0]!, 'kommunikation-inbound-intake')!.click(); });
    const busyButton = within(rows()[0]!, 'kommunikation-inbound-intake') as HTMLButtonElement;
    expect(busyButton.textContent).toBe('Wird übernommen …');
    expect(busyButton.disabled).toBe(true);
    expect((within(rows()[1]!, 'kommunikation-inbound-attachment-download') as HTMLButtonElement).disabled).toBe(true);
    // Ein zweiter Klick während der Übernahme löst nichts aus.
    await act(async () => { busyButton.click(); });
    expect(importAttachment).toHaveBeenCalledTimes(1);
    const [calledMessage, calledAttachment, calledDeps] = importAttachment.mock.calls[0] as unknown as [EmailMessage, EmailMessage['attachments'][number], { access: { canIntake: boolean } }];
    expect(calledMessage.id).toBe(message.id);
    expect(calledAttachment.id).toBe('att-pdf');
    expect(calledDeps.access.canIntake).toBe(true);

    await act(async () => { resolve({ outcome: 'created', inboxItemId: 'inbox-mail-att-pdf' }); });
    await settle();
    expect(lastLocation).toBe('/ablage/inbox-mail-att-pdf');
  });

  it('bereits übernommen: „Im Eingang öffnen" statt erneuter Übernahme', async () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'inbox-mail-att-pdf',
        importSource: 'email',
        emailOrigin: { messageId: 'msg-ui', attachmentId: 'att-pdf', position: 1, sha256: SHA, importedAt: '2026-09-30T10:00:00.000Z' },
      } as Partial<InboxItem>),
    ]);
    const importAttachment = vi.fn();
    await mountMail(importAttachment);
    const pdf = rows()[0]!;
    expect(within(pdf, 'kommunikation-inbound-intake')).toBeNull();
    await act(async () => { within(pdf, 'kommunikation-inbound-intake-open')!.click(); });
    await settle();
    expect(lastLocation).toBe('/ablage/inbox-mail-att-pdf');
    expect(importAttachment).not.toHaveBeenCalled();
  });

  it('Inhaltsduplikat: Hinweis „Bereits vorhanden" mit Link zum Vorhandenen', async () => {
    await mountMail(vi.fn(async () => ({ outcome: 'duplicate' as const, existing: { type: 'document' as const, id: 'doc-7' } })));
    await act(async () => { within(rows()[0]!, 'kommunikation-inbound-intake')!.click(); });
    await settle();
    expect(q('kommunikation-inbound-intake-duplicate')?.textContent).toContain('Bereits vorhanden');
    expect(q('kommunikation-inbound-intake-duplicate-open')?.getAttribute('href')).toBe('/dokumente/doc-7');
    expect(lastLocation).toBe('/kommunikation/eingang/msg-ui');
  });

  it('Fehler werden unterscheidbar angezeigt (Hash, Download, Berechtigung, Konflikt)', async () => {
    const cases: Array<[EmailAttachmentIntakeResult, string]> = [
      [{ outcome: 'failed', error: 'hash_mismatch' }, 'stimmt nicht mit dem beim Empfang gespeicherten Original überein'],
      [{ outcome: 'failed', error: 'download_failed' }, 'konnte nicht geladen werden'],
      [{ outcome: 'failed', error: 'not_permitted' }, 'Keine Berechtigung'],
      [{ outcome: 'failed', error: 'previously_removed' }, 'aus dem Eingang entfernt'],
      [{ outcome: 'failed', error: 'too_large' }, 'zu groß'],
    ];
    for (const [result, text] of cases) {
      await mountMail(vi.fn(async () => result));
      await act(async () => { within(rows()[0]!, 'kommunikation-inbound-intake')!.click(); });
      await settle();
      const alert = within(rows()[0]!, 'kommunikation-inbound-attachment-error');
      expect(alert?.getAttribute('role')).toBe('alert');
      expect(alert?.textContent).toContain(text);
      if (result.outcome === 'failed' && result.error !== 'not_permitted') expect(alert?.textContent).toContain('rechnung.pdf');
      expect(lastLocation).toBe('/kommunikation/eingang/msg-ui');
      await act(async () => root.unmount());
      document.body.innerHTML = '';
    }
  });

  it('ohne bekannte Mitgliedschaft kein Übernahme-Knopf (fail-closed)', async () => {
    hydrateWorkspaceStore({
      workspace: { id: WS, name: 'Betrieb', ownerUserId: 'someone-else', createdAt: 'x', updatedAt: 'x', version: 1 },
      workspaceMembers: [],
    });
    await mountMail(vi.fn());
    expect(qa('kommunikation-inbound-intake')).toHaveLength(0);
    expect(within(rows()[0]!, 'kommunikation-inbound-attachment-download')).not.toBeNull();
  });
});

describe('EINGANG-01B — Herkunft im Eingang (T16)', () => {
  function inboxItem(overrides: Partial<InboxItem>): InboxItem {
    return {
      ...createAuftragInboxItem({ id: 'inbox-origin-1' }),
      title: 'Rechnung Baustoff Meyer',
      sender: 'Baustoff Meyer GmbH',
      markedAsCompanyDocument: true,
      ...overrides,
    } as InboxItem;
  }

  it('mit emailOrigin: „Eingegangen per E-Mail", Absender, Datum und Rückverweis zur Mail', async () => {
    hydrateInboxStore([
      inboxItem({
        importSource: 'email',
        emailOrigin: { messageId: 'msg-ui', attachmentId: 'att-pdf', position: 1, sha256: SHA, receivedAt: '2026-09-27T08:15:00.000Z', importedAt: '2026-09-30T10:00:00.000Z' },
      }),
    ]);
    await mount(<EingangDetailPage />, '/ablage/inbox-origin-1', '/ablage/:id');
    await settle(20);
    const origin = q('eingang-detail-email-origin');
    expect(origin?.textContent).toContain('Eingegangen per E-Mail');
    expect(origin?.textContent).toContain('Baustoff Meyer GmbH');
    expect(origin?.textContent).toContain('27.09.2026');
    const link = q('eingang-detail-email-origin-link')!;
    expect(link.getAttribute('href')).toBe('/kommunikation/eingang/msg-ui');
    await act(async () => { link.click(); });
    await settle();
    expect(lastLocation).toBe('/kommunikation/eingang/msg-ui');
  });

  it('ohne emailOrigin (normaler Upload/Scan): keine Mail-Herkunft', async () => {
    hydrateInboxStore([inboxItem({ importSource: 'upload' })]);
    await mount(<EingangDetailPage />, '/ablage/inbox-origin-1', '/ablage/:id');
    await settle(20);
    expect(q('eingang-detail-header')).not.toBeNull();
    expect(q('eingang-detail-email-origin')).toBeNull();
  });
});
