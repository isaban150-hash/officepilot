/**
 * EMAIL-01B3 — Dialog und Versandpanel: Vorbelegung, Confirm-first (kein
 * Versand ohne Klick, Zusatzbestätigung bei Empfängerabweichung/Zweitversand),
 * Labels/Fokus/Escape, Statusdarstellung („übergeben" ≠ „zugestellt"),
 * manual vs. officepilot, Retry nur nach failed, unknown → „Status prüfen".
 * Supabase-Client gestubbt; kein Netz.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../../services/persistenceService';
import * as orchestrator from '../../services/delivery/sendDocumentOrchestrator';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { buildInvoiceDraftForType, finalizeInvoiceDraft, updateDraftPositionQuantity, updateInvoiceDraftMetadata } from '../../services/invoiceService';
import { getVorgangInvoice, hydrateVorgangStore } from '../../services/vorgangService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { CompanySetup, Vorgang, VorgangInvoice } from '../../types/models';
import { InvoiceDeliveryPanel } from './InvoiceDeliveryPanel';
import { SendDocumentDialog } from './SendDocumentDialog';
import { de } from '../../i18n';

const WS = '00000000-0000-4000-8000-00000000e1b3';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const translate = (key: string) => (de as Record<string, string>)[key] ?? key;

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
function q(id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${id}"]`);
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
  await act(async () => { (q(id) as HTMLElement).click(); });
  await settle();
}

function finalizeInvoice(id: string, email = 'kunde@example.invalid'): VorgangInvoice {
  hydrateVorgangStore([{ ...createTestVorgang({ id, status: 'beauftragt', customerBilling: { name: 'Kunde GmbH', contactPerson: '', street: 'Weg 1', zip: '1', city: 'X', email, phone: '' }, orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })] }), invoices: [] } as Vorgang]);
  const base = buildInvoiceDraftForType(id, setup, 'rechnung')!;
  const draft = updateInvoiceDraftMetadata(updateDraftPositionQuantity(base, base.positions[0]!.id, 10), { servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-05', servicePeriodConfirmed: true });
  const result = finalizeInvoiceDraft(id, draft, setup);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return getVorgangInvoice(id, result.invoice.id)!;
}

function delivery(overrides: Partial<DocumentDelivery>): DocumentDelivery {
  return { id: 'd-1', workspaceId: WS, clientDeliveryId: 'cd-1', documentKind: 'invoice', linkedInvoiceId: 'inv', recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B', provider: 'stub', status: 'queued', requestedBy: 'u', requestedAt: '2026-09-14T10:00:00.000Z', attemptNumber: 1, createdAt: '', updatedAt: '', rowVersion: 1, ...overrides };
}

async function mount(node: React.ReactNode): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter><AuthProvider><AppProvider initialSetup={setup}>{node}</AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}

describe('EMAIL-01B3 — SendDocumentDialog', () => {
  beforeEach(() => { resetTestStores(); hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', street: 'W', zip: '1', city: 'X', email: 'i@b.invalid', iban: 'DE89370400440532013000', taxNumber: '1' }); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ''; resetTestStores(); });

  it('D1: zeigt An/Betreff/Nachricht/Anhang mit Labels; Fokus auf An; kein Versand ohne Klick; Escape/Abbrechen senden nicht', async () => {
    const invoice = finalizeInvoice('v-d1');
    const onSend = vi.fn();
    const onCancel = vi.fn();
    await mount(<SendDocumentDialog open invoice={invoice} initialRecipient="kunde@example.invalid" canonicalRecipient="kunde@example.invalid" initialSubject={`Rechnung ${invoice.number}`} initialBody="Text" attachmentFilename={`Rechnung_${invoice.number}.pdf`} alreadySent={false} mode="send" phase={null} busy={false} errorKey={null} translate={translate} onCancel={onCancel} onSend={onSend} />);
    expect(host.querySelector('label[for="send-document-recipient"]')?.textContent).toBe('An');
    expect(host.querySelector('label[for="send-document-subject"]')?.textContent).toBe('Betreff');
    expect(host.querySelector('label[for="send-document-body"]')?.textContent).toBe('Nachricht');
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('kunde@example.invalid');
    expect(q('send-document-attachment-name')?.textContent).toContain(`Rechnung_${invoice.number}.pdf`);
    expect(document.activeElement).toBe(q('send-document-recipient'));
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    await click('send-document-cancel');
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('D2: Erstversand ohne Doppelconfirm; leere/ungültige Adresse blockiert textuell; Empfängerabweichung und Zweitversand verlangen Bestätigung', async () => {
    const invoice = finalizeInvoice('v-d2');
    const onSend = vi.fn();
    await mount(<SendDocumentDialog open invoice={invoice} initialRecipient="kunde@example.invalid" canonicalRecipient="kunde@example.invalid" initialSubject="S" initialBody="B" attachmentFilename="R.pdf" alreadySent={false} mode="send" phase={null} busy={false} errorKey={null} translate={translate} onCancel={() => {}} onSend={onSend} />);
    await click('send-document-send');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toEqual({ recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B' });

    await type('send-document-recipient', '');
    await click('send-document-send');
    expect(q('send-document-field-error')?.textContent).toContain('keine E-Mail-Adresse');
    expect(onSend).toHaveBeenCalledTimes(1);
    await type('send-document-recipient', 'kaputt');
    await click('send-document-send');
    expect(q('send-document-field-error')?.textContent).toContain('gültige');
    expect(onSend).toHaveBeenCalledTimes(1);

    await type('send-document-recipient', 'Andere@Example.invalid');
    await click('send-document-send');
    expect(q('send-document-confirm-recipient')).not.toBeNull();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(q('send-document-send')?.textContent).toContain('Jetzt senden');
    await click('send-document-send');
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]![0].recipientEmail).toBe('andere@example.invalid');
    await act(async () => root.unmount());
    host.remove();

    const onSend2 = vi.fn();
    await mount(<SendDocumentDialog open invoice={invoice} initialRecipient="kunde@example.invalid" canonicalRecipient="kunde@example.invalid" initialSubject="S" initialBody="B" attachmentFilename="R.pdf" alreadySent mode="send" phase={null} busy={false} errorKey={null} translate={translate} onCancel={() => {}} onSend={onSend2} />);
    await click('send-document-send');
    expect(q('send-document-confirm-resend')).not.toBeNull();
    expect(onSend2).not.toHaveBeenCalled();
    await click('send-document-send');
    expect(onSend2).toHaveBeenCalledTimes(1);
  });

  it('D3: während des Versands ist Senden gesperrt, Phase sichtbar, Fehler textuell', async () => {
    const invoice = finalizeInvoice('v-d3');
    await mount(<SendDocumentDialog open invoice={invoice} initialRecipient="kunde@example.invalid" canonicalRecipient="kunde@example.invalid" initialSubject="S" initialBody="B" attachmentFilename="R.pdf" alreadySent={false} mode="send" phase="uploading" busy errorKey={'delivery.error.uploadFailed' as never} translate={translate} onCancel={() => {}} onSend={() => {}} />);
    expect((q('send-document-send') as HTMLButtonElement).disabled).toBe(true);
    expect(q('send-document-phase')?.textContent).toContain('Anhang wird gesichert');
    expect(q('send-document-error')?.getAttribute('role')).toBe('alert');
    expect(q('send-document-error')?.textContent).toContain('nichts gesendet');
    expect((host.querySelector('[role="dialog"]') as HTMLElement).getAttribute('aria-busy')).toBe('true');
  });
});

describe('EMAIL-01B3 — InvoiceDeliveryPanel', () => {
  beforeEach(async () => {
    resetTestStores();
    resetAuthForTests();
    localStorage.clear();
    setActiveStorageScope({ type: 'workspace', workspaceId: WS });
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', street: 'W', zip: '1', city: 'X', email: 'i@b.invalid', iban: 'DE89370400440532013000', taxNumber: '1' });
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
    hydrateWorkspaceStore({
      workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-admin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
      workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
    await loginAsDefaultAdmin();
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ''; vi.restoreAllMocks(); resetTestStores(); });

  function withDeliveries(list: DocumentDelivery[]) {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(orchestrator, 'refreshDeliveries').mockImplementation(async (input) => ({ ok: true, deliveries: list, invoice: input.invoice }));
  }

  it('P1: ohne Cloud kein Versand-Knopf, aber Panel mit Herkunft „Noch nicht versendet"', async () => {
    const invoice = finalizeInvoice('v-p1');
    await mount(<InvoiceDeliveryPanel vorgangId="v-p1" invoice={invoice} onInvoiceUpdated={() => {}} />);
    expect(q('invoice-delivery-panel')).not.toBeNull();
    expect(q('invoice-delivery-cloud-required')).not.toBeNull();
    expect(q('invoice-delivery-send')).toBeNull();
    expect(q('invoice-delivery-source')?.textContent).toContain('Noch nicht versendet');
  });

  it('P2: Historie — provider_accepted heisst „übergeben" (nie „zugestellt"), failed mit Kategorie + „Erneut versuchen", unknown mit „Status prüfen" und ohne Retry', async () => {
    const invoice = finalizeInvoice('v-p2');
    withDeliveries([delivery({ id: 'd-2', clientDeliveryId: 'cd-2', status: 'provider_accepted', providerMessageId: 'm', providerAcceptedAt: '2026-09-14T10:01:00.000Z' })]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-p2" invoice={invoice} onInvoiceUpdated={() => {}} />);
    const statuses = Array.from(host.querySelectorAll('[data-testid="invoice-delivery-status"]')).map((el) => el.textContent);
    expect(statuses).toEqual(['An E-Mail-Dienst übergeben']);
    expect(host.textContent).not.toContain('Zugestellt');
    expect(q('invoice-delivery-item')?.textContent).toContain('kunde@example.invalid');
    expect(q('invoice-delivery-send')?.textContent).toBe('Erneut per E-Mail senden');
    await act(async () => root.unmount());
    host.remove();

    withDeliveries([delivery({ id: 'd-3', clientDeliveryId: 'cd-3', status: 'failed', errorCategory: 'recipient', failedAt: '2026-09-14T10:01:00.000Z' })]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-p2" invoice={invoice} onInvoiceUpdated={() => {}} />);
    expect(q('invoice-delivery-status')?.textContent).toBe('Versand fehlgeschlagen');
    expect(q('invoice-delivery-error')?.textContent).toContain('Empfängeradresse');
    expect(q('invoice-delivery-retry')).not.toBeNull();
    expect(q('invoice-delivery-check-status')).toBeNull();
    await click('invoice-delivery-retry');
    expect(q('send-document-dialog')).not.toBeNull();
    expect(q('send-document-retry-hint')).not.toBeNull();
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('kunde@example.invalid');
    await act(async () => root.unmount());
    host.remove();

    withDeliveries([delivery({ id: 'd-4', clientDeliveryId: 'cd-4', status: 'unknown', errorCategory: 'network' })]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-p2" invoice={invoice} onInvoiceUpdated={() => {}} />);
    expect(q('invoice-delivery-status')?.textContent).toBe('Versandstatus unklar');
    expect(q('invoice-delivery-unknown-hint')).not.toBeNull();
    expect(q('invoice-delivery-check-status')).not.toBeNull();
    expect(q('invoice-delivery-retry')).toBeNull();
    expect(q('invoice-delivery-send')).toBeNull();
  });

  it('P3: manual vs. officepilot — Herkunft sichtbar, sentManualPrior bleibt als Hinweis', async () => {
    const invoice = finalizeInvoice('v-p3');
    withDeliveries([]);
    const manual: VorgangInvoice = { ...invoice, status: 'versendet', sentAt: '2026-09-01', sentVia: 'post', sentSource: 'manual' };
    await mount(<InvoiceDeliveryPanel vorgangId="v-p3" invoice={manual} onInvoiceUpdated={() => {}} />);
    expect(q('invoice-delivery-source')?.textContent).toContain('Extern als versendet markiert');
    expect(q('invoice-delivery-source')?.getAttribute('data-source') ?? q('invoice-delivery-source')?.querySelector('[data-source]')?.getAttribute('data-source')).toBe('manual');
    await act(async () => root.unmount());
    host.remove();

    const officepilot: VorgangInvoice = { ...manual, sentAt: '2026-09-14', sentVia: 'email', sentSource: 'officepilot', sentDeliveryId: 'd-1', sentManualPrior: { sentAt: '2026-09-01', sentVia: 'post' } };
    await mount(<InvoiceDeliveryPanel vorgangId="v-p3" invoice={officepilot} onInvoiceUpdated={() => {}} />);
    expect(q('invoice-delivery-source')?.textContent).toContain('Per OfficePilot versendet');
    expect(q('invoice-delivery-manual-prior')?.textContent).toMatch(/1.9.2026|01.09.2026/);
    expect(q('invoice-delivery-manual-prior')?.textContent).toContain('Post');
  });

  it('P4: „Per E-Mail senden" öffnet den Dialog mit Vorbelegung; Senden ruft genau einen Orchestrator-Lauf (Doppelklick gesperrt); Erfolg → Rechnung aus Serverwahrheit', async () => {
    const invoice = finalizeInvoice('v-p4');
    let deliveries: DocumentDelivery[] = [];
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(orchestrator, 'refreshDeliveries').mockImplementation(async (input) => ({ ok: true, deliveries, invoice: deliveries[0]?.status === 'provider_accepted' ? { ...input.invoice, status: 'versendet', sentSource: 'officepilot', sentVia: 'email', sentAt: '2026-09-14', sentDeliveryId: 'd-1' } : input.invoice }));
    const run = vi.spyOn(orchestrator, 'runSendDocument').mockImplementation(async (input) => {
      await new Promise((r) => setTimeout(r, 5));
      const d = delivery({ id: 'd-1', clientDeliveryId: input.draft.clientDeliveryId, status: 'provider_accepted', providerMessageId: 'm', providerAcceptedAt: '2026-09-14T10:01:00.000Z', recipientEmail: input.draft.recipientEmail });
      deliveries = [d];
      return { ok: true, action: 'sent', delivery: d, deliveries };
    });
    const onUpdated = vi.fn();
    await mount(<InvoiceDeliveryPanel vorgangId="v-p4" invoice={invoice} onInvoiceUpdated={onUpdated} />);
    expect(q('invoice-delivery-empty')).not.toBeNull();
    await click('invoice-delivery-send');
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('kunde@example.invalid');
    expect((q('send-document-subject') as HTMLInputElement).value).toBe(`Rechnung ${invoice.number} - Betrieb`);
    expect((q('send-document-body') as HTMLTextAreaElement).value).toContain(`unsere Rechnung ${invoice.number}`);
    expect(run).not.toHaveBeenCalled();
    // Zwei schnelle Klicks → ein Lauf.
    await act(async () => { (q('send-document-send') as HTMLElement).click(); (q('send-document-send') as HTMLElement).click(); });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].draft.clientDeliveryId).toMatch(/^cd-/);
    expect(q('send-document-dialog')).toBeNull();
    expect(q('invoice-delivery-status')?.textContent).toBe('An E-Mail-Dienst übergeben');
    expect(onUpdated).toHaveBeenCalled();
    expect(onUpdated.mock.calls.at(-1)![0]).toMatchObject({ status: 'versendet', sentSource: 'officepilot' });
    expect(orchestrator.loadSendDraft({ kind: 'invoice', clientInvoiceId: invoice.id })).toBeNull();
  });
});
