/**
 * OFFICEPILOT-INVOICE-DRAFT-ROLLOVER-03B — nach der Rechnung ist vor der Rechnung.
 *
 * Ein erfolgreich finalisierter Entwurf blieb unter dem einzigen aktiven
 * Locator [scope, vorgangId, invoiceType] liegen. Beim nächsten „Rechnung
 * vorbereiten" wurde deshalb der historische Entwurf wieder geladen — mit
 * seinen eingefrorenen Werten: bereits abgerechnet 0, offen 950, Menge 800.
 * Eine zweite Rechnung desselben Typs war damit nicht erstellbar.
 *
 * Der Slot wird jetzt freigegeben — aber nur, wenn die fertige Rechnung
 * nachweislich im Vorgang liegt. `finalized` allein ist kein Grund, einen
 * gespeicherten Entwurf zu löschen.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  defaultInvoiceDraftDurabilityAdapter,
  useInvoiceDraftDurabilitySession,
  type InvoiceDraftDurabilitySession,
  type InvoiceDraftDurabilitySessionInput,
} from './useInvoiceDraftDurabilitySession';
import {
  beginInvoiceDraftFinalization,
  completeInvoiceDraftFinalization,
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from './invoiceDraftDurabilityService';
import { buildInvoiceDraftForType } from '../invoiceService';
import { getVorgangById, hydrateVorgangStore } from '../vorgangService';
import { getBilledQuantity, getBillableOpenQuantity } from '../orderBillingRules';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { InvoiceDraftLocator } from '../../types/invoiceDraftDurability';
import type { InvoiceDraft, InvoiceDraftPosition, Vorgang, VorgangInvoice } from '../../types/models';

const WORKSPACE = 'ws-rollover';
const SCOPE = `workspace:${WORKSPACE}`;
const VORGANG = 'vg-rollover';
const OLD_DRAFT_ID = 'draft-alt-0001';
const INVOICE_ID = 'cinv-rollover-1';
const NOW = '2026-08-25T09:00:00.000Z';

/* -------------------------------------------------------------------------- */
/* Fixtures — der reale Fall in neutralen Zahlen                              */
/* -------------------------------------------------------------------------- */

/** Erste Rechnung: Position 01 zu 800 von 950, Position 02 vollständig. */
function finalizedInvoice(): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0001',
    type: 'rechnung',
    status: 'versendet',
    date: '2026-08-24',
    createdAt: '2026-08-24T10:00:00.000Z',
    subtotal: 14820,
    amount: 17635.8,
    taxStatus: 'standard_19',
    sentAt: '2026-08-25',
    sentVia: 'email',
    paymentStatus: 'teilbezahlt',
    payments: [
      { id: 'pay-1', date: '2026-08-25', amount: 10000, method: 'ueberweisung' },
    ],
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Dampfsperre',
        quantity: 800,
        unit: 'm2',
        unitPrice: 3.8,
        lineTotal: 3040,
      },
      {
        id: 'line-2',
        orderPositionId: 'op-2',
        description: 'Dämmung',
        quantity: 950,
        unit: 'm2',
        unitPrice: 12.4,
        lineTotal: 11780,
      },
    ],
    legalNotices: [],
    previousAbschlagDeductions: [],
  } as VorgangInvoice;
}

function seedVorgang(withInvoice: boolean): void {
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG,
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'm2', plannedQuantity: 950, unitPrice: 3.8 }),
          createOrderPosition({ id: 'op-2', unit: 'm2', plannedQuantity: 950, unitPrice: 12.4 }),
        ],
      }),
      invoices: withInvoice ? [finalizedInvoice()] : [],
    } as Vorgang,
  ]);
}

function oldPosition(index: number, quantity: number): InvoiceDraftPosition {
  return {
    id: `pos-${index}`,
    orderPositionId: `op-${index}`,
    description: `Position ${index}`,
    plannedQuantity: 950,
    // Genau der eingefrorene Stand von vor der Finalisierung.
    billedQuantity: 0,
    openQuantity: 950,
    quantity,
    unit: 'm2' as InvoiceDraftPosition['unit'],
    unitPrice: index === 1 ? 3.8 : 12.4,
    billable: true,
  };
}

/** Der historische Entwurf, aus dem 2026-0001 entstand. */
function oldDraft(): InvoiceDraft {
  return {
    id: OLD_DRAFT_ID,
    vorgangId: VORGANG,
    vorgangTitle: 'Beispielvorgang',
    customer: 'Beispiel Projektbau GmbH',
    baustelle: 'Musterweg 1',
    type: 'rechnung',
    taxStatus: 'standard_19',
    materialSource: 'betrieb',
    positions: [oldPosition(1, 800), oldPosition(2, 950)],
    issueDate: '2026-08-24',
    paymentDueDate: '2026-09-07',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    skontoText: '',
    legalNotices: [],
    previousAbschlagDeductions: [],
    invoiceNumberPreview: 'Vorschau',
    introText: '',
    closingText: '',
  } as InvoiceDraft;
}

function locator(overrides: Partial<InvoiceDraftLocator> = {}): InvoiceDraftLocator {
  return {
    sourceScopeKey: SCOPE,
    workspaceId: WORKSPACE,
    vorgangId: VORGANG,
    invoiceType: 'rechnung',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Speicherzustände                                                           */
/* -------------------------------------------------------------------------- */

async function seedActive(draft: InvoiceDraft = oldDraft()): Promise<void> {
  const created = await createInvoiceDraftRecord({
    identity: { ...locator({ invoiceType: draft.type }), draftId: draft.id },
    draft,
    now: NOW,
  });
  expect(created.ok).toBe(true);
}

async function seedFinalizing(): Promise<void> {
  await seedActive();
  const begun = await beginInvoiceDraftFinalization({
    identity: { ...locator(), draftId: OLD_DRAFT_ID },
    expectedRevision: 1,
    clientInvoiceId: INVOICE_ID,
    contentFingerprint: 'fp-1',
    request: {
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      clientInvoiceId: INVOICE_ID,
      invoice: { id: INVOICE_ID, type: 'rechnung' },
    },
    approvalContext: {},
    now: NOW,
  });
  expect(begun.ok).toBe(true);
}

async function seedFinalized(): Promise<void> {
  await seedFinalizing();
  const done = await completeInvoiceDraftFinalization({
    identity: { ...locator(), draftId: OLD_DRAFT_ID },
    expectedRevision: 2,
    clientInvoiceId: INVOICE_ID,
    contentFingerprint: 'fp-1',
    finalizedInvoiceId: INVOICE_ID,
    archiveWarning: false,
    now: NOW,
  });
  expect(done.ok).toBe(true);
}

/* -------------------------------------------------------------------------- */
/* Renderaufbau                                                               */
/* -------------------------------------------------------------------------- */

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: InvoiceDraftDurabilitySession | null = null;

function Probe({ input }: { input: InvoiceDraftDurabilitySessionInput }) {
  latest = useInvoiceDraftDurabilitySession(input);
  return null;
}

async function settle(rounds = 25): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderSession(input: InvoiceDraftDurabilitySessionInput): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Probe input={input} />);
  });
  await settle();
}

function session(): InvoiceDraftDurabilitySession {
  if (!latest) throw new Error('keine Sitzung');
  return latest;
}

/** Der frische Entwurf entsteht wie in der Oberfläche, aus dem echten Vorgang. */
function freshDraft(): InvoiceDraft | null {
  return buildInvoiceDraftForType(VORGANG, { ...DEFAULT_SETUP }, 'rechnung');
}

describe('OFFICEPILOT-INVOICE-DRAFT-ROLLOVER-03B', () => {
  beforeEach(async () => {
    resetTestStores();
    await resetInvoiceDraftDurabilityDatabaseForTests();
    latest = null;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  it('A: ein aktiver Entwurf wird unverändert wieder aufgenommen', async () => {
    seedVorgang(false);
    await seedActive();

    await renderSession({ locator: locator(), createDraft: freshDraft });

    expect(session().record?.status).toBe('active');
    expect(session().draft?.id).toBe(OLD_DRAFT_ID);
    // Die Nutzereingabe bleibt exakt erhalten — kein Rollover.
    expect(session().draft?.positions[0]?.quantity).toBe(800);
  });

  it('B: ein laufender Abschluss wird nicht angetastet', async () => {
    seedVorgang(true);
    await seedFinalizing();

    await renderSession({ locator: locator(), createDraft: freshDraft });

    expect(session().status).toBe('finalization_pending');
    expect(session().record?.status).toBe('finalizing');
    expect(session().draft?.id).toBe(OLD_DRAFT_ID);
  });

  it('C/D/E: nach der Finalisierung entsteht ein neuer Entwurf', async () => {
    seedVorgang(true);
    await seedFinalized();

    await renderSession({ locator: locator(), createDraft: freshDraft });

    // C — der Slot ist frei, ein aktiver Entwurf steht bereit.
    expect(session().status).not.toBe('already_finalized');
    expect(session().record?.status).toBe('active');
    expect(session().readOnly).toBe(false);

    // D — eigene Identität.
    expect(session().draft?.id).toBeTruthy();
    expect(session().draft?.id).not.toBe(OLD_DRAFT_ID);

    // E — die alte Eingabe wandert nicht mit.
    const first = session().draft!.positions.find((p) => p.orderPositionId === 'op-1')!;
    expect(first.quantity).not.toBe(800);
    expect(first.quantity).toBeLessThanOrEqual(150);

    // Und der Speicher hält genau diesen neuen Entwurf.
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.record.status).toBe('active');
    expect(stored.record.draftId).toBe(session().draft?.id);
  });

  it('F/G: der neue Entwurf rechnet mit dem aktuellen Abrechnungsstand', async () => {
    seedVorgang(true);
    await seedFinalized();

    await renderSession({ locator: locator(), createDraft: freshDraft });

    const positions = session().draft!.positions;
    const first = positions.find((p) => p.orderPositionId === 'op-1')!;
    const second = positions.find((p) => p.orderPositionId === 'op-2')!;

    // F — 950 geplant, 800 abgerechnet, 150 offen.
    expect(first.plannedQuantity).toBe(950);
    expect(first.billedQuantity).toBe(800);
    expect(first.openQuantity).toBe(150);

    // G — vollständig fakturiert, nichts mehr offen.
    expect(second.billedQuantity).toBe(950);
    expect(second.openQuantity).toBe(0);
    expect(second.quantity).toBe(0);

    // Gegenprobe an der unveränderten Rechenregel selbst.
    const vorgang = getVorgangById(VORGANG)!;
    expect(getBilledQuantity(vorgang, 'op-1')).toBe(800);
    expect(getBillableOpenQuantity(vorgang, 'op-1')).toBe(150);
    expect(getBillableOpenQuantity(vorgang, 'op-2')).toBe(0);
  });

  it('H/I: die fertige Rechnung bleibt unangetastet und bleibt der Idempotenzanker', async () => {
    seedVorgang(true);
    await seedFinalized();
    const before = structuredClone(getVorgangById(VORGANG)!.invoices);

    await renderSession({ locator: locator(), createDraft: freshDraft });

    // H — Freigabe des Entwurfs verändert die Rechnung nicht.
    const after = getVorgangById(VORGANG)!.invoices;
    expect(after).toEqual(before);
    const invoice = after.find((inv) => inv.id === INVOICE_ID)!;
    expect(invoice.number).toBe('2026-0001');
    expect(invoice.status).toBe('versendet');
    expect(invoice.paymentStatus).toBe('teilbezahlt');
    expect(invoice.payments?.[0]?.amount).toBe(10000);
    expect(invoice.positions).toHaveLength(2);

    // I — die alte Finalisierung bleibt auflösbar; der Schutz hängt an der
    // Rechnung, nicht am gelöschten Entwurf.
    expect(getVorgangById(VORGANG)?.invoices.some((inv) => inv.id === INVOICE_ID)).toBe(true);
  });

  it('J: ohne auflösbare Rechnung wird nichts gelöscht', async () => {
    // Der Vorgang kennt die finalisierte Rechnung nicht — inkonsistenter Stand.
    seedVorgang(false);
    await seedFinalized();

    await renderSession({ locator: locator(), createDraft: freshDraft });

    // Kein stiller Datenverlust: der Entwurf liegt unverändert im Speicher.
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.record.status).toBe('finalized');
    expect(stored.record.draftId).toBe(OLD_DRAFT_ID);

    // Und es wurde kein neuer Entwurf darübergelegt.
    expect(session().record?.status).toBe('finalized');
    expect(session().readOnly).toBe(true);
  });

  it('K: bei Revisionskonflikt wird weder gelöscht noch neu angelegt', async () => {
    seedVorgang(true);
    await seedFinalized();

    const release = vi.fn(async () => ({
      ok: false as const,
      reason: 'conflict' as const,
      currentRevision: 99,
    }));

    await renderSession({
      locator: locator(),
      createDraft: freshDraft,
      adapter: { ...defaultInvoiceDraftDurabilityAdapter, releaseFinalized: release },
    });

    expect(release).toHaveBeenCalledTimes(1);

    // Kein neuer Entwurf, kein Verlust — der alte Stand gilt weiter.
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.record.status).toBe('finalized');
    expect(stored.record.draftId).toBe(OLD_DRAFT_ID);
    expect(session().readOnly).toBe(true);
  });

  it('L: die Typtrennung des Locators bleibt bestehen', async () => {
    seedVorgang(true);
    await seedFinalized();

    // Ein aktiver Abschlagsentwurf liegt unter einem eigenen Schlüssel …
    const abschlag = { ...oldDraft(), id: 'draft-abschlag', type: 'abschlag' } as InvoiceDraft;
    await seedActive(abschlag);

    await renderSession({
      locator: locator({ invoiceType: 'abschlag' }),
      createDraft: () => abschlag,
    });

    // … und wird vom Rollover der normalen Rechnung nicht berührt.
    expect(session().record?.status).toBe('active');
    expect(session().draft?.id).toBe('draft-abschlag');
  });
});
