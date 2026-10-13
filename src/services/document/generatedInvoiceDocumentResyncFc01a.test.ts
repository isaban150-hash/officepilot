/**
 * FINANZ-CORE-01A (STO-07) — das Archivdokument einer freigegebenen Rechnung
 * wird automatisch in die Cloud nachgeholt.
 *
 *  D1  gesendet wird nur, wozu die Cloud keine Zeile kennt — Grabsteine zählen als bekannt;
 *      Fremd-, Alt- und Korrekturbelege sowie Belege nicht freigegebener Rechnungen bleiben aussen vor
 *  D2  Abstand zwischen Läufen; Fehlschlag nach dem Abstand erneut, Konflikt in der Sitzung nicht
 *  D3  ohne erfolgreichen Abzug wird nichts gesendet
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyDocument } from '../../types/models';
import type { GeneratedInvoiceDocumentSyncOutcome } from '../invoiceArchiveService';
import {
  resetGeneratedInvoiceDocumentResyncForTests,
  resyncGeneratedInvoiceDocuments,
} from './generatedInvoiceDocumentCloudResyncService';
import type { WorkspaceDocumentRow } from './workspaceDocumentCloudService';

function beleg(id: string, invoiceId: string | undefined, overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id,
    title: id,
    category: 'ausgangsrechnung',
    classifiedKind: 'ausgangsrechnung',
    ...(invoiceId ? { linkedInvoiceId: invoiceId } : {}),
    ...overrides,
  } as CompanyDocument;
}

function zeile(invoiceId: string, deleted = false): WorkspaceDocumentRow {
  return {
    workspaceId: 'ws',
    clientDocumentId: `doc-cloud-${invoiceId}`,
    documentKind: 'generated_invoice',
    linkedInvoiceId: invoiceId,
    payload: {},
    createdAt: '2026-10-11T08:00:00.000Z',
    updatedAt: '2026-10-11T08:00:00.000Z',
    rowVersion: 1,
    ...(deleted ? { deletedAt: '2026-10-11T09:00:00.000Z' } : {}),
  };
}

const synced = (rows: WorkspaceDocumentRow[]) => async () => ({ outcome: 'synced' as const, rows });
const MIN = 60_000;

beforeEach(() => resetGeneratedInvoiceDocumentResyncForTests());
afterEach(() => resetGeneratedInvoiceDocumentResyncForTests());

describe('STO-07 — Archivdokumente nachholen', () => {
  it('D1: nur Fehlendes freigegebener Rechnungen; Grabstein, Fremd-, Alt- und Korrekturbeleg nicht', async () => {
    const push = vi.fn(async (): Promise<GeneratedInvoiceDocumentSyncOutcome> => 'synced');
    const report = await resyncGeneratedInvoiceDocuments({
      now: () => 0,
      documents: () => [
        beleg('doc-fehlt', 'inv-fehlt'),
        beleg('doc-da', 'inv-da'),
        beleg('doc-grab', 'inv-grab'),
        beleg('doc-entwurf', 'inv-entwurf'),
        beleg('doc-fremd', undefined),
        beleg('doc-alt', 'inv-alt', { classifiedKind: undefined }),
        beleg('doc-korr', 'inv-korr', { classifiedKind: 'rechnungskorrektur' }),
      ],
      isInvoiceFinalized: (id) => id !== 'inv-entwurf',
      pull: synced([zeile('inv-da'), zeile('inv-grab', true)]),
      push,
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-fehlt' }));
    expect(report).toEqual({ candidates: 1, synced: 1, failed: 0 });
  });

  it('D2: Abstand; Fehlschlag kommt nach dem Abstand wieder, ein Konflikt nicht', async () => {
    const outcomes: Record<string, GeneratedInvoiceDocumentSyncOutcome> = { 'doc-netz': 'failed', 'doc-konflikt': 'conflict' };
    const push = vi.fn(async (d: CompanyDocument): Promise<GeneratedInvoiceDocumentSyncOutcome> => outcomes[d.id]);
    const deps = {
      documents: () => [beleg('doc-netz', 'inv-netz'), beleg('doc-konflikt', 'inv-konflikt')],
      isInvoiceFinalized: () => true,
      pull: synced([]),
      push,
    };
    expect((await resyncGeneratedInvoiceDocuments({ ...deps, now: () => 0 })).failed).toBe(2);
    expect((await resyncGeneratedInvoiceDocuments({ ...deps, now: () => 1 * MIN })).skipped).toBe('throttled');
    outcomes['doc-netz'] = 'synced';
    const spaeter = await resyncGeneratedInvoiceDocuments({ ...deps, now: () => 11 * MIN });
    expect(spaeter).toEqual({ candidates: 1, synced: 1, failed: 0 });
    expect(push.mock.calls.filter(([d]) => d.id === 'doc-konflikt')).toHaveLength(1);
  });

  it('D3: ohne erfolgreichen Abzug wird nichts gesendet', async () => {
    const push = vi.fn(async (): Promise<GeneratedInvoiceDocumentSyncOutcome> => 'synced');
    const report = await resyncGeneratedInvoiceDocuments({
      now: () => 0,
      documents: () => [beleg('doc-1', 'inv-1')],
      isInvoiceFinalized: () => true,
      pull: async () => ({ outcome: 'failed' as const, detail: 'offline' }),
      push,
    });
    expect(report.skipped).toBe('pull_failed');
    expect(push).not.toHaveBeenCalled();
  });
});
