/**
 * E-MAIL-07C — sichtbare Teile: Einstellungen (Signatur, Vorlagen, Reload,
 * Cloud-Payload), Versanddialog (Signatur genau einmal, Dialogänderung
 * verändert die Vorlage nicht) und Kommunikationshistorie (Alltagssprache,
 * Retry-Kette als eine Zeile).
 *
 * Neutrale Beispieldaten.
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
import * as orchestrator from '../../services/delivery/sendDocumentOrchestrator';
import * as persistence from '../../services/persistenceService';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { hydrateDocumentStore } from '../../services/documentService';
import { hydrateDocumentFileStore, resetDocumentFileStoreForTests } from '../../services/documentFileStoreService';
import { hydrateBusinessLetters } from '../../services/businessLetterService';
import { hydrateCustomerStore } from '../../services/customerStoreService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { buildCompanyProfileCloudPayload } from '../../services/workspace/workspaceCloudService';
import { parseDocumentDeliveryRow } from '../../services/delivery/documentDeliveryContract';
import { groupDeliveryThreads } from '../../services/delivery/deliveryCommunicationContext';
import { CommunicationSettingsPage } from '../../pages/settings/CommunicationSettingsPage';
import { DocumentDeliveryPanel } from '../documents/DocumentDeliveryPanel';
import { CommunicationHistorySection } from './CommunicationHistorySection';
import type { CompanyDocument, CompanySetup, Customer } from '../../types/models';
import type { BusinessLetter } from '../../types/businessLetter';
import type { DocumentFileRef } from '../../types/documentFileRef';

const WS = '00000000-0000-4000-8000-0000000007c0';
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
const SIGNATURE = 'Mit freundlichen Grüßen\n\nBeispiel Haustechnik GmbH\nBahnhofstraße 12\n32105 Bad Salzuflen\nTelefon 05222 000000\nE-Mail info@beispiel.invalid';

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function type(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLInputElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(id: string): Promise<void> {
  await act(async () => { q(id)!.click(); });
  await settle();
}
async function mount(node: ReactNode): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter><AuthProvider><AppProvider initialSetup={setup}><Routes><Route path="*" element={node} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}
async function unmount(): Promise<void> {
  await act(async () => root.unmount());
  host.remove();
}

async function asOwner(): Promise<void> {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-admin', createdAt: 'x', updatedAt: 'x', version: 1 },
    workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: 'x', updatedAt: 'x' }],
  });
  await loginAsDefaultAdmin();
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  resetDocumentFileStoreForTests();
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  hydrateCompanyProfileStore({ ...PROFILE });
  await asOwner();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  resetTestStores();
});

describe('E-MAIL-07C — Einstellungen', () => {
  it('P: Signatur und Vorlagen sichtbar, speichern, nach Reload erhalten, im Cloud-Payload', async () => {
    await mount(<CommunicationSettingsPage />);
    expect(q('settings-communication-section-signature')).not.toBeNull();
    expect((q('settings-communication-emailSignature') as HTMLTextAreaElement).placeholder).toBe(SIGNATURE);
    expect(q('settings-communication-section-email')).not.toBeNull(); // Rechnung (bestehende Vorlage)
    expect(q('settings-communication-section-template-offer')).not.toBeNull();
    expect(q('settings-communication-section-template-letter')).not.toBeNull();
    // Nur belegbare Platzhalter: der Brief hat keine Dokumentnummer.
    expect(q('settings-communication-placeholders-letter')?.textContent).not.toContain('{{documentNumber}}');
    expect(q('settings-communication-placeholders-offer')?.textContent).toContain('{{documentNumber}}');
    // Vorschau mit Signatur genau einmal.
    expect(q('settings-communication-preview-letter-body')?.textContent?.split('Mit freundlichen Grüßen')).toHaveLength(2);

    await type('settings-communication-emailSignature', 'Viele Grüße\nIhr Beispiel-Team');
    await type('settings-communication-defaultOfferEmailSubject', 'Unser Angebot {{documentNumber}}');
    await type('settings-communication-defaultLetterEmailBody', 'Hallo {{customerName}},\n\nanbei „{{documentTitle}}“.');
    expect(q('settings-communication-preview-offer-subject')?.textContent).toBe('Unser Angebot AN-2026-0001');
    const form = host.querySelector('form.settings-form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();

    const saved = getCompanyProfile();
    expect(saved).toMatchObject({
      emailSignature: 'Viele Grüße\nIhr Beispiel-Team',
      defaultOfferEmailSubject: 'Unser Angebot {{documentNumber}}',
      defaultLetterEmailBody: 'Hallo {{customerName}},\n\nanbei „{{documentTitle}}“.',
    });
    // Cloud: dieselben Felder reisen im Firmenprofil-Payload.
    expect(buildCompanyProfileCloudPayload(saved).payload).toMatchObject({
      emailSignature: 'Viele Grüße\nIhr Beispiel-Team',
      defaultOfferEmailSubject: 'Unser Angebot {{documentNumber}}',
    });
    // Reload: aus dem gespeicherten Bestand neu einlesen.
    const stored = persistence.loadPersistedState();
    expect(stored?.companyProfile?.emailSignature).toBe('Viele Grüße\nIhr Beispiel-Team');
    await unmount();
    resetTestStores();
    hydrateCompanyProfileStore(stored!.companyProfile!);
    await asOwner();
    await mount(<CommunicationSettingsPage />);
    expect((q('settings-communication-emailSignature') as HTMLTextAreaElement).value).toBe('Viele Grüße\nIhr Beispiel-Team');
    expect((q('settings-communication-defaultOfferEmailSubject') as HTMLInputElement).value).toBe('Unser Angebot {{documentNumber}}');
    await unmount();
  });
});

describe('E-MAIL-07C — Versanddialog', () => {
  const PDF_DATA_URL = 'data:application/pdf;base64,' + btoa('%PDF-1.4 brief');
  function fileRef(): DocumentFileRef {
    return { id: 'fr-brief', originalFileName: 'brief.pdf', mimeType: 'application/pdf', fileSize: 20, contentHash: 'hash-brief', storageType: 'local_data_url', localDataKey: 'blob-fr-brief', createdAt: '2026-09-01T00:00:00.000Z', lifecycleStatus: 'committed' };
  }
  const letterDoc: CompanyDocument = {
    id: 'doc-brief-07c', title: 'Terminbestätigung', category: 'schriftverkehr', issuer: '', recognizedText: '', issueDate: '2026-09-01', validUntil: null,
    digitalFolder: { id: 'd', name: 'Briefe', path: '/B/' }, paperFolder: { folderId: 'f', register: 'A', label: 'B' }, tags: [], linkedCompany: 'Betrieb',
    linkedVorgang: null, archived: false, createdAt: '2026-09-01T00:00:00.000Z', fileRefId: 'fr-brief', mimeType: 'application/pdf', linkedLetterId: 'letter-07c',
  } as unknown as CompanyDocument;

  beforeEach(() => {
    hydrateDocumentFileStore([fileRef()], { 'blob-fr-brief': PDF_DATA_URL });
    hydrateCustomerStore([{ id: 'c-07c', name: 'Beispiel Kunde GmbH', street: 'W', zip: '1', city: 'X', email: 'kunde@example.invalid', createdAt: '2026-09-01T00:00:00.000Z' } as Customer]);
    hydrateBusinessLetters([{ id: 'letter-07c', workspaceId: WS, subject: 'Terminbestätigung', body: 'Text', customerId: 'c-07c', status: 'finalized', recipient: {}, documentId: 'doc-brief-07c' } as unknown as BusinessLetter]);
    hydrateDocumentStore([letterDoc]);
    vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
    vi.spyOn(orchestrator, 'refreshDocumentDeliveries').mockImplementation(async () => ({ ok: true, deliveries: [] }));
  });

  it('J/K/L/O: Brief — Briefvorlage + Signatur genau einmal; Dialogänderung und erneutes Öffnen verändern nichts an der Vorlage', async () => {
    const run = vi.spyOn(orchestrator, 'runSendDocument');
    await mount(<DocumentDeliveryPanel document={letterDoc} />);
    await click('document-delivery-send');
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('kunde@example.invalid');
    expect((q('send-document-subject') as HTMLInputElement).value).toBe('Terminbestätigung - Beispiel Haustechnik GmbH');
    const body = (q('send-document-body') as HTMLTextAreaElement).value;
    expect(body).toBe(`Guten Tag,\n\nanbei erhalten Sie unser Schreiben „Terminbestätigung“.\n\n${SIGNATURE}`);
    expect(body).not.toMatch(/Rechnung|Angebot|\{\{/);

    // Einmalige Änderung im Dialog, dann abbrechen.
    await type('send-document-body', `${body}\n\nPS: nur für diesen Versand`);
    await type('send-document-subject', 'Einmaliger Betreff');
    await click('send-document-cancel');
    expect(getCompanyProfile().defaultLetterEmailBody).toBeUndefined();
    expect(getCompanyProfile().defaultLetterEmailSubject).toBeUndefined();

    // Erneut öffnen: wieder Vorlage + Signatur genau einmal, keine Reste der Änderung.
    await click('document-delivery-send');
    const reopened = (q('send-document-body') as HTMLTextAreaElement).value;
    expect(reopened).toBe(body);
    expect(reopened.split('Mit freundlichen Grüßen')).toHaveLength(2);
    expect((q('send-document-subject') as HTMLInputElement).value).toBe('Terminbestätigung - Beispiel Haustechnik GmbH');
    expect(run).not.toHaveBeenCalled();
    await unmount();
  });
});

describe('E-MAIL-07C — Kommunikationshistorie', () => {
  function row(overrides: Record<string, unknown>) {
    return parseDocumentDeliveryRow({
      id: 'd1', workspace_id: WS, client_delivery_id: 'c1', document_kind: 'letter', linked_invoice_id: null, linked_document_id: 'doc-x',
      recipient_email: 'saban@example.invalid', subject: '01J Abnahme Kundenkontext - Beispiel Haustechnik GmbH', body_text: 'x',
      attachment_storage_path: null, attachment_sha256: null, attachment_size_bytes: null, attachment_filename: '01J Abnahme Kundenkontext.pdf', attachment_mime_type: null,
      provider: 'brevo', provider_message_id: null, status: 'failed', requested_by: 'u', requested_at: '2026-09-26T11:37:16.000Z', provider_accepted_at: null,
      failed_at: '2026-09-26T11:37:17.000Z', error_category: 'auth', error_code: 'x', error_message_safe: 'x', retry_of_delivery_id: null, attempt_number: 1,
      created_at: '2026-09-26T11:37:16.000Z', updated_at: '2026-09-26T11:37:17.000Z', row_version: 2, ...overrides,
    })!;
  }

  it('G/E: eine Zeile je Versandkette, Status in Alltagssprache, Versuche als Verlauf, keine technischen Begriffe', async () => {
    const threads = groupDeliveryThreads([
      row({}),
      row({
        id: 'd2', client_delivery_id: 'c2', retry_of_delivery_id: 'd1', attempt_number: 2, status: 'provider_accepted', provider_message_id: 'm',
        provider_accepted_at: '2026-09-26T20:13:49.000Z', failed_at: null, error_category: null, error_code: null, error_message_safe: null,
        requested_at: '2026-09-26T20:13:40.000Z',
      }),
    ]);
    const load = vi.fn(async () => ({ ok: true as const, threads, incomplete: false }));
    await mount(<CommunicationHistorySection target={{ customerId: 'c-07c' }} testId="kunden-email-history" load={load} />);
    expect(load).toHaveBeenCalledWith({ customerId: 'c-07c' });
    expect(host.querySelectorAll('[data-testid="kunden-email-history-thread"]')).toHaveLength(1);
    const text = q('kunden-email-history')!.textContent!;
    expect(text).toContain('Kommunikation');
    expect(text).toContain('Gesendet an saban@example.invalid');
    expect(text).toContain('An E-Mail-Dienst übergeben');
    expect(text).toContain('Versuch 1: Versand fehlgeschlagen · Versuch 2: An E-Mail-Dienst übergeben');
    expect(text).not.toMatch(/provider_accepted|retry_of|failed\b|unknown/);
    await unmount();
  });

  it('leer und ohne Cloud verständlich', async () => {
    await mount(<CommunicationHistorySection target={{ vorgangId: 'v-1' }} testId="vorgang-email-history" load={async () => ({ ok: true, threads: [], incomplete: false })} />);
    expect(q('vorgang-email-history-empty')?.textContent).toBe('Noch keine E-Mails über OfficeTakt versendet.');
    await unmount();
    await mount(<CommunicationHistorySection target={{ vorgangId: 'v-1' }} testId="vorgang-email-history" load={async () => ({ ok: false, error: 'not_configured' })} />);
    expect(q('vorgang-email-history-unavailable')?.textContent).toBe('Die Kommunikation ist mit Cloud-Anbindung sichtbar.');
    await unmount();
  });
});
