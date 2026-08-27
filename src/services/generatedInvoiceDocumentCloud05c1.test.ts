/**
 * OFFICEPILOT-GENERATED-INVOICE-DOCUMENT-CLOUD-05C1 — das Archivdokument reist mit.
 *
 * Realbefund: Auf einer frischen Origin kamen Rechnung, Versandstatus und
 * Zahlungen aus Supabase zurück — das erzeugte Ausgangsrechnungs-Dokument
 * nicht. Die Suche fand nur das Rechnungsobjekt.
 *
 * Der heikle Fall ist nicht der Transport, sondern die Identität: Zwei Geräte
 * erzeugen für dieselbe Rechnung lokal verschiedene `doc-<uuid>`. In der Cloud
 * darf davon nur eine kanonische Zeile existieren, und lokal darf daraus keine
 * zweite Karte für dieselbe Rechnung entstehen.
 *
 * Geprüft wird der Vertrag, nicht der Transport: Der Supabase-Client wird
 * ersetzt. Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import {
  getVorgangInvoice,
  hydrateVorgangStore,
} from './vorgangService';
import {
  getAllDocuments,
  getDocumentById,
  getDocumentByLinkedInvoiceId,
  hydrateDocumentStore,
  searchDocuments,
} from './documentService';
import {
  archiveOutgoingInvoice,
  isGeneratedInvoiceDocumentSyncSilent,
  syncGeneratedInvoiceDocumentToCloud,
} from './invoiceArchiveService';
import {
  isDocumentCloudSynced,
  parseWorkspaceDocumentRow,
  pullDocumentsFromCloud,
  tombstoneDocumentInCloud,
  upsertGeneratedInvoiceDocumentToCloud,
} from './document/workspaceDocumentCloudService';
import {
  applyDocumentCloudPull,
  buildGeneratedInvoiceDocumentPayload,
  isCloudEligibleGeneratedInvoiceDocument,
  mergeCloudDocuments,
} from './document/documentCloudPullOrchestrator';
import { hydrateWorkspaceStore } from './workspace/workspaceStore';
import { resetLastPersistFailureForTests } from './persistenceService';
import * as persistenceService from './persistenceService';
import * as supabaseLib from '../lib/supabase';
import type { CompanyDocument, Vorgang, VorgangInvoice } from '../types/models';

const WORKSPACE = '00000000-0000-4000-8000-00000000c5c1';
const VORGANG_ID = 'v-doc-cloud';
const INVOICE_ID = 'inv-doc-cloud';
const DOC_A = 'doc-11111111-1111-4111-8111-111111111111';
const DOC_B = 'doc-22222222-2222-4222-8222-222222222222';
const COMPANY = 'Muster GmbH';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function buildInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0002',
    invoiceSequenceNumber: 2,
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Dachsanierung',
        quantity: 100,
        unit: 'm²',
        unitPrice: 100,
        lineTotal: 10000,
      },
    ],
    subtotal: 10000,
    taxStatus: 'null_13b',
    amount: 10000,
    status: 'versendet',
    sentAt: '2026-08-25',
    sentVia: 'email',
    date: '2026-08-24',
    issueDate: '2026-08-24',
    createdAt: '2026-08-24T10:00:00.000Z',
    paymentDueDate: '2099-12-31',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as VorgangInvoice;
}

function seed(invoice: VorgangInvoice = buildInvoice()): void {
  hydrateDocumentStore([]);
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        title: 'Dachsanierung Beispielweg',
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 100, unitPrice: 100 }),
        ],
      }),
      invoices: [invoice],
    } as Vorgang,
  ]);
  // Der Push löst den Workspace aus dem Zustand auf, nicht aus einem Override.
  hydrateWorkspaceStore({
    workspace: {
      id: WORKSPACE,
      name: 'Beispielbetrieb',
      ownerUserId: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    },
  });
}

function stored(): VorgangInvoice {
  return getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
}

/** Ein lokal erzeugtes Ausgangsrechnungs-Dokument, wie der Archivpfad es baut. */
function generatedDocument(id: string, overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id,
    title: '2026-0002 – Rechnung',
    category: 'ausgangsrechnung',
    classifiedKind: 'ausgangsrechnung',
    issuer: COMPANY,
    recognizedText: `Rechnungsnummer: 2026-0002\nInvoice-ID: ${INVOICE_ID}`,
    issueDate: '2026-08-24',
    validUntil: null,
    digitalFolder: {
      id: `dig-inv-${INVOICE_ID}`,
      name: 'Ausgangsrechnungen',
      path: '/Vorgänge/Dachsanierung Beispielweg/Ausgangsrechnungen/',
    },
    paperFolder: { folderId: 'folder-3', register: 'A', label: 'Rechnungen' },
    tags: ['Ausgangsrechnung', '2026-0002'],
    linkedCompany: COMPANY,
    linkedVorgang: { vorgangId: VORGANG_ID, vorgangTitle: 'Dachsanierung Beispielweg' },
    linkedInvoiceId: INVOICE_ID,
    archived: true,
    createdAt: '2026-08-24T10:00:00.000Z',
    imagePreview: '🧾',
    ...overrides,
  };
}

/** Ein hochgeladenes Fremddokument — darf niemals in die Cloud. */
function uploadedDocument(id: string, overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id,
    title: 'Tankbeleg August',
    category: 'sonstiges',
    classifiedKind: 'beleg',
    issuer: 'Tankstelle Beispiel',
    recognizedText: 'Diesel 62,40 €',
    issueDate: '2026-08-10',
    validUntil: null,
    digitalFolder: { id: 'dig-belege', name: 'Belege', path: '/Belege/' },
    paperFolder: { folderId: 'folder-5', register: 'B', label: 'Belege' },
    tags: ['Beleg'],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-08-10T10:00:00.000Z',
    fileRefId: 'file-ref-1',
    mimeType: 'application/pdf',
    ...overrides,
  } as CompanyDocument;
}

/** Eine Cloud-Zeile, wie `pull_workspace_documents` sie liefert. */
function cloudRow(options: {
  documentId: string;
  invoiceId?: string;
  deletedAt?: string | null;
  payload?: Record<string, unknown>;
  kind?: string;
}): Record<string, unknown> {
  const invoiceId = options.invoiceId ?? INVOICE_ID;
  return {
    id: `row-${options.documentId}`,
    workspace_id: WORKSPACE,
    client_document_id: options.documentId,
    document_kind: options.kind ?? 'generated_invoice',
    linked_invoice_id: invoiceId,
    linked_vorgang_id: VORGANG_ID,
    payload:
      options.payload ??
      buildGeneratedInvoiceDocumentPayload(generatedDocument(options.documentId)),
    created_at: '2026-08-24T10:00:00.000Z',
    updated_at: '2026-08-24T10:00:00.000Z',
    row_version: 1,
    deleted_at: options.deletedAt ?? null,
  };
}

function stubRpc(handler: (name: string, args: Record<string, unknown>) => unknown) {
  return {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => ({
      data: handler(name, args),
      error: null,
    })),
  } as never;
}

function stubRpcError(message: string) {
  return { rpc: vi.fn(async () => ({ data: null, error: { message } })) } as never;
}

const override = { workspaceId: WORKSPACE };

function withClient(client: unknown) {
  return { ...override, client: client as never };
}

function parsedRows(raw: Record<string, unknown>[]) {
  return raw.map((row) => parseWorkspaceDocumentRow(row)!);
}

describe('OFFICEPILOT-GENERATED-INVOICE-DOCUMENT-CLOUD-05C1', () => {
  beforeEach(() => {
    resetTestStores();
    resetLastPersistFailureForTests();
    seed();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    resetLastPersistFailureForTests();
  });

  /* ---------------------------------------------------------------------- */
  /* Push                                                                    */
  /* ---------------------------------------------------------------------- */

  it('A: ein neu erzeugtes Dokument wird nach lokalem Erfolg cloudgesichert', async () => {
    const archived = archiveOutgoingInvoice(VORGANG_ID, buildInvoice(), COMPANY);
    expect(archived.success).toBe(true);
    if (!archived.success) return;

    // Lokal steht beides, bevor überhaupt gepusht wird.
    expect(stored().archiveDocumentId).toBe(archived.document.id);

    const sent: Record<string, unknown>[] = [];
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(
      stubRpc((_name, args) => {
        sent.push(args);
        // Die Cloud gibt zurück, was sie gespeichert hat — genau den Request.
        return [
          cloudRow({
            documentId: String(args.p_client_document_id),
            payload: args.p_payload as Record<string, unknown>,
          }),
        ];
      }),
    );
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);

    const outcome = await syncGeneratedInvoiceDocumentToCloud(archived.document);
    expect(outcome).toBe('synced');
    expect(sent).toHaveLength(1);
    expect(sent[0].p_client_document_id).toBe(archived.document.id);
    expect(sent[0].p_linked_invoice_id).toBe(INVOICE_ID);
    expect(sent[0].p_linked_vorgang_id).toBe(VORGANG_ID);
  });

  it('B: ohne dauerhaften lokalen Link wird gar nicht gepusht', async () => {
    // Der lokale Link-Commit scheitert (05B-Vertrag greift).
    let calls = 0;
    const real = persistenceService.persistAll;
    vi.spyOn(persistenceService, 'persistAll').mockImplementation(((...args: unknown[]) => {
      calls += 1;
      if (calls > 1) return { success: false };
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as typeof persistenceService.persistAll);

    const archived = archiveOutgoingInvoice(VORGANG_ID, buildInvoice(), COMPANY);
    expect(archived.success).toBe(false);
    if (archived.success) return;
    expect(archived.reason).toBe('archive_link_persist_failed');

    /*
     * Entscheidend: Es gibt kein `archived.document`, also auch nichts zu
     * pushen. Der Cloud-Aufruf ist an einen erfolgreichen Handoff gebunden —
     * ein Cloud-Dokument ohne gespeicherte lokale Entsprechung wäre eine
     * Behauptung ohne Deckung.
     */
    expect(stored().archiveDocumentId).toBeUndefined();
  });

  it('C: ein Cloud-Fehler lässt das lokale Dokument bestehen und meldet keinen Erfolg', async () => {
    const archived = archiveOutgoingInvoice(VORGANG_ID, buildInvoice(), COMPANY);
    expect(archived.success).toBe(true);
    if (!archived.success) return;

    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(
      stubRpcError('Cloud nicht erreichbar'),
    );

    const outcome = await syncGeneratedInvoiceDocumentToCloud(archived.document);
    expect(outcome).toBe('failed');
    expect(isDocumentCloudSynced(outcome)).toBe(false);

    // Lokal ändert sich nichts — weder Dokument noch Link.
    expect(getDocumentById(archived.document.id)).toBeDefined();
    expect(stored().archiveDocumentId).toBe(archived.document.id);
  });

  it('D: derselbe Push zweimal erzeugt eine Cloud-Zeile', async () => {
    const rows: string[] = [];
    const client = stubRpc((_name, args) => {
      const id = String(args.p_client_document_id);
      if (!rows.includes(id)) rows.push(id);
      return [cloudRow({ documentId: rows[0] })];
    });

    const document = generatedDocument(DOC_A);
    const first = await upsertGeneratedInvoiceDocumentToCloud(
      {
        clientDocumentId: DOC_A,
        linkedInvoiceId: INVOICE_ID,
        linkedVorgangId: VORGANG_ID,
        payload: buildGeneratedInvoiceDocumentPayload(document),
      },
      withClient(client),
    );
    const second = await upsertGeneratedInvoiceDocumentToCloud(
      {
        clientDocumentId: DOC_A,
        linkedInvoiceId: INVOICE_ID,
        linkedVorgangId: VORGANG_ID,
        payload: buildGeneratedInvoiceDocumentPayload(document),
      },
      withClient(client),
    );

    expect(first.outcome).toBe('synced');
    expect(second.outcome).toBe('synced');
    expect(rows).toEqual([DOC_A]);
  });

  it('E: zwei Geräte mit verschiedenen doc-IDs erhalten eine kanonische Zeile', async () => {
    /*
     * Die Cloud hat bereits das Dokument von Gerät A. Gerät B sendet seine
     * eigene Kennung — und bekommt die kanonische Zeile zurück, nicht seine.
     */
    const result = await upsertGeneratedInvoiceDocumentToCloud(
      {
        clientDocumentId: DOC_B,
        linkedInvoiceId: INVOICE_ID,
        linkedVorgangId: VORGANG_ID,
        payload: buildGeneratedInvoiceDocumentPayload(generatedDocument(DOC_B)),
      },
      withClient(stubRpc(() => [cloudRow({ documentId: DOC_A })])),
    );

    expect(result.outcome).toBe('synced');
    // Abweichende Kennung ist kein Fehler — sie ist die Antwort.
    expect(result.row?.clientDocumentId).toBe(DOC_A);
    expect(result.row?.linkedInvoiceId).toBe(INVOICE_ID);
  });

  it('E2: eine fremde Kennung mit fremdem Payload ist kein Erfolg', async () => {
    // Kam unsere eigene Kennung zurück, muss auch der Payload unserer sein.
    const result = await upsertGeneratedInvoiceDocumentToCloud(
      {
        clientDocumentId: DOC_A,
        linkedInvoiceId: INVOICE_ID,
        linkedVorgangId: VORGANG_ID,
        payload: buildGeneratedInvoiceDocumentPayload(generatedDocument(DOC_A)),
      },
      withClient(
        stubRpc(() => [
          cloudRow({ documentId: DOC_A, payload: { title: 'Etwas ganz anderes' } }),
        ]),
      ),
    );

    expect(result.outcome).toBe('failed');
  });

  /* ---------------------------------------------------------------------- */
  /* Pull und Merge                                                          */
  /* ---------------------------------------------------------------------- */

  it('F/G/H: eine frische Origin erhält Dokument, Link und archiveDocumentId', async () => {
    // Frische Origin: Rechnung da (aus der Rechnungs-Cloud), Dokument nicht.
    expect(getAllDocuments()).toHaveLength(0);
    expect(stored().archiveDocumentId).toBeUndefined();

    const result = await applyDocumentCloudPull(
      withClient(stubRpc(() => [cloudRow({ documentId: DOC_A })])),
    );

    expect(result.outcome).toBe('synced');
    expect(result.rowCount).toBe(1);

    // F: Das Dokument ist da.
    const document = getDocumentById(DOC_A);
    expect(document).toBeDefined();
    expect(document?.category).toBe('ausgangsrechnung');
    expect(document?.classifiedKind).toBe('ausgangsrechnung');

    // G: Die Verknüpfung stimmt — in beide Richtungen auflösbar.
    expect(document?.linkedInvoiceId).toBe(INVOICE_ID);
    expect(getDocumentByLinkedInvoiceId(INVOICE_ID)?.id).toBe(DOC_A);

    // H: Der lokale Komfort-Verweis ist rekonstruiert.
    expect(result.relinked).toBe(1);
    expect(stored().archiveDocumentId).toBe(DOC_A);
  });

  it('I: archiveDocumentId wird nicht zur zweiten Cloud-Wahrheit', () => {
    /*
     * Der Payload beschreibt das Dokument, nicht die Rechnung. Er trägt die
     * Beziehung nur in einer Richtung — über `linkedInvoiceId`.
     */
    const payload = buildGeneratedInvoiceDocumentPayload(generatedDocument(DOC_A));
    expect(payload.linkedInvoiceId).toBe(INVOICE_ID);
    expect(payload).not.toHaveProperty('archiveDocumentId');
    expect(JSON.stringify(payload)).not.toContain('archiveDocumentId');
  });

  it('J: die globale Suche findet das cloudgezogene Dokument', async () => {
    await applyDocumentCloudPull(withClient(stubRpc(() => [cloudRow({ documentId: DOC_A })])));

    const byNumber = searchDocuments('2026-0002', 'all');
    expect(byNumber.map((doc) => doc.id)).toContain(DOC_A);

    const byTitle = searchDocuments('Rechnung', 'all');
    expect(byTitle.map((doc) => doc.id)).toContain(DOC_A);
  });

  it('K/L: das gezogene Dokument trägt keine Dateireferenz', async () => {
    await applyDocumentCloudPull(withClient(stubRpc(() => [cloudRow({ documentId: DOC_A })])));

    const document = getDocumentById(DOC_A)!;
    // K: nutzbar ohne Datei.
    expect(document.title).toBe('2026-0002 – Rechnung');
    // L: keine vorgetäuschte Datei aus einer fremden Origin.
    expect(document.fileRefId).toBeUndefined();
    expect(document.sourceFileHash).toBeUndefined();
    expect(document.fileSize).toBeUndefined();

    const payload = buildGeneratedInvoiceDocumentPayload(generatedDocument(DOC_A));
    for (const key of ['fileRefId', 'sourceFileHash', 'fileSize', 'storagePath']) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('J2: zwei lokale doc-IDs für dieselbe Rechnung werden zusammengeführt', () => {
    // Gerät B hat lokal ein eigenes Dokument für dieselbe Rechnung.
    hydrateDocumentStore([generatedDocument(DOC_B)]);

    const merged = mergeCloudDocuments(
      [generatedDocument(DOC_B)],
      parsedRows([cloudRow({ documentId: DOC_A })]),
    );

    // Genau eine Karte für dieselbe Ausgangsrechnung.
    const forInvoice = merged.filter((doc) => doc.linkedInvoiceId === INVOICE_ID);
    expect(forInvoice).toHaveLength(1);
    expect(forInvoice[0].id).toBe(DOC_A);
  });

  /* ---------------------------------------------------------------------- */
  /* Tombstone                                                               */
  /* ---------------------------------------------------------------------- */

  it('M: ein Cloud-Grabstein deaktiviert die alte lokale Kopie', () => {
    const merged = mergeCloudDocuments(
      [generatedDocument(DOC_A)],
      parsedRows([cloudRow({ documentId: DOC_A, deletedAt: '2026-08-26T10:00:00.000Z' })]),
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].sync?.deleted).toBe(true);
  });

  it('M2: der Grabstein gewinnt auch gegen eine abweichende lokale Kennung', () => {
    const merged = mergeCloudDocuments(
      [generatedDocument(DOC_B)],
      parsedRows([cloudRow({ documentId: DOC_A, deletedAt: '2026-08-26T10:00:00.000Z' })]),
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].sync?.deleted).toBe(true);
  });

  it('N: ein zweiter Pull belebt den Grabstein nicht wieder', () => {
    const tombstone = parsedRows([
      cloudRow({ documentId: DOC_A, deletedAt: '2026-08-26T10:00:00.000Z' }),
    ]);

    const once = mergeCloudDocuments([generatedDocument(DOC_A)], tombstone);
    const twice = mergeCloudDocuments(once, tombstone);

    expect(twice).toHaveLength(1);
    expect(twice[0].sync?.deleted).toBe(true);
  });

  it('N2: das Reversal-RPC ist idempotent auswertbar', async () => {
    const result = await tombstoneDocumentInCloud(
      { clientDocumentId: DOC_A },
      withClient(
        stubRpc(() => [cloudRow({ documentId: DOC_A, deletedAt: '2026-08-26T10:00:00.000Z' })]),
      ),
    );

    expect(result.outcome).toBe('synced');
    expect(result.row?.deletedAt).toBe('2026-08-26T10:00:00.000Z');

    // Eine Zeile ohne Grabstein wäre kein Löscherfolg.
    const notDeleted = await tombstoneDocumentInCloud(
      { clientDocumentId: DOC_A },
      withClient(stubRpc(() => [cloudRow({ documentId: DOC_A })])),
    );
    expect(notDeleted.outcome).toBe('failed');
  });

  /* ---------------------------------------------------------------------- */
  /* Abgrenzung                                                              */
  /* ---------------------------------------------------------------------- */

  it('O: Fremddokumente werden weder gepusht noch vom Merge angefasst', async () => {
    const beleg = uploadedDocument('doc-beleg-1');
    expect(isCloudEligibleGeneratedInvoiceDocument(beleg)).toBe(false);

    // Kein Push — und zwar bevor irgendein Netzaufruf stattfindet.
    const rpcCalls: string[] = [];
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(
      stubRpc((name) => {
        rpcCalls.push(name);
        return [cloudRow({ documentId: DOC_A })];
      }),
    );
    const outcome = await syncGeneratedInvoiceDocumentToCloud(beleg);
    /*
     * 05C1B — `not_applicable`, nicht `failed`: Hier war nie etwas zu sichern.
     * Ein Fehlschlag würde eine Warnung auslösen, die schlicht falsch wäre.
     */
    expect(outcome).toBe('not_applicable');
    expect(isGeneratedInvoiceDocumentSyncSilent(outcome)).toBe(true);
    expect(rpcCalls).toEqual([]);

    // Und der Merge lässt ihn unverändert stehen.
    const merged = mergeCloudDocuments([beleg], parsedRows([cloudRow({ documentId: DOC_A })]));
    const kept = merged.find((doc) => doc.id === 'doc-beleg-1');
    expect(kept).toEqual(beleg);
  });

  it('O2: eine eingescannte fremde Ausgangsrechnung ohne Rechnungsbezug reist nicht', () => {
    const scanned = uploadedDocument('doc-scan-1', {
      category: 'ausgangsrechnung',
      classifiedKind: 'ausgangsrechnung',
      linkedInvoiceId: null,
    });
    // Die Kategorie allein genügt nicht — der Rechnungsbezug entscheidet.
    expect(isCloudEligibleGeneratedInvoiceDocument(scanned)).toBe(false);
  });

  it('O3: der Pull integriert keine fremden Dokumentarten', async () => {
    const result = await pullDocumentsFromCloud(
      withClient(
        stubRpc(() => [
          cloudRow({ documentId: DOC_A }),
          cloudRow({ documentId: 'doc-fremd-1', kind: 'uploaded' }),
        ]),
      ),
    );

    expect(result.outcome).toBe('synced');
    if (result.outcome !== 'synced') return;
    expect(result.rows.map((row) => row.clientDocumentId)).toEqual([DOC_A]);
  });

  /* ---------------------------------------------------------------------- */
  /* Bekannt vs. unbekannt                                                   */
  /* ---------------------------------------------------------------------- */

  it('P: ein leerer erfolgreicher Pull ist ein bekannter Stand', async () => {
    const pulled = await pullDocumentsFromCloud(withClient(stubRpc(() => [])));

    expect(pulled.outcome).toBe('synced');
    expect(pulled).toHaveProperty('rows');
    if (pulled.outcome !== 'synced') return;
    expect(pulled.rows).toEqual([]);
  });

  it('Q: ohne Workspace und bei Fehlern gibt es keinen falschen Erfolg', async () => {
    const missingWorkspace = await pullDocumentsFromCloud({
      client: stubRpc(() => []) as never,
      workspaceId: '',
    });
    expect(missingWorkspace.outcome).toBe('workspace_missing');
    expect(missingWorkspace).not.toHaveProperty('rows');

    const failed = await pullDocumentsFromCloud(withClient(stubRpcError('Cloud kaputt')));
    expect(failed.outcome).toBe('failed');
    expect(failed).not.toHaveProperty('rows');

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    const notConfigured = await pullDocumentsFromCloud();
    expect(notConfigured.outcome).toBe('supabase_not_configured');

    // Ein gescheiterter Pull ändert den lokalen Bestand nicht.
    hydrateDocumentStore([generatedDocument(DOC_A)]);
    const applied = await applyDocumentCloudPull(withClient(stubRpcError('Cloud kaputt')));
    expect(applied.outcome).toBe('failed');
    expect(getDocumentById(DOC_A)).toBeDefined();
  });

  it('Q2: historische lokale Dokumente werden nicht von selbst hochgeladen', async () => {
    hydrateDocumentStore([generatedDocument(DOC_A)]);

    const rpcCalls: string[] = [];
    await applyDocumentCloudPull(
      withClient(
        stubRpc((name) => {
          rpcCalls.push(name);
          return [];
        }),
      ),
    );

    // Nur gelesen. Kein Upsert, kein Auto-Scan, keine Recovery — das ist 05D.
    expect(rpcCalls).toEqual(['pull_workspace_documents']);
    expect(getDocumentById(DOC_A)).toBeDefined();
  });
});
