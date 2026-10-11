/**
 * GO-LIVE-SECURITY-01 / ABSCHLUSS — die E-Rechnung hängt nur am erzeugten Rechnungsbeleg.
 *
 * `getDocumentByLinkedInvoiceId` fiel ohne Beleg auf jedes Dokument mit Rechnungsbezug zurück.
 * Die E-Rechnungsdienste nutzen jetzt `getGeneratedInvoiceDocument`: nie ein Archivdokument aus
 * dem Eingang (dessen strukturierte Fassung wäre fremdes XML), Altbelege ohne `classifiedKind`
 * weiterhin, der neue Beleg mit Vorrang, kein Korrekturbeleg.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { getDocumentByLinkedInvoiceId, getGeneratedInvoiceDocument, hydrateDocumentStore } from '../documentService';
import type { CompanyDocument } from '../../types/models';

const INV = 'inv-beleg-1';

function dok(id: string, o: Partial<CompanyDocument>): CompanyDocument {
  return {
    id,
    title: id,
    createdAt: '2026-10-01T08:00:00.000Z',
    tags: [],
    digitalFolder: { id: 'f', name: 'f', path: '/f/' },
    linkedInvoiceId: INV,
    ...o,
  } as unknown as CompanyDocument;
}

const eingang = dok('doc-eingang', { category: 'eingangsrechnung', classifiedKind: 'eingangsrechnung' } as never);
const altbeleg = dok('doc-alt', { category: 'ausgangsrechnung' } as never);
const beleg = dok('doc-neu', { category: 'ausgangsrechnung', classifiedKind: 'ausgangsrechnung' } as never);
const korrektur = dok('corr-inv-beleg-1', { category: 'ausgangsrechnung', classifiedKind: 'rechnungskorrektur' } as never);

describe('GLS01 Abschluss — erzeugter Rechnungsbeleg für die E-Rechnung', () => {
  beforeEach(() => resetTestStores());
  afterEach(() => resetTestStores());

  it('B1: ein Archivdokument mit Rechnungsbezug ist nie der Beleg (der alte Weg fiel darauf zurück)', () => {
    hydrateDocumentStore([eingang] as never);
    expect(getGeneratedInvoiceDocument(INV)).toBeUndefined();
    expect(getDocumentByLinkedInvoiceId(INV)?.id).toBe('doc-eingang');
  });

  it('B2: ein Altbeleg ohne classifiedKind gilt weiterhin, der neue Beleg hat Vorrang', () => {
    hydrateDocumentStore([eingang, altbeleg] as never);
    expect(getGeneratedInvoiceDocument(INV)?.id).toBe('doc-alt');
    hydrateDocumentStore([eingang, altbeleg, beleg] as never);
    expect(getGeneratedInvoiceDocument(INV)?.id).toBe('doc-neu');
  });

  it('B3: der Korrekturbeleg zählt nicht als Rechnungsbeleg', () => {
    hydrateDocumentStore([korrektur] as never);
    expect(getGeneratedInvoiceDocument(INV)).toBeUndefined();
  });
});
