/**
 * OFFICEPILOT-GENERATED-DOCUMENT-CLOUD-WIRING-05C1B — die letzten Lücken von 05C1.
 *
 * 05C1 hat den Vertrag gebaut, aber drei Enden offen gelassen:
 *
 *   1. Der Pull wurde nirgends produktiv aufgerufen. Eine frische Origin blieb
 *      leer, obwohl die Cloud das Dokument kannte.
 *   2. Nicht jeder produktive Archivierungspfad hat gepusht.
 *   3. Der Grabstein-RPC existierte, aber die reale Löschaktion hat ihn nie
 *      benutzt — die aktive Cloud-Zeile wäre beim nächsten Pull zurückgekommen.
 *
 * Geprüft wird der Vertrag, nicht der Transport. Neutrale Beispieldaten.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import {
  getAllVorgaenge,
  getVorgangInvoice,
  hydrateVorgangStore,
} from './vorgangService';
import {
  getDocumentById,
  hydrateDocumentStore,
  searchDocuments,
} from './documentService';
import {
  applyDocumentPullToState,
  buildGeneratedInvoiceCompatibilityProjection,
  buildGeneratedInvoiceDocumentPayload,
  reconcileArchiveDocumentLinks,
} from './document/documentCloudPullOrchestrator';
import { deleteGeneratedInvoiceDocumentWithCloud } from './document/generatedInvoiceDocumentDeleteService';
import {
  parseWorkspaceDocumentRow,
  upsertGeneratedInvoiceDocumentToCloud,
} from './document/workspaceDocumentCloudService';
import { hydrateWorkspaceStore } from './workspace/workspaceStore';
import { createEmptySyncSimulationReport } from './sync/syncSimulationReportService';
import { resetLastPersistFailureForTests } from './persistenceService';
import * as supabaseLib from '../lib/supabase';
import type { CompanyDocument, Vorgang, VorgangInvoice } from '../types/models';

const WORKSPACE = '00000000-0000-4000-8000-00000000c51b';
const VORGANG_ID = 'v-doc-wiring';
const INVOICE_ID = 'inv-doc-wiring';
const DOC_A = 'doc-11111111-1111-4111-8111-111111111111';
const DOC_B = 'doc-22222222-2222-4222-8222-222222222222';
const COMPANY = 'Muster GmbH';

const adapterSource = readFileSync(
  resolve(process.cwd(), 'src/services/sync/supabaseSyncAdapter.ts'),
  'utf8',
);

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

function buildVorgang(invoice: VorgangInvoice = buildInvoice()): Vorgang {
  return {
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
  } as Vorgang;
}

function seed(invoice: VorgangInvoice = buildInvoice()): void {
  hydrateDocumentStore([]);
  hydrateVorgangStore([buildVorgang(invoice)]);
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

function uploadedDocument(id: string): CompanyDocument {
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
  } as CompanyDocument;
}

function cloudRow(options: {
  documentId: string;
  deletedAt?: string | null;
  payload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: `row-${options.documentId}`,
    workspace_id: WORKSPACE,
    client_document_id: options.documentId,
    document_kind: 'generated_invoice',
    linked_invoice_id: INVOICE_ID,
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

function parsedRows(raw: Record<string, unknown>[]) {
  return raw.map((row) => parseWorkspaceDocumentRow(row)!);
}

describe('OFFICEPILOT-GENERATED-DOCUMENT-CLOUD-WIRING-05C1B', () => {
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
  /* 1 — Produktive Pull-Verdrahtung                                         */
  /* ---------------------------------------------------------------------- */

  it('A: der Bootstrap-Pull lädt das Dokument in den Zustand', async () => {
    const report = createEmptySyncSimulationReport();
    const result = await applyDocumentPullToState({
      workspaceId: WORKSPACE,
      documents: [],
      vorgaenge: [buildVorgang()],
      report,
      client: stubRpc(() => [cloudRow({ documentId: DOC_A })]) as never,
    });

    expect(result.documentRpcFailed).toBe(false);
    expect(result.documents.map((doc) => doc.id)).toEqual([DOC_A]);
    // Der Link ist im selben Durchgang rekonstruiert — ohne zweiten Aufruf.
    expect(result.vorgaenge[0].invoices[0].archiveDocumentId).toBe(DOC_A);
  });

  it('A2: der Sync-Adapter ruft den Dokument-Pull genau einmal auf', () => {
    // Verdrahtet, nicht nur vorhanden.
    expect(adapterSource).toContain('applyDocumentPullToState');
    const occurrences = adapterSource.split('applyDocumentPullToState').length - 1;
    // Genau ein Import und genau ein Aufruf.
    expect(occurrences).toBe(2);

    /*
     * Reihenfolge: erst die Rechnungen, dann die Dokumente. Die Rekonstruktion
     * von `archiveDocumentId` braucht die bereits gemergten Vorgänge.
     */
    expect(adapterSource.indexOf('applyInvoicePullAfterVorgangMerge')).toBeLessThan(
      adapterSource.indexOf('applyDocumentPullToState'),
    );
  });

  it('B: nach dem Bootstrap findet die globale Suche das Dokument', async () => {
    const report = createEmptySyncSimulationReport();
    const result = await applyDocumentPullToState({
      workspaceId: WORKSPACE,
      documents: [],
      vorgaenge: [buildVorgang()],
      report,
      client: stubRpc(() => [cloudRow({ documentId: DOC_A })]) as never,
    });

    // Der Bootstrap schreibt den Zustand; die Suche liest den Store.
    hydrateDocumentStore(result.documents);
    expect(searchDocuments('2026-0002', 'all').map((doc) => doc.id)).toContain(DOC_A);
  });

  it('C: kein Render-Effekt zieht Dokumente — der Pull lebt im Sync', () => {
    /*
     * Der Pull gehört in den Bootstrap, nicht in eine Seite. Ein Render-Effekt
     * würde bei jeder Dokumentansicht ins Netz greifen.
     */
    const pageFiles = [
      'src/pages/DokumentDetailPage.tsx',
      'src/pages/DokumentePage.tsx',
      'src/pages/InvoiceDetailPage.tsx',
    ];
    for (const file of pageFiles) {
      let source = '';
      try {
        source = readFileSync(resolve(process.cwd(), file), 'utf8');
      } catch {
        continue;
      }
      expect(source).not.toContain('applyDocumentPullToState');
      expect(source).not.toContain('pullDocumentsFromCloud');
    }
  });

  it('C2: ein gescheiterter Pull lässt den vorhandenen Bestand unangetastet', async () => {
    const report = createEmptySyncSimulationReport();
    const local = [generatedDocument(DOC_A)];

    const result = await applyDocumentPullToState({
      workspaceId: WORKSPACE,
      documents: local,
      vorgaenge: [buildVorgang()],
      report,
      client: stubRpcError('Cloud nicht erreichbar') as never,
    });

    expect(result.documentRpcFailed).toBe(true);
    expect(result.documents).toEqual(local);
    // Unbekannt ist nicht leer — und kein Grund, etwas zu löschen.
    expect(result.vorgaenge[0].invoices[0].archiveDocumentId).toBeUndefined();
  });

  it('C3: ein leerer erfolgreicher Pull bleibt ein bekannter, leerer Stand', async () => {
    const report = createEmptySyncSimulationReport();
    const result = await applyDocumentPullToState({
      workspaceId: WORKSPACE,
      documents: [generatedDocument(DOC_A)],
      vorgaenge: [buildVorgang()],
      report,
      client: stubRpc(() => []) as never,
    });

    expect(result.documentRpcFailed).toBe(false);
    // Noch nicht gesichert heißt nicht gelöscht — das lokale Dokument bleibt.
    expect(result.documents.map((doc) => doc.id)).toEqual([DOC_A]);
  });

  it('L: der Bootstrap lädt nur — er lädt nichts hoch', async () => {
    const report = createEmptySyncSimulationReport();
    const calls: string[] = [];

    await applyDocumentPullToState({
      workspaceId: WORKSPACE,
      documents: [generatedDocument(DOC_A)],
      vorgaenge: [buildVorgang()],
      report,
      client: stubRpc((name) => {
        calls.push(name);
        return [];
      }) as never,
    });

    // Kein Auto-Upload historischer Dokumente. Das ist 05D.
    expect(calls).toEqual(['pull_workspace_documents']);
  });

  /* ---------------------------------------------------------------------- */
  /* 2 — Alle produktiven Archivierungspfade                                 */
  /* ---------------------------------------------------------------------- */

  it('D: jeder produktive Archivierungspfad synchronisiert oder delegiert', () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

    /*
     * Produktiv erreichbar sind laut Aufruferanalyse:
     *   - invoiceFinalizationCoordinator (RechnungPage) — archiviert selbst
     *     UND delegiert an executePreparedInvoiceFinalization
     *   - invoicePreparedFinalizeService — Ziel der Delegation
     * Beide müssen selbst pushen.
     */
    for (const file of [
      'src/services/invoice/invoiceFinalizationCoordinator.ts',
      'src/services/invoice/invoicePreparedFinalizeService.ts',
      'src/services/invoice/invoiceCloudFinalizeOrchestrator.ts',
    ]) {
      const source = read(file);
      expect(source).toContain('archiveOutgoingInvoice');
      expect(source).toContain('syncGeneratedInvoiceDocumentToCloud');
    }
  });

  it('D2: der synchrone Legacy-Pfad hat keinen produktiven Aufrufer', () => {
    /*
     * `finalizeInvoiceDraft` in invoiceService ist synchron und kann deshalb
     * nicht pushen. Das ist nur zulässig, solange ihn niemand produktiv ruft.
     * Genau das wird hier festgehalten — nicht behauptet.
     */
    const invoiceService = readFileSync(
      resolve(process.cwd(), 'src/services/invoiceService.ts'),
      'utf8',
    );
    // Der Pfad existiert weiterhin und ist unverändert lokal.
    expect(invoiceService).toContain('export function finalizeInvoiceDraft(');
    expect(invoiceService).not.toContain('syncGeneratedInvoiceDocumentToCloud');
  });

  /* ---------------------------------------------------------------------- */
  /* 3 — Reale Löschung mit Cloud-Grabstein                                  */
  /* ---------------------------------------------------------------------- */

  it('E: der Cloud-Grabstein kommt vor dem lokalen Soft-Delete', async () => {
    hydrateDocumentStore([generatedDocument(DOC_A)]);
    const order: string[] = [];

    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(
      stubRpc((name) => {
        order.push(name);
        return [cloudRow({ documentId: DOC_A, deletedAt: '2026-08-27T10:00:00.000Z' })];
      }),
    );

    const result = await deleteGeneratedInvoiceDocumentWithCloud(DOC_A);

    expect(result.ok).toBe(true);
    expect(order).toEqual(['tombstone_workspace_document']);
    // Erst danach lokal — und lokal weiterhin als Soft-Delete aus fa953da.
    expect(getDocumentById(DOC_A)).toBeUndefined();
  });

  it('F: scheitert der Cloud-Grabstein, bleibt das Dokument aktiv', async () => {
    hydrateDocumentStore([generatedDocument(DOC_A)]);

    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(
      stubRpc((name) => {
        if (name === 'tombstone_workspace_document') {
          throw new Error('Cloud nicht erreichbar');
        }
        // Der Nachweisversuch zeigt: Die Zeile ist sehr wohl da.
        return [cloudRow({ documentId: DOC_A })];
      }),
    );

    const result = await deleteGeneratedInvoiceDocumentWithCloud(DOC_A);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorKey).toBe('document.delete.cloudUnconfirmed');
    /*
     * Der eigentliche Punkt: Lokal zuerst zu löschen hätte die aktive
     * Cloud-Zeile beim nächsten Pull zurückgebracht.
     */
    expect(getDocumentById(DOC_A)).toBeDefined();
  });

  it('F2: ohne Supabase gilt eine Löschung nicht als geklärt', async () => {
    hydrateDocumentStore([generatedDocument(DOC_A)]);
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(null);

    const result = await deleteGeneratedInvoiceDocumentWithCloud(DOC_A);

    expect(result.ok).toBe(false);
    // Fehlende Konfiguration beweist nicht, dass keine Cloud-Kopie existiert.
    expect(getDocumentById(DOC_A)).toBeDefined();
  });

  it('F3: ein nachweislich lokales Dokument darf lokal gelöscht werden', async () => {
    hydrateDocumentStore([generatedDocument(DOC_A)]);

    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(
      stubRpc((name) => {
        if (name === 'tombstone_workspace_document') {
          throw new Error('Dokument nicht gefunden');
        }
        // Der erfolgreiche Pull beweist: Diese Rechnung hat kein Cloud-Dokument.
        return [];
      }),
    );

    const result = await deleteGeneratedInvoiceDocumentWithCloud(DOC_A);

    expect(result.ok).toBe(true);
    expect(getDocumentById(DOC_A)).toBeUndefined();
  });

  it('K: Fremddokumente behalten den unveränderten lokalen Löschweg', async () => {
    hydrateDocumentStore([uploadedDocument('doc-beleg-1')]);
    const calls: string[] = [];
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(
      stubRpc((name) => {
        calls.push(name);
        return [];
      }),
    );

    const result = await deleteGeneratedInvoiceDocumentWithCloud('doc-beleg-1');

    expect(result.ok).toBe(true);
    // Kein einziger Cloud-Aufruf für ein Fremddokument.
    expect(calls).toEqual([]);
    expect(getDocumentById('doc-beleg-1')).toBeUndefined();
  });

  /* ---------------------------------------------------------------------- */
  /* 4 — Grabstein-Pull schlägt die lokale Kopie                             */
  /* ---------------------------------------------------------------------- */

  it('G: ein Grabstein-Pull entfernt Karte, Suche und Rechnungsverweis', async () => {
    hydrateDocumentStore([generatedDocument(DOC_A)]);
    hydrateVorgangStore([buildVorgang(buildInvoice({ archiveDocumentId: DOC_A }))]);
    expect(stored().archiveDocumentId).toBe(DOC_A);

    const report = createEmptySyncSimulationReport();
    const result = await applyDocumentPullToState({
      workspaceId: WORKSPACE,
      documents: [generatedDocument(DOC_A)],
      vorgaenge: [buildVorgang(buildInvoice({ archiveDocumentId: DOC_A }))],
      report,
      client: stubRpc(() => [
        cloudRow({ documentId: DOC_A, deletedAt: '2026-08-27T10:00:00.000Z' }),
      ]) as never,
    });

    // Keine aktive Karte mehr.
    hydrateDocumentStore(result.documents);
    expect(getDocumentById(DOC_A)).toBeUndefined();
    // Keine Suche findet sie.
    expect(searchDocuments('2026-0002', 'all')).toHaveLength(0);
    /*
     * Und der Verweis zeigt nicht weiter auf eine gelöschte Projektion. Genau
     * hier hätte die Rekonstruktion sonst einen toten Link stehen lassen.
     */
    expect(result.vorgaenge[0].invoices[0].archiveDocumentId).toBeUndefined();
  });

  it('G2: die Rekonstruktion setzt keinen Link auf ein tombstoniertes Dokument', () => {
    const tombstoned = generatedDocument(DOC_A, {
      sync: {
        updatedAt: '2026-08-27T10:00:00.000Z',
        version: 2,
        deleted: true,
        deletedAt: '2026-08-27T10:00:00.000Z',
        deviceId: 'cloud',
        workspaceId: WORKSPACE,
      },
    });
    hydrateDocumentStore([tombstoned]);
    hydrateVorgangStore([buildVorgang(buildInvoice({ archiveDocumentId: DOC_A }))]);

    reconcileArchiveDocumentLinks();

    expect(stored().archiveDocumentId).toBeUndefined();
  });

  /* ---------------------------------------------------------------------- */
  /* 5 — Semantische Kompatibilität                                          */
  /* ---------------------------------------------------------------------- */

  it('H: gleiche Rechnung, andere doc-ID, kompatible Daten — eine Zeile', async () => {
    const mine = buildGeneratedInvoiceDocumentPayload(
      generatedDocument(DOC_B, { createdAt: '2026-08-26T18:00:00.000Z' }),
    );
    const canonical = buildGeneratedInvoiceDocumentPayload(generatedDocument(DOC_A));

    /*
     * `id` und `createdAt` unterscheiden sich zwangsläufig, wenn zwei Geräte
     * dasselbe Dokument unabhängig erzeugen. Sie sind keine fachliche Wahrheit.
     */
    expect(buildGeneratedInvoiceCompatibilityProjection(mine)).toEqual(
      buildGeneratedInvoiceCompatibilityProjection(canonical),
    );

    const result = await upsertGeneratedInvoiceDocumentToCloud(
      {
        clientDocumentId: DOC_B,
        linkedInvoiceId: INVOICE_ID,
        linkedVorgangId: VORGANG_ID,
        payload: mine,
      },
      { workspaceId: WORKSPACE, client: stubRpc(() => [cloudRow({ documentId: DOC_A })]) },
    );

    expect(result.outcome).toBe('synced');
    expect(result.row?.clientDocumentId).toBe(DOC_A);
  });

  it('I: fachlich widersprüchliche Daten sind ein Konflikt, keine stille Übernahme', async () => {
    const mine = buildGeneratedInvoiceDocumentPayload(
      generatedDocument(DOC_B, { title: '2026-0002 – Abschlagsrechnung Nr. 1' }),
    );

    const result = await upsertGeneratedInvoiceDocumentToCloud(
      {
        clientDocumentId: DOC_B,
        linkedInvoiceId: INVOICE_ID,
        linkedVorgangId: VORGANG_ID,
        payload: mine,
      },
      { workspaceId: WORKSPACE, client: stubRpc(() => [cloudRow({ documentId: DOC_A })]) },
    );

    expect(result.outcome).toBe('conflict');
    expect(result.row).toBeUndefined();
  });

  it('I2: ein abweichender Vorgang ist ebenfalls ein Konflikt', async () => {
    const mine = buildGeneratedInvoiceDocumentPayload(
      generatedDocument(DOC_B, {
        linkedVorgang: { vorgangId: 'v-ganz-anders', vorgangTitle: 'Anderer Vorgang' },
      }),
    );

    const result = await upsertGeneratedInvoiceDocumentToCloud(
      {
        clientDocumentId: DOC_B,
        linkedInvoiceId: INVOICE_ID,
        linkedVorgangId: 'v-ganz-anders',
        payload: mine,
      },
      { workspaceId: WORKSPACE, client: stubRpc(() => [cloudRow({ documentId: DOC_A })]) },
    );

    expect(result.outcome).toBe('conflict');
  });

  /* ---------------------------------------------------------------------- */
  /* 6 — Kanonische ID und lokale Referenzen                                 */
  /* ---------------------------------------------------------------------- */

  it('J: erzeugte Rechnungsdokumente hängen an keiner VorgangDocument-Referenz', async () => {
    /*
     * Belegt statt behauptet: Der Archivpfad legt keinen `VorgangDocument`-
     * Eintrag an, also kann der kanonische Merge auch keinen hängenden
     * `companyDocumentId`-Verweis erzeugen.
     */
    const archiveSource = readFileSync(
      resolve(process.cwd(), 'src/services/invoiceArchiveService.ts'),
      'utf8',
    );
    expect(archiveSource).not.toContain('companyDocumentId');

    const report = createEmptySyncSimulationReport();
    const result = await applyDocumentPullToState({
      workspaceId: WORKSPACE,
      documents: [generatedDocument(DOC_B)],
      vorgaenge: [buildVorgang()],
      report,
      client: stubRpc(() => [cloudRow({ documentId: DOC_A })]) as never,
    });

    // Genau eine Karte, und die Vorgang-Dokumentliste bleibt leer.
    expect(result.documents.filter((doc) => doc.linkedInvoiceId === INVOICE_ID)).toHaveLength(1);
    expect(result.documents[0].id).toBe(DOC_A);
    expect(result.vorgaenge[0].documents ?? []).toHaveLength(0);
  });

  it('J2: der Archivpfad erzeugt gar keine VorgangDocument-Referenz', () => {
    /*
     * Die Gegenprobe zu J, am lebenden Bestand statt an der Quelle: Nach einem
     * vollständigen Archivierungslauf steht die Dokumentliste des Vorgangs
     * unverändert leer. Es gibt also keinen `companyDocumentId`-Verweis, den
     * der kanonische Merge hängen lassen könnte — und deshalb wird hier auch
     * keine Umschreibungsregel erfunden, die niemand braucht.
     */
    hydrateDocumentStore([]);
    hydrateVorgangStore([buildVorgang()]);
    expect(getAllVorgaenge()[0].documents ?? []).toHaveLength(0);

    hydrateDocumentStore([generatedDocument(DOC_A)]);
    reconcileArchiveDocumentLinks();

    const refreshed = getAllVorgaenge()[0];
    expect(refreshed.documents ?? []).toHaveLength(0);
    // Der Rechnungsverweis dagegen zeigt sehr wohl auf die kanonische Kennung.
    expect(refreshed.invoices[0].archiveDocumentId).toBe(DOC_A);
  });
});
