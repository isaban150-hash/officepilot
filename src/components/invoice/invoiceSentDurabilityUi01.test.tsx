/**
 * INVOICE-SENT-CLOUD-DURABILITY-01B — Oberfläche.
 *
 * Der Versandsatz ist korrigierbar, also gibt es Lagen, die OfficePilot nicht
 * allein entscheiden darf. Hier wird festgehalten, welche Aktion in welcher
 * Lage überhaupt angeboten wird — und vor allem, welche nicht.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import { getVorgangInvoice, hydrateVorgangStore } from '../../services/vorgangService';
import * as sentService from '../../services/invoiceSentService';
import * as cloudService from '../../services/invoice/workspaceInvoiceCloudService';
import { InvoiceSentPanel } from './InvoiceSentPanel';
import type { InvoiceSentCloudState } from '../../services/invoiceSentService';
import { de, type TranslationKey } from '../../i18n';
import type { VorgangInvoice } from '../../types/models';

const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-sent-ui-1';

function translate(key: TranslationKey): string {
  return key;
}

function sentInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0012',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-test-1',
        description: 'Beispielleistung',
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: 520,
      },
    ],
    subtotal: 520,
    taxStatus: 'standard_19',
    amount: 618.8,
    status: 'versendet',
    sentAt: '2026-09-10',
    sentVia: 'email',
    date: '2026-09-06',
    createdAt: '2026-09-06T10:00:00.000Z',
    issueDate: '2026-09-06',
    paymentDueDate: '2099-09-20',
    customerSnapshot: {
      name: 'M5 Testbau GmbH',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Betrieb GmbH' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

function markup(invoice: VorgangInvoice, cloudState: InvoiceSentCloudState | null): string {
  return renderToStaticMarkup(
    createElement(InvoiceSentPanel, {
      vorgangId: VORGANG_ID,
      invoice,
      cloudState,
      translate,
      onUpdated: () => {},
      onCloudStateChange: () => {},
    }),
  );
}

describe('SENT-DUR-UI — welche Aktion wann erscheint', () => {
  it('S4b: pending zeigt einen Hinweis und genau eine Sicherungsaktion', () => {
    const html = markup(sentInvoice(), { kind: 'pending' });
    expect(html).toContain('invoice-sent-cloud-pending');
    expect(html).toContain('invoice.sent.cloudPending');
    expect(html).toContain('invoice-sent-secure-now');
    expect(html).not.toContain('invoice-sent-use-cloud');
  });

  it('S10b: synced zeigt keinen zusätzlichen Cloud-Lärm', () => {
    const html = markup(sentInvoice(), { kind: 'synced' });
    expect(html).not.toContain('invoice-sent-cloud-pending');
    expect(html).not.toContain('invoice-sent-cloud-conflict');
    // Die bestehende Versandanzeige bleibt unverändert.
    expect(html).toContain('invoice-sent-status');
  });

  it('S11b: der Konflikt zeigt beide Stände und zwei ausdrückliche Wege', () => {
    const html = markup(sentInvoice(), {
      kind: 'conflict',
      cloud: { sentAt: '2026-09-11', sentVia: 'post', sentNote: 'Von Gerät B' },
    });
    expect(html).toContain('invoice-sent-cloud-conflict');
    expect(html).toContain('invoice-sent-local-side');
    expect(html).toContain('invoice-sent-cloud-side');
    expect(html).toContain('invoice-sent-use-local');
    expect(html).toContain('invoice-sent-use-cloud');
    // Keine scheinbar harmlose Standardaktion.
    expect(html).not.toContain('invoice-sent-secure-now');
    /*
     * Keine technischen Begriffe im tatsächlich sichtbaren Text. Geprüft wird
     * die echte Übersetzung, nicht der Schlüsselname — der Stub oben gibt den
     * Schlüssel zurück und wäre kein Beleg.
     */
    for (const key of [
      'invoice.sent.cloudConflict',
      'invoice.sent.localSide',
      'invoice.sent.cloudSide',
      'invoice.sent.useLocal',
      'invoice.sent.useCloud',
    ] as const) {
      const text = de[key].toLowerCase();
      for (const forbidden of ['rowversion', 'payload', 'conflict', 'sync']) {
        expect(text, `${key}/${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('S19c: cloud_only bietet nur die Übernahme an, kein Hochladen', () => {
    const html = markup(sentInvoice({ status: 'vorbereitet', sentAt: undefined, sentVia: undefined }), {
      kind: 'cloud_only',
      cloud: { sentAt: '2026-09-11', sentVia: 'post' },
    });
    expect(html).toContain('invoice-sent-use-cloud');
    expect(html).not.toContain('invoice-sent-use-local');
    expect(html).not.toContain('invoice-sent-secure-now');
  });

  it('S9c/S8c/S7b: missing, unknown und not_configured bieten nichts an', () => {
    for (const kind of ['missing', 'unknown', 'not_configured'] as const) {
      const html = markup(sentInvoice(), { kind });
      expect(html, kind).not.toContain('invoice-sent-cloud-pending');
      expect(html, kind).not.toContain('invoice-sent-cloud-conflict');
      expect(html, kind).not.toContain('invoice-sent-secure-now');
      expect(html, kind).not.toContain('invoice-sent-use-cloud');
    }
    // Auch ohne jede Abfrage wird nichts behauptet.
    expect(markup(sentInvoice(), null)).not.toContain('invoice-sent-cloud-pending');
  });
});

describe('SENT-DUR-UI — die Aktionen tun das Richtige', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [sentInvoice()] })]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function render(cloudState: InvoiceSentCloudState): void {
    act(() => {
      root.render(
        createElement(InvoiceSentPanel, {
          vorgangId: VORGANG_ID,
          invoice: getVorgangInvoice(VORGANG_ID, INVOICE_ID)!,
          cloudState,
          translate,
          onUpdated: () => {},
          onCloudStateChange: () => {},
        }),
      );
    });
  }

  it('S5b: „Jetzt sichern" nutzt den bestehenden Sent-Cloud-Weg', async () => {
    const spy = vi.spyOn(sentService, 'syncInvoiceSentToCloud').mockResolvedValue('synced');
    render({ kind: 'pending' });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="invoice-sent-secure-now"]')!.click();
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([VORGANG_ID, INVOICE_ID]);
  });

  it('S15b: „Stand dieses Geräts verwenden" nutzt genau denselben Weg', async () => {
    const spy = vi.spyOn(sentService, 'syncInvoiceSentToCloud').mockResolvedValue('synced');
    render({ kind: 'conflict', cloud: { sentAt: '2026-09-11', sentVia: 'post' } });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="invoice-sent-use-local"]')!.click();
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('S16b: „Online-Stand verwenden" schreibt lokal und ruft keine Cloud-Mutation', async () => {
    const write = vi.spyOn(cloudService, 'rpcUpdateWorkspaceInvoiceSent');
    render({
      kind: 'conflict',
      cloud: { sentAt: '2026-09-11', sentVia: 'post', sentNote: 'Von Gerät B' },
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="invoice-sent-use-cloud"]')!.click();
    });

    const local = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
    expect(local.sentAt).toBe('2026-09-11');
    expect(local.sentVia).toBe('post');
    expect(local.sentNote).toBe('Von Gerät B');
    // Die Cloud trägt bereits den gewählten Stand — es gibt nichts zu schreiben.
    expect(write).not.toHaveBeenCalled();
  });

  it('S14: ein angezeigter Konflikt löst von sich aus gar nichts aus', async () => {
    const sync = vi.spyOn(sentService, 'syncInvoiceSentToCloud');
    const write = vi.spyOn(cloudService, 'rpcUpdateWorkspaceInvoiceSent');
    render({ kind: 'conflict', cloud: { sentAt: '2026-09-11', sentVia: 'post' } });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sync).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    // Der lokale Stand ist unberührt.
    expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)?.sentAt).toBe('2026-09-10');
  });
});
