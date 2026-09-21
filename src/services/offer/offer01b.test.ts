/**
 * ANGEBOT-01B — gezielte Prüfungen der neuen Fachlogik.
 *
 * A  Summen: Angebot und Rechnung rechnen aus derselben Basis.
 * B  Entwurf: anlegen, ändern, Freigabekandidat und Blocker.
 * C  Freigabe über die (gemockte) Server-RPC: Nummer vom Server, Freeze,
 *    Wiederholung ohne zweite Nummer, keine Änderung danach.
 * D  Status: nur erlaubte Übergänge.
 * E  Cloud-Transport: Payload ↔ Zeile, Inhaltsschlüssel, Merge, Altbestand.
 * F  Druckmodell: Angebotskontext ohne Leistungszeitraum/Fälligkeit;
 *    Rechnungsmodell unverändert ohne `offer`.
 * G  Ablage: Archivdokument mit `angebot`, gebundener PDF-Datei, idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InvoiceDraft } from '../../types/models';
import type { Offer } from '../../types/offer';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { calculateInvoiceTotals } from '../invoiceService';
import { resetSyncClientForTests } from '../sync/syncClientService';
import { hydrateSyncOutbox } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { clearMockRpcHandlers, registerMockRpcHandler } from '../../test/mockProfileStore';
import { isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';
import { getAllDocuments, resetDocuments } from '../documentService';
import { resetDocumentBlobDatabaseForTests } from '../storage/documentBlobIndexedDbService';
import { getDocumentFileRefById } from '../documentFileStoreService';
import { hydrateWorkspaceStore, resetWorkspaceStore } from '../workspace/workspaceStore';
import {
  getOfferStoreSnapshot,
  setOfferStoreForTests,
  addOfferDraft,
  buildOfferFinalizationCandidate,
  canTransitionOfferStatus,
  computeOfferTotals,
  getOfferById,
  isOfferExpired,
  markOfferSent,
  rejectOffer,
  resetOffers,
  updateOfferDraft,
  cancelOffer,
} from './offerService';
import { finalizeOfferWithCloud } from './offerFinalizeCloudService';
import {
  buildOfferCloudContentKey,
  mergeOffersFromPull,
  offerFromCloud,
  parseOfferCloudPayload,
  planOfferBackfill,
  stripOfferForCloud,
  type WorkspaceOfferRow,
} from './offerCloudService';
import { buildOfferPrintModel } from './offerPrintModel';
import { ensureOfferArchived } from './offerArchiveService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { enqueueSyncOutbox, getSyncOutboxSnapshot } from '../sync/syncOutboxService';

const WORKSPACE = '2e49b0a1-dbee-4649-aa4e-68064d52c8f5';

const KUNDE = {
  name: 'Muster Baustoffe GmbH',
  contactPerson: 'Frau Muster',
  street: 'Musterweg 1',
  zip: '33602',
  city: 'Bielefeld',
  email: 'kunde@example.invalid',
  phone: '',
};

function entwurf(overrides: Partial<Parameters<typeof addOfferDraft>[1]> = {}): Offer {
  const r = addOfferDraft(WORKSPACE, {
    customerId: 'cust-1',
    customer: KUNDE,
    title: 'Badsanierung EG',
    baustelle: 'Musterweg 1, Bielefeld',
    positions: [
      { id: 'p1', description: 'Demontage', quantity: 4, unit: 'Stunden', unitPrice: 55 },
      { id: 'p2', description: 'Fliesen', quantity: 12.5, unit: 'm²', unitPrice: 48.9 },
      { id: 'p3', description: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitPrice: 35 },
    ],
    taxStatus: 'standard_19',
    offerDate: '2026-09-21',
    validUntil: '2026-10-21',
    introText: 'Vielen Dank für Ihre Anfrage.',
    closingText: 'Wir freuen uns auf Ihren Auftrag.',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    ...overrides,
  });
  if (!r.success) throw new Error(r.errorKey);
  return r.offer;
}

/** Der Server, wie ihn die Migration definiert — hier als Mock mit Zähler. */
function mockServer() {
  const rows = new Map<string, WorkspaceOfferRow>();
  let seq = 0;
  const handler = (args: Record<string, unknown>) => {
    const id = String(args.p_offer_id);
    const existing = rows.get(id);
    if (existing && existing.status !== 'entwurf') {
      if (existing.content_fingerprint === args.p_fingerprint) {
        return { row: existing, row_version: existing.row_version, replayed: true };
      }
      throw new Error(`Angebot ist bereits freigegeben (${existing.offer_number})`);
    }
    seq += 1;
    const number = `AN-2026-${String(seq).padStart(4, '0')}`;
    const payload = {
      ...(args.p_payload as Record<string, unknown>),
      status: 'freigegeben',
      offerNumber: number,
      offerSequenceNumber: seq,
      contentFingerprint: args.p_fingerprint,
      finalizedAt: '2026-09-21T10:00:00.000Z',
    };
    const row: WorkspaceOfferRow = {
      workspace_id: WORKSPACE,
      client_offer_id: id,
      client_customer_id: 'cust-1',
      offer_number: number,
      offer_sequence_number: seq,
      status: 'freigegeben',
      payload,
      row_version: (existing?.row_version ?? 1) + 1,
      deleted: false,
      deleted_at: null,
      updated_at: '2026-09-21T10:00:00.000Z',
    };
    rows.set(id, row);
    return { row, row_version: row.row_version, replayed: false };
  };
  registerMockRpcHandler('finalize_workspace_offer', handler);
  return { rows, calls: () => seq, handler };
}

beforeEach(async () => {
  localStorage.clear();
  resetOffers();
  resetDocuments();
  resetCompanyProfile();
  resetSyncChangeTrackerForTests();
  hydrateSyncOutbox([]);
  await resetDocumentBlobDatabaseForTests();
  clearMockRpcHandlers();
  resetWorkspaceStore();
  hydrateWorkspaceStore({ workspace: { id: WORKSPACE, name: 'Test', ownerUserId: 'user-1' } as never });
  resetSyncClientForTests({
    deviceId: 'device-test',
    workspaceId: WORKSPACE,
    serverWorkspaceId: WORKSPACE,
    createdAt: '2026-09-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
  hydrateCompanyProfileStore({
    ...createCompanyProfileFromSetup(DEFAULT_SETUP),
    companyName: 'Beispiel Haustechnik GmbH',
    street: 'Musterstrasse 5',
    zip: '33602',
    city: 'Bielefeld',
  });
});

afterEach(() => {
  clearMockRpcHandlers();
});

describe('A — gemeinsame Rechenbasis', () => {
  it('Angebotssummen entsprechen der Rechnungsberechnung für dieselben Positionen', () => {
    const offer = entwurf();
    const totals = computeOfferTotals(offer.positions, 'standard_19');
    const draft = {
      positions: offer.positions.map((p) => ({ ...p, billable: true })),
      taxStatus: 'standard_19',
      type: 'rechnung',
      previousAbschlagDeductions: [],
    } as unknown as InvoiceDraft;
    const invoice = calculateInvoiceTotals(draft, DEFAULT_SETUP);
    expect(totals.subtotal).toBe(invoice.subtotal);
    expect(totals.tax).toBe(invoice.tax);
    expect(totals.total).toBe(invoice.total);
    // 4×55 + 12,5×48,9 + 35 = 866,25 netto
    expect(totals.subtotal).toBe(866.25);
    expect(totals.total).toBe(1030.84);
  });

  it('Kleinunternehmer: keine Steuer, Brutto = Netto', () => {
    const t = computeOfferTotals([{ quantity: 2, unitPrice: 100 }], 'kleinunternehmer_19');
    expect(t.taxRate).toBe(0);
    expect(t.total).toBe(200);
  });
});

describe('B — Entwurf und Freigabekandidat', () => {
  it('Entwurf lässt sich ändern und wieder öffnen', () => {
    const offer = entwurf();
    const r = updateOfferDraft(offer.id, { title: 'Badsanierung OG' });
    expect(r.success && r.offer.title).toBe('Badsanierung OG');
    expect(getOfferById(offer.id)?.status).toBe('entwurf');
  });

  it('Blocker: ohne Kunde, ohne Position, ohne Gültigkeit', () => {
    const offer = entwurf({ customer: { ...KUNDE, name: '' }, positions: [], validUntil: '2026-09-01' });
    const c = buildOfferFinalizationCandidate(offer.id);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.blockers).toContain('customer_missing');
      expect(c.blockers).toContain('positions_missing');
      expect(c.blockers).toContain('valid_until_before_date');
    }
  });

  it('Kandidat friert Firma, Branding, Hinweise und Summen ein', () => {
    const c = buildOfferFinalizationCandidate(entwurf().id);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.content.companySnapshot?.companyName).toBe('Beispiel Haustechnik GmbH');
      expect(c.content.totals.total).toBe(1030.84);
      expect(c.fingerprint.length).toBeGreaterThan(50);
    }
  });
});

describe('C — Freigabe über den Server', () => {
  it('Nummer kommt vom Server; danach eingefroren; Wiederholung ohne zweite Nummer', async () => {
    const server = mockServer();
    const offer = entwurf();

    const r1 = await finalizeOfferWithCloud(offer.id);
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    const nach = getOfferById(offer.id);
    expect(nach?.status).toBe('freigegeben');
    expect(nach?.offerNumber).toBe('AN-2026-0001');
    expect(nach?.totals?.total).toBe(1030.84);
    expect(nach?.companySnapshot?.companyName).toBe('Beispiel Haustechnik GmbH');
    expect(nach?.sync?.version).toBe(2);

    // Eingefroren: keine Änderung mehr.
    const u = updateOfferDraft(offer.id, { title: 'anders' });
    expect(u.success).toBe(false);

    // Wiederholung (Reload/Retry): keine zweite Nummer, kein zweiter Serveraufruf mit neuer Sequenz.
    const r2 = await finalizeOfferWithCloud(offer.id);
    expect(r2.ok && r2.replayed).toBe(true);
    expect(server.calls()).toBe(1);
    expect(getOfferById(offer.id)?.offerNumber).toBe('AN-2026-0001');
  });

  it('zweites Angebot bekommt die nächste Nummer', async () => {
    mockServer();
    const a = entwurf();
    const b = entwurf({ title: 'Zweites' });
    await finalizeOfferWithCloud(a.id);
    await finalizeOfferWithCloud(b.id);
    expect(getOfferById(a.id)?.offerNumber).toBe('AN-2026-0001');
    expect(getOfferById(b.id)?.offerNumber).toBe('AN-2026-0002');
  });

  it('ohne Cloud keine Freigabe — der Entwurf bleibt', async () => {
    resetSyncClientForTests({
      deviceId: 'device-test',
      workspaceId: WORKSPACE,
      createdAt: '2026-09-01T00:00:00.000Z',
      syncPolicy: 'local_only',
    });
    const offer = entwurf();
    const r = await finalizeOfferWithCloud(offer.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('cloud_required');
    expect(getOfferById(offer.id)?.status).toBe('entwurf');
  });

  it('Blocker verhindern den Serveraufruf', async () => {
    const server = mockServer();
    const offer = entwurf({ positions: [] });
    const r = await finalizeOfferWithCloud(offer.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('blocked');
    expect(server.calls()).toBe(0);
  });
});

describe('D — Statusübergänge', () => {
  it('nur erlaubte Übergänge; abgelaufen ist berechnet', async () => {
    mockServer();
    const offer = entwurf();
    expect(rejectOffer(offer.id).success).toBe(false); // Entwurf kann nicht abgelehnt werden
    await finalizeOfferWithCloud(offer.id);
    expect(markOfferSent(offer.id).success).toBe(true);
    expect(getOfferById(offer.id)?.status).toBe('versendet');
    expect(markOfferSent(offer.id).success).toBe(true); // Zweitversand: kein Fehler
    expect(rejectOffer(offer.id).success).toBe(true);
    expect(cancelOffer(offer.id).success).toBe(false); // abgelehnt ist Endzustand
    expect(canTransitionOfferStatus('freigegeben', 'angenommen')).toBe(true);
    expect(canTransitionOfferStatus('entwurf', 'versendet')).toBe(false);
    expect(isOfferExpired({ status: 'freigegeben', validUntil: '2026-01-01' }, '2026-09-21')).toBe(true);
    expect(isOfferExpired({ status: 'abgelehnt', validUntil: '2026-01-01' }, '2026-09-21')).toBe(false);
  });
});

describe('E — Cloud-Transport', () => {
  it('ist für Supabase freigegeben', () => {
    expect(isSupabaseSyncAllowed('offer')).toBe(true);
  });

  it('Payload → Zeile → Entität ergibt denselben Inhaltsschlüssel', () => {
    const offer = entwurf();
    const payload = stripOfferForCloud(offer);
    const parsed = parseOfferCloudPayload({ payload: JSON.parse(JSON.stringify(payload)) });
    expect(parsed).not.toBeNull();
    const remote = offerFromCloud(offer.id, parsed!, 1, '2026-09-21T10:00:00.000Z', false, 'other', WORKSPACE);
    expect(buildOfferCloudContentKey(remote)).toBe(buildOfferCloudContentKey(offer));
    expect((payload as Record<string, unknown>).sync).toBeUndefined();
  });

  it('Merge: Serverzeile ohne lokalen Stand wird übernommen; Grabstein löscht; Altbestand wird erkannt', () => {
    const offer = entwurf();
    const row: WorkspaceOfferRow = {
      workspace_id: WORKSPACE,
      client_offer_id: 'offer-remote',
      client_customer_id: null,
      offer_number: 'AN-2026-0007',
      offer_sequence_number: 7,
      status: 'freigegeben',
      payload: { ...stripOfferForCloud({ ...offer, id: 'offer-remote' }), status: 'freigegeben' },
      row_version: 3,
      deleted: false,
      deleted_at: null,
      updated_at: '2026-09-21T10:00:00.000Z',
    };
    const grab: WorkspaceOfferRow = { ...row, client_offer_id: 'offer-gone', deleted: true, payload: {}, offer_number: null, status: 'entwurf' };
    const local = [offer, { ...offer, id: 'offer-gone', sync: { updatedAt: '', version: 1, deleted: false, deviceId: 'd', workspaceId: WORKSPACE } }];
    const merged = mergeOffersFromPull(local, [row, grab], 'device-test', WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    const ids = merged.offers.map((o) => o.id).sort();
    expect(ids).toEqual([offer.id, 'offer-remote'].sort());
    const remote = merged.offers.find((o) => o.id === 'offer-remote');
    expect(remote?.offerNumber).toBe('AN-2026-0007');
    expect(remote?.sync?.version).toBe(3);
    expect(planOfferBackfill(merged.offers, [row, grab])).toEqual([offer.id]);
  });
});

describe('F — Druckmodell', () => {
  it('Angebot: Titel, Nummer, Gültig bis, keine Fälligkeit; Rechnungsmodell trägt kein offer', async () => {
    mockServer();
    const offer = entwurf();
    const entwurfModell = buildOfferPrintModel(offer);
    expect(entwurfModell.documentTitle).toBe('Angebot');
    expect(entwurfModell.offer?.isDraft).toBe(true);
    expect(entwurfModell.invoiceNumber).toBe('ENTWURF');

    await finalizeOfferWithCloud(offer.id);
    const model = buildOfferPrintModel(getOfferById(offer.id)!);
    expect(model.invoiceNumber).toBe('AN-2026-0001');
    expect(model.offer).toEqual({ validUntil: '2026-10-21', isDraft: false });
    expect(model.paymentDueDate).toBe('');
    expect(model.servicePeriodFrom).toBe('');
    expect(model.summary.amountDue).toBe(1030.84);
    expect(model.positions).toHaveLength(3);
    expect(model.company.companyName).toBe('Beispiel Haustechnik GmbH');
  });

  it('nach der Freigabe zählt der Schnappschuss, nicht das heutige Profil', async () => {
    mockServer();
    const offer = entwurf();
    await finalizeOfferWithCloud(offer.id);
    hydrateCompanyProfileStore({ ...createCompanyProfileFromSetup(DEFAULT_SETUP), companyName: 'Umbenannt GmbH' });
    expect(buildOfferPrintModel(getOfferById(offer.id)!).company.companyName).toBe('Beispiel Haustechnik GmbH');
  });
});

describe('G — Ablage', () => {
  it('legt genau ein Archivdokument mit gebundener PDF-Datei an', async () => {
    mockServer();
    const offer = entwurf();
    expect((await ensureOfferArchived(offer.id)).ok).toBe(false); // Entwurf wird nicht abgelegt
    await finalizeOfferWithCloud(offer.id);

    const erst = await ensureOfferArchived(offer.id);
    expect(erst.ok, JSON.stringify(erst)).toBe(true);
    if (!erst.ok) return;
    expect(erst.created).toBe(true);
    expect(erst.document.classifiedKind).toBe('angebot');
    expect(erst.document.linkedOfferId).toBe(offer.id);
    expect(erst.document.mimeType).toBe('application/pdf');
    const ref = getDocumentFileRefById(erst.document.fileRefId ?? '');
    expect(ref?.lifecycleStatus).toBe('committed');
    expect(getOfferById(offer.id)?.archiveDocumentId).toBe(erst.document.id);

    const zweit = await ensureOfferArchived(offer.id);
    expect(zweit.ok && zweit.created).toBe(false);
    expect(getAllDocuments().filter((d) => d.linkedOfferId === offer.id)).toHaveLength(1);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* H — Crash-Recovery: Server freigegeben, Client hat die Antwort nie   */
/* übernommen.                                                          */
/* ------------------------------------------------------------------ */
function pullMit(rows: WorkspaceOfferRow[]) {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: [],
    customers: [],
    offers: rows,
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

/** Der Server, wie er nach einer Freigabe steht, deren Antwort den Client nie erreicht hat. */
function serverFinalisiertOhneClient(offer: Offer): { row: WorkspaceOfferRow; fingerprint: string } {
  const server = mockServer();
  const candidate = buildOfferFinalizationCandidate(offer.id);
  if (!candidate.ok) throw new Error('Kandidat');
  // Die Server-RPC läuft — die Antwort erreicht den Client nie (kein apply, kein Archiv): der Crash.
  server.handler({
    p_workspace_id: WORKSPACE,
    p_offer_id: offer.id,
    p_payload: { ...candidate.content, id: offer.id, workspaceId: WORKSPACE, createdAt: offer.createdAt },
    p_fingerprint: candidate.fingerprint,
    p_row_version: 0,
  });
  const row = server.rows.get(offer.id);
  if (!row) throw new Error('Serverzeile fehlt');
  return { row, fingerprint: candidate.fingerprint };
}

function getOfferStoreSnapshotIds(): string[] {
  return getOfferStoreSnapshot().map((o) => o.id);
}

describe('H — Crash-Recovery nach Server-Freigabe', () => {
  async function crashFall(entwurfNachCrashAendern: boolean) {
    // a) lokaler Entwurf, als synchronisiert (Version 1) mit offenem Update-Auftrag
    const offer = entwurf();
    const { row, fingerprint } = serverFinalisiertOhneClient(offer);
    // c) lokal weiterhin Entwurf: nichts übernommen
    expect(getOfferById(offer.id)?.status).toBe('entwurf');
    expect(getOfferById(offer.id)?.offerNumber).toBeUndefined();

    if (entwurfNachCrashAendern) {
      const r = updateOfferDraft(offer.id, { title: 'Nach dem Crash geändert' });
      expect(r.success).toBe(true);
    }
    // ein offener Sendeauftrag des Entwurfs steht noch in der Warteschlange
    enqueueSyncOutbox({ entityType: 'offer', entityId: offer.id, operation: 'update', version: 1 });

    // d) Wiederöffnen/Sync: Pull mit der freigegebenen Serverzeile
    const state = buildPersistedStateSnapshot();
    const merged = mergeRemoteWorkspacePullIntoState(state, pullMit([row]));
    expect(merged.conflicts).toEqual([]);
    const lokal = merged.state.offers?.find((o) => o.id === offer.id);

    // e) lokale Sicht = Serverversion
    expect(lokal?.status).toBe('freigegeben');
    expect(lokal?.offerNumber).toBe('AN-2026-0001');
    expect(lokal?.title).toBe('Badsanierung EG'); // nie der geänderte Entwurf
    expect(lokal?.sync?.version).toBe(row.row_version);
    // j) Snapshot/Fingerprint unverändert
    expect(lokal?.contentFingerprint).toBe(fingerprint);
    expect(lokal?.totals?.total).toBe(1030.84);
    expect(lokal?.companySnapshot?.companyName).toBe('Beispiel Haustechnik GmbH');
    // überholter Sendeauftrag abgeschlossen — er würde den Beleg nur noch abgewiesen sehen
    expect(getSyncOutboxSnapshot().filter((e) => e.entityType === 'offer' && e.entityId === offer.id && e.status !== 'completed')).toHaveLength(0);

    // Zustand übernehmen (wie nach dem Sync-Lauf) und f) Archiv idempotent erzeugen
    setOfferStoreForTests(merged.state.offers ?? []);
    const erst = await ensureOfferArchived(offer.id);
    expect(erst.ok && erst.created).toBe(true);
    const zweit = await ensureOfferArchived(offer.id);
    expect(zweit.ok && !zweit.created).toBe(true);
    // i) genau ein Archivdokument
    expect(getAllDocuments().filter((d) => d.linkedOfferId === offer.id)).toHaveLength(1);

    // g/h) erneute Freigabe: Replay, keine zweite Nummer, kein zweites Angebot
    const again = await finalizeOfferWithCloud(offer.id);
    expect(again.ok && again.replayed).toBe(true);
    expect(getOfferById(offer.id)?.offerNumber).toBe('AN-2026-0001');
    expect(getOfferStoreSnapshotIds()).toEqual([offer.id]);
  }

  it('a–j: unveränderter Entwurf wird zur freigegebenen Serverversion', async () => {
    await crashFall(false);
  }, 30_000);

  it('Entwurf nach dem Crash geändert: Serverversion bleibt, nichts wird überschrieben', async () => {
    await crashFall(true);
  }, 30_000);
});
