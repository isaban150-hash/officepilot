/**
 * V1-B2 — Dokument-/Briefversand: Vertrag (SQL-Text), Client-Dienste und Panel.
 *
 *  S1  SQL: letter/offer/other zugelassen, linked_document_id Pflicht, keine linked_invoice_id,
 *      Dokument im Workspace (F/G), Dokumentart passt (H), Anhang an Dokument gebunden (I),
 *      Rechnungszweig unveraendert (A/B), Fingerprint/Retry um Dokumentbezug erweitert,
 *      unknown-Sperre bleibt (M), Historie je Dokument, Absenderkontext fuer die Function
 *  C1  Client: Versandart aus classifiedKind; Create-RPC traegt linked_document_id, keine Rechnung;
 *      Historie ueber die Dokument-RPC; Server-Fehler -> definierte Client-Fehler
 *  C2  Anhang: nur PDF (Original), Bild ohne Archiv-PDF -> not sendable; Hash/Name/Groesse
 *  J   Dokumentversand ruft nie die Rechnungskopplung
 *  O   Panel: „Per E-Mail senden" nur bei versendbaren Dokumenten; Rechnungsdokument ohne Panel
 *  L/M Panel: failed -> Retry; unknown -> nur Status pruefen
 *  N   Panel-Dialog: technische Details nie sichtbar
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import * as supabaseLib from '../../lib/supabase';
import * as orchestrator from '../../services/delivery/sendDocumentOrchestrator';
import * as vorgangService from '../../services/vorgangService';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateDocumentStore } from '../../services/documentService';
import { hydrateDocumentFileStore, resetDocumentFileStoreForTests } from '../../services/documentFileStoreService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import * as persistence from '../../services/persistenceService';
import { resetTestStores } from '../../test/resetStores';
import {
  prepareArchivedDocumentDeliveryAttachment,
  resolveArchivedDocumentDeliveryKind,
  rpcCreateWorkspaceDocumentDelivery,
  rpcListWorkspaceDocumentDeliveries,
  type CreateDocumentDeliveryInput,
} from '../../services/delivery/documentDeliveryCloudService';
import { resolveDocumentDeliveryDraftDefaults } from '../../services/delivery/documentDeliveryDefaults';
import { DocumentDeliveryPanel, isArchivedDocumentEmailSendable } from './DocumentDeliveryPanel';
import type { CompanyDocument, CompanySetup } from '../../types/models';
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { DocumentFileRef } from '../../types/documentFileRef';

const WS = '00000000-0000-4000-8000-00000000b2b2';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const PDF_DATA_URL = 'data:application/pdf;base64,' + btoa('%PDF-1.4 archived');
const PNG_DATA_URL = 'data:image/png;base64,' + btoa('\x89PNG not a pdf');

function fileRef(id: string, mimeType = 'application/pdf'): DocumentFileRef {
  return { id, originalFileName: mimeType === 'application/pdf' ? 'brief.pdf' : 'foto.png', mimeType, fileSize: 20, contentHash: `hash-${id}`, storageType: 'local_data_url', localDataKey: `blob-${id}`, createdAt: '2026-09-01T00:00:00.000Z', lifecycleStatus: 'committed' };
}

function doc(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-b2', title: 'Zertifikat Schweißen', category: 'zertifikat', issuer: 'TÜV', recognizedText: '', issueDate: '2026-09-01', validUntil: null,
    digitalFolder: { id: 'd', name: 'Zertifikate', path: '/Z/' }, paperFolder: { folderId: 'f', register: 'A', label: 'Z' }, tags: [], linkedCompany: 'Betrieb',
    linkedVorgang: null, archived: false, createdAt: '2026-09-01T00:00:00.000Z', fileRefId: 'fr-pdf', mimeType: 'application/pdf', ...overrides,
  };
}

function delivery(overrides: Partial<DocumentDelivery>): DocumentDelivery {
  return { id: 'd-1', workspaceId: WS, clientDeliveryId: 'cd-1', documentKind: 'other', linkedDocumentId: 'doc-b2', recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B', provider: 'stub', status: 'queued', requestedBy: 'u', requestedAt: '2026-09-14T10:00:00.000Z', attemptNumber: 1, createdAt: '', updatedAt: '', rowVersion: 1, ...overrides };
}

const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260922120000_workspace_document_delivery_documents.sql'), 'utf8');
const original = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260914120000_workspace_document_deliveries.sql'), 'utf8');

describe('V1-B2 — SQL-Vertrag (S1)', () => {
  const create = migration.slice(migration.indexOf('create or replace function public.create_workspace_document_delivery('), migration.indexOf('\n$$;') + 4);

  it('Dokumentarten und Bezug: letter/offer/other nur mit linked_document_id, ohne linked_invoice_id; Rechnung weiter mit linked_invoice_id', () => {
    expect(create).toContain("v_document_kind not in ('invoice', 'invoice_correction', 'letter', 'offer', 'other')");
    expect(create).toContain("if v_document_kind in ('invoice', 'invoice_correction') then\n    if v_linked_invoice_id is null then\n      raise exception 'linked_invoice_id fehlt';");
    expect(create).toContain("raise exception 'linked_document_id fehlt'");
    expect(create).toContain("raise exception 'linked_invoice_id nicht zulaessig'");
  });

  it('F/G/H/I: Dokument im Workspace, nicht geloescht, Art passend, Anhang-Hash an das Dokument gebunden (PDF, original/archive)', () => {
    expect(create).toContain("and client_document_id = v_linked_document_id\n      and document_kind = 'archived_document'");
    expect(create).toContain("if v_document.id is null or v_document.deleted or v_document.deleted_at is not null then\n      raise exception 'Dokument nicht gefunden'");
    expect(create).toContain("case v_document_classified when 'brief' then 'letter' when 'angebot' then 'offer' else 'other' end");
    expect(create).toContain("raise exception 'Dokumentart passt nicht zum Dokument'");
    expect(create).toContain("b.binding_kind in ('original', 'archive')");
    expect(create).toContain("f.mime_type = 'application/pdf'\n        and f.content_sha256 = v_sha");
    expect(create).toContain("raise exception 'Anhang gehoert nicht zu diesem Dokument'");
  });

  it('A/B: Rechnungszweig, Anhangspruefung, Rechte und Idempotenz-Fehler sind wortgleich zur Erstfassung', () => {
    for (const fragment of [
      "raise exception 'Rechnung nicht finalisiert'",
      "if v_document_kind = 'invoice' and v_invoice.cancelled_at is not null then",
      "raise exception 'Kein Korrekturbeleg vorhanden'",
      "split_part(v_path, '/', 3) <> v_sha || '.pdf'",
      'p_attachment_size_bytes > 10485760',
      "raise exception 'Idempotenzkonflikt: client_delivery_id mit abweichendem Inhalt'",
      "raise exception 'Keine Schreibberechtigung'",
    ]) {
      expect(original).toContain(fragment);
      expect(create).toContain(fragment);
    }
  });

  it('M + Fingerprint/Retry: unknown bleibt gesperrt; Dokumentbezug im Fingerprint und in der Retry-Pruefung', () => {
    expect(create).toContain("if v_retry_of.status = 'unknown' then");
    expect(create).toContain("v_retry_of.status not in ('failed', 'rejected', 'bounced')");
    expect(create).toContain('or v_existing.linked_document_id is distinct from v_linked_document_id');
    expect(create).toContain('or v_retry_of.linked_document_id is distinct from v_linked_document_id');
  });

  it('Historie je Dokument und Absenderkontext (Firmenprofil) fuer die Edge Function; keine Rechnungskopplung veraendert', () => {
    expect(migration).toContain('create or replace function public.list_workspace_document_deliveries_for_document(');
    expect(migration).toContain("and d.document_kind in ('letter', 'offer', 'other')");
    expect(migration).toContain("'company', case when v_company is null then null else jsonb_build_object(");
    expect(migration).toContain("'attachment_bound', v_attachment_bound");
    expect(migration).not.toContain('mark_workspace_document_delivery_accepted');
    expect(migration).not.toMatch(/alter table|create table|create policy|drop /i);
  });
});

describe('V1-B2 — Client-Dienste (C1/C2/J)', () => {
  beforeEach(() => { resetTestStores(); resetDocumentFileStoreForTests(); });

  it('C1: Versandart aus der erkannten Dokumentart; Create-RPC traegt linked_document_id und keine Rechnung; Historie ueber die Dokument-RPC', async () => {
    expect(resolveArchivedDocumentDeliveryKind({ classifiedKind: 'brief' })).toBe('letter');
    expect(resolveArchivedDocumentDeliveryKind({ classifiedKind: 'angebot' })).toBe('offer');
    expect(resolveArchivedDocumentDeliveryKind({ classifiedKind: 'zertifikat' })).toBe('other');
    expect(resolveArchivedDocumentDeliveryKind({})).toBe('other');

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data: name.startsWith('list') ? [] : { outcome: 'created', delivery: {} }, error: null }; }) } as never;
    const input: CreateDocumentDeliveryInput = {
      workspaceId: WS, clientDeliveryId: 'cd-doc', identity: { kind: 'letter', clientDocumentId: 'doc-b2' }, recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B',
      attachment: { storagePath: `${WS}/letter-doc-b2/${'a'.repeat(64)}.pdf`, sha256: 'a'.repeat(64), sizeBytes: 10, filename: 'Brief.pdf' }, provider: 'stub',
    };
    await rpcCreateWorkspaceDocumentDelivery(input, client);
    expect(calls[0]!.name).toBe('create_workspace_document_delivery');
    expect(calls[0]!.args).toMatchObject({ p_document_kind: 'letter', p_linked_invoice_id: null, p_linked_document_id: 'doc-b2' });
    await rpcListWorkspaceDocumentDeliveries({ workspaceId: WS, identity: { kind: 'letter', clientDocumentId: 'doc-b2' } }, client);
    expect(calls[1]).toMatchObject({ name: 'list_workspace_document_deliveries_for_document', args: { p_client_document_id: 'doc-b2' } });
    await rpcListWorkspaceDocumentDeliveries({ workspaceId: WS, identity: { kind: 'invoice', clientInvoiceId: 'inv-1' } }, client);
    expect(calls[2]).toMatchObject({ name: 'list_workspace_document_deliveries', args: { p_linked_invoice_id: 'inv-1', p_document_kind: 'invoice' } });

    for (const [message, error] of [
      ['Dokument nicht gefunden', 'not_found'],
      ['Dokumentart passt nicht zum Dokument', 'not_sendable'],
      ['Anhang gehoert nicht zu diesem Dokument', 'not_sendable'],
      ['Erneuter Versand nicht moeglich: Versandstatus unklar', 'uncertain_pending'],
    ] as const) {
      const failing = { rpc: vi.fn(async () => ({ data: null, error: { message } })) } as never;
      expect(await rpcCreateWorkspaceDocumentDelivery(input, failing), message).toMatchObject({ ok: false, error });
    }
  });

  it('C2: Anhang ist die gebundene PDF-Datei; Bild ohne Archiv-PDF ist nicht versendbar; Groesse/Hash/Name', async () => {
    hydrateDocumentFileStore([fileRef('fr-pdf'), fileRef('fr-png', 'image/png')], { 'blob-fr-pdf': PDF_DATA_URL, 'blob-fr-png': PNG_DATA_URL });
    expect(isArchivedDocumentEmailSendable(doc())).toBe(true);
    expect(isArchivedDocumentEmailSendable(doc({ fileRefId: 'fr-png', mimeType: 'image/png' }))).toBe(false);
    expect(isArchivedDocumentEmailSendable(doc({ fileRefId: undefined }))).toBe(false);

    const prepared = await prepareArchivedDocumentDeliveryAttachment(doc());
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.attachment.filename).toBe('Zertifikat Schwei_en.pdf');
      expect(prepared.attachment.sizeBytes).toBe('%PDF-1.4 archived'.length);
      expect(prepared.attachment.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(prepared.attachment.mimeType).toBe('application/pdf');
    }
    expect(await prepareArchivedDocumentDeliveryAttachment(doc({ fileRefId: 'fr-png', mimeType: 'image/png' }))).toEqual({ ok: false, reason: 'no_pdf' });
    expect(await prepareArchivedDocumentDeliveryAttachment(undefined)).toEqual({ ok: false, reason: 'document_missing' });
  });

  it('Defaults: Empfaenger nur aus dem Kunden des Auftrags (sonst leer), Betreff/Text mit Titel und Firma', () => {
    const d = resolveDocumentDeliveryDraftDefaults({ title: 'Zertifikat', vorgangCustomerEmail: 'Kunde@Example.invalid', profile: { companyName: 'Betrieb', legalForm: 'GmbH' } }, 'de');
    expect(d.recipient).toEqual({ email: 'kunde@example.invalid', source: 'customer' });
    expect(d.subject).toBe('Zertifikat - Betrieb GmbH');
    expect(d.bodyText).toContain('„Zertifikat“');
    expect(d.bodyText).not.toMatch(/\{\w+\}/);
    expect(resolveDocumentDeliveryDraftDefaults({ title: 'X', vorgangCustomerEmail: null, profile: { companyName: 'B', legalForm: '' } }, 'de').recipient).toEqual({ email: '', source: 'none' });
  });

  it('J: Dokumentversand ruft nie die Rechnungskopplung — runSendDocument (Dokument) beruehrt keine Rechnung', async () => {
    hydrateDocumentStore([doc()]);
    hydrateDocumentFileStore([fileRef('fr-pdf')], { 'blob-fr-pdf': PDF_DATA_URL });
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const sentFields = vi.spyOn(vorgangService, 'updateInvoiceSentFields');
    const row = { id: 'd-doc', workspace_id: WS, client_delivery_id: 'cd-doc', document_kind: 'other', linked_invoice_id: null, linked_document_id: 'doc-b2', recipient_email: 'kunde@example.invalid', subject: 'S', body_text: 'B', attachment_storage_path: `${WS}/other-doc-b2/${'a'.repeat(64)}.pdf`, attachment_sha256: 'a'.repeat(64), attachment_size_bytes: 17, attachment_filename: 'Z.pdf', attachment_mime_type: 'application/pdf', provider: 'stub', provider_message_id: 'stub-1', status: 'provider_accepted', requested_by: 'u', requested_at: '2026-09-14T10:00:00.000Z', provider_accepted_at: '2026-09-14T10:00:01.000Z', failed_at: null, error_category: null, error_code: null, error_message_safe: null, retry_of_delivery_id: null, attempt_number: 1, created_at: '2026-09-14T10:00:00.000Z', updated_at: '2026-09-14T10:00:01.000Z', row_version: 2 };
    const client = {
      rpc: vi.fn(async (name: string) => ({ data: name.startsWith('list') ? [row] : { outcome: 'created', delivery: { ...row, status: 'queued', provider_message_id: null, provider_accepted_at: null, row_version: 1 } }, error: null })),
      storage: { from: vi.fn(() => ({ upload: vi.fn(async () => ({ error: null })) })) },
    } as never;
    const draft = orchestrator.createSendDraft({ identity: { kind: 'other', clientDocumentId: 'doc-b2' }, vorgangId: null, recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B' });
    const result = await orchestrator.runSendDocument({ draft, vorgangId: null }, { client, invokeSend: async () => ({ status: 200, body: { ok: true, action: 'sent', delivery: { id: 'd-doc', clientDeliveryId: 'cd-doc', status: 'provider_accepted', providerMessageId: 'stub-1', errorCategory: null, errorCode: null, errorMessageSafe: null, rowVersion: 2 } } }) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe('sent');
    expect(sentFields).not.toHaveBeenCalled();
  });
});

describe('V1-B2 — DocumentDeliveryPanel (O/L/M/N)', () => {
  let root: Root;
  let host: HTMLDivElement;
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  async function settle() { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
  async function mount(document: CompanyDocument) {
    host = window.document.createElement('div');
    window.document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(<MemoryRouter><AuthProvider><AppProvider initialSetup={setup}><DocumentDeliveryPanel document={document} /></AppProvider></AuthProvider></MemoryRouter>); });
    await settle();
  }
  function withDeliveries(list: DocumentDelivery[]) {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(orchestrator, 'refreshDocumentDeliveries').mockImplementation(async () => ({ ok: true, deliveries: list }));
  }

  beforeEach(async () => {
    resetTestStores();
    resetAuthForTests();
    resetDocumentFileStoreForTests();
    localStorage.clear();
    setActiveStorageScope({ type: 'workspace', workspaceId: WS });
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', legalForm: 'GmbH', email: 'info@betrieb.invalid', street: 'W', zip: '1', city: 'X', iban: 'DE89370400440532013000', taxNumber: '1' });
    hydrateDocumentFileStore([fileRef('fr-pdf'), fileRef('fr-png', 'image/png')], { 'blob-fr-pdf': PDF_DATA_URL, 'blob-fr-png': PNG_DATA_URL });
    vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
    hydrateWorkspaceStore({
      workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-admin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
      workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
    await loginAsDefaultAdmin();
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.document.body.innerHTML = ''; vi.restoreAllMocks(); resetTestStores(); });

  it('O: „Per E-Mail senden" nur mit PDF-Datei; Bild-Dokument zeigt den Grund; Dialog mit Vorbelegung, Anhangname, ohne technische Begriffe', async () => {
    withDeliveries([]);
    await mount(doc({ fileRefId: 'fr-png', mimeType: 'image/png' }));
    expect(q('document-delivery-panel')?.getAttribute('data-sendable')).toBe('false');
    expect(q('document-delivery-not-sendable')).not.toBeNull();
    expect(q('document-delivery-send')).toBeNull();
    await act(async () => root.unmount()); host.remove();

    await mount(doc());
    expect(q('document-delivery-panel')?.getAttribute('data-document-kind')).toBe('other');
    expect(q('document-delivery-send')?.textContent).toBe('Per E-Mail senden');
    await act(async () => { q('document-delivery-send')!.click(); }); await settle();
    const dialog = q('send-document-dialog')!;
    expect(dialog.getAttribute('data-document-kind')).toBe('other');
    expect(dialog.textContent).toContain('Dokument per E-Mail senden');
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('');
    expect((q('send-document-subject') as HTMLInputElement).value).toBe('Zertifikat Schweißen - Betrieb GmbH');
    expect(dialog.textContent).toContain('Zertifikat Schweißen.pdf');
    expect(dialog.textContent).not.toMatch(/Delivery|Provider|Storage|RPC|Hash/);
  });

  it('L/M: failed → „Erneut versuchen"; unknown → nur „Status prüfen", kein Senden, kein Orchestrator-Lauf', async () => {
    const run = vi.spyOn(orchestrator, 'runSendDocument');
    withDeliveries([delivery({ status: 'failed', errorCategory: 'recipient' })]);
    await mount(doc());
    expect(q('invoice-delivery-status')?.textContent).toBe('Versand fehlgeschlagen');
    expect(q('document-delivery-retry')).not.toBeNull();
    expect(q('document-delivery-check-status')).toBeNull();
    await act(async () => root.unmount()); host.remove();

    withDeliveries([delivery({ id: 'd-2', clientDeliveryId: 'cd-2', status: 'unknown', errorCategory: 'network' })]);
    await mount(doc());
    expect(q('document-delivery-check-status')).not.toBeNull();
    expect(q('document-delivery-retry')).toBeNull();
    expect(q('document-delivery-send')).toBeNull();
    expect(q('invoice-delivery-unknown-hint')?.textContent).toContain('doppelt');
    expect(run).not.toHaveBeenCalled();
  });

  it('N + Zweitversand: provider_accepted heisst „übergeben"; Fehler nur lokalisiert, kein Rohtext', async () => {
    withDeliveries([delivery({ status: 'provider_accepted', providerMessageId: 'm', providerAcceptedAt: '2026-09-14T10:01:00.000Z' })]);
    vi.spyOn(orchestrator, 'runSendDocument').mockImplementation(async ({ draft }) => ({ ok: false, error: 'rpc_failed', message: 'HTTP 500 {"code":"PGRST"} storage.objects', draft }));
    await mount(doc());
    expect(q('invoice-delivery-status')?.textContent).toBe('An E-Mail-Dienst übergeben');
    expect(host.textContent).not.toContain('Zugestellt');
    expect(q('document-delivery-send')?.textContent).toBe('Erneut per E-Mail senden');
    await act(async () => { q('document-delivery-send')!.click(); }); await settle();
    const input = q('send-document-recipient') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'kunde@example.invalid'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { q('send-document-send')!.click(); }); await settle();
    // Zweitversand verlangt Bestätigung
    expect(q('send-document-confirm-resend')).not.toBeNull();
    await act(async () => { q('send-document-send')!.click(); }); await settle();
    expect(q('send-document-error')?.textContent).toBe('Der Versanddienst ist nicht erreichbar. Es wurde nichts gesendet.');
    expect(host.textContent).not.toMatch(/HTTP|PGRST|storage\.objects/);
  });
});
