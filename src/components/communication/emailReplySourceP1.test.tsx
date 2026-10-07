/**
 * P1 EINGANGSSCHREIBEN Phase 1 — E-Mail-Antwort auf ein Eingangsschreiben.
 *
 *  M  die Quelle reist in den bestehenden E-Mail-Editor: Empfänger (bestätigter Kunde)
 *     und Betreff vorbelegt, eigener Entwurfsplatz je Schreiben, Hinweis sichtbar
 *  N  über diesen Weg wird nie ohne Pflichtbestätigung gesendet
 *  O  erst ein erfolgreicher Versand erfasst „beantwortet" — mit Nachweis auf die Mail;
 *     ein fehlgeschlagener oder noch laufender Versand nicht
 *  P  ohne belastbare Adresse bleibt „An" leer — nichts wird erfunden
 *  —  Antwort auf die ursprüngliche Mail (Schreiben kam als Mail-Anhang) trägt die Quelle ebenso
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
import { createAuftragInboxItem } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../../services/persistenceService';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { hydrateCustomerStore } from '../../services/customerStoreService';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { hydrateInboxStore } from '../../services/inboxService';
import { hydrateDocumentWorkResultStore } from '../../services/documentWorkResultStoreService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { parseEmailMessageRow } from '../../services/email/emailMessageCloudService';
import * as freeEmail from '../../services/email/freeEmailOrchestrator';
import { getCommunicationEvents } from '../../services/communicationHistoryService';
import { resolveDocumentReplyNeed } from '../../services/documentReplyNeedService';
import { KommunikationEmailComposePage } from '../../pages/KommunikationEmailComposePage';
import type { BusinessInterpretationResult } from '../../types/businessInterpretation';
import type { CompanySetup, Customer, Vorgang } from '../../types/models';
import type { EmailMessage } from '../../types/emailMessage';

const WS = '00000000-0000-4000-8000-0000000p1e01';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const value = (id: string) => (q(id) as HTMLInputElement).value;
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function click(id: string): Promise<void> {
  const target = q(id) ?? (document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null);
  await act(async () => { target!.click(); });
  await settle();
}
async function type(id: string, text: string): Promise<void> {
  const el = q(id) as HTMLTextAreaElement | HTMLInputElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
async function mount(node: ReactNode, path: string): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            <Routes>
              <Route path="/kommunikation/email/neu" element={node} />
              <Route path="*" element={<p data-testid="navigated">elsewhere</p>} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

function antwortFristErgebnis(inboxItemId: string) {
  return {
    schemaVersion: 1 as const,
    inboxItemId,
    analyzedAt: '2026-10-07T09:00:00.000Z',
    analysisVersion: 'p1-test',
    sourceFingerprint: `fp-${inboxItemId}`,
    businessInterpretation: {
      operational: { primaryCase: 'communication_information', meanings: [], nextStep: '', confirmRequirement: '', certainty: 'detected' },
      semantic: {
        deadlines: [{ date: '2026-10-20', type: 'response_due', appliesTo: 'Antwort', actionRequired: true, certainty: 'detected' }],
        subject: { value: 'Rückfrage zum Bauvorhaben' },
      },
    } as unknown as BusinessInterpretationResult,
    specialistRefs: { hasContractIntelligence: false, hasContractOrderProposal: false, hasClassification: true, hasDocumentUnderstanding: true, companyRelevant: true },
    overlay: [],
  };
}

function inbound(): EmailMessage {
  return parseEmailMessageRow({
    id: 'in-mail-1', workspace_id: WS, client_message_id: 'in:c:p1', direction: 'inbound', provider: 'microsoft_graph', provider_message_id: 'p-p1',
    mailbox_connection_id: 'conn-1', internet_message_id: '<p1@absender.invalid>', from_address: 'service@absender.invalid', from_name: 'Absender Service',
    to_recipients: ['buero@betrieb.invalid'], cc_recipients: [], bcc_recipients: [],
    subject: 'Ihre Rückmeldung bis 20.10.', body_text: 'Bitte teilen Sie uns bis zum 20.10.2026 mit, ob …', has_html: false, status: 'received',
    received_at: '2026-10-06T08:00:00.000Z', imported_at: '2026-10-06T08:01:00.000Z', created_at: '2026-10-06T08:01:00.000Z',
    updated_at: '2026-10-06T08:01:00.000Z', row_version: 1, attachments: [],
  } as never);
}

const sentMessage = (id: string) => ({ id } as unknown as EmailMessage);

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
    { id: 'c-1', name: 'Bauherr Eins GmbH', street: 'Weg 1', zip: '33602', city: 'Bielefeld', email: 'post@bauherr-eins.invalid', createdAt: '2026-09-01T00:00:00.000Z' } as Customer,
  ]);
  hydrateVorgangStore([
    { id: 'v-1', title: 'Neubau Eins', customer: 'Bauherr Eins GmbH', customerId: 'c-1', baustelle: '', status: 'aktiv', documents: [], tasks: [], photos: [], createdAt: '2026-09-01', updatedAt: '2026-09-01' } as unknown as Vorgang,
  ]);
  hydrateInboxStore([
    createAuftragInboxItem({ id: 'in-m', title: 'Rückfrage Bauvorhaben', documentType: 'brief', classifiedKind: 'brief', sender: 'Bauherr Eins GmbH', vorgangId: 'v-1', vorgangLinkStatus: 'linked', recognizedData: { Datum: '05.10.2026' }, deadline: null }),
    createAuftragInboxItem({ id: 'in-ohne', title: 'Schreiben ohne Adresse', documentType: 'brief', classifiedKind: 'brief', sender: 'Unbekannte Stelle', recognizedData: {}, deadline: null }),
    createAuftragInboxItem({
      id: 'in-anhang', title: 'Schreiben aus Mail', documentType: 'brief', classifiedKind: 'brief', sender: 'Absender Service', recognizedData: {}, deadline: null,
      emailOrigin: { messageId: 'in-mail-1', attachmentId: 'att-1', position: 0, sha256: 'x', importedAt: '2026-10-06T08:02:00.000Z' },
    }),
  ]);
  hydrateDocumentWorkResultStore([antwortFristErgebnis('in-m'), antwortFristErgebnis('in-ohne'), antwortFristErgebnis('in-anhang')]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Netz im Test verboten'); });
});

afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  resetTestStores();
});

const quelle = (id: string) => `/kommunikation/email/neu?quelle=${encodeURIComponent(`inbox:${id}`)}`;
const answeredEvents = () => getCommunicationEvents().filter((event) => event.type === 'marked_answered');

describe('P1 — E-Mail-Antwort auf ein Eingangsschreiben', () => {
  it('M — Empfänger und Betreff vorbelegt, eigener Entwurfsplatz, Hinweis auf die Quelle', async () => {
    await mount(<KommunikationEmailComposePage />, quelle('in-m'));
    expect(value('free-email-to')).toBe('post@bauherr-eins.invalid');
    expect(value('free-email-subject')).toBe('Ihr Schreiben vom 05.10.2026 – Rückfrage zum Bauvorhaben');
    expect(q('kommunikation-email-reply-source')?.textContent).toContain('Rückfrage Bauvorhaben');
    expect(freeEmail.loadFreeEmailDraft(undefined, undefined, { type: 'inbox', id: 'in-m' })?.sourceRef).toEqual({ type: 'inbox', id: 'in-m' });
    // Der allgemeine freie Entwurf bleibt unberührt.
    expect(freeEmail.loadFreeEmailDraft()).toBeNull();
  });

  it('N — ohne ausdrückliche Bestätigung wird nichts gesendet', async () => {
    const send = vi.spyOn(freeEmail, 'sendFreeEmail');
    await mount(<KommunikationEmailComposePage />, quelle('in-m'));
    await type('free-email-body', 'Sehr geehrte Damen und Herren, wir melden uns bis Freitag.');
    await click('free-email-send');
    expect(q('kommunikation-reply-confirm')).not.toBeNull();
    expect(send).not.toHaveBeenCalled();
    await click('kommunikation-reply-confirm-cancel');
    expect(send).not.toHaveBeenCalled();
    expect(answeredEvents()).toHaveLength(0);
    expect(resolveDocumentReplyNeed({ inboxId: 'in-m' }).state).toBe('open');
  });

  it('O — nach bestätigtem, erfolgreichem Versand ist das Schreiben beantwortet (Nachweis auf die Mail)', async () => {
    const send = vi.spyOn(freeEmail, 'sendFreeEmail').mockResolvedValue({ ok: true, action: 'sent', message: sentMessage('out-p1'), chain: [] } as never);
    await mount(<KommunikationEmailComposePage />, quelle('in-m'));
    await type('free-email-body', 'Sehr geehrte Damen und Herren, wir melden uns bis Freitag.');
    await click('free-email-send');
    await click('kommunikation-reply-confirm-send');
    expect(send).toHaveBeenCalledTimes(1);
    const [event] = answeredEvents();
    expect(event?.contextRef).toEqual({ type: 'inbox', id: 'in-m' });
    expect(event?.channel).toBe('email');
    expect(event?.answerRef).toEqual({ kind: 'email', id: 'out-p1' });
    expect(resolveDocumentReplyNeed({ inboxId: 'in-m' }).state).toBe('answered');
  });

  it('O — ein fehlgeschlagener oder noch laufender Versand erledigt das Schreiben nicht', async () => {
    for (const action of ['failed', 'in_progress', 'unknown_pending'] as const) {
      vi.spyOn(freeEmail, 'sendFreeEmail').mockResolvedValue({ ok: true, action, message: sentMessage(`out-${action}`), chain: [] } as never);
      await mount(<KommunikationEmailComposePage />, quelle('in-m'));
      await type('free-email-body', 'Text.');
      await click('free-email-send');
      await click('kommunikation-reply-confirm-send');
      await act(async () => root.unmount());
      document.body.innerHTML = '';
      vi.mocked(freeEmail.sendFreeEmail).mockRestore();
    }
    expect(answeredEvents()).toHaveLength(0);
    expect(resolveDocumentReplyNeed({ inboxId: 'in-m' }).state).toBe('open');
  });

  it('P — ohne belastbare Adresse bleibt „An" leer', async () => {
    await mount(<KommunikationEmailComposePage />, quelle('in-ohne'));
    expect(value('free-email-to')).toBe('');
    expect(value('free-email-subject')).toContain('Ihr Schreiben');
  });

  it('Antwort auf die ursprüngliche Mail trägt die Quelle; erst der bestätigte Versand erledigt das Schreiben', async () => {
    const send = vi.spyOn(freeEmail, 'sendFreeEmail').mockResolvedValue({ ok: true, action: 'sent', message: sentMessage('out-reply'), chain: [] } as never);
    const loadReplySource = async () => ({ ok: true as const, parent: inbound(), ownAddresses: ['buero@betrieb.invalid'], thread: [inbound()] });
    await mount(
      <KommunikationEmailComposePage loadReplySource={loadReplySource} />,
      `/kommunikation/email/neu?antwortAuf=in-mail-1&quelle=${encodeURIComponent('inbox:in-anhang')}`,
    );
    expect(value('free-email-to')).toBe('service@absender.invalid');
    await type('free-email-body', 'Danke, wir melden uns.');
    await click('free-email-send');
    expect(send).not.toHaveBeenCalled();
    await click('kommunikation-reply-confirm-send');
    expect(send).toHaveBeenCalledTimes(1);
    const [event] = answeredEvents();
    expect(event?.contextRef).toEqual({ type: 'inbox', id: 'in-anhang' });
    expect(event?.answerRef).toEqual({ kind: 'email', id: 'out-reply' });
  });
});
