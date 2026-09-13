/**
 * EMAIL-01B4 — Korrekturbeleg-Versand (UI) und Settings-Abschnitt „E-Mail-Versand".
 * Correction-Panel nur bei Korrektur, eigener Dialogtitel/Betreff/Anhang,
 * Historie mit Dokumentart, Retry/Unknown/Zweitversand, Original bleibt
 * unberührt; Settings: Felder, Save/Reload, Validierung, read-only, Draft-Freeze.
 * Supabase gestubbt; kein Netz.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
import { getCompanyProfile, hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { buildInvoiceDraftForType, finalizeInvoiceDraft, updateDraftPositionQuantity, updateInvoiceDraftMetadata } from '../../services/invoiceService';
import { getVorgangInvoice, hydrateVorgangStore } from '../../services/vorgangService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { InvoiceSettingsPage } from '../../pages/settings/InvoiceSettingsPage';
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { CompanySetup, Vorgang, VorgangInvoice } from '../../types/models';
import { InvoiceDeliveryPanel } from './InvoiceDeliveryPanel';

const WS = '00000000-0000-4000-8000-00000000e1b4';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const PROFILE = { ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', legalForm: 'GmbH', contactPerson: 'A', street: 'W', zip: '1', city: 'X', email: 'i@b.invalid', iban: 'DE89370400440532013000', taxNumber: '1', defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.' };

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
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

function finalizeInvoice(id: string): VorgangInvoice {
  hydrateVorgangStore([{ ...createTestVorgang({ id, status: 'beauftragt', customerBilling: { name: 'Kunde GmbH', contactPerson: '', street: 'Weg 1', zip: '1', city: 'X', email: 'kunde@example.invalid', phone: '' }, orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })] }), invoices: [] } as Vorgang]);
  const base = buildInvoiceDraftForType(id, setup, 'rechnung')!;
  const draft = updateInvoiceDraftMetadata(updateDraftPositionQuantity(base, base.positions[0]!.id, 10), { servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-05', servicePeriodConfirmed: true });
  const result = finalizeInvoiceDraft(id, draft, setup);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return getVorgangInvoice(id, result.invoice.id)!;
}

function delivery(overrides: Partial<DocumentDelivery>): DocumentDelivery {
  return { id: 'd-1', workspaceId: WS, clientDeliveryId: 'cd-1', documentKind: 'invoice_correction', linkedInvoiceId: 'inv', recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B', provider: 'stub', status: 'queued', requestedBy: 'u', requestedAt: '2026-09-14T10:00:00.000Z', attemptNumber: 1, createdAt: '', updatedAt: '', rowVersion: 1, ...overrides };
}

async function mount(node: ReactNode): Promise<void> {
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={['/einstellungen/rechnungen']}><AuthProvider><AppProvider initialSetup={setup}><Routes><Route path="*" element={node} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  hydrateCompanyProfileStore(PROFILE);
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-admin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
  await loginAsDefaultAdmin();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ''; vi.restoreAllMocks(); resetTestStores(); localStorage.clear(); });

function withDeliveries(list: DocumentDelivery[]) {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(orchestrator, 'refreshDeliveries').mockImplementation(async (input) => ({ ok: true, deliveries: list.filter((d) => d.documentKind === input.identity.kind), invoice: input.invoice }));
}

describe('EMAIL-01B4 — Korrekturbeleg-Versand', () => {
  it('C1: Correction-Panel nur mit gültigem Korrekturbeleg; eigener Titel, Aktion, Dialogtitel, Correction-Betreff/-Nachricht, Correction-Anhang; Rechnungs-Standards greifen nicht', async () => {
    const base = finalizeInvoice('v-c1');
    hydrateCompanyProfileStore({ ...PROFILE, defaultInvoiceEmailSubject: 'FALSCH {invoiceNumber}', defaultInvoiceEmailBody: 'FALSCH' });
    withDeliveries([]);
    const internal: VorgangInvoice = { ...base, status: 'versendet', cancelledAt: '2026-09-14T00:00:00Z', cancellationKind: 'internal' };
    await mount(<InvoiceDeliveryPanel vorgangId="v-c1" invoice={internal} onInvoiceUpdated={() => {}} documentKind="invoice_correction" />);
    expect(q('invoice-correction-delivery-panel')).not.toBeNull();
    expect(q('invoice-delivery-send')).toBeNull();
    await act(async () => root.unmount());
    host.remove();

    const corrected: VorgangInvoice = { ...base, status: 'versendet', sentSource: 'officepilot', sentDeliveryId: 'd-orig', cancelledAt: '2026-09-14T00:00:00Z', cancellationKind: 'correction', correctionDocumentId: `corr-${base.id}` };
    await mount(<InvoiceDeliveryPanel vorgangId="v-c1" invoice={corrected} onInvoiceUpdated={() => {}} documentKind="invoice_correction" />);
    expect(q('invoice-correction-delivery-panel')?.textContent).toContain('Korrekturbeleg per E-Mail');
    expect(q('invoice-delivery-source')).toBeNull();
    expect(q('invoice-delivery-empty')?.textContent).toContain('Korrekturbeleg noch nicht');
    expect(q('invoice-delivery-send')?.textContent).toBe('Korrektur per E-Mail senden');
    await click('invoice-delivery-send');
    expect(q('send-document-dialog')?.getAttribute('data-document-kind')).toBe('invoice_correction');
    expect(host.querySelector('#send-document-dialog-title')?.textContent).toBe('Korrekturbeleg per E-Mail senden');
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('kunde@example.invalid');
    expect((q('send-document-subject') as HTMLInputElement).value).toBe(`Rechnungskorrektur zu ${base.number} - Betrieb GmbH`);
    expect((q('send-document-body') as HTMLTextAreaElement).value).toContain('Rechnungskorrektur zu unserer Rechnung');
    expect((q('send-document-body') as HTMLTextAreaElement).value).not.toContain('FALSCH');
    expect(q('send-document-attachment-name')?.textContent).toContain(`Rechnung_Rechnungskorrektur-${base.number}.pdf`);
  });

  it('C2: Senden der Korrektur → Delivery invoice_correction, Original-Sent-Daten unverändert; Historie zeigt „Korrekturbeleg" und „übergeben"; Zweitversand-Confirm mit Korrekturtext', async () => {
    const base = finalizeInvoice('v-c2');
    const corrected: VorgangInvoice = { ...base, status: 'versendet', sentSource: 'officepilot', sentDeliveryId: 'd-orig', sentAt: '2026-09-10', sentVia: 'email', cancelledAt: '2026-09-14T00:00:00Z', cancellationKind: 'correction', correctionDocumentId: `corr-${base.id}` };
    let deliveries: DocumentDelivery[] = [];
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(orchestrator, 'refreshDeliveries').mockImplementation(async (input) => ({ ok: true, deliveries: deliveries.filter((d) => d.documentKind === input.identity.kind), invoice: input.invoice }));
    const run = vi.spyOn(orchestrator, 'runSendDocument').mockImplementation(async (input) => {
      expect(input.draft.identity).toEqual({ kind: 'invoice_correction', clientInvoiceId: base.id });
      const d = delivery({ id: 'd-corr', clientDeliveryId: input.draft.clientDeliveryId, linkedInvoiceId: base.id, status: 'provider_accepted', providerMessageId: 'm', providerAcceptedAt: '2026-09-14T10:01:00.000Z', subject: input.draft.subject });
      deliveries = [d];
      return { ok: true, action: 'sent', delivery: d, deliveries };
    });
    const onUpdated = vi.fn();
    await mount(<InvoiceDeliveryPanel vorgangId="v-c2" invoice={corrected} onInvoiceUpdated={onUpdated} documentKind="invoice_correction" />);
    await click('invoice-delivery-send');
    await act(async () => { q('send-document-send')!.click(); q('send-document-send')!.click(); });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(q('invoice-delivery-kind')?.textContent).toBe('Korrekturbeleg');
    expect(q('invoice-delivery-status')?.textContent).toBe('An E-Mail-Dienst übergeben');
    expect(host.textContent).not.toContain('Zugestellt');
    // Original unverändert: keine Statusänderung wurde propagiert.
    for (const call of onUpdated.mock.calls) {
      expect(call[0]).toMatchObject({ sentSource: 'officepilot', sentDeliveryId: 'd-orig', sentAt: '2026-09-10' });
    }
    expect(q('invoice-delivery-send')?.textContent).toBe('Korrektur erneut per E-Mail senden');
    await click('invoice-delivery-send');
    await click('send-document-send');
    expect(q('send-document-confirm-resend')?.textContent).toContain('Korrekturbeleg');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('C3: Korrektur — failed → Retry-Dialog mit vorherigen Werten (kein Settings-Einmischen); unknown → nur Status prüfen', async () => {
    const base = finalizeInvoice('v-c3');
    const corrected: VorgangInvoice = { ...base, status: 'versendet', cancelledAt: '2026-09-14T00:00:00Z', cancellationKind: 'correction', correctionDocumentId: `corr-${base.id}` };
    hydrateCompanyProfileStore({ ...PROFILE, defaultInvoiceEmailSubject: 'NEUER STANDARD' });
    withDeliveries([delivery({ id: 'd-f', clientDeliveryId: 'cd-f', linkedInvoiceId: base.id, status: 'failed', errorCategory: 'provider', subject: 'Vorheriger Betreff', bodyText: 'Vorheriger Text', recipientEmail: 'alt@example.invalid' })]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-c3" invoice={corrected} onInvoiceUpdated={() => {}} documentKind="invoice_correction" />);
    expect(q('invoice-delivery-retry')).not.toBeNull();
    await click('invoice-delivery-retry');
    expect((q('send-document-subject') as HTMLInputElement).value).toBe('Vorheriger Betreff');
    expect((q('send-document-body') as HTMLTextAreaElement).value).toBe('Vorheriger Text');
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('alt@example.invalid');
    await act(async () => root.unmount());
    host.remove();

    withDeliveries([delivery({ id: 'd-u', clientDeliveryId: 'cd-u', linkedInvoiceId: base.id, status: 'unknown', errorCategory: 'network' })]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-c3" invoice={corrected} onInvoiceUpdated={() => {}} documentKind="invoice_correction" />);
    expect(q('invoice-delivery-check-status')).not.toBeNull();
    expect(q('invoice-delivery-retry')).toBeNull();
    expect(q('invoice-delivery-send')).toBeNull();
  });
});

describe('EMAIL-01B4 — Settings „E-Mail-Versand"', () => {
  it('S1: Felder sichtbar, Speichern persistiert, Vorschau nutzt die Werte, Validierung blockiert, member read-only', async () => {
    await mount(<InvoiceSettingsPage />);
    expect(q('settings-invoices-section-email')).not.toBeNull();
    expect((q('settings-invoices-defaultInvoiceEmailSubject') as HTMLInputElement).value).toBe('');
    expect(q('settings-invoices-email-preview-subject')?.textContent).toBe('Rechnung VORSCHAU-0001 - Betrieb GmbH');
    await type('settings-invoices-defaultInvoiceEmailSubject', 'Ihre Rechnung {invoiceNumber} von {companyName}');
    await type('settings-invoices-defaultInvoiceEmailBody', 'Hallo,\n\nRechnung {invoiceNumber} anbei.\n\n{companyName}');
    expect(q('settings-invoices-email-preview-subject')?.textContent).toBe('Ihre Rechnung VORSCHAU-0001 von Betrieb GmbH');
    expect(q('settings-invoices-dirty')?.textContent).toBe('Ungespeicherte Änderungen');
    const form = host.querySelector('form.settings-form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
    expect(getCompanyProfile().defaultInvoiceEmailSubject).toBe('Ihre Rechnung {invoiceNumber} von {companyName}');
    expect(getCompanyProfile().defaultInvoiceEmailBody).toContain('Rechnung {invoiceNumber} anbei.');
    await act(async () => root.unmount());
    host.remove();

    await mount(<InvoiceSettingsPage />);
    expect((q('settings-invoices-defaultInvoiceEmailSubject') as HTMLInputElement).value).toBe('Ihre Rechnung {invoiceNumber} von {companyName}');
    // Längenschutz in der UI (maxLength) + zentrale Validierung (siehe emailDefaults01b4 M2).
    expect((q('settings-invoices-defaultInvoiceEmailSubject') as HTMLInputElement).maxLength).toBe(255);
    expect((q('settings-invoices-defaultInvoiceEmailBody') as HTMLTextAreaElement).maxLength).toBe(20000);
    expect(getCompanyProfile().defaultInvoiceEmailSubject).toBe('Ihre Rechnung {invoiceNumber} von {companyName}');
    await act(async () => root.unmount());
    host.remove();

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    hydrateWorkspaceStore({
      workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
      workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'member', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
    await mount(<InvoiceSettingsPage />);
    expect((q('settings-invoices-defaultInvoiceEmailSubject') as HTMLInputElement).readOnly).toBe(true);
    expect(q('settings-invoices-save')).toBeNull();
  });
});
