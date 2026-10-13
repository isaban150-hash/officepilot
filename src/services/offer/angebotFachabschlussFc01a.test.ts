/**
 * FINANZ-CORE-01A — Fachabschluss Angebote (ANG-05 … ANG-14).
 *
 *  A5   eine leere Kundenauswahl entfernt den Kundenbezug des Entwurfs
 *  A6   die Freigabe verlangt Absendername und -anschrift
 *  A8   ein angenommener Versand macht „freigegeben" zu „versendet" — nur dann, nur für
 *       eigene Angebotsdokumente, im gesperrten Schreibbereich
 *  A11a Überarbeiten eines offenen Angebots: Entwurf mit Bezug, neue Positionskennungen,
 *       heutiges Datum, gleiche Gültigkeitsdauer
 *  A11b Vorlage aus einem abgeschlossenen Angebot ohne Bezug; ein Entwurf wird nicht überarbeitet
 *  A11c erst die Freigabe der Überarbeitung ersetzt den Vorgänger; der Bezug reist mit
 *  A12  gleichzeitige Ablageaufrufe teilen sich einen Lauf: ein Dokument unter fester Kennung
 *  A13a Kennung am Angebot, Dokument fehlt: archive_missing, kein neues Dokument
 *  A13b feste Kennung schon vergeben (gelöscht): archive_missing, kein zweites Dokument
 *  A14a Servertexte werden übersetzten Meldungen zugeordnet; unbekannte nie gezeigt
 *  A14b Versionskonflikt bei Freigabe und Annahme: stale_version mit genau einem Abgleich
 *  A14c offline mit offenem Sendeauftrag: „keine Verbindung" statt „wird noch gespeichert"
 *  A14d Angebotsdatum außerhalb 2000–2100 oder kein Kalenderdatum: Blocker offer_date_invalid
 *
 * Neutrale Beispieldaten, gemockte RPCs, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Offer } from '../../types/offer';
import type { CompanyDocument } from '../../types/models';
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { SyncOutboxEntry } from '../../types/sync';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetSyncClientForTests } from '../sync/syncClientService';
import { getSyncOutboxSnapshot, hydrateSyncOutbox, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import * as syncUi from '../sync/syncUiService';
import { clearMockRpcHandlers, registerMockRpcHandler } from '../../test/mockProfileStore';
import { getAllDocuments, hydrateDocumentStore, resetDocuments } from '../documentService';
import { resetDocumentBlobDatabaseForTests } from '../storage/documentBlobIndexedDbService';
import { hydrateWorkspaceStore, resetWorkspaceStore } from '../workspace/workspaceStore';
import { persistAll } from '../persistenceService';
import { getBusinessDay } from '../businessDateService';
import { addCalendarDays } from '../invoiceTaxService';
import {
  addOfferDraft,
  buildOfferFinalizationCandidate,
  getOfferById,
  hydrateOffers,
  resetOffers,
  reviseOffer,
  updateOfferDraft,
} from './offerService';
import { finalizeOfferWithCloud } from './offerFinalizeCloudService';
import { acceptOfferWithCloud } from './offerAcceptCloudService';
import { buildOfferArchiveDocumentId, ensureOfferArchived, resetOfferArchiveForTests } from './offerArchiveService';
import { syncOfferSentFromDeliveries } from './offerDeliveryStatus';
import { offerServerRejectionKey } from './offerServerRejection';
import type { WorkspaceOfferRow } from './offerCloudService';

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

const PROFIL = {
  ...createCompanyProfileFromSetup(DEFAULT_SETUP),
  companyName: 'Beispiel Haustechnik GmbH',
  street: 'Musterstrasse 5',
  zip: '33602',
  city: 'Bielefeld',
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
    ],
    taxStatus: 'standard_19',
    offerDate: '2026-09-21',
    validUntil: '2026-10-21',
    introText: '',
    closingText: '',
    paymentTermsText: '',
    ...overrides,
  });
  if (!r.success) throw new Error(r.errorKey);
  return r.offer;
}

/** Der Freigabe-Server als Mock: vergibt Nummern, merkt sich den gesendeten Payload. */
function mockFreigabe() {
  const payloads: Record<string, unknown>[] = [];
  let seq = 0;
  registerMockRpcHandler('finalize_workspace_offer', (args) => {
    seq += 1;
    const number = `AN-2026-${String(seq).padStart(4, '0')}`;
    payloads.push(args.p_payload as Record<string, unknown>);
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
      client_offer_id: String(args.p_offer_id),
      client_customer_id: 'cust-1',
      offer_number: number,
      offer_sequence_number: seq,
      status: 'freigegeben',
      payload,
      row_version: 2,
      deleted: false,
      deleted_at: null,
      updated_at: '2026-09-21T10:00:00.000Z',
    };
    return { row, row_version: 2, replayed: false };
  });
  return { payloads };
}

async function freigegeben(overrides: Partial<Parameters<typeof addOfferDraft>[1]> = {}): Promise<Offer> {
  const offer = entwurf(overrides);
  const r = await finalizeOfferWithCloud(offer.id);
  if (!r.ok) throw new Error(`Freigabe im Test fehlgeschlagen: ${JSON.stringify(r)}`);
  // Die Freigabe ist Serverwahrheit; ein offener Sendeauftrag wäre hier nur Testrauschen.
  hydrateSyncOutbox([]);
  return getOfferById(offer.id)!;
}

const SYNC = { updatedAt: '2026-09-21T10:00:00.000Z', version: 2, deleted: false, deviceId: 'device-test', workspaceId: WORKSPACE };

/** Ein eingefrorenes Angebot direkt im Speicher (ohne PDF-Erzeugung). */
function eingefroren(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-fest',
    workspaceId: WORKSPACE,
    offerNumber: 'AN-2026-0099',
    offerSequenceNumber: 99,
    status: 'freigegeben',
    customerId: 'cust-1',
    customer: KUNDE,
    title: 'Badsanierung',
    baustelle: 'Musterweg 1',
    positions: [{ id: 'pos-a', description: 'Montage', quantity: 2, unit: 'Stunden', unitPrice: 100 }],
    taxStatus: 'standard_19',
    offerDate: '2026-09-21',
    validUntil: '2026-10-21',
    introText: 'Einleitung',
    closingText: 'Schluss',
    paymentTermsText: 'Zahlbar in 14 Tagen.',
    createdAt: '2026-09-21T10:00:00.000Z',
    sync: SYNC,
    ...overrides,
  } as Offer;
}

function lieferung(status: DocumentDelivery['status']): DocumentDelivery {
  return {
    id: `del-${status}`,
    workspaceId: WORKSPACE,
    clientDeliveryId: `del-${status}`,
    documentKind: 'offer',
    recipientEmail: 'kunde@example.invalid',
    subject: 'Angebot',
    bodyText: 'Guten Tag',
    provider: 'stub',
    status,
    requestedBy: 'user-1',
    requestedAt: '2026-09-22T10:00:00.000Z',
    attemptNumber: 1,
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
    rowVersion: 1,
  } as DocumentDelivery;
}

function abweisung(entityId: string): SyncOutboxEntry {
  return {
    id: `out-offer-${entityId}`,
    entityType: 'offer',
    entityId,
    operation: 'update',
    version: 2,
    queuedAt: '2026-09-21T10:00:00.000Z',
    retryCount: 1,
    status: 'failed',
    lastErrorMessage: 'Kein Zugriff auf Workspace',
    lastErrorRetryable: false,
  };
}

function offenerAuftrag(entityId: string): SyncOutboxEntry {
  return {
    id: `out-offer-offen-${entityId}`,
    entityType: 'offer',
    entityId,
    operation: 'update',
    version: 1,
    queuedAt: '2026-09-21T10:00:00.000Z',
    retryCount: 0,
    status: 'pending',
  };
}

const offenFuer = (entityId: string) =>
  getSyncOutboxSnapshot().filter(
    (entry) => entry.entityType === 'offer' && entry.entityId === entityId && ['pending', 'error', 'blocked'].includes(entry.status),
  );

beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetOffers();
  resetDocuments();
  resetCompanyProfile();
  resetSyncChangeTrackerForTests();
  hydrateSyncOutbox([]);
  resetOfferArchiveForTests();
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
  hydrateCompanyProfileStore(PROFIL);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearMockRpcHandlers();
});

describe('ANG-05 / ANG-06 — Entwurf und Freigabeprüfung', () => {
  it('A5: eine leere Kundenauswahl entfernt den Kundenbezug', () => {
    const offer = entwurf();
    expect(offer.customerId).toBe('cust-1');
    const r = updateOfferDraft(offer.id, { customerId: '' });
    expect(r.success).toBe(true);
    expect(getOfferById(offer.id)?.customerId).toBeUndefined();
    // „nicht angegeben" bleibt „unverändert".
    updateOfferDraft(offer.id, { customerId: 'cust-2' });
    updateOfferDraft(offer.id, { title: 'Neuer Betreff' });
    expect(getOfferById(offer.id)?.customerId).toBe('cust-2');
  });

  it('A6: ohne Absenderanschrift keine Freigabe; mit vollständigem Absender ja', () => {
    const offer = entwurf();
    hydrateCompanyProfileStore({ ...PROFIL, street: '', zip: '', city: '' });
    const ohne = buildOfferFinalizationCandidate(offer.id);
    expect(ohne.ok).toBe(false);
    if (!ohne.ok) expect(ohne.blockers).toContain('company_profile_missing');

    hydrateCompanyProfileStore({ ...PROFIL, companyName: '  ' });
    const ohneName = buildOfferFinalizationCandidate(offer.id);
    expect(!ohneName.ok && ohneName.blockers.includes('company_profile_missing')).toBe(true);

    hydrateCompanyProfileStore(PROFIL);
    expect(buildOfferFinalizationCandidate(offer.id).ok).toBe(true);
  });
});

describe('ANG-08 — Versandstatus aus der Versandhistorie', () => {
  const DOKUMENT = { classifiedKind: 'angebot', linkedOfferId: 'offer-fest' } as Pick<CompanyDocument, 'classifiedKind' | 'linkedOfferId'>;

  it('A8: nur ein angenommener Versand macht „freigegeben" zu „versendet"', () => {
    hydrateOffers([eingefroren()]);
    expect(syncOfferSentFromDeliveries(DOKUMENT, [lieferung('sending'), lieferung('failed')])).toBe(false);
    expect(getOfferById('offer-fest')?.status).toBe('freigegeben');

    // Fremdes Dokument: nichts.
    const fremd = { classifiedKind: 'ausgangsrechnung', linkedOfferId: 'offer-fest' } as typeof DOKUMENT;
    expect(syncOfferSentFromDeliveries(fremd, [lieferung('provider_accepted')])).toBe(false);
    expect(getOfferById('offer-fest')?.status).toBe('freigegeben');

    expect(syncOfferSentFromDeliveries(DOKUMENT, [lieferung('provider_accepted')])).toBe(true);
    expect(getOfferById('offer-fest')?.status).toBe('versendet');
    // Zweiter Durchlauf: schon versendet, kein weiterer Wechsel.
    expect(syncOfferSentFromDeliveries(DOKUMENT, [lieferung('delivered')])).toBe(false);
  });

  it('A8: ein abgelehntes oder storniertes Angebot bleibt, wie es ist', () => {
    hydrateOffers([eingefroren({ status: 'abgelehnt' })]);
    expect(syncOfferSentFromDeliveries(DOKUMENT, [lieferung('provider_accepted')])).toBe(false);
    expect(getOfferById('offer-fest')?.status).toBe('abgelehnt');
  });

  it('A8: im gesperrten Schreibbereich — eine endgültige Abweisung wird nicht still abgelöst', () => {
    hydrateOffers([eingefroren()]);
    persistAll(); // Vergleichsbasis des Änderungsverfolgers
    resetSyncOutboxForTests([abweisung('offer-fest')]);
    expect(syncOfferSentFromDeliveries(DOKUMENT, [lieferung('provider_accepted')])).toBe(true);
    expect(getOfferById('offer-fest')?.status).toBe('versendet');
    expect(offenFuer('offer-fest')).toEqual([]);
  });

  it('A8-Gegenstück: ohne Abweisung geht der Statuswechsel wie gewohnt in die Cloud', () => {
    hydrateOffers([eingefroren()]);
    persistAll();
    resetSyncOutboxForTests([]);
    expect(syncOfferSentFromDeliveries(DOKUMENT, [lieferung('provider_accepted')])).toBe(true);
    expect(offenFuer('offer-fest')).toHaveLength(1);
  });
});

describe('ANG-11 — Überarbeiten und Vorlage', () => {
  it('A11a: ein offenes Angebot wird zum Entwurf mit Nachfolgebezug', () => {
    hydrateOffers([eingefroren({ status: 'versendet', offerDate: '2026-09-21', validUntil: '2026-10-05' })]);
    const r = reviseOffer('offer-fest');
    expect(r.success).toBe(true);
    if (!r.success) return;
    const neu = r.offer;
    expect(neu.id).not.toBe('offer-fest');
    expect(neu.status).toBe('entwurf');
    expect(neu.supersedesOfferId).toBe('offer-fest');
    expect(neu.offerNumber).toBeUndefined();
    expect(neu.customer).toEqual(KUNDE);
    expect(neu.positions.map((p) => [p.description, p.quantity, p.unitPrice])).toEqual([['Montage', 2, 100]]);
    expect(neu.positions[0].id).toBeTruthy();
    expect(neu.positions[0].id).not.toBe('pos-a');
    const heute = getBusinessDay();
    expect(neu.offerDate).toBe(heute);
    expect(neu.validUntil).toBe(addCalendarDays(heute, 14));
    // Das alte Angebot bleibt gültig, bis die Überarbeitung freigegeben ist.
    expect(getOfferById('offer-fest')?.status).toBe('versendet');
  });

  it('A11b: ein abgeschlossenes Angebot dient als Vorlage ohne Bezug; ein Entwurf wird nicht überarbeitet', () => {
    hydrateOffers([eingefroren({ status: 'abgelehnt' })]);
    const r = reviseOffer('offer-fest');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.offer.supersedesOfferId).toBeUndefined();
    expect(reviseOffer(r.offer.id)).toEqual({ success: false, errorKey: 'offer.error.reviseDraft' });
    expect(reviseOffer('gibt-es-nicht')).toEqual({ success: false, errorKey: 'offer.error.notFound' });
  });

  it('A11c: erst die Freigabe der Überarbeitung ersetzt den Vorgänger; der Bezug reist im Payload mit', async () => {
    const server = mockFreigabe();
    const alt = await freigegeben();
    expect(alt.status).toBe('freigegeben');

    const r = reviseOffer(alt.id);
    if (!r.success) throw new Error(r.errorKey);
    expect(getOfferById(alt.id)?.status).toBe('freigegeben');

    hydrateSyncOutbox([]);
    const fin = await finalizeOfferWithCloud(r.offer.id);
    expect(fin.ok, JSON.stringify(fin)).toBe(true);
    expect(server.payloads.at(-1)?.supersedesOfferId).toBe(alt.id);
    expect(getOfferById(r.offer.id)?.supersedesOfferId).toBe(alt.id);
    expect(getOfferById(r.offer.id)?.status).toBe('freigegeben');
    expect(getOfferById(alt.id)?.status).toBe('ersetzt');
    // Der Statuswechsel des Vorgängers geht als eigene Änderung in die Cloud.
    expect(offenFuer(alt.id)).toHaveLength(1);
  });
});

describe('ANG-12 / ANG-13 — Ablage im Archiv', () => {
  it('A12: gleichzeitige Aufrufe teilen sich einen Lauf — ein Dokument unter fester Kennung', async () => {
    mockFreigabe();
    const offer = await freigegeben();
    const [a, b] = await Promise.all([ensureOfferArchived(offer.id), ensureOfferArchived(offer.id)]);
    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.document.id).toBe(buildOfferArchiveDocumentId(offer.id));
    expect(b.document.id).toBe(a.document.id);
    expect(getAllDocuments().filter((d) => d.linkedOfferId === offer.id)).toHaveLength(1);
    expect(getOfferById(offer.id)?.archiveDocumentId).toBe(a.document.id);

    const spaeter = await ensureOfferArchived(offer.id);
    expect(spaeter).toMatchObject({ ok: true, created: false });
  }, 30_000);

  it('A13a: Kennung am Angebot, Dokument (noch) nicht hier — kein neues Dokument', async () => {
    hydrateOffers([eingefroren({ archiveDocumentId: 'doc-anderes-geraet' })]);
    const r = await ensureOfferArchived('offer-fest');
    expect(r).toEqual({ ok: false, reason: 'archive_missing' });
    // Der Demo-Bestand bleibt; zu diesem Angebot entsteht nichts.
    expect(getAllDocuments().filter((d) => d.linkedOfferId === 'offer-fest' || d.id === buildOfferArchiveDocumentId('offer-fest'))).toHaveLength(0);
    expect(getOfferById('offer-fest')?.archiveDocumentId).toBe('doc-anderes-geraet');
  });

  it('A13a: kommt das Dokument mit dem Abgleich, wird es genommen', async () => {
    hydrateOffers([eingefroren({ archiveDocumentId: 'doc-anderes-geraet' })]);
    hydrateDocumentStore([
      {
        id: 'doc-anderes-geraet',
        title: 'AN-2026-0099 – Angebot',
        category: 'sonstiges',
        classifiedKind: 'angebot',
        linkedOfferId: 'offer-fest',
        issuer: 'Beispiel Haustechnik GmbH',
        recognizedText: '',
        issueDate: '2026-09-21',
        validUntil: null,
        digitalFolder: { id: 'dig-x', name: 'Angebote', path: '/Angebote/' },
        paperFolder: { folderId: 'ordner-x', register: 'A', label: 'Ordner' },
        tags: [],
        linkedCompany: KUNDE.name,
        linkedVorgang: null,
        archived: true,
        createdAt: '2026-09-21T10:00:00.000Z',
      } as CompanyDocument,
    ]);
    const r = await ensureOfferArchived('offer-fest');
    expect(r).toMatchObject({ ok: true, created: false });
    expect(getAllDocuments()).toHaveLength(1);
  });

  it('A13b: die feste Kennung ist vergeben (gelöscht) — archive_missing, kein zweites Dokument', async () => {
    mockFreigabe();
    const offer = await freigegeben();
    const fest = buildOfferArchiveDocumentId(offer.id);
    hydrateDocumentStore([
      {
        id: fest,
        title: 'gelöscht',
        category: 'sonstiges',
        classifiedKind: 'angebot',
        linkedOfferId: offer.id,
        issuer: '',
        recognizedText: '',
        issueDate: '2026-09-21',
        validUntil: null,
        digitalFolder: { id: 'dig-x', name: 'Angebote', path: '/Angebote/' },
        paperFolder: { folderId: 'ordner-x', register: 'A', label: 'Ordner' },
        tags: [],
        linkedCompany: '',
        linkedVorgang: null,
        archived: true,
        createdAt: '2026-09-21T10:00:00.000Z',
        sync: { ...SYNC, deleted: true },
      } as CompanyDocument,
    ]);
    const r = await ensureOfferArchived(offer.id);
    expect(r).toEqual({ ok: false, reason: 'archive_missing' });
    expect(getAllDocuments().filter((d) => d.linkedOfferId === offer.id)).toHaveLength(0);
    expect(getOfferById(offer.id)?.archiveDocumentId).toBeUndefined();
  }, 30_000);
});

describe('ANG-14 — Meldungen statt Rohtexte', () => {
  it('A14a: Servertexte werden übersetzten Meldungen zugeordnet', () => {
    expect(offerServerRejectionKey('Angebot ungueltig: Summen passen nicht zu den Positionen', 'finalize')).toBe('offer.server.totalsMismatch');
    expect(offerServerRejectionKey('Angebot ungueltig: Steuerstatus unklar', 'finalize')).toBe('offer.finalize.blocked.tax_status_unclear');
    expect(offerServerRejectionKey('Angebot ungueltig: keine Position mit Menge', 'finalize')).toBe('offer.finalize.blocked.positions_missing');
    expect(offerServerRejectionKey('Angebot ungueltig: negativer Preis', 'finalize')).toBe('offer.finalize.blocked.position_invalid');
    expect(
      offerServerRejectionKey(
        'new row for relation "workspace_offer_sequences" violates check constraint "workspace_offer_sequences_year_check"',
        'finalize',
      ),
    ).toBe('offer.server.dateInvalid');
    expect(offerServerRejectionKey('Angebot ist geloescht', 'finalize')).toBe('offer.server.deleted');
    expect(offerServerRejectionKey('Angebot kann im Zustand storniert nicht angenommen werden', 'accept')).toBe('offer.accept.notAcceptable');
    expect(offerServerRejectionKey('Keine Schreibberechtigung', 'accept')).toBe('offer.accept.roleHint');
    // Unbekannt: keine Zuordnung — der Aufrufer zeigt seine allgemeine Meldung, nie den Rohtext.
    expect(offerServerRejectionKey('Vorgangskennung bereits vergeben', 'accept')).toBeNull();
    expect(offerServerRejectionKey('Ungültige Server-Antwort', 'finalize')).toBeNull();
  });

  it('A14b: Versionskonflikt bei der Freigabe — stale_version und genau ein Abgleich', async () => {
    const lauf = vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue(undefined as never);
    registerMockRpcHandler('finalize_workspace_offer', () => {
      throw new Error('Versionskonflikt offer:3');
    });
    const offer = entwurf();
    hydrateSyncOutbox([]);
    expect(await finalizeOfferWithCloud(offer.id)).toEqual({ ok: false, reason: 'stale_version' });
    expect(lauf).toHaveBeenCalledTimes(1);
    expect(getOfferById(offer.id)?.status).toBe('entwurf');
  });

  it('A14b: Versionskonflikt bei der Annahme — stale_version, kein Auftrag', async () => {
    mockFreigabe();
    const offer = await freigegeben();
    const lauf = vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue(undefined as never);
    registerMockRpcHandler('accept_workspace_offer', () => {
      throw new Error('Versionskonflikt offer:4');
    });
    expect(await acceptOfferWithCloud(offer.id)).toEqual({ ok: false, reason: 'stale_version' });
    expect(lauf).toHaveBeenCalledTimes(1);
    expect(getOfferById(offer.id)?.status).toBe('freigegeben');
    expect(getOfferById(offer.id)?.resultingVorgangId).toBeUndefined();
  });

  it('A14c: offline mit offenem Sendeauftrag — „keine Verbindung", nicht „wird noch gespeichert"', async () => {
    vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue(undefined as never);
    const rpc = vi.fn();
    registerMockRpcHandler('finalize_workspace_offer', rpc);
    const offer = entwurf();
    resetSyncOutboxForTests([offenerAuftrag(offer.id)]);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await finalizeOfferWithCloud(offer.id)).toEqual({ ok: false, reason: 'network', message: 'offline' });

    // Online, aber der letzte Versuch scheiterte an der Verbindung: ebenso.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    resetSyncOutboxForTests([{ ...offenerAuftrag(offer.id), status: 'error', lastErrorMessage: 'TypeError: Failed to fetch' }]);
    expect(await finalizeOfferWithCloud(offer.id)).toEqual({ ok: false, reason: 'network', message: 'offline' });

    // Online ohne Verbindungsfehler: weiterhin „wird noch gespeichert".
    resetSyncOutboxForTests([offenerAuftrag(offer.id)]);
    expect(await finalizeOfferWithCloud(offer.id)).toEqual({ ok: false, reason: 'sync_pending' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('A14d: Angebotsdatum außerhalb 2000–2100 oder kein Kalenderdatum — Blocker vor dem Serveraufruf', () => {
    for (const datum of ['1999-12-31', '2101-01-01', '2026-02-30']) {
      const offer = entwurf({ offerDate: datum, validUntil: '2101-12-31' });
      const r = buildOfferFinalizationCandidate(offer.id);
      expect(r.ok, datum).toBe(false);
      if (!r.ok) expect(r.blockers, datum).toContain('offer_date_invalid');
    }
    const gut = entwurf({ offerDate: '2026-10-12', validUntil: '2026-11-12' });
    expect(buildOfferFinalizationCandidate(gut.id).ok).toBe(true);
  });
});
