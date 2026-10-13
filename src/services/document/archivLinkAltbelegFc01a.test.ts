/**
 * FINANZ-CORE-01A (STO-08) — der Archivverweis eines erzeugten Altbelegs ohne
 * Belegart flattert nicht mehr.
 *
 *  L1  ein Altbeleg (Kategorie Ausgangsrechnung, Rechnungsverknüpfung, ohne Belegart) ist das Archivdokument
 *  L2  ein Beleg mit Belegart geht dem Altbeleg vor; Korrektur- und Fremdbelege zählen nicht
 *  L3  der Abgleich behält den Verweis der Rechnung, statt ihn zu löschen
 *  L4  die Cloud-Eignung bleibt streng: der Altbeleg reist weiterhin nicht
 */
import { describe, expect, it } from 'vitest';
import type { CompanyDocument, VorgangInvoice } from '../../types/models';
import {
  buildArchiveDocumentIdByInvoice,
  isCloudEligibleGeneratedInvoiceDocument,
  reconcileArchiveLinksOnInvoices,
} from './documentCloudPullOrchestrator';

function beleg(id: string, overrides: Partial<CompanyDocument>): CompanyDocument {
  return { id, title: id, category: 'ausgangsrechnung', ...overrides } as CompanyDocument;
}

const altbeleg = beleg('doc-alt', { linkedInvoiceId: 'inv-1' });
const neuerBeleg = beleg('doc-neu', { linkedInvoiceId: 'inv-1', classifiedKind: 'ausgangsrechnung' });
const korrektur = beleg('doc-korr', { linkedInvoiceId: 'inv-2', classifiedKind: 'rechnungskorrektur' });
const fremd = beleg('doc-fremd', {});

describe('STO-08 — Archivverweis alter Belege', () => {
  it('L1/L2: Altbeleg zählt, Belegart geht vor, Korrektur und Fremdbeleg nicht', () => {
    expect([...buildArchiveDocumentIdByInvoice([altbeleg, korrektur, fremd])]).toEqual([['inv-1', 'doc-alt']]);
    expect(buildArchiveDocumentIdByInvoice([neuerBeleg, altbeleg]).get('inv-1')).toBe('doc-neu');
    expect(buildArchiveDocumentIdByInvoice([altbeleg, neuerBeleg]).get('inv-1')).toBe('doc-neu');
  });

  it('L3: der Abgleich behält den Verweis', () => {
    const invoice = { id: 'inv-1', archiveDocumentId: 'doc-alt' } as VorgangInvoice;
    const result = reconcileArchiveLinksOnInvoices([invoice], buildArchiveDocumentIdByInvoice([altbeleg]));
    expect(result.changed).toBe(0);
    expect(result.invoices[0]?.archiveDocumentId).toBe('doc-alt');
  });

  it('L4: die Cloud-Eignung bleibt streng', () => {
    expect(isCloudEligibleGeneratedInvoiceDocument(altbeleg)).toBe(false);
    expect(isCloudEligibleGeneratedInvoiceDocument(neuerBeleg)).toBe(true);
  });
});
