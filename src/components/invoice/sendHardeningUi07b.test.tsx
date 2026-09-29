/**
 * E-MAIL-07B — sichtbare Seite des Versandkerns (ohne Browser, gegen den
 * gerenderten DOM): getrennte Überschriften für echten und externen Versand,
 * laufender Versand („Status prüfen", kein Neuversand), unklarer Versand mit
 * ausdrücklich bestätigtem Neuversuch, verständliche Fehlertexte.
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

const WS = '00000000-0000-4000-8000-0000000007b9';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const texte = de as Record<string, string>;
const translate = (key: string) => texte[key] ?? key;

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
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

function finalizeInvoice(id: string): VorgangInvoice {
  hydrateVorgangStore([{ ...createTestVorgang({ id, status: 'beauftragt', customerBilling: { name: 'Kunde GmbH', contactPerson: '', street: 'Weg 1', zip: '1', city: 'X', email: 'kunde@example.invalid', phone: '' }, orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })] }), invoices: [] } as Vorgang]);
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

function withDeliveries(list: DocumentDelivery[]) {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(orchestrator, 'refreshDeliveries').mockImplementation(async (input) => ({ ok: true, deliveries: list, invoice: input.invoice }));
}

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
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  resetTestStores();
});

/* ================================================================== */

describe('07B — echter Versand und externer Versand sind sichtbar getrennt', () => {
  it('der Versandbereich heißt „Über OfficeTakt per E-Mail senden"; der manuelle Bereich „Externen Versand dokumentieren"', async () => {
    const invoice = finalizeInvoice('v-t1');
    withDeliveries([]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-t1" invoice={invoice} onInvoiceUpdated={() => {}} />);
    const panel = q('invoice-delivery-panel')!;
    expect(panel.textContent).toContain('Über OfficeTakt per E-Mail senden');
    // Der Versandstand trägt nicht mehr die Überschrift des manuellen Bereichs.
    expect(q('invoice-delivery-source')?.textContent).toContain('Versandstand');
    expect(panel.textContent).not.toContain('Versand (manuell)');
    expect(texte['invoice.sent.title']).toBe('Externen Versand dokumentieren');
    expect(texte['invoice.sent.hint']).toContain('Hier wird nichts versendet');
    expect(texte['delivery.document.panel.title']).toBe('Über OfficeTakt per E-Mail senden');
  });
});

describe('07B — laufender Versand (sending)', () => {
  it('zeigt „Wird an den E-Mail-Dienst übergeben", bietet nur „Status prüfen" — der prüft beim Server, sendet aber nicht', async () => {
    const invoice = finalizeInvoice('v-s1');
    const laufend = delivery({ id: 'd-s', clientDeliveryId: 'cd-s', status: 'sending' });
    withDeliveries([laufend]);
    const run = vi.spyOn(orchestrator, 'runSendDocument');
    const check = vi.spyOn(orchestrator, 'checkDeliveryStatus').mockResolvedValue({ ok: true, deliveries: [laufend] });
    await mount(<InvoiceDeliveryPanel vorgangId="v-s1" invoice={invoice} onInvoiceUpdated={() => {}} />);

    expect(q('invoice-delivery-status')?.textContent).toBe('Wird an den E-Mail-Dienst übergeben');
    expect(q('invoice-delivery-sending-hint')?.textContent).toContain('nichts doppelt');
    expect(q('invoice-delivery-send')).toBeNull();
    expect(q('invoice-delivery-retry')).toBeNull();
    expect(q('invoice-delivery-retry-uncertain')).toBeNull();

    await click('invoice-delivery-check-status');
    expect(check).toHaveBeenCalledWith({ delivery: laufend });
    expect(run).not.toHaveBeenCalled();
    expect(q('send-document-dialog')).toBeNull();
  });
});

describe('07B — unklarer Versand ist keine Sackgasse mehr', () => {
  it('„Trotzdem erneut senden" verlangt die ausdrückliche Bestätigung und legt einen Neuversuch mit Bezug an', async () => {
    const invoice = finalizeInvoice('v-u1');
    const unklar = delivery({ id: 'd-u', clientDeliveryId: 'cd-u', status: 'unknown', errorCategory: 'network' });
    withDeliveries([unklar]);
    const run = vi.spyOn(orchestrator, 'runSendDocument').mockResolvedValue({
      ok: true,
      action: 'sent',
      delivery: delivery({ id: 'd-n', status: 'provider_accepted', retryOfDeliveryId: 'd-u', attemptNumber: 2 }),
      deliveries: [],
    });
    await mount(<InvoiceDeliveryPanel vorgangId="v-u1" invoice={invoice} onInvoiceUpdated={() => {}} />);

    // Gewöhnliche Wege bleiben zu; zwei klare Wege sind offen.
    expect(q('invoice-delivery-send')).toBeNull();
    expect(q('invoice-delivery-retry')).toBeNull();
    expect(q('invoice-delivery-check-status')).not.toBeNull();
    expect(q('invoice-delivery-retry-uncertain')?.textContent).toBe('Trotzdem erneut senden');

    await click('invoice-delivery-retry-uncertain');
    expect(q('send-document-retry-uncertain-hint')).not.toBeNull();
    expect((q('send-document-recipient') as HTMLInputElement).value).toBe('kunde@example.invalid');

    // Erster Klick: Bestätigung mit dem Risiko — noch kein Versand.
    await click('send-document-send');
    expect(q('send-document-confirm-uncertain')?.textContent).toBe(
      'Der vorherige Versandstatus ist unklar. Die Nachricht könnte bereits angekommen sein. Ein erneuter Versand kann zu einer doppelten E-Mail führen. Trotzdem senden?',
    );
    expect(run).not.toHaveBeenCalled();

    // Zweiter Klick: Versand mit Bezug auf die unklare Zeile und Bestätigung.
    await click('send-document-send');
    expect(run).toHaveBeenCalledTimes(1);
    const draft = run.mock.calls[0]![0].draft;
    expect(draft.retryOfDeliveryId).toBe('d-u');
    expect(draft.confirmUncertainRetry).toBe(true);
    expect(draft.clientDeliveryId).not.toBe('cd-u');
  });

  it('läuft der Neuversuch bereits, gibt es keinen zweiten; ist er gescheitert, wieder nur mit Bestätigung', async () => {
    const invoice = finalizeInvoice('v-u2');
    const unklar = delivery({ id: 'd-u', clientDeliveryId: 'cd-u', status: 'unknown' });
    withDeliveries([delivery({ id: 'd-n', clientDeliveryId: 'cd-n', status: 'sending', retryOfDeliveryId: 'd-u', attemptNumber: 2 }), unklar]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-u2" invoice={invoice} onInvoiceUpdated={() => {}} />);
    expect(q('invoice-delivery-retry-uncertain')).toBeNull();
    expect(q('invoice-delivery-check-status')).not.toBeNull();
    await act(async () => root.unmount());
    host.remove();

    withDeliveries([delivery({ id: 'd-n', clientDeliveryId: 'cd-n', status: 'failed', errorCategory: 'provider', retryOfDeliveryId: 'd-u', attemptNumber: 2 }), unklar]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-u2" invoice={invoice} onInvoiceUpdated={() => {}} />);
    expect(q('invoice-delivery-retry')).toBeNull();
    expect(q('invoice-delivery-retry-uncertain')).not.toBeNull();
  });

  it('ein erfolgreich beantworteter unklarer Versuch sperrt nicht mehr', async () => {
    const invoice = finalizeInvoice('v-u3');
    withDeliveries([
      delivery({ id: 'd-n', clientDeliveryId: 'cd-n', status: 'provider_accepted', providerMessageId: 'm', retryOfDeliveryId: 'd-u', attemptNumber: 2 }),
      delivery({ id: 'd-u', clientDeliveryId: 'cd-u', status: 'unknown' }),
    ]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-u3" invoice={invoice} onInvoiceUpdated={() => {}} />);
    expect(q('invoice-delivery-retry-uncertain')).toBeNull();
    expect(q('invoice-delivery-send')?.textContent).toBe('Erneut per E-Mail senden');
  });
});

describe('07B — verständliche Fehler ohne Rohtexte', () => {
  it('Testempfänger abgelehnt und ungültige Antwortadresse haben eigene Texte', async () => {
    const invoice = finalizeInvoice('v-e1');
    withDeliveries([delivery({ id: 'd-e', clientDeliveryId: 'cd-e', status: 'failed', errorCategory: 'recipient', errorCode: 'test_recipient_not_allowed', errorMessageSafe: 'Testmodus: …', failedAt: '2026-09-14T10:01:00.000Z' })]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-e1" invoice={invoice} onInvoiceUpdated={() => {}} />);
    expect(q('invoice-delivery-error')?.textContent).toContain('Testmodus');
    expect(q('invoice-delivery-error')?.textContent).toContain('Es wurde nichts gesendet');
    await act(async () => root.unmount());
    host.remove();

    withDeliveries([delivery({ id: 'd-r', clientDeliveryId: 'cd-r', status: 'failed', errorCategory: 'unknown', errorCode: 'sender_reply_to_invalid', failedAt: '2026-09-14T10:01:00.000Z' })]);
    await mount(<InvoiceDeliveryPanel vorgangId="v-e1" invoice={invoice} onInvoiceUpdated={() => {}} />);
    expect(q('invoice-delivery-error')?.textContent).toContain('Antwortadresse');
    expect(host.textContent).not.toMatch(/sender_reply_to_invalid|test_recipient|HTTP|JSON/);
  });
});

describe('07B — Dialog: Bestätigungen der Reihe nach', () => {
  it('abweichender Empfänger und unklarer Vorversuch werden nacheinander bestätigt, dann erst gesendet', async () => {
    const onSend = vi.fn();
    await mount(
      <SendDocumentDialog open initialRecipient="kunde@example.invalid" canonicalRecipient="kunde@example.invalid" initialSubject="S" initialBody="B" attachmentFilename="R.pdf" alreadySent mode="retry_uncertain" phase={null} busy={false} errorKey={null} translate={translate} onCancel={() => {}} onSend={onSend} />,
    );
    await type('send-document-recipient', 'andere@example.invalid');
    await click('send-document-send');
    expect(q('send-document-confirm-recipient')).not.toBeNull();
    await click('send-document-send');
    expect(q('send-document-confirm-uncertain')).not.toBeNull();
    // Der gewöhnliche „bereits gesendet"-Schritt entfällt: die Doppelzustellung ist schon bestätigt.
    expect(q('send-document-confirm-resend')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    await click('send-document-send');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toMatchObject({ recipientEmail: 'andere@example.invalid' });
  });
});
