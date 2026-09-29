/**
 * E-MAIL-07D — sichtbare Teile der freien E-Mail: Neue E-Mail (Signatur
 * genau einmal, Cc/Bcc, Kunde/Vorgang, Anhänge mit Fehlern, Senden gesperrt
 * während Uploads), Gesendet-Liste, Detail und die gemeinsame Historie beim
 * Kunden/Vorgang. Kein Netz, kein Provider — alles über Test-Doubles.
 */
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
import * as cloud from '../../services/email/emailMessageCloudService';
import * as freeEmail from '../../services/email/freeEmailOrchestrator';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { hydrateCustomerStore } from '../../services/customerStoreService';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { parseDocumentDeliveryRow } from '../../services/delivery/documentDeliveryContract';
import { groupDeliveryThreads } from '../../services/delivery/deliveryCommunicationContext';
import { KommunikationEmailComposePage } from '../../pages/KommunikationEmailComposePage';
import { KommunikationEmailDetailPage } from '../../pages/KommunikationEmailDetailPage';
import { SentEmailList } from './SentEmailList';
import { CommunicationHistorySection } from './CommunicationHistorySection';
import type { CompanySetup, Customer, Vorgang } from '../../types/models';

const WS = '00000000-0000-4000-8000-0000000007d0';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const PROFILE = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Beispiel Haustechnik',
  legalForm: 'GmbH',
  street: 'Bahnhofstraße 12',
  zip: '32105',
  city: 'Bad Salzuflen',
  phone: '05222 000000',
  email: 'info@beispiel.invalid',
  iban: 'DE89370400440532013000',
  taxNumber: '1',
};
const GREETING = 'Mit freundlichen Grüßen';

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function type(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLInputElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function select(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function click(id: string, index = 0): Promise<void> {
  await act(async () => { qa(id)[index]!.click(); });
  await settle();
}
function file(name: string, bytes: Uint8Array | number, typeName = ''): File {
  const content = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
  const created = new File([content as BlobPart], name, { type: typeName });
  Object.defineProperty(created, 'arrayBuffer', { value: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) });
  return created;
}
async function attach(files: File[]): Promise<void> {
  const input = q('free-email-file-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function mount(node: ReactNode, path = '/', route = '*'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}><AuthProvider><AppProvider initialSetup={setup}><Routes><Route path={route} element={node} /><Route path="/kommunikation/email/:id" element={<p data-testid="navigated-detail">detail</p>} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}

function messageRow(patch: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    workspace_id: WS,
    client_message_id: 'em-1',
    to_recipients: ['kunde@example.invalid'],
    cc_recipients: ['buero@example.invalid'],
    bcc_recipients: ['archiv@example.invalid'],
    subject: 'Unterlagen Bad',
    body_text: `Guten Tag,\n\nanbei die Unterlagen.\n\n${GREETING}\nBeispiel Haustechnik GmbH`,
    sender_name: 'Beispiel Haustechnik GmbH',
    reply_to_email: 'info@beispiel.invalid',
    provider: 'brevo',
    provider_message_id: null,
    status: 'provider_accepted',
    provider_accepted_at: '2026-09-26T10:01:00.000Z',
    created_at: '2026-09-26T10:00:00.000Z',
    attempt_number: 1,
    row_version: 3,
    customer_id: 'c-1',
    attachments: [
      { position: 1, filename: 'Angebot.pdf', mime_type: 'application/pdf', size_bytes: 2048, sha256: 'a'.repeat(64), storage_path: `${WS}/${'a'.repeat(64)}.pdf` },
      { position: 2, filename: 'Foto.png', mime_type: 'image/png', size_bytes: 4096, sha256: 'b'.repeat(64), storage_path: `${WS}/${'b'.repeat(64)}.png` },
    ],
    ...patch,
  };
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  hydrateCompanyProfileStore({ ...PROFILE });
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-admin', createdAt: 'x', updatedAt: 'x', version: 1 },
    workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: 'x', updatedAt: 'x' }],
  });
  await loginAsDefaultAdmin();
  hydrateCustomerStore([
    { id: 'c-1', name: 'Kunde Eins GmbH', street: 'W', zip: '1', city: 'X', email: 'einkauf@kunde-eins.invalid', createdAt: '2026-09-01T00:00:00.000Z' } as Customer,
    { id: 'c-2', name: 'Kunde Zwei', street: 'W', zip: '1', city: 'X', email: '', createdAt: '2026-09-01T00:00:00.000Z' } as Customer,
  ]);
  hydrateVorgangStore([
    { id: 'v-7d', title: 'Badsanierung Eins', customer: 'Kunde Eins GmbH', customerId: 'c-1', baustelle: '', status: 'aktiv', documents: [], tasks: [], photos: [], createdAt: '2026-09-01', updatedAt: '2026-09-01' } as unknown as Vorgang,
  ]);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  resetTestStores();
});

describe('E-MAIL-07D — Neue E-Mail', () => {
  it('Signatur genau einmal; nach Löschen nicht erneut eingefügt (auch nach Reload)', async () => {
    await mount(<KommunikationEmailComposePage />);
    const body = () => (q('free-email-body') as HTMLTextAreaElement).value;
    expect(body().split(GREETING)).toHaveLength(2);
    expect(body()).toContain('Beispiel Haustechnik GmbH');
    expect(q('free-email-body-hint')).not.toBeNull();
    await type('free-email-body', 'Nur dieser Text, ohne Signatur.');
    await act(async () => root.unmount());
    host.remove();
    await mount(<KommunikationEmailComposePage />);
    expect(body()).toBe('Nur dieser Text, ohne Signatur.');
  });

  it('Kunde schlägt E-Mail nur vor; Vorgang bestimmt den Kunden; Cc/Bcc sichtbar', async () => {
    await mount(<KommunikationEmailComposePage />);
    expect(q('free-email-cc')).toBeNull();
    await click('free-email-show-cc-bcc');
    expect(q('free-email-cc')).not.toBeNull();
    expect(q('free-email-bcc')).not.toBeNull();

    await select('free-email-customer', 'c-1');
    expect((q('free-email-to') as HTMLInputElement).value).toBe('');
    expect(q('free-email-suggest-customer-email')?.textContent).toContain('einkauf@kunde-eins.invalid');
    await click('free-email-suggest-customer-email');
    expect((q('free-email-to') as HTMLInputElement).value).toBe('einkauf@kunde-eins.invalid');
    expect(q('free-email-suggest-customer-email')).toBeNull();

    // Anderer Kunde gewählt, dann Vorgang von Kunde Eins → Kunde folgt dem Vorgang, Auswahl gesperrt.
    await select('free-email-customer', 'c-2');
    await select('free-email-vorgang', '');
    await select('free-email-customer', '');
    await select('free-email-vorgang', 'v-7d');
    expect((q('free-email-customer') as HTMLSelectElement).value).toBe('c-1');
    expect((q('free-email-customer') as HTMLSelectElement).disabled).toBe(true);
    expect(q('free-email-customer-from-vorgang')).not.toBeNull();
    const draft = freeEmail.loadFreeEmailDraft();
    expect(draft).toMatchObject({ customerId: 'c-1', vorgangId: 'v-7d' });
  });

  it('mehrere Anhänge: Name/Größe, entfernen, Fehler für Typ/Größe/Upload; Senden gesperrt während Upload', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const upload = vi.spyOn(cloud, 'uploadEmailAttachment').mockImplementation(async (input) => {
      if (input.filename === 'kaputt.pdf') return { ok: false, error: 'network' };
      await gate;
      const sha = (input.filename === 'Angebot.pdf' ? 'a' : 'b').repeat(64);
      const ext = input.filename.split('.').pop()!;
      return { ok: true, reused: false, attachment: { filename: input.filename, mimeType: ext === 'pdf' ? 'application/pdf' : 'image/png', sizeBytes: input.bytes.byteLength, sha256: sha, storagePath: `${WS}/${sha}.${ext}` } };
    });
    await mount(<KommunikationEmailComposePage />);
    await type('free-email-to', 'kunde@example.invalid');
    await type('free-email-subject', 'Unterlagen');

    await attach([
      file('Angebot.pdf', new TextEncoder().encode('%PDF-1.4 a')),
      file('Foto.png', 1500),
      file('setup.exe', 10),
      file('riesig.pdf', 4 * 1024 * 1024 + 1),
      file('kaputt.pdf', 10),
    ]);
    await settle();
    expect(qa('free-email-attachment-pending').length).toBe(2);
    expect((q('free-email-send') as HTMLButtonElement).disabled).toBe(true);
    expect(q('free-email-send-locked')).not.toBeNull();
    const errors = qa('free-email-attachment-error').map((entry) => entry.textContent);
    expect(errors.some((text) => text?.includes('setup.exe') && text.includes('nicht erlaubt'))).toBe(true);
    expect(errors.some((text) => text?.includes('riesig.pdf') && text.includes('zu groß'))).toBe(true);
    expect(errors.some((text) => text?.includes('kaputt.pdf') && text.includes('nicht hochgeladen'))).toBe(true);

    await act(async () => { release(); });
    await settle();
    expect(qa('free-email-attachment-name').map((entry) => entry.textContent)).toEqual(['Angebot.pdf', 'Foto.png']);
    expect(qa('free-email-attachment-size')[1].textContent).toBe('1 KB');
    expect((q('free-email-send') as HTMLButtonElement).disabled).toBe(false);
    expect(upload).toHaveBeenCalledTimes(3);

    await click('free-email-attachment-remove', 0);
    expect(qa('free-email-attachment-name').map((entry) => entry.textContent)).toEqual(['Foto.png']);
    expect(freeEmail.loadFreeEmailDraft()?.attachments.map((entry) => entry.filename)).toEqual(['Foto.png']);
  });

  it('Senden: Validierung sichtbar; danach ein Versand mit Entwurfsdaten und Wechsel ins Detail', async () => {
    const send = vi.spyOn(freeEmail, 'sendFreeEmail').mockImplementation(async (draft) => ({
      ok: true,
      action: 'sent',
      message: cloud.parseEmailMessageRow(messageRow({ id: 'm-neu', client_message_id: draft.clientMessageId }))!,
      chain: [],
    }));
    await mount(<KommunikationEmailComposePage />);
    await type('free-email-to', 'kaputt');
    const form = host.querySelector('form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
    expect(q('free-email-validation-recipient_invalid')?.textContent).toContain('kaputt');
    expect(q('free-email-validation-subject_missing')).not.toBeNull();
    expect(send).not.toHaveBeenCalled();

    await type('free-email-to', 'kunde@example.invalid');
    await type('free-email-subject', 'Unterlagen');
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: 'kunde@example.invalid', subject: 'Unterlagen' });
    expect(q('navigated-detail')).not.toBeNull();
  });

  it('unterbrochener Versand nach Reload: Felder gesperrt, „Versand fortsetzen" mit derselben ID', async () => {
    const draft = freeEmail.createFreeEmailDraft({ to: 'kunde@example.invalid', subject: 'S', bodyText: 'T' });
    freeEmail.saveFreeEmailDraft({ ...draft, phase: 'sending' });
    const send = vi.spyOn(freeEmail, 'sendFreeEmail').mockImplementation(async () => ({ ok: false, error: 'server_unavailable' }));
    await mount(<KommunikationEmailComposePage />);
    expect(q('kommunikation-email-compose-resume-hint')).not.toBeNull();
    expect((q('free-email-subject') as HTMLInputElement).closest('fieldset')!.disabled).toBe(true);
    expect(q('free-email-send')?.textContent).toContain('Versand fortsetzen');
    const form = host.querySelector('form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
    expect(send.mock.calls[0][0].clientMessageId).toBe(draft.clientMessageId);
    expect(q('free-email-error')?.textContent).toContain('höchstens einmal');
  });
});

describe('E-MAIL-07D — Gesendet, Detail, Historie', () => {
  it('Gesendet-Liste: Datum, Empfänger, Betreff, Kontext, Anhänge, Status; Neuversuch in derselben Zeile', async () => {
    const messages = [
      cloud.parseEmailMessageRow(messageRow({ id: 'm-1', status: 'failed', provider_accepted_at: null, failed_at: '2026-09-26T10:00:30.000Z', error_category: 'provider' }))!,
      cloud.parseEmailMessageRow(messageRow({ id: 'm-2', retry_of_message_id: 'm-1', attempt_number: 2, created_at: '2026-09-26T10:05:00.000Z' }))!,
    ];
    await mount(<SentEmailList load={async () => ({ ok: true, messages })} />);
    expect(q('kommunikation-email-new')?.getAttribute('href')).toBe('/kommunikation/email/neu');
    const rows = qa('kommunikation-email-sent-thread');
    expect(rows).toHaveLength(1);
    const text = rows[0].textContent ?? '';
    expect(text).toContain('Unterlagen Bad');
    expect(text).toContain('kunde@example.invalid');
    expect(text).toContain('Kunde Eins GmbH');
    expect(text).toContain('2 Anhänge');
    expect(text).toContain('2 Versuche');
    expect(text).toContain('An E-Mail-Dienst übergeben');
    expect(q('kommunikation-email-sent-link')?.getAttribute('href')).toBe('/kommunikation/email/m-2');
  });

  it('Gesendet-Liste ohne Cloud-Migration: klare Meldung statt Fehler', async () => {
    await mount(<SentEmailList load={async () => ({ ok: false, error: 'not_deployed' })} />);
    expect(q('kommunikation-email-sent-unavailable')?.textContent).toContain('noch nicht freigeschaltet');
  });

  it('Detail: An/Cc/Bcc, Betreff, Text mit Signatur, Anhänge, Kontext, Verlauf; Neuversuch nur bei Fehlschlag', async () => {
    const chain = [
      cloud.parseEmailMessageRow(messageRow({ id: 'm-1', status: 'failed', provider_accepted_at: null, failed_at: '2026-09-26T10:00:30.000Z', error_category: 'provider', error_code: 'brevo_500' }))!,
    ];
    const retry = vi.spyOn(freeEmail, 'retryFreeEmail').mockImplementation(async () => ({
      ok: true,
      action: 'sent',
      message: cloud.parseEmailMessageRow(messageRow({ id: 'm-2', retry_of_message_id: 'm-1', attempt_number: 2 }))!,
      chain: [chain[0], cloud.parseEmailMessageRow(messageRow({ id: 'm-2', retry_of_message_id: 'm-1', attempt_number: 2 }))!],
    }));
    const retried = cloud.parseEmailMessageRow(messageRow({ id: 'm-2', retry_of_message_id: 'm-1', attempt_number: 2 }))!;
    // Der Server liefert zu jeder Nachricht die ganze Kette.
    const loadChain = async (id: string) => ({ ok: true as const, messages: id === 'm-2' ? [chain[0], retried] : chain });
    await mount(<KommunikationEmailDetailPage loadChain={loadChain} />, '/kommunikation/email/m-1', '/kommunikation/email/:id');
    expect(q('kommunikation-email-detail-to')?.textContent).toBe('kunde@example.invalid');
    expect(q('kommunikation-email-detail-cc')?.textContent).toBe('buero@example.invalid');
    expect(q('kommunikation-email-detail-bcc')?.textContent).toBe('archiv@example.invalid');
    expect(q('kommunikation-email-detail-body')?.textContent).toContain(GREETING);
    expect(qa('kommunikation-email-detail-attachment').map((entry) => entry.textContent)).toEqual(['Angebot.pdf · 2 KB', 'Foto.png · 4 KB']);
    expect(q('kommunikation-email-detail-customer')?.textContent).toBe('Kunde Eins GmbH');
    expect(q('kommunikation-email-detail-attempt-status')?.textContent).toBe('Versand fehlgeschlagen');
    expect(q('kommunikation-email-detail-retry-uncertain')).toBeNull();
    await click('kommunikation-email-detail-retry');
    expect(retry).toHaveBeenCalledWith({ previous: chain[0] });
    expect(qa('kommunikation-email-detail-attempt')).toHaveLength(2);
    expect(qa('kommunikation-email-detail-attempt')[1].textContent).toContain('Neuversuch zu Versuch 1');
  });

  it('Detail bei unklarem Status: nur „Trotzdem erneut senden" mit Bestätigung', async () => {
    const chain = [cloud.parseEmailMessageRow(messageRow({ status: 'unknown', provider_accepted_at: null, error_category: 'unknown', error_code: 'send_interrupted' }))!];
    const retry = vi.spyOn(freeEmail, 'retryFreeEmail').mockImplementation(async () => ({ ok: false, error: 'uncertain_pending' }));
    await mount(<KommunikationEmailDetailPage loadChain={async () => ({ ok: true, messages: chain })} />, '/kommunikation/email/m-1', '/kommunikation/email/:id');
    expect(q('kommunikation-email-detail-retry')).toBeNull();
    await click('kommunikation-email-detail-retry-uncertain');
    const dialog = () => document.querySelector('[data-testid="kommunikation-email-detail-retry-uncertain-dialog"]');
    expect(dialog()?.textContent).toContain('doppelt');
    await act(async () => { (document.querySelector('[data-testid="kommunikation-email-detail-retry-uncertain-cancel"]') as HTMLElement).click(); });
    await settle();
    expect(retry).not.toHaveBeenCalled();
    await click('kommunikation-email-detail-retry-uncertain');
    await act(async () => { (document.querySelector('[data-testid="kommunikation-email-detail-retry-uncertain-confirm"]') as HTMLElement).click(); });
    await settle();
    expect(retry).toHaveBeenCalledWith({ previous: chain[0], confirmUncertainRetry: true });
  });

  it('Historie beim Kunden/Vorgang: Dokumentversand und freie E-Mail gemeinsam, chronologisch, klar benannt, ohne Doppelung', async () => {
    const delivery = parseDocumentDeliveryRow({
      id: 'd-1', workspace_id: WS, client_delivery_id: 'cd-1', document_kind: 'invoice', linked_invoice_id: 'inv-1', linked_document_id: null,
      recipient_email: 'kunde@example.invalid', subject: 'Rechnung RE-1', body_text: 'x',
      attachment_storage_path: null, attachment_sha256: null, attachment_size_bytes: null, attachment_filename: 'RE-1.pdf', attachment_mime_type: null,
      provider: 'brevo', provider_message_id: 'p', status: 'provider_accepted', requested_by: 'u', requested_at: '2026-09-26T09:00:00.000Z',
      provider_accepted_at: '2026-09-26T09:00:05.000Z', failed_at: null, error_category: null, error_code: null, error_message_safe: null,
      retry_of_delivery_id: null, attempt_number: 1, created_at: '2026-09-26T09:00:00.000Z', updated_at: '2026-09-26T09:00:05.000Z', row_version: 3, customer_id: 'c-1',
    })!;
    const email = cloud.parseEmailMessageRow(messageRow())!;
    const loadEmails = vi.fn(async () => ({ ok: true as const, messages: [email, email] }));
    await mount(
      <CommunicationHistorySection
        target={{ customerId: 'c-1' }}
        testId="kunden-email-history"
        load={async () => ({ ok: true, threads: groupDeliveryThreads([delivery]), incomplete: false })}
        loadEmails={loadEmails}
      />,
    );
    expect(loadEmails).toHaveBeenCalledWith({ customerId: 'c-1' });
    const emailRows = qa('kunden-email-history-email-thread');
    const deliveryRows = qa('kunden-email-history-thread');
    expect(emailRows).toHaveLength(1);
    expect(deliveryRows).toHaveLength(1);
    expect(emailRows[0].textContent).toContain('Freie E-Mail');
    expect(deliveryRows[0].textContent).toContain('Rechnung');
    // Neueste zuerst: die freie E-Mail (10:01) vor der Rechnung (09:00).
    const order = Array.from(host.querySelectorAll('[data-testid="kunden-email-history-email-thread"], [data-testid="kunden-email-history-thread"]')).map((entry) => entry.getAttribute('data-testid'));
    expect(order).toEqual(['kunden-email-history-email-thread', 'kunden-email-history-thread']);
    expect(q('kunden-email-history-email-link')?.getAttribute('href')).toBe('/kommunikation/email/m-1');
  });
});
