/**
 * E-MAIL-07B-FIX1 — Abnahmefehler beim Geschäftsbrief.
 *
 *  1. Widerspruch „Anhang sichtbar" + „keine versendbare PDF-Datei": Das PDF
 *     war lokal gebunden, in der Cloud aber (noch) nicht — der Server lehnte
 *     mit „Dokument nicht gefunden" / „Anhang gehoert nicht zu diesem Dokument"
 *     ab, und die Oberfläche übersetzte das in „keine PDF-Datei". Jetzt: einmal
 *     synchronisieren, derselbe Auftrag erneut (idempotent), sonst eine
 *     zutreffende Meldung. Fail-closed bleibt.
 *  2. Empfänger aus dem strukturell zugeordneten Kunden (Brief → customerId).
 *  3. Produktname im Versandbereich: OfficeTakt.
 *  4. Versand direkt auf der Briefseite — dasselbe Panel, dieselbe Delivery.
 *
 * Keine echte Mail: Cloud-Grenzen und Versandlauf sind gestubbt.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../../services/persistenceService';
import * as orchestrator from '../../services/delivery/sendDocumentOrchestrator';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateCustomerStore, getCustomerById } from '../../services/customerStoreService';
import { addDocument, getAllDocuments, getDocumentById } from '../../services/documentService';
import { hydrateDocumentFileStore, resetDocumentFileStoreForTests, getDocumentFileRefStoreSnapshot } from '../../services/documentFileStoreService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { resetTestStores } from '../../test/resetStores';
import {
  addBusinessLetter,
  attachArchiveDocumentToLetter,
  finalizeBusinessLetter,
  getBusinessLetterById,
} from '../../services/businessLetterService';
import {
  ensureBusinessLetterArchived,
  resolveBusinessLetterCustomerEmail,
} from '../../services/letter/businessLetterArchiveService';
import { rpcCreateWorkspaceDocumentDelivery, type CreateDocumentDeliveryInput } from '../../services/delivery/documentDeliveryCloudService';
import { DocumentDeliveryPanel, isArchivedDocumentEmailSendable } from './DocumentDeliveryPanel';
import { BriefDetailPage } from '../../pages/BriefDetailPage';
import { de } from '../../i18n';
import { deDelivery } from '../../i18n/locales/de/delivery';
import type { BusinessLetter } from '../../types/businessLetter';
import type { CompanyDocument, CompanySetup, Customer } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';

const WS = '00000000-0000-4000-8000-0000000b7f11';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const texte = de as Record<string, string>;
const PDF_DATA_URL = 'data:application/pdf;base64,' + btoa('%PDF-1.4 brief');

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`);
async function click(id: string): Promise<void> {
  await act(async () => { (q(id) as HTMLElement).click(); });
  await settle();
}
async function type(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function render(node: React.ReactNode, path = '/'): Promise<void> {
  host = window.document.createElement('div');
  window.document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            <Routes>
              <Route path="/schreiben/:letterId" element={<BriefDetailPage />} />
              <Route path="*" element={node} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}
async function unmount(): Promise<void> {
  await act(async () => root.unmount());
  host.remove();
}

function kunde(overrides: Partial<Customer> = {}): Customer {
  return { id: 'cust-az', name: 'AZ Testbau GmbH', street: 'Weg 1', zip: '33602', city: 'Bielefeld', email: 'testkunde@officepilot-test.de', createdAt: '2026-01-01T00:00:00.000Z', ...overrides } as Customer;
}

function fertigerBrief(customerId?: string): BusinessLetter {
  const angelegt = addBusinessLetter(WS, {
    subject: '01J Abnahme Kundenkontext',
    body: 'Sehr geehrte Damen und Herren,\n\nanbei.',
    letterDate: '2026-09-25',
    recipient: { name: '', company: 'AZ Testbau GmbH', street: 'Weg 1', zip: '33602', city: 'Bielefeld' },
    customerId,
  });
  if (!angelegt.success) throw new Error('Brief nicht angelegt');
  const fertig = finalizeBusinessLetter(angelegt.letter.id);
  if (!fertig.success) throw new Error('Brief nicht fertig');
  return fertig.letter;
}

async function abgelegterBrief(customerId?: string): Promise<{ brief: BusinessLetter; dokument: CompanyDocument }> {
  const brief = fertigerBrief(customerId);
  const ergebnis = await ensureBusinessLetterArchived(brief);
  if (!ergebnis.ok) throw new Error('nicht abgelegt');
  return { brief: getBusinessLetterById(brief.id)!, dokument: getDocumentById(ergebnis.document.id)! };
}

function withDeliveries() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(orchestrator, 'refreshDocumentDeliveries').mockImplementation(async () => ({ ok: true, deliveries: [] }));
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  resetDocumentFileStoreForTests();
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', legalForm: 'GmbH', email: 'info@betrieb.invalid', street: 'W', zip: '1', city: 'X', iban: 'DE89370400440532013000', taxNumber: '1' });
  hydrateCustomerStore([kunde(), kunde({ id: 'cust-ohne', name: 'Ohne Mail GmbH', email: '' })]);
  vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-admin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
  await loginAsDefaultAdmin();
});
afterEach(async () => {
  if (host?.isConnected) await unmount();
  window.document.body.innerHTML = '';
  vi.restoreAllMocks();
  resetTestStores();
});

/* ================================================================== */
/* 1 — kein Widerspruch zwischen Anhang und PDF-Zustand               */
/* ================================================================== */

describe('07B-FIX1 — PDF-Zustand des Geschäftsbriefs', () => {
  it('A/F: neuer Brief — Anhang sichtbar UND versendbar, Versandart letter', async () => {
    const { dokument } = await abgelegterBrief('cust-az');
    expect(isArchivedDocumentEmailSendable(dokument)).toBe(true);
    withDeliveries();
    await render(<DocumentDeliveryPanel document={dokument} />);
    expect(q('document-delivery-panel')?.getAttribute('data-sendable')).toBe('true');
    expect(q('document-delivery-panel')?.getAttribute('data-document-kind')).toBe('letter');
    expect(q('document-delivery-not-sendable')).toBeNull();
    await click('document-delivery-send');
    expect(q('send-document-attachment-name')?.textContent).toContain('01J Abnahme Kundenkontext.pdf');
    expect(q('send-document-error')).toBeNull();
  });

  it('B/C/H: alter Brief ohne fileRefId wird nachgerüstet — derselbe Eintrag, genau eine Datei', async () => {
    const brief = fertigerBrief('cust-az');
    const alt = addDocument({
      title: brief.subject, category: 'geschaeftsschreiben', issuer: 'Betrieb', issueDate: null, documentDate: null, linkedCompany: 'AZ Testbau GmbH',
      linkedVorgang: null, linkedLetterId: brief.id, classifiedKind: 'schriftverkehr',
      digitalFolder: { id: 'dig', name: 'G', path: '/G/' }, paperFolder: { folderId: 'paper-kunden', register: 'Sonstiges', label: 'K' },
      archived: true, recognizedText: brief.body, tags: [],
    });
    if (!alt.success) throw new Error('Altbestand');
    attachArchiveDocumentToLetter(brief.id, alt.document.id);
    expect(isArchivedDocumentEmailSendable(getDocumentById(alt.document.id)!)).toBe(false);

    const vorher = getDocumentFileRefStoreSnapshot().length;
    const [a, b] = await Promise.all([
      ensureBusinessLetterArchived(getBusinessLetterById(brief.id)!),
      ensureBusinessLetterArchived(getBusinessLetterById(brief.id)!),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(getAllDocuments().filter((d) => d.linkedLetterId === brief.id)).toHaveLength(1);
    expect(getDocumentFileRefStoreSnapshot().length - vorher).toBe(1);
    expect(isArchivedDocumentEmailSendable(getDocumentById(alt.document.id)!)).toBe(true);
  });

  it('D/E: nach Reload und direkt nach der Nachrüstung ist derselbe Eintrag versendbar — Dialog ohne Widerspruch', async () => {
    const { dokument } = await abgelegterBrief('cust-az');
    // Reload: echter Snapshot, serialisiert, Stores geleert, neu geladen.
    vi.restoreAllMocks();
    const gespeichert = JSON.parse(JSON.stringify(persistence.buildPersistedStateSnapshot()));
    resetTestStores();
    persistence.applyStateToStores(gespeichert);
    vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
    const neuGelesen = getDocumentById(dokument.id)!;
    expect(neuGelesen.fileRefId).toBe(dokument.fileRefId);
    expect(isArchivedDocumentEmailSendable(neuGelesen)).toBe(true);
    withDeliveries();
    await render(<DocumentDeliveryPanel document={neuGelesen} />);
    await click('document-delivery-send');
    expect(q('send-document-attachment-name')).not.toBeNull();
    expect(q('send-document-error')).toBeNull();
  });

  it('Server kennt das PDF noch nicht: einmal synchronisieren, derselbe Auftrag erneut — dann gesendet', async () => {
    const { dokument } = await abgelegterBrief('cust-az');
    const syncNow = vi.fn(async () => undefined);
    let createCalls = 0;
    const row = (status: string) => ({
      id: 'd-l', workspace_id: WS, client_delivery_id: 'x', document_kind: 'letter', linked_invoice_id: null, linked_document_id: dokument.id,
      recipient_email: 'testkunde@officepilot-test.de', subject: 'S', body_text: 'B', attachment_storage_path: `${WS}/letter-${dokument.id}/${'a'.repeat(64)}.pdf`,
      attachment_sha256: 'a'.repeat(64), attachment_size_bytes: 10, attachment_filename: 'B.pdf', attachment_mime_type: 'application/pdf', provider: 'stub',
      provider_message_id: status === 'provider_accepted' ? 'm-1' : null, status, requested_by: 'u', requested_at: '2026-09-26T10:00:00.000Z',
      provider_accepted_at: status === 'provider_accepted' ? '2026-09-26T10:00:01.000Z' : null, failed_at: null, error_category: null, error_code: null,
      error_message_safe: null, retry_of_delivery_id: null, attempt_number: 1, created_at: 'x', updated_at: 'x', row_version: status === 'queued' ? 1 : 3,
    });
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    let draftId = '';
    const client = {
      rpc: vi.fn(async (name: string) => {
        if (name.startsWith('list')) return { data: [{ ...row('provider_accepted'), client_delivery_id: draftId }], error: null };
        createCalls += 1;
        if (createCalls === 1) return { data: null, error: { message: 'Anhang gehoert nicht zu diesem Dokument' } };
        return { data: { outcome: 'created', delivery: { ...row('queued'), client_delivery_id: draftId } }, error: null };
      }),
      storage: { from: vi.fn(() => ({ upload: vi.fn(async () => ({ error: null })) })) },
    } as never;
    const draft = orchestrator.createSendDraft({ identity: { kind: 'letter', clientDocumentId: dokument.id }, vorgangId: null, recipientEmail: 'testkunde@officepilot-test.de', subject: 'S', bodyText: 'B' });
    draftId = draft.clientDeliveryId;
    const invokeSend = vi.fn(async () => ({ status: 200, body: { ok: true, action: 'sent' as const } }));
    const result = await orchestrator.runSendDocument({ draft, vorgangId: null }, { client, invokeSend, syncNow });
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(createCalls).toBe(2);
    expect(invokeSend).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, action: 'sent' });
  });

  it('G: bleibt die Bindung aus, wird nicht gesendet — mit zutreffender Meldung statt „keine PDF-Datei"', async () => {
    const { dokument } = await abgelegterBrief('cust-az');
    const syncNow = vi.fn(async () => undefined);
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const client = {
      rpc: vi.fn(async () => ({ data: null, error: { message: 'Dokument nicht gefunden' } })),
      storage: { from: vi.fn(() => ({ upload: vi.fn(async () => ({ error: null })) })) },
    } as never;
    const draft = orchestrator.createSendDraft({ identity: { kind: 'letter', clientDocumentId: dokument.id }, vorgangId: null, recipientEmail: 'a@b.invalid', subject: 'S', bodyText: 'B' });
    const invokeSend = vi.fn();
    const result = await orchestrator.runSendDocument({ draft, vorgangId: null }, { client, invokeSend, syncNow });
    expect(result).toMatchObject({ ok: false, error: 'attachment_not_synced' });
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(invokeSend).not.toHaveBeenCalled();
    expect(texte['delivery.error.attachmentNotSynced']).toContain('noch nicht online gesichert');
    expect(texte['delivery.error.attachmentNotSynced']).not.toContain('keine versendbare PDF');
  });

  it('G2: ohne PDF bleibt der Brief fail-closed nicht versendbar; eine unlesbare Datei ist keine „fehlende PDF"', async () => {
    const { dokument } = await abgelegterBrief('cust-az');
    const ohnePdf = { ...dokument, fileRefId: undefined } as CompanyDocument;
    expect(isArchivedDocumentEmailSendable(ohnePdf)).toBe(false);

    // Datei gebunden, Bytes auf diesem Gerät nicht lesbar.
    const ref: DocumentFileRef = { id: 'fr-weg', originalFileName: 'b.pdf', mimeType: 'application/pdf', fileSize: 10, contentHash: 'h', storageType: 'local_data_url', localDataKey: 'blob-weg', createdAt: 'x', lifecycleStatus: 'committed' };
    hydrateDocumentFileStore([ref], {});
    const unlesbar = { ...dokument, fileRefId: 'fr-weg' } as CompanyDocument;
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn((await import('../../services/documentService')), 'getDocumentById').mockReturnValue(unlesbar);
    const draft = orchestrator.createSendDraft({ identity: { kind: 'letter', clientDocumentId: dokument.id }, vorgangId: null, recipientEmail: 'a@b.invalid', subject: 'S', bodyText: 'B' });
    const result = await orchestrator.runSendDocument({ draft, vorgangId: null }, { client: { rpc: vi.fn() } as never, invokeSend: vi.fn() });
    expect(result).toMatchObject({ ok: false, error: 'attachment_unavailable' });
  });

  it('Fehlerklassen: nur Dokument-Bindung ist „noch nicht gesichert"; Rechnung bleibt not_found', async () => {
    const input = { workspaceId: WS, clientDeliveryId: 'cd', identity: { kind: 'letter', clientDocumentId: 'd' }, recipientEmail: 'a@b.invalid', subject: 'S', bodyText: 'B', attachment: { storagePath: 'p', sha256: 'a', sizeBytes: 1, filename: 'f.pdf' }, provider: 'stub' } as CreateDocumentDeliveryInput;
    const mit = (message: string) => rpcCreateWorkspaceDocumentDelivery(input, { rpc: vi.fn(async () => ({ data: null, error: { message } })) } as never);
    expect(await mit('Anhang gehoert nicht zu diesem Dokument')).toMatchObject({ error: 'attachment_not_synced' });
    expect(await mit('Dokument nicht gefunden')).toMatchObject({ error: 'attachment_not_synced' });
    expect(await mit('Rechnung nicht gefunden')).toMatchObject({ error: 'not_found' });
    expect(await mit('Dokumentart passt nicht zum Dokument')).toMatchObject({ error: 'not_sendable' });
  });

  it('das Panel zeigt bei „noch nicht gesichert" die zutreffende Meldung, nie „keine versendbare PDF-Datei" neben dem Anhang', async () => {
    const { dokument } = await abgelegterBrief('cust-az');
    withDeliveries();
    vi.spyOn(orchestrator, 'runSendDocument').mockImplementation(async (input) => ({ ok: false, error: 'attachment_not_synced', draft: input.draft }));
    await render(<DocumentDeliveryPanel document={dokument} />);
    await click('document-delivery-send');
    await click('send-document-send');
    expect(q('send-document-attachment-name')).not.toBeNull();
    const fehler = q('send-document-error')?.textContent ?? '';
    expect(fehler).toContain('noch nicht online gesichert');
    expect(fehler).not.toContain('keine versendbare PDF-Datei');
  });
});

/* ================================================================== */
/* 2 — Empfänger aus der strukturellen Kundenbeziehung                */
/* ================================================================== */

describe('07B-FIX1 — Kunden-E-Mail beim Geschäftsbrief', () => {
  it('A: Brief mit Kunde + E-Mail — Dialog vorbelegt', async () => {
    const { dokument } = await abgelegterBrief('cust-az');
    expect(resolveBusinessLetterCustomerEmail(dokument)).toBe('testkunde@officepilot-test.de');
    withDeliveries();
    await render(<DocumentDeliveryPanel document={dokument} />);
    await click('document-delivery-send');
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('testkunde@officepilot-test.de');
  });

  it('B: Kunde ohne E-Mail — leer', async () => {
    const { dokument } = await abgelegterBrief('cust-ohne');
    expect(resolveBusinessLetterCustomerEmail(dokument)).toBeNull();
    withDeliveries();
    await render(<DocumentDeliveryPanel document={dokument} />);
    await click('document-delivery-send');
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('');
  });

  it('C: Brief ohne Kunde — leer, kein Raten über den Firmennamen im Empfänger', async () => {
    const { dokument } = await abgelegterBrief(undefined);
    // Der Empfänger heißt wie der Kunde „AZ Testbau GmbH" — trotzdem keine Adresse.
    expect(resolveBusinessLetterCustomerEmail(dokument)).toBeNull();
    withDeliveries();
    await render(<DocumentDeliveryPanel document={dokument} />);
    await click('document-delivery-send');
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('');
  });

  it('D: eine Änderung im Dialog verändert den Kundenstamm nicht', async () => {
    const { dokument } = await abgelegterBrief('cust-az');
    withDeliveries();
    const run = vi.spyOn(orchestrator, 'runSendDocument').mockImplementation(async (input) => ({ ok: false, error: 'server_unavailable', draft: input.draft }));
    await render(<DocumentDeliveryPanel document={dokument} />);
    await click('document-delivery-send');
    await type('send-document-recipient', 'andere@example.invalid');
    await click('send-document-send'); // Abweichung bestätigen
    await click('send-document-send');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].draft.recipientEmail).toBe('andere@example.invalid');
    expect(getCustomerById('cust-az')?.email).toBe('testkunde@officepilot-test.de');
  });

  it('E: nach Reload bleibt die Zuordnung (Brief → Kunde) die Quelle', async () => {
    const { dokument, brief } = await abgelegterBrief('cust-az');
    vi.restoreAllMocks();
    const gespeichert = JSON.parse(JSON.stringify(persistence.buildPersistedStateSnapshot()));
    resetTestStores();
    persistence.applyStateToStores(gespeichert);
    expect(getBusinessLetterById(brief.id)?.customerId).toBe('cust-az');
    expect(resolveBusinessLetterCustomerEmail(getDocumentById(dokument.id)!)).toBe('testkunde@officepilot-test.de');
  });
});

/* ================================================================== */
/* 3/4 — OfficeTakt und Versand direkt auf der Briefseite             */
/* ================================================================== */

describe('07B-FIX1 — Produktname und Briefseite', () => {
  it('im Versandbereich steht überall OfficeTakt, nirgends OfficePilot', () => {
    const werte = Object.values(deDelivery).join('\n');
    expect(werte).not.toContain('OfficePilot');
    expect(texte['delivery.document.panel.hint']).toBe('OfficeTakt sendet dieses Dokument als PDF. Der Versand wird hier festgehalten.');
    expect(texte['delivery.source.officepilot']).toBe('Per OfficeTakt versendet');
  });

  it('die Briefseite bietet den Versand selbst an — dasselbe Panel, dasselbe Dokument, mit Kunden-Adresse', async () => {
    const brief = fertigerBrief('cust-az');
    withDeliveries();
    await render(null, `/schreiben/${brief.id}`);
    const panel = q('document-delivery-panel');
    expect(panel).not.toBeNull();
    const archiv = getBusinessLetterById(brief.id)!.documentId!;
    expect(panel?.getAttribute('data-document-kind')).toBe('letter');
    expect(panel?.getAttribute('data-sendable')).toBe('true');
    expect(panel?.textContent).toContain('Über OfficeTakt per E-Mail senden');
    expect(panel?.textContent).not.toContain('OfficePilot');
    // Genau ein Archiveintrag — die Briefseite legt keinen zweiten an.
    expect(getAllDocuments().filter((d) => d.linkedLetterId === brief.id).map((d) => d.id)).toEqual([archiv]);
    await click('document-delivery-send');
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('testkunde@officepilot-test.de');
  });

  it('ein Entwurf zeigt keinen Versandbereich', async () => {
    const entwurf = addBusinessLetter(WS, { subject: 'Entwurf', body: 'x', letterDate: '2026-09-25', recipient: { name: 'X', company: '', street: '', zip: '', city: '' }, customerId: 'cust-az' });
    if (!entwurf.success) throw new Error('nicht angelegt');
    withDeliveries();
    await render(null, `/schreiben/${entwurf.letter.id}`);
    expect(q('letter-detail-page')).not.toBeNull();
    expect(q('document-delivery-panel')).toBeNull();
  });

  it('eine PDF-Datei im Speicher wird nicht als Bild behandelt (Kontrolle der Testumgebung)', () => {
    hydrateDocumentFileStore([{ id: 'fr-x', originalFileName: 'x.pdf', mimeType: 'application/pdf', fileSize: 10, contentHash: 'h', storageType: 'local_data_url', localDataKey: 'blob-x', createdAt: 'x', lifecycleStatus: 'committed' }], { 'blob-x': PDF_DATA_URL });
    expect(isArchivedDocumentEmailSendable({ id: 'z', fileRefId: 'fr-x', mimeType: 'application/pdf' } as CompanyDocument)).toBe(true);
  });
});
