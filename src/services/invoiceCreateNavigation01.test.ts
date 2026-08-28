/**
 * OFFICEPILOT-INVOICE-CREATE-ROUTE-TYPE-01 — der Einstieg aus der Ablage.
 *
 * `InboxVorgangPanel` bot „Rechnung vorbereiten" bislang ohne `?type=` an. Der
 * Parser-Fallback machte daraus `rechnung`, was zum Label passte — der Link
 * verliess sich damit aber auf eine Zufälligkeit, statt den Typ auszusprechen.
 * Dieser Einstieg war von keinem Test gedeckt.
 *
 * Ohne JSX geschrieben, damit der Fall in der vom Auftrag vorgesehenen
 * `.ts`-Datei liegen kann.
 *
 * Neutrale Beispieldaten.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { InboxVorgangPanel } from '../components/inbox/InboxVorgangPanel';
import { DEFAULT_SETUP } from '../data/mockData';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { hydrateVorgangStore } from './vorgangService';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { t } from '../i18n';
import type { InboxItem, VorgangInvoice } from '../types/models';

const VORGANG_ID = 'v-inbox-create';
const CREATE_HREF = `/vorgaenge/${VORGANG_ID}/rechnung?type=rechnung`;
const OPEN_HREF = `/vorgaenge/${VORGANG_ID}`;
const CLOSED_HINT = t('vorgang.invoicesClosedBySchluss', 'de');

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-inbox-1',
    number: '2026-0004',
    type: 'schluss',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'vorbereitet',
    date: '2026-08-20',
    createdAt: '2026-08-20T09:00:00.000Z',
    ...overrides,
  } as VorgangInvoice;
}

/** Legt den Vorgang an; `undefined` lässt den Store bewusst leer. */
function seedVorgang(invoices: VorgangInvoice[] | undefined): void {
  if (!invoices) {
    hydrateVorgangStore([]);
    return;
  }
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG_ID,
      title: 'Beispielauftrag',
      orderPositions: [createOrderPosition({ id: 'op-inbox-1' })],
      invoices,
    }),
  ]);
}

function seedItem(): InboxItem {
  const seeded = createAuftragInboxItem({ id: 'inbox-create-01' });
  seeded.vorgangId = VORGANG_ID;
  seeded.vorgangTitle = 'Beispielauftrag';
  // Erst der Verknüpfungsstatus bringt das Panel in den `open`-Modus.
  seeded.vorgangLinkStatus = 'linked';
  hydrateInboxStore([seeded]);
  return getInboxItemById(seeded.id)!;
}

function hrefs(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
}

describe('OFFICEPILOT-INVOICE-CREATE-ROUTE-TYPE-01 — InboxVorgangPanel', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetTestStores();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container.remove();
    resetTestStores();
  });

  function mount(item: InboxItem): void {
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          MemoryRouter,
          null,
          createElement(
            AppProvider,
            { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
            createElement(InboxVorgangPanel, {
              item,
              materialDefault: 'betrieb' as const,
              onLinked: () => {},
            }),
          ),
        ),
      );
    });
  }

  function unmount(): void {
    if (!root) return;
    act(() => root!.unmount());
    root = null;
  }

  /** Rendert das Panel für einen Vorgang mit genau diesen Rechnungen. */
  function render(invoices: VorgangInvoice[] | undefined): void {
    seedVorgang(invoices);
    mount(seedItem());
  }

  function expectCtaVisible(): void {
    expect(hrefs(container)).toContain(CREATE_HREF);
    expect(container.textContent).not.toContain(CLOSED_HINT);
  }

  function expectCtaClosed(): void {
    expect(hrefs(container)).not.toContain(CREATE_HREF);
    expect(container.querySelector('[data-testid="inbox-vorgang-invoices-closed"]')).not.toBeNull();
    expect(container.textContent).toContain(CLOSED_HINT);
    // Der Weg zum Auftrag bleibt in jedem Fall offen.
    expect(hrefs(container)).toContain(OPEN_HREF);
  }

  it('A: ohne Rechnungen bleibt der Einstieg samt Route erhalten', () => {
    render([]);
    expectCtaVisible();
  });

  it('B: eine Abschlagsrechnung schliesst den Strang nicht', () => {
    render([invoice({ id: 'inv-abschlag', type: 'abschlag', number: '2026-0001' })]);
    expectCtaVisible();
  });

  it('C: eine normale Rechnung schliesst den Strang nicht', () => {
    render([invoice({ id: 'inv-normal', type: 'rechnung', number: '2026-0002' })]);
    expectCtaVisible();
  });

  it('D: eine vorbereitete Schlussrechnung schliesst den Einstieg', () => {
    render([invoice()]);
    expectCtaClosed();
  });

  it('E: eine versendete Schlussrechnung schliesst den Einstieg', () => {
    render([invoice({ status: 'versendet' })]);
    expectCtaClosed();
  });

  /*
   * `cancelledAt` verändert den Status nicht. Der Guard folgt damit exakt
   * `hasSchlussrechnung` und bleibt mit VorgangDetailPage und dem Serverguard
   * konsistent. Wiederabrechenbarkeit nach Storno ist ein eigener Fachpunkt.
   */
  it('F: eine stornierte, vorbereitete Schlussrechnung zählt weiterhin', () => {
    render([invoice({ cancelledAt: '2026-08-21T08:00:00.000Z' })]);
    expectCtaClosed();
  });

  it('G: eine stornierte, versendete Schlussrechnung zählt weiterhin', () => {
    render([invoice({ status: 'versendet', cancelledAt: '2026-08-21T08:00:00.000Z' })]);
    expectCtaClosed();
  });

  it('H: eine Gutschrift löst den Guard nicht aus', () => {
    render([invoice({ id: 'inv-gut', type: 'gutschrift', number: '2026-0005' })]);
    expectCtaVisible();
  });

  it('I: eine Storno-Rechnung löst den Guard nicht aus', () => {
    render([invoice({ id: 'inv-storno', type: 'storno', number: '2026-0006' })]);
    expectCtaVisible();
  });

  it('J: eine ins Leere zeigende vorgangId lässt das bisherige Verhalten unberührt', () => {
    // Der Vorgang fehlt im Store — das darf weder werfen noch den CTA sperren.
    render(undefined);
    expectCtaVisible();
  });

  /*
   * Die Aktualitätszusicherung dieser Architektur ist der Remount: der Store
   * wird beim Rendern gelesen, es gibt keine Subscription. Genau das — und
   * nicht mehr — wird hier festgehalten.
   */
  it('K: nach einer Store-Änderung zeigt das neu montierte Panel den Abschluss', () => {
    render([]);
    expectCtaVisible();
    unmount();

    seedVorgang([invoice()]);
    mount(seedItem());
    expectCtaClosed();
  });
});
