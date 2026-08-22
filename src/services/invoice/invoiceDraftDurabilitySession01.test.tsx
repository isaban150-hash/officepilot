/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P3 — Sitzung für
 * Rechnungsentwürfe.
 *
 * Ausschließlich synthetische, neutrale Daten. Geprüft werden Draft-Inhalt,
 * Reihenfolge, Revision und gespeicherter Rohtext — keine bloßen Klassen- oder
 * Aufrufexistenzen. L2, L3, L4, L9 und L10 laufen zusätzlich gegen den echten
 * IndexedDB-Kern aus 01P2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  defaultInvoiceDraftDurabilityAdapter,
  useInvoiceDraftDurabilitySession,
  type InvoiceDraftDurabilityAdapter,
  type InvoiceDraftDurabilitySession,
  type InvoiceDraftDurabilitySessionInput,
} from './useInvoiceDraftDurabilitySession';
import {
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
  beginInvoiceDraftFinalization,
  completeInvoiceDraftFinalization,
} from './invoiceDraftDurabilityService';
import type {
  InvoiceDraftLocator,
  InvoiceDraftRecord,
} from '../../types/invoiceDraftDurability';
import type { InvoiceDraft, InvoiceDraftPosition } from '../../types/models';

const WORKSPACE = 'ws-sitzung-a';
const SCOPE = `workspace:${WORKSPACE}`;
const VORGANG = 'vg-2001';
const VORGANG_B = 'vg-2002';
const DRAFT_ID = 'draft-sitzung-0001';
const NOW = '2026-08-20T14:00:00.000Z';
const LONG_TEXT = `Hinweis ${'Beispieltext '.repeat(30)}Ende`;

function buildPosition(index: number): InvoiceDraftPosition {
  return {
    id: `pos-${index}`,
    orderPositionId: `op-${index}`,
    description: `Beispielposition ${index}`,
    plannedQuantity: 10,
    billedQuantity: 0,
    openQuantity: 10,
    quantity: index,
    unit: 'stk' as InvoiceDraftPosition['unit'],
    unitPrice: 10 + index,
    billable: true,
  };
}

function buildDraft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return {
    id: DRAFT_ID,
    vorgangId: VORGANG,
    vorgangTitle: 'Beispielvorgang',
    customer: 'Beispiel Kundschaft GmbH',
    baustelle: 'Musterweg 1',
    type: 'rechnung',
    taxStatus: 'standard_19',
    materialSource: 'betrieb',
    positions: [buildPosition(1), buildPosition(2)],
    issueDate: '2026-08-20',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-19',
    paymentDueDate: '2026-09-03',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    skontoText: '',
    customerBilling: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: 'A. Beispiel',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: 'kontakt@beispiel.example',
      phone: '030 0000000',
    },
    companySnapshot: {
      companyName: 'Beispiel Betrieb GmbH',
      legalForm: 'GmbH',
      street: 'Werkstraße 2',
      zip: '54321',
      city: 'Betriebsstadt',
      country: 'Deutschland',
      contactPerson: 'B. Beispiel',
      phone: '030 1111111',
      email: 'info@betrieb.example',
      website: '',
      taxNumber: '11/222/33333',
      vatId: 'DE000000000',
      bankName: 'Beispielbank',
      iban: 'DE00000000000000000000',
      bic: 'BEISPIELXXX',
      defaultPaymentDays: 14,
      defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
      defaultSkonto: '',
      invoiceFooterNotes: LONG_TEXT,
    } as InvoiceDraft['companySnapshot'],
    legalNotices: [LONG_TEXT],
    previousAbschlagDeductions: [],
    invoiceNumberPreview: 'Vorschau',
    introText: LONG_TEXT,
    closingText: LONG_TEXT,
    ...overrides,
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
/* Testaufbau                                                                 */
/* -------------------------------------------------------------------------- */

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: InvoiceDraftDurabilitySession | null = null;

/** Renderhistorie: jeder Renderdurchlauf wird beim Rendern selbst erfasst. */
let renderLog: InvoiceDraftDurabilitySession[] = [];

function Probe({ input }: { input: InvoiceDraftDurabilitySessionInput }) {
  latest = useInvoiceDraftDurabilitySession(input);
  renderLog.push(latest);
  return null;
}

async function settle(rounds = 20): Promise<void> {
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

async function rerenderSession(input: InvoiceDraftDurabilitySessionInput): Promise<void> {
  await act(async () => {
    root!.render(<Probe input={input} />);
  });
  await settle();
}

async function unmountSession(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
}

function session(): InvoiceDraftDurabilitySession {
  expect(latest, 'Sitzung fehlt').not.toBeNull();
  return latest as InvoiceDraftDurabilitySession;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Adapter mit echten Kernfunktionen als Grundlage und Zählung. */
function trackingAdapter(
  overrides: Partial<InvoiceDraftDurabilityAdapter> = {},
): InvoiceDraftDurabilityAdapter & { calls: { load: number; create: number; save: number } } {
  const calls = { load: 0, create: 0, save: 0 };
  return {
    calls,
    loadByLocator: async (input) => {
      calls.load += 1;
      return (overrides.loadByLocator ?? defaultInvoiceDraftDurabilityAdapter.loadByLocator)(input);
    },
    create: async (input) => {
      calls.create += 1;
      return (overrides.create ?? defaultInvoiceDraftDurabilityAdapter.create)(input);
    },
    save: async (input) => {
      calls.save += 1;
      return (overrides.save ?? defaultInvoiceDraftDurabilityAdapter.save)(input);
    },
  };
}

async function seedActiveRecord(draft = buildDraft()): Promise<void> {
  const created = await createInvoiceDraftRecord({
    identity: { ...locator(), draftId: draft.id },
    draft,
    now: NOW,
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
}

beforeEach(async () => {
  latest = null;
  renderLog = [];
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

afterEach(async () => {
  if (root) await unmountSession();
  vi.restoreAllMocks();
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

/* -------------------------------------------------------------------------- */

describe('01P3 — Rechnungsentwurf-Sitzung', () => {
  it('L1: ein null-Locator blockiert ohne jeden Datenbankaufruf', async () => {
    const adapter = trackingAdapter();
    const createDraft = vi.fn(() => buildDraft());

    await renderSession({ locator: null, createDraft, adapter });

    expect(session().status).toBe('blocked_no_identity');
    expect(session().draft).toBeNull();
    expect(session().readOnly).toBe(true);
    expect(session().blocked).toBe(true);
    expect(adapter.calls).toEqual({ load: 0, create: 0, save: 0 });
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('L2: ein vorhandener active-Datensatz wird vollständig geladen', async () => {
    const draft = buildDraft();
    await seedActiveRecord(draft);
    const createDraft = vi.fn(() => buildDraft({ id: 'draft-neu' }));

    await renderSession({ locator: locator(), createDraft });

    expect(session().status).toBe('ready');
    expect(session().readOnly).toBe(false);
    expect(session().restored).toBe(true);
    expect(session().draft).toEqual(draft);
    expect(session().draft?.id).toBe(DRAFT_ID);
    expect(session().record?.revision).toBe(1);
    expect(session().record?.draftId).toBe(DRAFT_ID);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('L3: not_found legt an und wird erst danach bearbeitbar', async () => {
    const gate = deferred<void>();
    const adapter = trackingAdapter({
      create: async (input) => {
        await gate.promise;
        return defaultInvoiceDraftDurabilityAdapter.create(input);
      },
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });

    // Solange das Anlegen läuft, ist nichts bearbeitbar.
    expect(session().status).toBe('creating');
    expect(session().readOnly).toBe(true);

    await act(async () => {
      gate.resolve();
    });
    await settle();

    expect(session().status).toBe('ready');
    expect(session().readOnly).toBe(false);
    expect(session().restored).toBe(false);
    expect(session().draft?.id).toBe(DRAFT_ID);
    expect(session().record?.revision).toBe(1);

    // Der Datensatz liegt dauerhaft im Kern.
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.draft).toEqual(buildDraft());
  });

  it('L4: konkurrierende Erstanlagen ergeben genau einen dauerhaften Gewinner', async () => {
    let counter = 0;
    const createDraft = () => {
      counter += 1;
      return buildDraft({ id: `draft-kandidat-${counter}` });
    };
    const adapter = trackingAdapter();

    // Zwei Sitzungen desselben Locators gleichzeitig.
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <>
          <Probe input={{ locator: locator(), createDraft, adapter }} />
          <Probe input={{ locator: locator(), createDraft, adapter }} />
        </>,
      );
    });
    await settle();

    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok, JSON.stringify(stored)).toBe(true);
    if (!stored.ok) return;

    // Genau ein dauerhafter Datensatz, genau eine Gewinner-draftId.
    expect(['draft-kandidat-1', 'draft-kandidat-2']).toContain(stored.record.draftId);
    expect(stored.record.revision).toBe(1);
    expect(stored.draft.id).toBe(stored.record.draftId);
    expect(session().draft?.id).toBe(stored.record.draftId);
    expect(session().status).toBe('ready');
  });

  it('L5: already_exists lädt anschließend den Gewinner über den Locator', async () => {
    const winner = buildDraft({ id: 'draft-gewinner', introText: 'Gewinnerstand' });
    await seedActiveRecord(winner);

    const adapter = trackingAdapter({
      loadByLocator: (() => {
        let call = 0;
        return async (input: InvoiceDraftLocator) => {
          call += 1;
          // Erster Ladeversuch sieht den Datensatz noch nicht.
          if (call === 1) return { ok: false as const, reason: 'not_found' as const };
          return defaultInvoiceDraftDurabilityAdapter.loadByLocator(input);
        };
      })(),
    });

    await renderSession({
      locator: locator(),
      createDraft: () => buildDraft({ id: 'draft-verlierer' }),
      adapter,
    });

    expect(session().status).toBe('ready');
    expect(session().draft?.id).toBe('draft-gewinner');
    expect(session().draft?.introText).toBe('Gewinnerstand');
    expect(adapter.calls.load).toBe(2);
  });

  it('L6: finalizing wird schreibgeschützt geladen', async () => {
    await seedActiveRecord();
    await beginInvoiceDraftFinalization({
      identity: { ...locator(), draftId: DRAFT_ID },
      expectedRevision: 1,
      clientInvoiceId: 'cinv-1',
      contentFingerprint: 'fp-1',
      request: {
        workspaceId: locator().workspaceId,
        vorgangId: locator().vorgangId,
        clientInvoiceId: 'cinv-1',
        invoice: { id: 'cinv-1', type: locator().invoiceType },
      },
      approvalContext: {},
      now: NOW,
    });

    const adapter = trackingAdapter();
    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });

    expect(session().status).toBe('finalization_pending');
    expect(session().readOnly).toBe(true);
    expect(session().draft).not.toBeNull();
    expect(session().record?.status).toBe('finalizing');
    expect(adapter.calls.save).toBe(0);
    expect(adapter.calls.create).toBe(0);
  });

  it('L7: finalized wird schreibgeschützt geladen', async () => {
    await seedActiveRecord();
    await beginInvoiceDraftFinalization({
      identity: { ...locator(), draftId: DRAFT_ID },
      expectedRevision: 1,
      clientInvoiceId: 'cinv-1',
      contentFingerprint: 'fp-1',
      request: {
        workspaceId: locator().workspaceId,
        vorgangId: locator().vorgangId,
        clientInvoiceId: 'cinv-1',
        invoice: { id: 'cinv-1', type: locator().invoiceType },
      },
      approvalContext: {},
      now: NOW,
    });
    await completeInvoiceDraftFinalization({
      identity: { ...locator(), draftId: DRAFT_ID },
      expectedRevision: 2,
      clientInvoiceId: 'cinv-1',
      contentFingerprint: 'fp-1',
      finalizedInvoiceId: 'cinv-1',
      archiveWarning: false,
      now: NOW,
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft() });

    expect(session().status).toBe('already_finalized');
    expect(session().readOnly).toBe(true);
    expect(session().record?.status).toBe('finalized');
    expect(session().record?.finalization?.finalizedInvoiceId).toBe('cinv-1');
  });

  it('L8: ein beschädigter Datensatz blockiert und wird nicht ersetzt', async () => {
    await seedActiveRecord();
    const createDraft = vi.fn(() => buildDraft());
    const adapter = trackingAdapter({
      loadByLocator: async () => ({ ok: false as const, reason: 'corrupt' as const }),
    });

    await renderSession({ locator: locator(), createDraft, adapter });

    expect(session().status).toBe('blocked_storage');
    expect(session().blocked).toBe(true);
    expect(session().readOnly).toBe(true);
    expect(createDraft).not.toHaveBeenCalled();
    expect(adapter.calls.create).toBe(0);

    // Der vorhandene Datensatz ist unangetastet.
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.record.revision).toBe(1);
  });

  it('L9: mutateDraft speichert sofort; saved erst nach ok:true', async () => {
    await seedActiveRecord();
    const gate = deferred<void>();
    const adapter = trackingAdapter({
      save: async (input) => {
        await gate.promise;
        return defaultInvoiceDraftDurabilityAdapter.save(input);
      },
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    expect(session().status).toBe('ready');

    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Erste Änderung' }));
    });
    await settle(3);

    // Der sichtbare Stand ist sofort da, gespeichert ist er noch nicht.
    expect(session().draft?.introText).toBe('Erste Änderung');
    expect(session().status).toBe('saving');
    expect(adapter.calls.save).toBe(1);

    await act(async () => {
      gate.resolve();
    });
    await settle();

    expect(session().status).toBe('saved');
    expect(session().record?.revision).toBe(2);

    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.draft.introText).toBe('Erste Änderung');
      expect(stored.record.revision).toBe(2);
    }
  });

  it('L10: drei Änderungen während eines Saves ergeben genau einen Folgesave', async () => {
    await seedActiveRecord();
    const gate = deferred<void>();
    let first = true;
    const savedTexts: string[] = [];
    const adapter = trackingAdapter({
      save: async (input) => {
        savedTexts.push(input.draft.introText);
        if (first) {
          first = false;
          await gate.promise;
        }
        return defaultInvoiceDraftDurabilityAdapter.save(input);
      },
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });

    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'A' }));
    });
    await settle(3);
    expect(adapter.calls.save).toBe(1);

    // Drei weitere Änderungen, während der erste Save noch läuft.
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'B' }));
      session().mutateDraft((prev) => ({ ...prev, introText: 'C' }));
      session().mutateDraft((prev) => ({ ...prev, introText: 'D' }));
    });
    await settle(3);
    expect(adapter.calls.save).toBe(1);

    await act(async () => {
      gate.resolve();
    });
    await settle();

    // Genau ein Folgesave mit dem neuesten Stand.
    expect(adapter.calls.save).toBe(2);
    expect(savedTexts).toEqual(['A', 'D']);
    expect(session().status).toBe('saved');
    expect(session().record?.revision).toBe(3);

    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.draft.introText).toBe('D');
      expect(stored.record.revision).toBe(3);
      expect(JSON.parse(stored.record.draftRawJson).introText).toBe('D');
    }
  });

  it('L11: Revisionen stammen ausschließlich aus den Kernergebnissen', async () => {
    await seedActiveRecord();
    const seen: number[] = [];
    const adapter = trackingAdapter({
      save: async (input) => {
        seen.push(input.expectedRevision);
        return defaultInvoiceDraftDurabilityAdapter.save(input);
      },
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    expect(session().record?.revision).toBe(1);

    for (const text of ['A', 'B', 'C']) {
      await act(async () => {
        session().mutateDraft((prev) => ({ ...prev, introText: text }));
      });
      await settle();
    }

    expect(seen).toEqual([1, 2, 3]);
    expect(session().record?.revision).toBe(4);
  });

  it('L12: conflict stoppt die Warteschlange und erhält den eigenen Stand', async () => {
    await seedActiveRecord();
    const adapter = trackingAdapter({
      save: async () => ({ ok: false as const, reason: 'conflict' as const, currentRevision: 7 }),
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Eigener Stand' }));
    });
    await settle();

    expect(session().status).toBe('blocked_conflict');
    expect(session().blocked).toBe(true);
    expect(session().readOnly).toBe(true);
    expect(session().draft?.introText).toBe('Eigener Stand');

    const before = adapter.calls.save;
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Weiterer Versuch' }));
    });
    await settle();
    expect(adapter.calls.save).toBe(before);
    expect(session().draft?.introText).toBe('Eigener Stand');

    const flushed = await session().flush();
    expect(flushed).toEqual({ ok: false, outcome: 'conflict' });
  });

  it('L13: ein Speicherfehler zeigt niemals saved', async () => {
    await seedActiveRecord();
    const adapter = trackingAdapter({
      save: async () => ({ ok: false as const, reason: 'verify_failed' as const }),
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Nicht gespeichert' }));
    });
    await settle();

    expect(session().status).toBe('blocked_storage');
    expect(session().readOnly).toBe(true);
    expect(session().draft?.introText).toBe('Nicht gespeichert');

    const flushed = await session().flush();
    expect(flushed).toEqual({ ok: false, outcome: 'storage_error' });

    // Der gespeicherte Stand blieb unverändert.
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.record.revision).toBe(1);
  });

  it('L14: flush wartet auf laufenden und neuesten wartenden Save', async () => {
    await seedActiveRecord();
    const gate = deferred<void>();
    let first = true;
    const adapter = trackingAdapter({
      save: async (input) => {
        if (first) {
          first = false;
          await gate.promise;
        }
        return defaultInvoiceDraftDurabilityAdapter.save(input);
      },
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });

    const empty = await session().flush();
    expect(empty).toEqual({ ok: true, outcome: 'no_changes' });

    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'A' }));
    });
    await settle(2);

    let flushResult: unknown = null;
    await act(async () => {
      void session()
        .flush()
        .then((result) => {
          flushResult = result;
        });
      // Während flush läuft, kommt eine weitere Änderung.
      session().mutateDraft((prev) => ({ ...prev, introText: 'B' }));
    });
    await settle(2);
    expect(flushResult).toBeNull();

    await act(async () => {
      gate.resolve();
    });
    await settle();

    expect(flushResult).toEqual({ ok: true, outcome: 'saved' });
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.draft.introText).toBe('B');
  });

  it('L15: verspätete Ergebnisse verändern eine neue Sitzung nicht', async () => {
    await seedActiveRecord();
    const otherDraft = buildDraft({ id: 'draft-b', vorgangId: VORGANG_B, introText: 'Zweiter' });
    await createInvoiceDraftRecord({
      identity: { ...locator({ vorgangId: VORGANG_B }), draftId: 'draft-b' },
      draft: otherDraft,
      now: NOW,
    });

    const gate = deferred<void>();
    let slow = true;
    const adapter = trackingAdapter({
      loadByLocator: async (input) => {
        if (slow) {
          slow = false;
          await gate.promise;
        }
        return defaultInvoiceDraftDurabilityAdapter.loadByLocator(input);
      },
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    expect(session().status).toBe('loading');

    // Locatorwechsel, bevor das erste Laden zurückkehrt.
    await rerenderSession({
      locator: locator({ vorgangId: VORGANG_B }),
      createDraft: () => otherDraft,
      adapter,
    });

    await act(async () => {
      gate.resolve();
    });
    await settle();

    expect(session().draft?.id).toBe('draft-b');
    expect(session().draft?.vorgangId).toBe(VORGANG_B);
    expect(session().status).toBe('ready');

    // Unmount verwirft ebenfalls.
    await unmountSession();
    expect(latest?.draft?.id).toBe('draft-b');
  });

  it('L16: Mutationen sind in gesperrten Zuständen vollständig wirkungslos', async () => {
    await seedActiveRecord();
    await beginInvoiceDraftFinalization({
      identity: { ...locator(), draftId: DRAFT_ID },
      expectedRevision: 1,
      clientInvoiceId: 'cinv-1',
      contentFingerprint: 'fp-1',
      request: {
        workspaceId: locator().workspaceId,
        vorgangId: locator().vorgangId,
        clientInvoiceId: 'cinv-1',
        invoice: { id: 'cinv-1', type: locator().invoiceType },
      },
      approvalContext: {},
      now: NOW,
    });

    const adapter = trackingAdapter();
    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    expect(session().status).toBe('finalization_pending');

    const before = session().draft?.introText;
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Verbotene Änderung' }));
    });
    await settle();

    expect(session().draft?.introText).toBe(before);
    expect(adapter.calls.save).toBe(0);
    expect(await session().flush()).toEqual({ ok: false, outcome: 'read_only' });

    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.record.status).toBe('finalizing');
      expect(stored.record.revision).toBe(2);
    }

    // Nach dem Unmount ist jede Mutation ebenfalls wirkungslos.
    const disposedSession = session();
    await unmountSession();
    await act(async () => {
      disposedSession.mutateDraft((prev) => ({ ...prev, introText: 'Nach Unmount' }));
    });
    expect(adapter.calls.save).toBe(0);
    expect(await disposedSession.flush()).toEqual({ ok: false, outcome: 'disposed' });
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P3A — StrictMode und
 * generationssichere Warteschlange.
 * ========================================================================== */

async function renderStrict(input: InvoiceDraftDurabilitySessionInput): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <StrictMode>
        <Probe input={input} />
      </StrictMode>,
    );
  });
  await settle();
}

describe('01P3A — StrictMode und generationssichere Warteschlange', () => {
  it('L17: echter StrictMode führt zu genau einem Gewinner und bleibt bedienbar', async () => {
    // (a) vorhandener Datensatz
    const draft = buildDraft();
    await seedActiveRecord(draft);
    await renderStrict({ locator: locator(), createDraft: () => buildDraft() });

    expect(session().status).toBe('ready');
    expect(session().readOnly).toBe(false);
    expect(session().blocked).toBe(false);
    expect(session().draft).toEqual(draft);

    // Nach dem StrictMode-Cleanup muss die Sitzung weiter arbeiten.
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Nach StrictMode' }));
    });
    await settle();
    expect(session().status).toBe('saved');
    const afterMutation = await loadInvoiceDraftRecordByLocator(locator());
    expect(afterMutation.ok).toBe(true);
    if (afterMutation.ok) expect(afterMutation.draft.introText).toBe('Nach StrictMode');

    await unmountSession();
    await resetInvoiceDraftDurabilityDatabaseForTests();

    // (b) not_found unter StrictMode
    let counter = 0;
    await renderStrict({
      locator: locator(),
      createDraft: () => {
        counter += 1;
        return buildDraft({ id: `draft-strict-${counter}` });
      },
    });

    expect(session().status).toBe('ready');
    expect(session().blocked).toBe(false);
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok, JSON.stringify(stored)).toBe(true);
    if (!stored.ok) return;
    expect(stored.record.revision).toBe(1);
    expect(stored.record.draftId).toBe(session().draft?.id);
    expect(await session().flush()).toEqual({ ok: true, outcome: 'no_changes' });
  });

  it('L18: ein alter Save beeinflusst die neue Sitzung nicht', async () => {
    await seedActiveRecord();
    const otherDraft = buildDraft({ id: 'draft-b', vorgangId: VORGANG_B, introText: 'B-Start' });
    await createInvoiceDraftRecord({
      identity: { ...locator({ vorgangId: VORGANG_B }), draftId: 'draft-b' },
      draft: otherDraft,
      now: NOW,
    });

    const gateA = deferred<void>();
    const gateB = deferred<void>();
    const adapter = trackingAdapter({
      save: async (input) => {
        if (input.identity.vorgangId === VORGANG) await gateA.promise;
        else await gateB.promise;
        return defaultInvoiceDraftDurabilityAdapter.save(input);
      },
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'A-Änderung' }));
    });
    await settle(2);
    expect(session().status).toBe('saving');

    // Locatorwechsel, während Save A noch läuft.
    await rerenderSession({
      locator: locator({ vorgangId: VORGANG_B }),
      createDraft: () => otherDraft,
      adapter,
    });
    expect(session().draft?.id).toBe('draft-b');
    expect(session().status).toBe('ready');

    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'B-Änderung' }));
    });
    await settle(2);
    expect(session().status).toBe('saving');

    let flushB: unknown = null;
    void session()
      .flush()
      .then((result) => {
        flushB = result;
      });

    // Save A löst zuerst auf — die neue Sitzung darf sich nicht ändern.
    await act(async () => {
      gateA.resolve();
    });
    await settle();

    expect(session().status).toBe('saving');
    expect(session().draft?.introText).toBe('B-Änderung');
    expect(session().record?.vorgangId).toBe(VORGANG_B);
    expect(session().record?.revision).toBe(1);
    expect(flushB).toBeNull();

    // Erst Save B schließt die neue Sitzung ab.
    await act(async () => {
      gateB.resolve();
    });
    await settle();

    expect(session().status).toBe('saved');
    expect(session().record?.revision).toBe(2);
    expect(flushB).toEqual({ ok: true, outcome: 'saved' });

    // Beide Datensätze bleiben getrennt und korrekt.
    const storedA = await loadInvoiceDraftRecordByLocator(locator());
    const storedB = await loadInvoiceDraftRecordByLocator(locator({ vorgangId: VORGANG_B }));
    expect(storedA.ok && storedB.ok).toBe(true);
    if (storedA.ok) expect(storedA.draft.introText).toBe('A-Änderung');
    if (storedB.ok) expect(storedB.draft.introText).toBe('B-Änderung');
  });

  it('L19: alte Flush-Wartende erhalten disposed und lösen nichts Neues aus', async () => {
    await seedActiveRecord();
    const otherDraft = buildDraft({ id: 'draft-b', vorgangId: VORGANG_B });
    await createInvoiceDraftRecord({
      identity: { ...locator({ vorgangId: VORGANG_B }), draftId: 'draft-b' },
      draft: otherDraft,
      now: NOW,
    });

    const gateA = deferred<void>();
    const gateB = deferred<void>();
    const adapter = trackingAdapter({
      save: async (input) => {
        if (input.identity.vorgangId === VORGANG) await gateA.promise;
        else await gateB.promise;
        return defaultInvoiceDraftDurabilityAdapter.save(input);
      },
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'A' }));
    });
    await settle(2);

    let flushA: unknown = null;
    void session()
      .flush()
      .then((result) => {
        flushA = result;
      });
    await settle(2);
    expect(flushA).toBeNull();

    await rerenderSession({
      locator: locator({ vorgangId: VORGANG_B }),
      createDraft: () => otherDraft,
      adapter,
    });
    await settle(2);

    // Der alte Wartende wurde beim Sitzungswechsel entlassen.
    expect(flushA).toEqual({ ok: false, outcome: 'disposed' });

    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'B' }));
    });
    await settle(2);

    let flushB: unknown = null;
    void session()
      .flush()
      .then((result) => {
        flushB = result;
      });

    await act(async () => {
      gateA.resolve();
    });
    await settle();
    expect(flushB).toBeNull();

    await act(async () => {
      gateB.resolve();
    });
    await settle();
    expect(flushB).toEqual({ ok: true, outcome: 'saved' });
  });

  it('L20: alte Callbacks wirken nicht auf die neue Sitzung', async () => {
    await seedActiveRecord();
    const otherDraft = buildDraft({ id: 'draft-b', vorgangId: VORGANG_B, introText: 'B-Start' });
    await createInvoiceDraftRecord({
      identity: { ...locator({ vorgangId: VORGANG_B }), draftId: 'draft-b' },
      draft: otherDraft,
      now: NOW,
    });

    const adapter = trackingAdapter();
    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    const oldSession = session();

    await rerenderSession({
      locator: locator({ vorgangId: VORGANG_B }),
      createDraft: () => otherDraft,
      adapter,
    });
    const savesBefore = adapter.calls.save;

    await act(async () => {
      oldSession.mutateDraft((prev) => ({ ...prev, introText: 'Alter Callback' }));
    });
    await settle();

    expect(session().draft?.introText).toBe('B-Start');
    expect(session().draft?.id).toBe('draft-b');
    expect(adapter.calls.save).toBe(savesBefore);
    expect(await oldSession.flush()).toEqual({ ok: false, outcome: 'disposed' });

    const storedB = await loadInvoiceDraftRecordByLocator(locator({ vorgangId: VORGANG_B }));
    expect(storedB.ok).toBe(true);
    if (storedB.ok) {
      expect(storedB.draft.introText).toBe('B-Start');
      expect(storedB.record.revision).toBe(1);
    }
  });

  it('L21: geworfene Adapter-, createDraft- und now-Fehler bleiben typisiert', async () => {
    // (a) loadByLocator wirft
    const throwingLoad = trackingAdapter({
      loadByLocator: async () => {
        throw new Error('simulierter Ladefehler');
      },
    });
    await renderSession({
      locator: locator(),
      createDraft: () => buildDraft(),
      adapter: throwingLoad,
    });
    expect(session().status).toBe('blocked_storage');
    expect(session().readOnly).toBe(true);
    expect(await session().flush()).toEqual({ ok: false, outcome: 'storage_error' });
    await unmountSession();

    // (b) createDraft wirft
    const throwingCreateDraft = trackingAdapter();
    await renderSession({
      locator: locator(),
      createDraft: () => {
        throw new Error('simulierter Entwurfsfehler');
      },
      adapter: throwingCreateDraft,
    });
    expect(session().status).toBe('blocked_storage');
    expect(throwingCreateDraft.calls.create).toBe(0);
    await unmountSession();

    // (c) create wirft
    const throwingCreate = trackingAdapter({
      create: async () => {
        throw new Error('simulierter Anlagefehler');
      },
    });
    await renderSession({
      locator: locator(),
      createDraft: () => buildDraft(),
      adapter: throwingCreate,
    });
    expect(session().status).toBe('blocked_storage');
    await unmountSession();

    // (d) save wirft — der sichtbare Stand bleibt erhalten
    await seedActiveRecord();
    const throwingSave = trackingAdapter({
      save: async () => {
        throw new Error('simulierter Speicherfehler');
      },
    });
    await renderSession({
      locator: locator(),
      createDraft: () => buildDraft(),
      adapter: throwingSave,
    });
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Nicht gespeichert' }));
    });
    await settle();

    expect(session().status).toBe('blocked_storage');
    expect(session().status).not.toBe('saved');
    expect(session().draft?.introText).toBe('Nicht gespeichert');
    expect(session().readOnly).toBe(true);
    expect(await session().flush()).toEqual({ ok: false, outcome: 'storage_error' });

    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.record.revision).toBe(1);
    await unmountSession();

    // (e) now wirft
    await resetInvoiceDraftDurabilityDatabaseForTests();
    await seedActiveRecord();
    await renderSession({
      locator: locator(),
      createDraft: () => buildDraft(),
      now: () => {
        throw new Error('simulierter Zeitfehler');
      },
    });
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Zeitfehler' }));
    });
    await settle();
    expect(session().status).toBe('blocked_storage');
  });

  it('L22: der issue-Befund ist typisiert und wird bei neuer Sitzung zurückgesetzt', async () => {
    await seedActiveRecord();
    const otherDraft = buildDraft({ id: 'draft-b', vorgangId: VORGANG_B });
    await createInvoiceDraftRecord({
      identity: { ...locator({ vorgangId: VORGANG_B }), draftId: 'draft-b' },
      draft: otherDraft,
      now: NOW,
    });

    const conflictAdapter = trackingAdapter({
      save: async () => ({ ok: false as const, reason: 'conflict' as const, currentRevision: 9 }),
    });
    await renderSession({
      locator: locator(),
      createDraft: () => buildDraft(),
      adapter: conflictAdapter,
    });
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Konflikt' }));
    });
    await settle();

    expect(session().status).toBe('blocked_conflict');
    expect(session().issue).toEqual({ kind: 'conflict', reason: 'conflict', currentRevision: 9 });

    // Ein Sitzungswechsel setzt den Befund zurück.
    await rerenderSession({
      locator: locator({ vorgangId: VORGANG_B }),
      createDraft: () => otherDraft,
      adapter: trackingAdapter(),
    });
    expect(session().status).toBe('ready');
    expect(session().issue).toBeNull();
    await unmountSession();

    // Speicherfehler tragen den echten Grund.
    await renderSession({
      locator: locator(),
      createDraft: () => buildDraft(),
      adapter: trackingAdapter({
        save: async () => ({ ok: false as const, reason: 'verify_failed' as const }),
      }),
    });
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Verify' }));
    });
    await settle();

    expect(session().status).toBe('blocked_storage');
    expect(session().issue?.kind).toBe('storage');
    expect(session().issue?.reason).toBe('verify_failed');
    expect(session().issue?.currentRevision).toBeUndefined();
  });

  it('L23: restored gilt nur bis zur ersten angenommenen Mutation', async () => {
    await seedActiveRecord();
    const otherDraft = buildDraft({ id: 'draft-b', vorgangId: VORGANG_B });
    await createInvoiceDraftRecord({
      identity: { ...locator({ vorgangId: VORGANG_B }), draftId: 'draft-b' },
      draft: otherDraft,
      now: NOW,
    });

    const adapter = trackingAdapter();
    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    expect(session().restored).toBe(true);

    // Eine wirkungslose Mutation ändert den Hinweis nicht.
    await act(async () => {
      session().mutateDraft((prev) => prev);
    });
    await settle();
    expect(session().restored).toBe(true);
    expect(adapter.calls.save).toBe(0);

    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Eigene Änderung' }));
    });
    await settle(2);
    expect(session().restored).toBe(false);

    // Für die neue Sitzung wird der Hinweis neu berechnet.
    await rerenderSession({
      locator: locator({ vorgangId: VORGANG_B }),
      createDraft: () => otherDraft,
      adapter,
    });
    expect(session().restored).toBe(true);
  });

  it('L24: ein werfender Updater zerstört die Sitzungssteuerung nicht', async () => {
    await seedActiveRecord();
    const adapter = trackingAdapter();
    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });

    const before = session().draft;
    await act(async () => {
      // Wirft synchron — darf nicht bis zum Aufrufer durchlaufen.
      session().mutateDraft(() => {
        throw new Error('simulierter Updater-Fehler');
      });
    });
    await settle();

    expect(session().draft).toEqual(before);
    expect(adapter.calls.save).toBe(0);
    expect(session().status).toBe('blocked_storage');
    expect(session().issue?.kind).toBe('storage');
    expect(session().readOnly).toBe(true);
    expect(await session().flush()).toEqual({ ok: false, outcome: 'storage_error' });

    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.record.revision).toBe(1);
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P3B — Snapshot-Isolierung und
 * synchrone Locator-Sperre.
 * ========================================================================== */

describe('01P3B — Snapshot-Isolierung und synchrone Locator-Sperre', () => {
  it('L25: ein mutativer Updater wird übernommen, ohne den vorherigen Stand zu verändern', async () => {
    const draft = buildDraft();
    await seedActiveRecord(draft);
    const adapter = trackingAdapter();
    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });

    const previous = session().draft!;
    const previousText = JSON.stringify(previous);

    await act(async () => {
      session().mutateDraft((prev) => {
        // Bewusst mutativ auf dem übergebenen Kandidaten.
        prev.positions[0]!.quantity = 99;
        prev.customerBilling.city = 'Neustadt';
        return prev;
      });
    });
    await settle();

    expect(session().draft?.positions[0]?.quantity).toBe(99);
    expect(session().draft?.customerBilling.city).toBe('Neustadt');
    // Der zuvor ausgegebene Stand blieb vollständig unangetastet.
    expect(JSON.stringify(previous)).toBe(previousText);
    expect(previous.positions[0]?.quantity).toBe(draft.positions[0]?.quantity);

    expect(adapter.calls.save).toBe(1);
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.draft.positions[0]?.quantity).toBe(99);
    expect(stored.draft.customerBilling.city).toBe('Neustadt');
    expect(stored.draft.positions.length).toBe(2);
    expect(stored.draft.companySnapshot).toEqual(draft.companySnapshot);
    expect(stored.draft.legalNotices).toEqual(draft.legalNotices);
    expect(stored.draft.introText).toBe(LONG_TEXT);
  });

  it('L26: ein mutierender und dann werfender Updater lässt alles unverändert', async () => {
    const draft = buildDraft();
    await seedActiveRecord(draft);
    const adapter = trackingAdapter();
    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });

    const before = session().draft!;
    const beforeText = JSON.stringify(before);

    await act(async () => {
      session().mutateDraft((prev) => {
        prev.positions[0]!.quantity = 4242;
        prev.introText = 'Halb verändert';
        throw new Error('simulierter Updater-Fehler');
      });
    });
    await settle();

    expect(JSON.stringify(before)).toBe(beforeText);
    expect(session().draft?.positions[0]?.quantity).toBe(draft.positions[0]?.quantity);
    expect(session().draft?.introText).toBe(LONG_TEXT);
    expect(adapter.calls.save).toBe(0);
    expect(session().status).toBe('blocked_storage');
    expect(session().issue).toEqual({ kind: 'storage', reason: 'updater_threw' });
    expect(await session().flush()).toEqual({ ok: false, outcome: 'storage_error' });

    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.record.revision).toBe(1);
      expect(stored.draft).toEqual(draft);
    }
  });

  it('L27: ein inhaltlich unveränderter Klon löst keinen Save aus', async () => {
    await seedActiveRecord();
    const adapter = trackingAdapter();
    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });

    expect(session().restored).toBe(true);
    const statusBefore = session().status;

    await act(async () => {
      session().mutateDraft((prev) => JSON.parse(JSON.stringify(prev)) as InvoiceDraft);
    });
    await settle();

    expect(adapter.calls.save).toBe(0);
    expect(session().status).toBe(statusBefore);
    expect(session().status).not.toBe('saving');
    expect(session().restored).toBe(true);
    expect(session().record?.revision).toBe(1);
  });

  it('L28: eine äußere Veränderung des ausgegebenen Drafts wirkt nicht zurück', async () => {
    const draft = buildDraft();
    await seedActiveRecord(draft);
    const adapter = trackingAdapter();
    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });

    // Fremdcode verändert das ausgegebene Objekt direkt.
    const exposed = session().draft!;
    exposed.positions[0]!.quantity = 12345;
    exposed.introText = 'Von außen verändert';

    expect(adapter.calls.save).toBe(0);
    const untouched = await loadInvoiceDraftRecordByLocator(locator());
    expect(untouched.ok).toBe(true);
    if (untouched.ok) expect(untouched.draft).toEqual(draft);

    // Die nächste reguläre Mutation geht vom geschützten internen Stand aus.
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, closingText: 'Reguläre Änderung' }));
    });
    await settle();

    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.draft.closingText).toBe('Reguläre Änderung');
    expect(stored.draft.positions[0]?.quantity).toBe(draft.positions[0]?.quantity);
    expect(stored.draft.introText).toBe(LONG_TEXT);
  });

  it('L29: die Locator-Sperre greift bereits im Render, vor dem passiven Effect', async () => {
    const draftA = buildDraft();
    await seedActiveRecord(draftA);
    const otherDraft = buildDraft({ id: 'draft-b', vorgangId: VORGANG_B, introText: 'B-Start' });
    await createInvoiceDraftRecord({
      identity: { ...locator({ vorgangId: VORGANG_B }), draftId: 'draft-b' },
      draft: otherDraft,
      now: NOW,
    });

    const adapter = trackingAdapter();
    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    expect(session().draft?.id).toBe(DRAFT_ID);

    const oldSession = session();
    const savesBefore = adapter.calls.save;
    const logLengthBefore = renderLog.length;

    // Renderwechsel auf Locator B — der erste Renderdurchlauf zählt.
    await act(async () => {
      root!.render(
        <Probe
          input={{
            locator: locator({ vorgangId: VORGANG_B }),
            createDraft: () => otherDraft,
            adapter,
          }}
        />,
      );
    });

    const firstRenderWithB = renderLog[logLengthBefore];
    expect(firstRenderWithB, 'kein Render nach dem Wechsel erfasst').toBeTruthy();
    expect(firstRenderWithB!.draft).toBeNull();
    expect(firstRenderWithB!.record).toBeNull();
    expect(firstRenderWithB!.readOnly).toBe(true);

    // Der alte Callback darf ab diesem Render nichts mehr bewirken.
    await act(async () => {
      oldSession.mutateDraft((prev) => ({ ...prev, introText: 'Alter Callback nach Wechsel' }));
    });
    expect(await oldSession.flush()).toEqual({ ok: false, outcome: 'disposed' });
    expect(adapter.calls.save).toBe(savesBefore);

    await settle();
    expect(session().draft?.id).toBe('draft-b');
    expect(session().draft?.introText).toBe('B-Start');

    const storedA = await loadInvoiceDraftRecordByLocator(locator());
    expect(storedA.ok).toBe(true);
    if (storedA.ok) expect(storedA.draft).toEqual(draftA);
  });

  it('L30: verspätete Updates einer alten Generation erreichen die Renderhistorie nicht', async () => {
    const draftA = buildDraft({ introText: 'A-Inhalt' });
    await seedActiveRecord(draftA);
    const otherDraft = buildDraft({ id: 'draft-b', vorgangId: VORGANG_B, introText: 'B-Start' });
    await createInvoiceDraftRecord({
      identity: { ...locator({ vorgangId: VORGANG_B }), draftId: 'draft-b' },
      draft: otherDraft,
      now: NOW,
    });

    const gateA = deferred<void>();
    const gateSaveB = deferred<void>();
    const adapter = trackingAdapter({
      loadByLocator: async (input) => {
        if (input.vorgangId === VORGANG) await gateA.promise;
        return defaultInvoiceDraftDurabilityAdapter.loadByLocator(input);
      },
      save: async (input) => {
        await gateSaveB.promise;
        return defaultInvoiceDraftDurabilityAdapter.save(input);
      },
    });

    await renderSession({ locator: locator(), createDraft: () => buildDraft(), adapter });
    expect(session().draft).toBeNull();

    const switchIndex = renderLog.length;
    await rerenderSession({
      locator: locator({ vorgangId: VORGANG_B }),
      createDraft: () => otherDraft,
      adapter,
    });
    expect(session().draft?.id).toBe('draft-b');

    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'B-Änderung' }));
    });
    await settle(2);
    expect(session().status).toBe('saving');

    let flushB: unknown = null;
    void session()
      .flush()
      .then((result) => {
        flushB = result;
      });

    // Erst jetzt kehrt das Laden der alten Sitzung zurück.
    await act(async () => {
      gateA.resolve();
    });
    await settle();
    expect(flushB).toBeNull();

    await act(async () => {
      gateSaveB.resolve();
    });
    await settle();
    const revisionB = session().record?.revision;
    expect(revisionB).toBe(2);

    for (const entry of renderLog.slice(switchIndex)) {
      expect(entry.draft?.id ?? 'draft-b').toBe('draft-b');
      expect(entry.draft?.introText === 'A-Inhalt').toBe(false);
      expect(entry.record?.vorgangId ?? VORGANG_B).toBe(VORGANG_B);
    }
    expect(session().draft?.introText).toBe('B-Änderung');
    expect(session().record?.revision).toBe(revisionB);
    expect(session().issue).toBeNull();
    expect(flushB).toEqual({ ok: true, outcome: 'saved' });
  });

  it('L31: die issue-Klassifikation trennt identity, storage und conflict', async () => {
    // identity_mismatch → kind identity
    await renderSession({
      locator: locator(),
      createDraft: () => buildDraft(),
      adapter: trackingAdapter({
        loadByLocator: async () => ({ ok: false as const, reason: 'identity_mismatch' as const }),
      }),
    });
    expect(session().status).toBe('blocked_storage');
    expect(session().issue).toEqual({ kind: 'identity', reason: 'identity_mismatch' });
    await unmountSession();

    // fehlender Locator → kind identity
    await renderSession({ locator: null, createDraft: () => buildDraft() });
    expect(session().issue?.kind).toBe('identity');
    await unmountSession();

    // verify_failed → kind storage
    await seedActiveRecord();
    await renderSession({
      locator: locator(),
      createDraft: () => buildDraft(),
      adapter: trackingAdapter({
        save: async () => ({ ok: false as const, reason: 'verify_failed' as const }),
      }),
    });
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Verify' }));
    });
    await settle();
    expect(session().issue).toEqual({ kind: 'storage', reason: 'verify_failed' });
    await unmountSession();

    // conflict → kind conflict mit currentRevision
    await renderSession({
      locator: locator(),
      createDraft: () => buildDraft(),
      adapter: trackingAdapter({
        save: async () => ({ ok: false as const, reason: 'conflict' as const, currentRevision: 5 }),
      }),
    });
    await act(async () => {
      session().mutateDraft((prev) => ({ ...prev, introText: 'Konflikt' }));
    });
    await settle();
    expect(session().issue).toEqual({ kind: 'conflict', reason: 'conflict', currentRevision: 5 });
  });
});
