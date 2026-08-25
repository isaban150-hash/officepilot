/**
 * OFFICEPILOT-INVOICE-SENT-CLOUD-DURABILITY-04B1 — Versandwahrheit überlebt den Browser.
 *
 * `workspace_invoices` wird bei der Finalisierung mit `invoice_status = 'vorbereitet'`
 * angelegt. Alles danach — „Als versendet markieren“, `sentAt`, `sentVia` — lebte
 * bisher ausschließlich im `localStorage` der jeweiligen Origin. Ein Wechsel der
 * Adresse zeigte die Rechnung deshalb wieder als „Vorbereitet“.
 *
 * Geprüft wird hier nicht die lokale Persistenz, sondern der Roundtrip: schreiben,
 * den lokalen Zustand wegwerfen und die Rechnung ausschließlich aus dem
 * Cloud-Ergebnis wieder aufbauen.
 *
 * Zahlungen sind ausdrücklich nicht Gegenstand dieses Sprints.
 *
 * Neutrale Beispieldaten, kein Netzwerk — der Supabase-Client wird ersetzt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import {
  buildWorkspaceInvoiceFinalizePayload,
  mapWorkspaceInvoicePullRowToVorgangInvoice,
  parseWorkspaceInvoicePullRow,
  rpcUpdateWorkspaceInvoiceSent,
  WorkspaceInvoiceCloudError,
} from './workspaceInvoiceCloudService';
import { applyFinalizedInvoiceToVorgang, hydrateVorgangStore } from '../vorgangService';
import type { Vorgang, VorgangInvoice } from '../../types/models';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const VORGANG_ID = 'v-sent-cloud';
const INVOICE_ID = 'cinv-sent-cloud-1';

function buildFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0001',
    invoiceSequenceNumber: 1,
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Dachsanierung',
        quantity: 10,
        unit: 'm²',
        unitPrice: 100,
        lineTotal: 1000,
      },
    ],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'vorbereitet',
    date: '2026-08-24',
    issueDate: '2026-08-24',
    createdAt: '2026-08-24T10:00:00.000Z',
    paymentDueDate: '2026-09-07',
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as VorgangInvoice;
}

function seedVorgang(invoices: VorgangInvoice[]): Vorgang {
  const vorgang = {
    ...createTestVorgang({
      id: VORGANG_ID,
      status: 'beauftragt',
      customer: 'Beispiel Projektbau GmbH',
      orderPositions: [
        createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 100 }),
      ],
    }),
    invoices,
  } as Vorgang;
  hydrateVorgangStore([vorgang]);
  return vorgang;
}

/**
 * Die Cloud-Zeile, wie `pull_workspace_invoices` sie liefert. Der Payload wird
 * exakt so gebildet wie beim Finalisieren — ohne Versandfelder.
 */
function buildCloudRow(options: {
  status: VorgangInvoice['status'];
  payloadPatch?: Record<string, unknown>;
  rowVersion?: number;
  clientInvoiceId?: string;
}): Record<string, unknown> {
  const clientInvoiceId = options.clientInvoiceId ?? INVOICE_ID;
  const payload = {
    ...buildWorkspaceInvoiceFinalizePayload(buildFinalizedInvoice()),
    id: clientInvoiceId,
    number: '2026-0001',
    invoiceSequenceNumber: 1,
    status: options.status,
    ...(options.payloadPatch ?? {}),
  };
  return {
    id: 'row-1',
    workspace_id: WORKSPACE,
    vorgang_id: VORGANG_ID,
    client_invoice_id: clientInvoiceId,
    invoice_number: '2026-0001',
    invoice_year: 2026,
    invoice_sequence_number: 1,
    invoice_type: 'rechnung',
    invoice_status: options.status,
    payload,
    row_version: options.rowVersion ?? 1,
    updated_at: '2026-08-25T09:00:00.000Z',
  };
}

/** Ein Client ohne jeden lokalen Geschäftszustand — die neue Origin. */
function rebuildFromCloudOnly(row: Record<string, unknown>): VorgangInvoice {
  const parsed = parseWorkspaceInvoicePullRow(row);
  expect(parsed).not.toBeNull();
  const mapped = mapWorkspaceInvoicePullRowToVorgangInvoice(parsed!);

  hydrateVorgangStore([{ ...seedVorgang([]), invoices: [] } as Vorgang]);
  const empty = seedVorgang([]);
  const applied = applyFinalizedInvoiceToVorgang(empty, mapped.invoice);
  expect(applied.ok).toBe(true);
  if (!applied.ok || !applied.vorgang) throw new Error('Merge fehlgeschlagen');
  return applied.vorgang.invoices[0]!;
}

function stubRpc(handler: (name: string, args: Record<string, unknown>) => unknown) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
    data: handler(name, args),
    error: null,
  }));
  return { rpc } as never;
}

describe('OFFICEPILOT-INVOICE-SENT-CLOUD-DURABILITY-04B1', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('A: der Sent-RPC schreibt Status, sentAt und sentVia', async () => {
    let received: Record<string, unknown> | null = null;
    const client = stubRpc((name, args) => {
      expect(name).toBe('update_workspace_invoice_sent');
      received = args;
      return [
        buildCloudRow({
          status: 'versendet',
          payloadPatch: { sentAt: '2026-08-25', sentVia: 'email' },
          rowVersion: 2,
        }),
      ];
    });

    const result = await rpcUpdateWorkspaceInvoiceSent(
      {
        workspaceId: WORKSPACE,
        clientInvoiceId: INVOICE_ID,
        sentAt: '2026-08-25',
        sentVia: 'email',
      },
      { client },
    );

    // Identität ausschließlich über Workspace und Client-Kennung.
    expect(received).toEqual({
      p_workspace_id: WORKSPACE,
      p_client_invoice_id: INVOICE_ID,
      p_sent_at: '2026-08-25',
      p_sent_via: 'email',
      p_sent_note: null,
    });
    expect(result.invoice.status).toBe('versendet');
    expect(result.invoice.sentAt).toBe('2026-08-25');
    expect(result.invoice.sentVia).toBe('email');
    expect(result.rowVersion).toBe(2);
  });

  it('B: die neue Origin baut die Rechnung nur aus der Cloud korrekt auf', () => {
    const row = buildCloudRow({
      status: 'versendet',
      payloadPatch: { sentAt: '2026-08-25', sentVia: 'email' },
      rowVersion: 2,
    });

    const rebuilt = rebuildFromCloudOnly(row);

    expect(rebuilt.status).toBe('versendet');
    expect(rebuilt.sentAt).toBe('2026-08-25');
    expect(rebuilt.sentVia).toBe('email');
    // Die Rechnung selbst bleibt unverändert.
    expect(rebuilt.number).toBe('2026-0001');
    expect(rebuilt.amount).toBe(1190);
    expect(rebuilt.positions).toHaveLength(1);
  });

  it('C: ohne Versanddaten in der Cloud bleibt es beim vorbereiteten Stand', () => {
    const rebuilt = rebuildFromCloudOnly(buildCloudRow({ status: 'vorbereitet' }));

    expect(rebuilt.status).toBe('vorbereitet');
    expect(rebuilt.sentAt).toBeUndefined();
    expect(rebuilt.sentVia).toBeUndefined();
  });

  it('D: ein älterer Cloudstand stuft eine lokal versendete Rechnung nicht zurück', () => {
    const local = seedVorgang([
      buildFinalizedInvoice({ status: 'versendet', sentAt: '2026-08-25', sentVia: 'email' }),
    ]);
    const parsed = parseWorkspaceInvoicePullRow(buildCloudRow({ status: 'vorbereitet' }));
    const mapped = mapWorkspaceInvoicePullRowToVorgangInvoice(parsed!);

    const applied = applyFinalizedInvoiceToVorgang(local, mapped.invoice);
    expect(applied.ok).toBe(true);
    if (!applied.ok || !applied.vorgang) return;

    const invoice = applied.vorgang.invoices[0]!;
    expect(invoice.status).toBe('versendet');
    expect(invoice.sentAt).toBe('2026-08-25');
    expect(invoice.sentVia).toBe('email');
  });

  it('E: der Versand verändert den Finalisierungs-Fingerprint nicht', () => {
    const before = buildWorkspaceInvoiceFinalizePayload(buildFinalizedInvoice());
    const after = buildWorkspaceInvoiceFinalizePayload(
      buildFinalizedInvoice({ status: 'versendet', sentAt: '2026-08-25', sentVia: 'email' }),
    );

    // Der Inhalt der Rechnung ist derselbe — nur der Status unterscheidet sich,
    // und den vergibt ohnehin der Server.
    const { status: _s1, sentAt: _a1, sentVia: _v1, ...contentBefore } = before;
    const { status: _s2, sentAt: _a2, sentVia: _v2, ...contentAfter } = after;
    expect(contentAfter).toEqual(contentBefore);
  });

  /**
   * Der Client prüft `sentAt` nur auf die Form `YYYY-MM-DD`. Ein Datum wie
   * 2026-02-29 oder 2026-04-31 hat diese Form, existiert aber nicht — und auch
   * `Date.parse` lässt beide durch, weil JavaScript überrollt. Den Kalender
   * kennt allein PostgreSQL: Die Migration castet nach der Formatprüfung auf
   * `date` und weist mit `sent_at ungueltig` ab.
   *
   * Dieser Test hält den Vertrag der Grenze fest: Der Client reicht solche
   * Werte weiter, und die Ablehnung des Servers kommt als
   * `WorkspaceInvoiceCloudError` bei uns an — nicht als stiller Erfolg.
   */
  it('G: ein nicht existierendes Kalenderdatum wird vom Server abgewiesen', async () => {
    const forwarded: Record<string, unknown>[] = [];
    const client = {
      rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => {
        forwarded.push(args);
        return { data: null, error: { message: 'sent_at ungueltig' } };
      }),
    } as never;

    for (const invalid of ['2026-02-29', '2026-04-31']) {
      await expect(
        rpcUpdateWorkspaceInvoiceSent(
          {
            workspaceId: WORKSPACE,
            clientInvoiceId: INVOICE_ID,
            sentAt: invalid,
            sentVia: 'email',
          },
          { client },
        ),
      ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
    }

    // Beide passieren die Formprüfung des Clients — die Kalenderwahrheit
    // entscheidet der Server.
    expect(forwarded.map((args) => args.p_sent_at)).toEqual(['2026-02-29', '2026-04-31']);

    // Ein gültiges Schaltjahrsdatum wird dagegen nicht vom Client blockiert.
    const okClient = stubRpc(() => [
      buildCloudRow({
        status: 'versendet',
        payloadPatch: { sentAt: '2028-02-29', sentVia: 'email' },
        rowVersion: 2,
      }),
    ]);
    const leap = await rpcUpdateWorkspaceInvoiceSent(
      {
        workspaceId: WORKSPACE,
        clientInvoiceId: INVOICE_ID,
        sentAt: '2028-02-29',
        sentVia: 'email',
      },
      { client: okClient },
    );
    expect(leap.invoice.sentAt).toBe('2028-02-29');
  });

  it('H: ein formal falsches Datum lehnt bereits der Client ab', async () => {
    const client = stubRpc(() => []);

    await expect(
      rpcUpdateWorkspaceInvoiceSent(
        {
          workspaceId: WORKSPACE,
          clientInvoiceId: INVOICE_ID,
          sentAt: '2026-13-01',
          sentVia: 'email',
        },
        { client },
      ),
    ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
  });

  /**
   * 04B1U — die Antwort muss die Mutation beweisen.
   *
   * Auf dem Realgerät kam eine gültige, aber **unveränderte** Zeile zurück. Der
   * Wrapper prüfte nur den Workspace, meldete Erfolg — und zwei Sprints lang
   * blieb unsichtbar, dass die Cloud-Zeile nie geschrieben wurde.
   */
  describe('04B1U — strenger Antwortvertrag', () => {
    const input = {
      workspaceId: WORKSPACE,
      clientInvoiceId: INVOICE_ID,
      sentAt: '2026-08-25',
      sentVia: 'email' as const,
    };

    async function expectRejected(data: unknown): Promise<void> {
      const client = stubRpc(() => data);
      await expect(rpcUpdateWorkspaceInvoiceSent(input, { client })).rejects.toBeInstanceOf(
        WorkspaceInvoiceCloudError,
      );
    }

    it('U-A: eine leere Antwort ist kein Erfolg', async () => {
      await expectRejected([]);
    });

    it('U-B: keine Antwort ist kein Erfolg', async () => {
      await expectRejected(null);
    });

    it('U-C: eine fremde Rechnung ist kein Erfolg', async () => {
      await expectRejected([
        buildCloudRow({
          status: 'versendet',
          clientInvoiceId: 'cinv-jemand-anderes',
          payloadPatch: { sentAt: '2026-08-25', sentVia: 'email' },
        }),
      ]);
    });

    it('U-D: eine unverändert vorbereitete Zeile ist kein Erfolg', async () => {
      // Genau der Realfall: gültige Zeile, aber die Mutation blieb aus.
      await expectRejected([buildCloudRow({ status: 'vorbereitet' })]);
    });

    it('U-E: ein fehlendes oder abweichendes Versanddatum ist kein Erfolg', async () => {
      await expectRejected([
        buildCloudRow({ status: 'versendet', payloadPatch: { sentVia: 'email' } }),
      ]);
      await expectRejected([
        buildCloudRow({
          status: 'versendet',
          payloadPatch: { sentAt: '2026-08-24', sentVia: 'email' },
        }),
      ]);
    });

    it('U-F: ein fehlender oder abweichender Versandweg ist kein Erfolg', async () => {
      await expectRejected([
        buildCloudRow({ status: 'versendet', payloadPatch: { sentAt: '2026-08-25' } }),
      ]);
      await expectRejected([
        buildCloudRow({
          status: 'versendet',
          payloadPatch: { sentAt: '2026-08-25', sentVia: 'post' },
        }),
      ]);
    });

    it('U-G: mehr als eine Zeile ist kein Erfolg', async () => {
      const row = buildCloudRow({
        status: 'versendet',
        payloadPatch: { sentAt: '2026-08-25', sentVia: 'email' },
      });
      await expectRejected([row, row]);
    });

    it('U-H: sentNote null gilt nie als Erfolg', async () => {
      // Der Pull-Validator lehnt `null` ohnehin ab — der Wrapper darf es erst
      // recht nicht als gespeicherte Notiz durchgehen lassen.
      await expectRejected([
        buildCloudRow({
          status: 'versendet',
          payloadPatch: { sentAt: '2026-08-25', sentVia: 'email', sentNote: null },
        }),
      ]);
    });

    it('U-I: eine erwartete Notiz muss auch zurückkommen', async () => {
      const client = stubRpc(() => [
        buildCloudRow({
          status: 'versendet',
          payloadPatch: { sentAt: '2026-08-25', sentVia: 'email' },
        }),
      ]);
      await expect(
        rpcUpdateWorkspaceInvoiceSent({ ...input, sentNote: 'per Outlook' }, { client }),
      ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
    });

    it('U-J: die vollständig bewiesene Mutation ist ein Erfolg', async () => {
      const client = stubRpc(() => [
        buildCloudRow({
          status: 'versendet',
          payloadPatch: { sentAt: '2026-08-25', sentVia: 'email', sentNote: 'per Outlook' },
          rowVersion: 2,
        }),
      ]);
      const result = await rpcUpdateWorkspaceInvoiceSent(
        { ...input, sentNote: 'per Outlook' },
        { client },
      );
      expect(result.invoice.status).toBe('versendet');
      expect(result.invoice.sentAt).toBe('2026-08-25');
      expect(result.invoice.sentVia).toBe('email');
      expect(result.invoice.sentNote).toBe('per Outlook');
    });

    it('U-K: ohne Notiz darf der Schlüssel schlicht fehlen', async () => {
      const row = buildCloudRow({
        status: 'versendet',
        payloadPatch: { sentAt: '2026-08-25', sentVia: 'email' },
        rowVersion: 2,
      });
      const client = stubRpc(() => [row]);

      const result = await rpcUpdateWorkspaceInvoiceSent(input, { client });
      expect(result.invoice.sentNote).toBeUndefined();

      // Gegenprobe: derselbe Payload passiert den Pull-Parser (Aufgabe 11).
      const parsed = parseWorkspaceInvoicePullRow(row);
      expect(parsed).not.toBeNull();
      const mapped = mapWorkspaceInvoicePullRowToVorgangInvoice(parsed!);
      expect(mapped.invoice.status).toBe('versendet');
      expect(mapped.invoice.sentAt).toBe('2026-08-25');
      expect(mapped.invoice.sentVia).toBe('email');
      expect(mapped.invoice.sentNote).toBeUndefined();
    });
  });

  it('F: zweimal dasselbe Versanddatum ergibt denselben Zustand', async () => {
    const client = stubRpc(() => [
      buildCloudRow({
        status: 'versendet',
        payloadPatch: { sentAt: '2026-08-25', sentVia: 'email' },
        rowVersion: 2,
      }),
    ]);
    const input = {
      workspaceId: WORKSPACE,
      clientInvoiceId: INVOICE_ID,
      sentAt: '2026-08-25',
      sentVia: 'email' as const,
    };

    const first = await rpcUpdateWorkspaceInvoiceSent(input, { client });
    const second = await rpcUpdateWorkspaceInvoiceSent(input, { client });

    expect(second.invoice.id).toBe(first.invoice.id);
    expect(second.invoice.number).toBe(first.invoice.number);
    expect(second.invoice.status).toBe('versendet');
    expect(second.invoice.sentAt).toBe(first.invoice.sentAt);
  });
});
