/**
 * INVOICE-FINALIZE-HANG-01B — `session.flush()` wartet nicht mehr unbegrenzt.
 *
 * Der Realtest zeigte eine Oberfläche, die dauerhaft bei „Rechnung wird
 * freigegeben…" stand — ohne Meldung und ohne Serverkontakt. Ursache war dieser
 * Wartepunkt: Er löste nur auf, wenn ein Speicherlauf die Warteliste leerte.
 *
 * Hier wird genau das erzwungen — über den bereits vorhandenen injizierbaren
 * Adapter, ohne Modulmocks und ohne IndexedDB. Geprüft wird ausschliesslich der
 * Wartevertrag.
 */
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useInvoiceDraftDurabilitySession,
  INVOICE_DRAFT_FLUSH_TIMEOUT_MS,
  type InvoiceDraftDurabilityAdapter,
  type InvoiceDraftFlushResult,
} from './useInvoiceDraftDurabilitySession';
import { buildInvoiceDraftForType } from '../invoiceService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateVorgangStore } from '../vorgangService';
import { createTestVorgang } from '../../test/fixtures';
import type { InvoiceDraft } from '../../types/models';
import type { InvoiceDraftRecord } from '../../types/invoiceDraftDurability';

const WORKSPACE = 'ws-flush-timeout';
const VORGANG = 'vg-flush-timeout';

function baseRecord(revision: number): InvoiceDraftRecord {
  return {
    kind: 'officepilot-invoice-draft',
    formatVersion: 1,
    recordKey: 'record-key',
    sourceScopeKey: `workspace:${WORKSPACE}`,
    workspaceId: WORKSPACE,
    vorgangId: VORGANG,
    invoiceType: 'rechnung',
    draftId: 'draft-flush',
    revision,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
    draftRawJson: '{}',
    draftSha256: 'sha',
    status: 'active',
  } as InvoiceDraftRecord;
}

/** Speichert nie zu Ende — genau die Lage aus dem Realtest. */
const hangingAdapter: InvoiceDraftDurabilityAdapter = {
  loadByLocator: (async () => ({ ok: false, reason: 'not_found' })) as never,
  create: (async () => ({ ok: true, record: baseRecord(1) })) as never,
  save: (() => new Promise(() => {})) as never,
  releaseFinalized: (async () => ({ ok: true, deletedRevision: 1 })) as never,
};

interface ProbeApi {
  flush: () => Promise<InvoiceDraftFlushResult>;
  mutate: () => void;
}

let api: ProbeApi | null = null;

function Probe({ draft }: { draft: InvoiceDraft }) {
  const session = useInvoiceDraftDurabilitySession({
    locator: {
      sourceScopeKey: `workspace:${WORKSPACE}`,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'rechnung',
    },
    createDraft: () => draft,
    adapter: hangingAdapter,
  });
  const ref = useRef(session);
  ref.current = session;

  useEffect(() => {
    api = {
      flush: () => ref.current.flush(),
      mutate: () => ref.current.mutateDraft((prev) => ({ ...prev, introText: 'geändert' })),
    };
  });

  return <div data-testid="probe" data-status={session.status} />;
}

let container: HTMLDivElement;
let root: Root;

async function tick(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  api = null;
  hydrateVorgangStore([createTestVorgang({ id: VORGANG, invoices: [] })]);
  hydrateCompanyProfileStore({
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Betrieb GmbH',
    street: 'Werkstraße 2',
    zip: '54321',
    city: 'Betriebsstadt',
  });

  const draft = buildInvoiceDraftForType(VORGANG, DEFAULT_SETUP, 'rechnung');
  expect(draft, 'Entwurf konnte nicht gebaut werden').not.toBeNull();

  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<Probe draft={draft!} />);
    await Promise.resolve();
  });
  await tick();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('INVOICE-FINALIZE-HANG-01B — Wartevertrag des Flush', () => {
  it('F1: ein nie endender Speicherlauf führt nach der Frist zu `timeout`', async () => {
    expect(api, 'Probe nicht bereit').not.toBeNull();

    // Eine echte Änderung — sonst kürzt der Flush mit `no_changes` ab.
    await act(async () => {
      api!.mutate();
      await Promise.resolve();
    });

    let result: InvoiceDraftFlushResult | null = null;
    const pending = api!.flush().then((value) => {
      result = value;
    });

    // Vor Ablauf der Frist ist noch nichts entschieden.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(result).toBeNull();

    await act(async () => {
      await new Promise((done) => setTimeout(done, INVOICE_DRAFT_FLUSH_TIMEOUT_MS + 50));
      await pending;
    });

    expect(result).toEqual({ ok: false, outcome: 'timeout' });
  }, 30_000);

  /*
   * F2 — Waiter-Aufräumen: Nach der Frist darf ein später doch noch
   * eintreffender Speicherlauf denselben Aufrufer nicht ein zweites Mal
   * bedienen. Beobachtbar daran, dass genau ein Ergebnis ankommt.
   */
  it('F2: nach dem Timeout kommt kein zweites Ergebnis mehr an', async () => {
    expect(api).not.toBeNull();
    await act(async () => {
      api!.mutate();
      await Promise.resolve();
    });

    const results: InvoiceDraftFlushResult[] = [];
    const pending = api!.flush().then((value) => {
      results.push(value);
    });

    await act(async () => {
      await new Promise((done) => setTimeout(done, INVOICE_DRAFT_FLUSH_TIMEOUT_MS + 50));
      await pending;
    });
    await tick(10);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ok: false, outcome: 'timeout' });
  }, 30_000);

  /* F3 — ohne ausstehende Änderung bleibt der bisherige Kurzschluss. */
  it('F3: ohne Änderung antwortet der Flush sofort mit `no_changes`', async () => {
    expect(api).not.toBeNull();
    const result = await api!.flush();
    expect(result).toEqual({ ok: true, outcome: 'no_changes' });
  });
});
