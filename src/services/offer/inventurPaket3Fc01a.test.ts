/**
 * FINANZ-CORE-01A — Gesamtnacharbeit Paket 3 (WEISS-Gesamtmängelinventur vom 15.10.2026): Rechnungskanon
 * und Angebotskette. Der Server prüft dieselben Fälle in `supabase/tests/fc01a_inventur_paket3.sql`.
 *
 *  K   INV-06/07: Centvertrag der gespeicherten Positionen sperrt Druck, PDF und E-Rechnung eines
 *      unstimmigen Belegs (WEISS I04/I08); Serverabweisungen benannt; der strenge Cloud-Leser bleibt streng
 *  A   INV-10: der Kunde des Angebots vollständig gelesen; die verlustbehaftete Kopie (WEISS AN-2026-0006)
 *      wird beim Abgleich ohne Konflikt durch den Serverbeleg ersetzt, ihr Archivverweis gezielt erneut
 *      gesendet; die Änderung an einem freigegebenen Angebot bleibt endgültig abgewiesen
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { hasInconsistentInvoicePositions, validateFinalizedInvoiceForPdf } from '../invoiceValidationService';
import { serverRejectionMessageKey } from '../invoice/invoiceApprovalUx';
import { validateWorkspaceInvoiceCloudPayload } from '../invoice/workspaceInvoiceCloudPayloadValidator';
import {
  buildOfferCloudContentKey,
  isLossyFinalizedOfferCopy,
  mergeOffersFromPull,
  offerFromCloud,
  parseOfferCloudPayload,
  stripOfferForCloud,
  type WorkspaceOfferRow,
} from './offerCloudService';
import { getOfferStoreSnapshot, hydrateOffers } from './offerService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { isFinalBusinessRejectionMessage } from '../sync/syncRoleDenial';
import { mapSyncErrorReason } from '../sync/syncOutboxDescriptionService';
import { t } from '../../i18n';
import type { Offer } from '../../types/offer';
import type { VorgangInvoice } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

const WORKSPACE = '37e64576-f224-4fa9-a145-9b74ecad7154';
const DEVICE = 'device-inventur-3';
const OFFER_ID = 'offer-1722b556-c7ef-4cfe-a540-24a0e6f3bf03';

function rechnung(positions: VorgangInvoice['positions'], subtotal: number, amount: number): VorgangInvoice {
  return {
    id: 'wi-inv', number: 'WEISS-INVENTUR-01', type: 'rechnung', positions, subtotal, amount, taxStatus: 'standard_19',
    status: 'versendet', date: '2026-05-25', issueDate: '2026-05-25', createdAt: '2026-05-25T08:00:00Z', paymentDueDate: '2026-06-08',
    customerId: 'wi-cust', customerSnapshot: { name: 'WEISS Testkunde', contactPerson: '', street: 'Testweg 1', zip: '48431', city: 'Rheine', email: '', phone: '', countryCode: 'DE' },
    servicePeriodFrom: '2026-05-25', servicePeriodTo: '2026-05-25', servicePeriodConfirmed: true,
    companySnapshot: {
      ...DEFAULT_COMPANY_PROFILE, companyName: 'WEISS Testbetrieb', legalForm: 'GmbH', street: 'Werkweg 1', zip: '33100', city: 'Paderborn',
      countryCode: 'DE', email: 'weiss@example.invalid', taxNumber: '11/222/33333', vatId: 'DE111111111', iban: 'DE89370400440532013000',
    },
    legalNotices: [], payments: [],
  } as VorgangInvoice;
}

describe('K — INV-06/07 Centvertrag der gespeicherten Positionen', () => {
  it('K1 WEISS I04: 10 × 0,045 = 0,45 lässt sich nicht nachrechnen; 10 × 0,05 = 0,50 schon', () => {
    const untercent = rechnung([{ id: 'p1', description: 'Kleinteile', quantity: 10, unit: 'Stück', unitPrice: 0.045, lineTotal: 0.45 }], 0.45, 0.54);
    const cent = rechnung([{ id: 'p1', description: 'Kleinteile', quantity: 10, unit: 'Stück', unitPrice: 0.05, lineTotal: 0.5 }], 0.5, 0.6);
    expect(hasInconsistentInvoicePositions(untercent)).toBe(true);
    expect(hasInconsistentInvoicePositions(cent)).toBe(false);
    expect(hasInconsistentInvoicePositions({ positions: [{ id: 'p', description: 'x', quantity: 1, unit: 'Stück', unitPrice: 1 } as never], subtotal: 1 })).toBe(true);
    expect(hasInconsistentInvoicePositions({ positions: [{ id: 'p', description: 'x', quantity: 2, unit: 'Stück', unitPrice: 1, lineTotal: 2 }], subtotal: 3 })).toBe(true);
    expect(hasInconsistentInvoicePositions({ positions: [], subtotal: 400 })).toBe(false);
  });

  it('K2 WEISS I08: das Ausgabegate (PDF, Druck, E-Rechnung) sperrt den unstimmigen Beleg, nicht den stimmigen', () => {
    const untercent = rechnung([{ id: 'p1', description: 'Kleinteile', quantity: 10, unit: 'Stück', unitPrice: 0.045, lineTotal: 0.45 }], 0.45, 0.54);
    expect(validateFinalizedInvoiceForPdf(untercent).blockingErrors.map((e) => e.code)).toEqual(['positions_inconsistent']);
    // Die Positionssperre kommt hinzu, sie verdeckt keine spezifischere Sperre (zugferd 04e3 T27e).
    const cent = rechnung([{ id: 'p1', description: 'Kleinteile', quantity: 10, unit: 'Stück', unitPrice: 0.05, lineTotal: 0.5 }], 0.5, 0.6);
    expect(validateFinalizedInvoiceForPdf(cent).blockingErrors.map((e) => e.code)).not.toContain('positions_inconsistent');
    expect(t('invoice.pdf.positionsInconsistent')).toContain('Rechnungskorrektur');
  });

  it('K3 Serverabweisungen vor der Nummernvergabe sind benannt', () => {
    expect(serverRejectionMessageKey('ERROR: invoice_unit_price_precision: Position 1 hat Einzelpreis 0.045')).toBe('invoice.approve.unitPricePrecision');
    expect(serverRejectionMessageKey('ERROR: invoice_line_total_missing: Position 1 ohne Zeilenbetrag')).toBe('invoice.approve.lineTotalMissing');
    expect(t('invoice.approve.unitPricePrecision')).toContain('keine Nummer vergeben');
  });

  it('K4 der strenge Cloud-Leser bleibt streng (WEISS I05): keine Position ohne Zeilenbetrag', () => {
    const payload = {
      id: 'iv-missing-line', number: '2026-0007', type: 'rechnung', status: 'vorbereitet', invoiceSequenceNumber: 7,
      positions: [{ id: 'p1', unit: 'Stück', quantity: 1, unitPrice: 1, description: 'Testleistung' }],
      subtotal: 1, amount: 1.19, taxStatus: 'standard_19', date: '2026-09-23', issueDate: '2026-09-23', createdAt: '2026-09-23T08:00:00Z',
    };
    expect(validateWorkspaceInvoiceCloudPayload(payload)).toMatchObject({ ok: false, detail: 'payload.positions[0].lineTotal:not_finite' });
  });
});

/** Die Serverzeile von AN-2026-0006 (WEISS-Inventur-App-Angebot-Zustand.json, gekürzt auf den Beleg). */
function serverPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OFFER_ID,
    title: 'WEISS INVENTUR 20261015 Finanzkette',
    status: 'freigegeben',
    totals: { tax: 190, total: 1190, taxRate: 19, subtotal: 1000 },
    customer: {
      zip: '33100', city: 'Paderborn', name: 'WEISS INVENTUR 20261015 Testkunde', email: 'weiss-inventur@example.invalid',
      phone: '', street: 'Testweg 15', countryCode: 'DE', contactPerson: '',
    },
    baustelle: '', createdAt: '2026-10-15T09:26:09.015Z', introText: '', offerDate: '2026-10-15',
    positions: [{ id: 'offer-pos-f4a158ff', unit: 'Stück', quantity: 1, unitPrice: 1000, description: 'Synthetische Testleistung, kein realer Auftrag' }],
    taxStatus: 'standard_19', customerId: 'cust-23d2c8ef-1ba4-4960-88d7-cb59caa27a1e', validUntil: '2026-11-14', closingText: '',
    finalizedAt: '2026-10-15T09:26:09.920Z', offerNumber: 'AN-2026-0006', offerSequenceNumber: 6, workspaceId: WORKSPACE,
    legalNotices: [], paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.', contentFingerprint: 'fp-weiss',
    ...extra,
  };
}

function row(payload: Record<string, unknown>, rowVersion = 2): WorkspaceOfferRow {
  return {
    workspace_id: WORKSPACE, client_offer_id: OFFER_ID, client_customer_id: 'cust-23d2c8ef-1ba4-4960-88d7-cb59caa27a1e',
    offer_number: 'AN-2026-0006', offer_sequence_number: 6, status: 'freigegeben', payload, row_version: rowVersion,
    deleted: false, deleted_at: null, updated_at: '2026-10-15T09:26:10.000Z',
  };
}

/** Der lokale Stand im WEISS-Browser: mit dem alten Leser ohne Land gelesen, Archivverweis lokal gesetzt. */
function verlustbehaftet(): Offer {
  const geparst = parseOfferCloudPayload(serverPayload())!;
  const { countryCode: _weg, ...ohneLand } = geparst.customer as unknown as Record<string, string>;
  return {
    ...offerFromCloud(OFFER_ID, { ...geparst, customer: ohneLand as never }, 2, '2026-10-15T09:26:10.000Z', false, DEVICE, WORKSPACE),
    archiveDocumentId: `offer-archive-${OFFER_ID}`,
  };
}

describe('A — INV-10 Angebotskette', () => {
  beforeEach(() => {
    resetTestStores();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE, serverWorkspaceId: WORKSPACE });
  });
  afterEach(() => vi.restoreAllMocks());

  it('A1 der Kunde wird vollständig gelesen; Hin- und Rückweg ergeben denselben Beleg', () => {
    const vier = serverPayload({
      customer: { ...(serverPayload().customer as object), vatId: 'DE123456789', buyerReference: 'REF-1', leitwegId: '04011000-12345-67' },
    });
    const geparst = parseOfferCloudPayload(vier)!;
    expect(geparst.customer).toMatchObject({ countryCode: 'DE', vatId: 'DE123456789', buyerReference: 'REF-1', leitwegId: '04011000-12345-67' });
    const offer = offerFromCloud(OFFER_ID, geparst, 2, '2026-10-15T09:26:10.000Z', false, DEVICE, WORKSPACE);
    expect(stripOfferForCloud(offer).customer).toEqual(vier.customer);
  });

  it('A2 verlustbehaftete Kopie erkannt — nur bei fehlenden, nie bei abweichenden Feldern oder anderem Inhalt', () => {
    const remote = offerFromCloud(OFFER_ID, parseOfferCloudPayload(serverPayload())!, 2, '2026-10-15T09:26:10.000Z', false, DEVICE, WORKSPACE);
    expect(isLossyFinalizedOfferCopy(verlustbehaftet(), remote)).toBe(true);
    expect(isLossyFinalizedOfferCopy({ ...verlustbehaftet(), customer: { ...remote.customer, countryCode: 'AT' } }, remote)).toBe(false);
    expect(isLossyFinalizedOfferCopy({ ...verlustbehaftet(), title: 'anders' }, remote)).toBe(false);
    expect(isLossyFinalizedOfferCopy(remote, remote)).toBe(false);
  });

  it('A3 Abgleich: kein Konflikt, Serverbeleg gilt, Archivverweis bleibt und wird erneut gesendet', () => {
    const lokal = verlustbehaftet();
    const ergebnis = mergeOffersFromPull([lokal], [row(serverPayload())], DEVICE, WORKSPACE, new Set([OFFER_ID]));
    expect(ergebnis.conflicts).toEqual([]);
    expect(ergebnis.archiveRelink).toEqual([OFFER_ID]);
    const repariert = ergebnis.offers[0]!;
    expect(repariert.customer.countryCode).toBe('DE');
    expect(repariert.archiveDocumentId).toBe(`offer-archive-${OFFER_ID}`);
    expect(repariert.offerNumber).toBe('AN-2026-0006');
    // Der Push enthält jetzt genau den Serverbeleg plus den zulässigen Archivverweis.
    expect(buildOfferCloudContentKey({ ...repariert, archiveDocumentId: undefined })).toBe(
      buildOfferCloudContentKey(offerFromCloud(OFFER_ID, parseOfferCloudPayload(serverPayload())!, 2, '', false, DEVICE, WORKSPACE)),
    );
  });

  it('A4 Wiederanlauf über den echten Abgleich: endgültig abgewiesener Altauftrag wird gezielt abgelöst, keine neue Nummer', () => {
    hydrateOffers([verlustbehaftet()]);
    const abgewiesen: SyncOutboxEntry = {
      id: 'out-offer-alt', entityType: 'offer', entityId: OFFER_ID, operation: 'update', version: 2, queuedAt: '2026-10-15T09:27:00.000Z',
      retryCount: 3, status: 'failed', lastErrorMessage: 'Angebot ist freigegeben und kann nicht mehr geaendert werden', lastErrorRetryable: false,
    };
    resetSyncOutboxForTests([abgewiesen]);
    const pull = {
      workspace: null, members: [], settings: null, setupPayload: null, setupRowVersion: 0, setupUpdatedAt: null,
      companyProfilePayload: null, companyProfileRowVersion: 0, companyProfileUpdatedAt: null, vorgaenge: [], customers: [],
      offers: [row(serverPayload())],
    } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
    const { state, conflicts } = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pull);
    expect(conflicts.filter((c) => c.includes(OFFER_ID))).toEqual([]);
    const offer = (state.offers ?? []).find((o) => o.id === OFFER_ID)!;
    expect(offer.customer.countryCode).toBe('DE');
    expect(offer.archiveDocumentId).toBe(`offer-archive-${OFFER_ID}`);
    const auftraege = getSyncOutboxSnapshot().filter((e) => e.entityType === 'offer' && e.entityId === OFFER_ID);
    expect(auftraege.filter((e) => e.status === 'pending')).toHaveLength(1);
    expect(auftraege.find((e) => e.id === 'out-offer-alt')?.status).not.toBe('failed');
    expect(getOfferStoreSnapshot().length).toBeLessThanOrEqual(1);
  });

  it('A5 ohne Archivverweis: Serverbeleg übernommen, nichts erneut gesendet', () => {
    const { archiveDocumentId: _a, ...ohneArchiv } = verlustbehaftet();
    const ergebnis = mergeOffersFromPull([ohneArchiv as Offer], [row(serverPayload())], DEVICE, WORKSPACE);
    expect(ergebnis.conflicts).toEqual([]);
    expect(ergebnis.archiveRelink).toEqual([]);
    expect(ergebnis.offers[0]!.customer.countryCode).toBe('DE');
  });

  it('A6 eine Änderung am freigegebenen Beleg bleibt endgültig abgewiesen, mit eigenem Grund', () => {
    const meldung = 'Angebot ist freigegeben und kann nicht mehr geaendert werden';
    expect(isFinalBusinessRejectionMessage(meldung)).toBe(true);
    expect(mapSyncErrorReason(meldung, 'failed')).toBe('sync.failure.reason.offerFrozen');
  });
});
