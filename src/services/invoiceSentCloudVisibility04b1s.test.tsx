/**
 * OFFICEPILOT-INVOICE-SENT-CLOUD-DURABILITY-04B1S — kein stiller Fehlschlag.
 *
 * 04B1 hat den Cloud-Schreibweg gebaut, 04B1R hat gezeigt, dass er auf dem
 * Realgerät nicht angekommen ist — und zwar ohne jede sichtbare Spur. Zwei
 * Wege enden im Code stumm: `not_configured` schweigt absichtlich, und eine
 * Rejection vor dem `try` schweigt mangels `.catch()`.
 *
 * Bevor wir raten, welcher davon es war, muss der Fehlschlag sichtbar werden.
 * Diese Tests prüfen deshalb nicht den RPC-Wrapper — den hatten wir schon —,
 * sondern `syncInvoiceSentToCloud` selbst und den Weg durch das Panel.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { InvoiceSentPanel } from '../components/invoice/InvoiceSentPanel';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { getVorgangInvoice, hydrateVorgangStore } from './vorgangService';
import { syncInvoiceSentToCloud } from './invoiceSentService';
import * as supabaseLib from '../lib/supabase';
import * as workspacePayload from './workspace/workspaceSyncPayloadService';
import * as invoiceCloud from './invoice/workspaceInvoiceCloudService';
import type { Vorgang, VorgangInvoice } from '../types/models';

const VORGANG_ID = 'v-sent-visibility';
const INVOICE_ID = 'inv-sent-visibility';
const WORKSPACE = '00000000-0000-4000-8000-000000000009';

function buildInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0001',
    invoiceSequenceNumber: 1,
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Leistung',
        quantity: 2,
        unit: 'Stunden',
        unitPrice: 50,
        lineTotal: 100,
      },
    ],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    sentAt: '2026-08-25',
    sentVia: 'email',
    date: '2026-08-24',
    issueDate: '2026-08-24',
    createdAt: '2026-08-24T10:00:00.000Z',
    paymentDueDate: '2026-09-07',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' },
    ...overrides,
  } as VorgangInvoice;
}

function seed(invoice: VorgangInvoice = buildInvoice()): void {
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'Stunden', plannedQuantity: 2, unitPrice: 50 }),
        ],
      }),
      invoices: [invoice],
    } as Vorgang,
  ]);
}

/** Cloud vorhanden und Workspace auflösbar — der Normalfall unserer Umgebung. */
function stubCloudReady(workspaceId = WORKSPACE): void {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(workspaceId);
}

describe('OFFICEPILOT-INVOICE-SENT-CLOUD-VISIBILITY-04B1S — Sync-Vertrag', () => {
  beforeEach(() => {
    resetTestStores();
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('A: gelungener Cloud-Write meldet synced', async () => {
    stubCloudReady();
    const rpc = vi
      .spyOn(invoiceCloud, 'rpcUpdateWorkspaceInvoiceSent')
      .mockResolvedValue({ invoice: buildInvoice() } as never);

    await expect(syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID)).resolves.toBe('synced');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('B: ohne Supabase bleibt es beim bewussten lokalen Betrieb', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);

    await expect(syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID)).resolves.toBe(
      'supabase_not_configured',
    );
  });

  it('C: konfigurierte Cloud ohne auflösbaren Workspace ist ein Fehler, kein Normalfall', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue('   ');

    await expect(syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID)).resolves.toBe('workspace_missing');
  });

  it('D: eine lokal unvollständige Versandwahrheit wird nicht in die Cloud geschrieben', async () => {
    stubCloudReady();
    const rpc = vi.spyOn(invoiceCloud, 'rpcUpdateWorkspaceInvoiceSent');

    // Status versendet, aber ohne Versandweg — darf nie hochgeladen werden.
    seed(buildInvoice({ sentVia: undefined }));
    await expect(syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID)).resolves.toBe(
      'local_invoice_invalid',
    );

    seed(buildInvoice({ status: 'vorbereitet', sentAt: undefined, sentVia: undefined }));
    await expect(syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID)).resolves.toBe(
      'local_invoice_invalid',
    );

    expect(rpc).not.toHaveBeenCalled();
  });

  it('E: eine unbekannte Rechnung endet kontrolliert', async () => {
    stubCloudReady();
    await expect(syncInvoiceSentToCloud(VORGANG_ID, 'gibt-es-nicht')).resolves.toBe(
      'local_invoice_invalid',
    );
  });

  it('F: ein technischer Fehler wird gefangen und nie zur Rejection', async () => {
    stubCloudReady();
    vi.spyOn(invoiceCloud, 'rpcUpdateWorkspaceInvoiceSent').mockRejectedValue(
      new Error('Netzwerk weg'),
    );

    // Kein try/catch im Test: Die Funktion selbst muss total sein.
    await expect(syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID)).resolves.toBe('failed');
  });

  it('G: auch ein werfender Konfigurationszugriff endet kontrolliert', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockImplementation(() => {
      throw new Error('Zugriff auf Konfiguration fehlgeschlagen');
    });

    await expect(syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID)).resolves.toBe('failed');
  });
});

/* -------------------------------------------------------------------------- */
/* Panelpfad                                                                  */
/* -------------------------------------------------------------------------- */

type Mount = { container: HTMLDivElement; root: Root };

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountPanel(invoice: VorgangInvoice): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(InvoiceSentPanel, {
            vorgangId: VORGANG_ID,
            invoice,
            translate: (key: string) => key,
            onUpdated: () => undefined,
          }),
        ),
      ),
    );
  });
  await settle();
  return { container, root };
}

function find(mount: Mount, testId: string): HTMLElement | null {
  return mount.container.querySelector(`[data-testid="${testId}"]`);
}

async function click(mount: Mount, testId: string): Promise<void> {
  const element = find(mount, testId) as HTMLButtonElement | null;
  if (!element) throw new Error(`nicht gefunden: ${testId}`);
  await act(async () => element.click());
  await settle();
}

/** Der reale Weg von Origin A: die Rechnung war bereits versendet. */
async function runCorrection(mount: Mount): Promise<void> {
  await click(mount, 'invoice-sent-correct');
  await click(mount, 'invoice-sent-continue');
  await click(mount, 'invoice-sent-confirm-submit');
  await settle();
  await settle();
}

describe('OFFICEPILOT-INVOICE-SENT-CLOUD-VISIBILITY-04B1S — Panel', () => {
  let mount: Mount | null = null;

  beforeEach(() => {
    resetTestStores();
    seed();
  });

  afterEach(async () => {
    if (mount) {
      await act(async () => mount!.root.unmount());
      mount.container.remove();
      mount = null;
    }
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('H: der Korrekturpfad ruft den Cloud-Sync und meldet einen Fehlschlag sichtbar', async () => {
    stubCloudReady();
    const rpc = vi
      .spyOn(invoiceCloud, 'rpcUpdateWorkspaceInvoiceSent')
      .mockRejectedValue(new Error('RPC abgelehnt'));

    mount = await mountPanel(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!);
    await runCorrection(mount);

    // Der Cloud-Sync läuft auch beim Korrigieren, nicht nur beim Erstmarkieren.
    expect(rpc).toHaveBeenCalledTimes(1);
    // Und der Fehlschlag ist sichtbar — nach closeAll(), im geschlossenen Zustand.
    expect(find(mount, 'invoice-sent-cloud-warning')).not.toBeNull();
    expect(find(mount, 'invoice-sent-confirm')).toBeNull();
  });

  it('I: ein leerer Workspace bleibt nicht still', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue('');

    mount = await mountPanel(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!);
    await runCorrection(mount);

    expect(find(mount, 'invoice-sent-cloud-warning')).not.toBeNull();
  });

  it('J: bei Erfolg erscheint keine Warnung', async () => {
    stubCloudReady();
    vi.spyOn(invoiceCloud, 'rpcUpdateWorkspaceInvoiceSent').mockResolvedValue({
      invoice: buildInvoice(),
    } as never);

    mount = await mountPanel(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!);
    await runCorrection(mount);

    expect(find(mount, 'invoice-sent-cloud-warning')).toBeNull();
  });

  it('K: ohne Cloud bleibt der bewusste lokale Betrieb ohne Warnung', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);

    mount = await mountPanel(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!);
    await runCorrection(mount);

    expect(find(mount, 'invoice-sent-cloud-warning')).toBeNull();
  });
});
