/**
 * FINANZ-CORE-01A — STO-Reste.
 *
 *  S6a  eine Stornoantwort, die die strenge Zeilenprüfung ablehnt, zählt über ihre Stornospalten
 *  S6b  nach einem Netzabbruch liest der Dienst einmal nach — hat die Cloud storniert, gilt das lokal
 *  S6c  bleibt das Nachlesen ohne Storno, bleibt der Ausgang unklar („offline"), lokal nichts storniert
 *  S6d  ein Archivfehler nach erfolgtem Storno ist kein Fehlschlag (correctionArchivePending)
 *  S16  der Nachdruck eines stornierten Originals trägt den Vermerk; der Korrekturbeleg nicht
 *  S18  ein Altstorno ohne Art erscheint in der Monatsmappe nicht als „intern"
 *
 * Synthetische Daten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAbschlagInvoice, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { InvoicePrintModel, VorgangInvoice } from '../../types/models';
import { getVorgangInvoice, hydrateVorgangStore } from '../vorgangService';
import * as cloudService from './workspaceInvoiceCloudService';
import * as invoiceSent from '../invoiceSentService';
import * as documentService from '../documentService';
import { cancelFinalizedInvoice } from './invoiceCancellationService';
import { cancellationNoticeLines, withCancellationNotice } from '../invoicePdfService';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';

const VORGANG = 'v-sto-rest';
const WS = '00000000-0000-4000-8000-0000000fc0c1';

const rechnung = createAbschlagInvoice('op-test-1', 2, {
  id: 'inv-sto',
  number: '2026-0021',
  type: 'rechnung',
  abschlagNumber: undefined,
  status: 'vorbereitet',
});

function seed(invoices: VorgangInvoice[]): void {
  hydrateVorgangStore([createTestVorgang({ id: VORGANG, invoices })]);
}

async function storno() {
  return cancelFinalizedInvoice({
    vorgangId: VORGANG,
    invoiceId: 'inv-sto',
    reason: 'Doppelt erstellt',
    actor: { userId: 'u-1', cloudConfigured: true },
  });
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('STO-06 — unklarer Ausgang', () => {
  it('S6a: die Stornospalten entscheiden, auch wenn die Vollzeile unlesbar ist', async () => {
    const client = {
      rpc: vi.fn(async () => ({
        data: [
          {
            workspace_id: WS,
            client_invoice_id: 'inv-sto',
            cancelled_at: '2026-10-10T08:00:00.000Z',
            cancel_reason: 'Doppelt erstellt',
            cancellation_kind: 'correction',
            correction_document_id: 'corr-inv-sto',
            correction_number: '2026-0030',
          },
        ],
        error: null,
      })),
    } as unknown as SupabaseClient;
    const r = await cloudService.rpcCancelWorkspaceInvoice({ workspaceId: WS, clientInvoiceId: 'inv-sto', reason: 'Doppelt erstellt' }, client);
    expect(r.invoice).toEqual({
      cancelledAt: '2026-10-10T08:00:00.000Z',
      cancelReason: 'Doppelt erstellt',
      cancellationKind: 'correction',
      correctionDocumentId: 'corr-inv-sto',
      correctionNumber: '2026-0030',
    });

    // Eine fremde Zeile zählt nie.
    const fremd = {
      rpc: vi.fn(async () => ({ data: [{ workspace_id: 'anderer', client_invoice_id: 'inv-sto', cancelled_at: '2026-10-10T08:00:00.000Z' }], error: null })),
    } as unknown as SupabaseClient;
    await expect(
      cloudService.rpcCancelWorkspaceInvoice({ workspaceId: WS, clientInvoiceId: 'inv-sto', reason: 'x' }, fremd),
    ).rejects.toThrow('Ungültige Server-Antwort');
  });

  it('S6b: nach einem Netzabbruch einmal nachlesen — storniert in der Cloud heisst storniert', async () => {
    seed([rechnung]);
    vi.spyOn(cloudService, 'rpcCancelWorkspaceInvoice').mockRejectedValue(
      new cloudService.WorkspaceInvoiceCloudError('Failed to fetch', 'network', true),
    );
    const lesen = vi.spyOn(cloudService, 'readWorkspaceInvoiceCancelFacts').mockResolvedValue({
      cancelledAt: '2026-10-10T08:00:00.000Z',
      cancelReason: 'Doppelt erstellt',
      cancellationKind: 'internal',
    });
    const r = await storno();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(lesen).toHaveBeenCalledTimes(1);
    expect(getVorgangInvoice(VORGANG, 'inv-sto')?.cancelledAt).toBe('2026-10-10T08:00:00.000Z');
  });

  it('S6c: ohne Storno in der Cloud bleibt der Ausgang unklar; lokal nichts storniert', async () => {
    seed([rechnung]);
    vi.spyOn(cloudService, 'rpcCancelWorkspaceInvoice').mockRejectedValue(
      new cloudService.WorkspaceInvoiceCloudError('Failed to fetch', 'network', true),
    );
    vi.spyOn(cloudService, 'readWorkspaceInvoiceCancelFacts').mockResolvedValue(null);
    const r = await storno();
    expect(r).toMatchObject({ ok: false, reason: 'offline' });
    expect(getVorgangInvoice(VORGANG, 'inv-sto')?.cancelledAt).toBeUndefined();
  });

  it('S6c: eine fachliche Ablehnung wird nicht nachgelesen', async () => {
    seed([rechnung]);
    vi.spyOn(cloudService, 'rpcCancelWorkspaceInvoice').mockRejectedValue(
      new cloudService.WorkspaceInvoiceCloudError('invoice_cancel_has_active_payments', 'cancel_has_active_payments', false),
    );
    const lesen = vi.spyOn(cloudService, 'readWorkspaceInvoiceCancelFacts');
    expect(await storno()).toMatchObject({ ok: false, reason: 'has_active_payments' });
    expect(lesen).not.toHaveBeenCalled();
  });

  it('S6d: Archivfehler nach erfolgtem Storno — storniert, Korrekturbeleg folgt mit dem Abgleich', async () => {
    const versendet = { ...rechnung, status: 'versendet' as const, sentAt: '2026-10-02', sentVia: 'email' as const };
    seed([versendet]);
    vi.spyOn(invoiceSent, 'readInvoiceSentStateFromCloud').mockResolvedValue({ kind: 'synced' });
    vi.spyOn(cloudService, 'rpcCancelWorkspaceInvoice').mockResolvedValue({
      invoice: {
        cancelledAt: '2026-10-10T08:00:00.000Z',
        cancelReason: 'Doppelt erstellt',
        cancellationKind: 'correction',
        correctionDocumentId: 'corr-inv-sto',
        correctionNumber: '2026-0030',
      },
    });
    vi.spyOn(documentService, 'commitDocumentStoreMerge').mockReturnValue(false);
    const r = await storno();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.correctionArchivePending).toBe(true);
    expect(getVorgangInvoice(VORGANG, 'inv-sto')?.cancellationKind).toBe('correction');
  });
});

describe('STO-16 — Stornovermerk auf dem Nachdruck', () => {
  const modell = { documentTitle: 'Rechnung', invoiceNumber: '2026-0021' } as InvoicePrintModel;

  it('S16: ein storniertes Original bekommt den Vermerk, ein nicht storniertes nicht', () => {
    const storniert = withCancellationNotice(modell, {
      ...rechnung,
      cancelledAt: '2026-10-10T08:00:00.000Z',
      cancellationKind: 'correction',
      correctionNumber: '2026-0030',
    });
    expect(storniert.cancellationNotice).toEqual({ cancelledAt: '2026-10-10T08:00:00.000Z', kind: 'correction', correctionNumber: '2026-0030' });
    expect(cancellationNoticeLines(storniert.cancellationNotice!)).toEqual([
      'STORNIERT am 10.10.2026 – berichtigt durch Korrekturbeleg 2026-0030',
      'Diese Rechnung ist nicht mehr gültig und nicht zu bezahlen.',
    ]);
    expect(withCancellationNotice(modell, rechnung).cancellationNotice).toBeUndefined();
    // Intern storniert: ohne Korrekturbeleg-Hinweis.
    const intern = withCancellationNotice(modell, { ...rechnung, cancelledAt: '2026-10-10T08:00:00.000Z', cancellationKind: 'internal' });
    expect(cancellationNoticeLines(intern.cancellationNotice!)[0]).toBe('STORNIERT am 10.10.2026');
  });

  it('S16: der Korrekturbeleg selbst trägt keinen Stornovermerk', () => {
    const korrektur = { ...modell, correction: { correctionNumber: '2026-0030' } } as unknown as InvoicePrintModel;
    expect(withCancellationNotice(korrektur, { ...rechnung, cancelledAt: '2026-10-10T08:00:00.000Z' }).cancellationNotice).toBeUndefined();
  });
});

describe('STO-18 — Altstorno ohne Art', () => {
  it('S18: nicht als „intern" ausgegeben', () => {
    const alt = { ...rechnung, status: 'versendet' as const, issueDate: '2026-09-02', date: '2026-09-02', cancelledAt: '2026-09-20T10:00:00.000Z', cancelReason: 'Alt' };
    const model = buildMonatsmappeModel({
      monthKey: '2026-09',
      invoices: [{ invoice: alt, vorgangId: null }],
      expenses: [],
      documents: [],
      inboxItems: [],
      fileRefs: [],
    } as never);
    expect(model.stornos[0]?.hinweis).toContain('Art nicht erfasst');
    expect(model.stornos[0]?.hinweis).not.toContain('Interner Storno');
  });
});
