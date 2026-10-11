/**
 * GO-LIVE-SECURITY-01 / FINALISIERUNG — Identität der Rechnungsbelege und Vertrauensmarke im Sync.
 *
 * Reine Funktionen und Speicher, kein Netzwerk. Geprüft:
 *  - Ein Archivdokument aus dem Eingangsweg gibt sich nicht als Rechnungs- oder
 *    Korrekturbeleg aus — weder neu gezogen noch als Bestand auf dem Gerät; ein
 *    gewöhnlicher Rechnungsbezug (etwa ein Zahlungsavis) bleibt; nur die Spalte zählt.
 *  - Die Suche nach dem Beleg einer Rechnung bevorzugt den erzeugten Rechnungsbeleg.
 *  - Die Vertrauensmarke kommt mit dem Abzug, auch ohne neue Version, nur für dieselbe Datei.
 *  - Der Bindungsspeicher behält Serverstand und Marke.
 *  - Eine abgewiesene E-Rechnungsbindung weicht dem Cloud-Stand; andere Abweisungen bleiben.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppPersistedState, CompanyDocument } from '../../types/models';
import type { DocumentFileRepresentationBinding } from '../../types/documentFileRepresentationBinding';
import type { SyncMeta, SyncOutboxEntry } from '../../types/sync';
import {
  applyIntakePullToState,
  mapCloudArchivedDocumentRow,
  mergeBindingsFromPull,
  planRoleDeniedEInvoiceBindingRelease,
  withoutInvoiceDocumentClaim,
  type CloudArchivedDocumentRow,
  type CloudBindingRow,
  type IntakeCloudPull,
} from './intakeCloudSyncService';
import { buildArchiveDocumentIdByInvoice } from './documentCloudPullOrchestrator';
import { getDocumentByLinkedInvoiceId, hydrateDocumentStore } from '../documentService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
} from '../documentFileRepresentationBindingStoreService';
import { resetTestStores } from '../../test/resetStores';

const WS = '00000000-0000-4000-8000-00000000f1a1';
const KONTEXT = { deviceId: 'geraet-1', workspaceId: WS, dirty: new Set<string>() };
const meta = (version: number): SyncMeta => ({ updatedAt: '2026-10-10T08:00:00.000Z', version, deleted: false, deviceId: 'geraet-1', workspaceId: WS });

function archivZeile(o: Partial<CloudArchivedDocumentRow> = {}): CloudArchivedDocumentRow {
  return {
    client_document_id: 'doc-falsch',
    document_kind: 'archived_document',
    linked_invoice_id: null,
    linked_vorgang_id: null,
    payload: {
      id: 'doc-falsch',
      title: 'Rechnung 2026-0005',
      category: 'ausgangsrechnung',
      classifiedKind: 'ausgangsrechnung',
      linkedInvoiceId: 'inv-5',
    },
    updated_at: '2026-10-10T08:00:00.000Z',
    deleted: false,
    row_version: 1,
    ...o,
  };
}

function bindungZeile(o: Partial<CloudBindingRow> = {}): CloudBindingRow {
  return {
    client_document_id: 'doc-rechnung',
    client_file_ref_id: 'file-mitglied',
    binding_kind: 'structured',
    part: 'xrechnung-cii',
    provenance: 'derived',
    updated_at: '2026-10-10T08:00:00.000Z',
    deleted: false,
    row_version: 1,
    einvoice_untrusted_at: '2026-11-07T12:00:00.000Z',
    einvoice_untrusted_reason: 'bindung_nicht_von_inhaber_oder_admin',
    ...o,
  };
}

function lokal(o: Partial<DocumentFileRepresentationBinding> = {}): DocumentFileRepresentationBinding {
  return { documentId: 'doc-rechnung', kind: 'structured', part: 'xrechnung-cii', fileRefId: 'file-mitglied', sync: meta(1), ...o };
}

function abgewiesen(entityType: SyncOutboxEntry['entityType'], entityId: string): SyncOutboxEntry {
  return {
    id: `out-${entityType}-${entityId}`,
    entityType,
    entityId,
    operation: 'create',
    version: 1,
    queuedAt: '2026-10-10T08:00:00.000Z',
    retryCount: 1,
    status: 'error',
    lastErrorMessage: 'Keine Schreibberechtigung',
    lastErrorAt: '2026-10-10T08:00:05.000Z',
    lastErrorRetryable: false,
  };
}

function abzug(o: Partial<IntakeCloudPull> = {}): IntakeCloudPull {
  return { files: [], bindings: [], inboxItems: [], workResults: [], archivedDocuments: [], ...o };
}

function zustand(o: Partial<AppPersistedState>): AppPersistedState {
  return {
    inboxItems: [],
    documents: [],
    documentFileRefs: [],
    documentFileRepresentationBindings: [],
    documentWorkResults: [],
    syncOutbox: [],
    ...o,
  } as unknown as AppPersistedState;
}

beforeEach(() => {
  resetTestStores();
});

describe('FINALISIERUNG — ein Archivdokument ist kein Rechnungsbeleg', () => {
  it('R1: vorgeblicher Rechnungsbeleg aus dem Abzug verliert den Rechnungsbezug — Spalte wie Nutzlast', () => {
    const nurNutzlast = mapCloudArchivedDocumentRow(archivZeile(), undefined, undefined, KONTEXT);
    expect(nurNutzlast.linkedInvoiceId).toBeNull();
    expect(nurNutzlast.title).toBe('Rechnung 2026-0005');

    const mitSpalte = mapCloudArchivedDocumentRow(archivZeile({ linked_invoice_id: 'inv-5' }), undefined, undefined, KONTEXT);
    expect(mitSpalte.linkedInvoiceId).toBeNull();

    const korrektur = mapCloudArchivedDocumentRow(
      archivZeile({ linked_invoice_id: 'inv-5', payload: { id: 'doc-falsch', title: 'Storno', classifiedKind: 'rechnungskorrektur' } }),
      undefined,
      undefined,
      KONTEXT,
    );
    expect(korrektur.linkedInvoiceId).toBeNull();
  });

  it('R2: ein gewöhnlicher Rechnungsbezug bleibt; die Nutzlast allein begründet keinen', () => {
    const avis = mapCloudArchivedDocumentRow(
      archivZeile({ linked_invoice_id: 'inv-5', payload: { id: 'doc-falsch', title: 'Zahlungsavis', category: 'zahlungsavis' } }),
      undefined,
      undefined,
      KONTEXT,
    );
    expect(avis.linkedInvoiceId).toBe('inv-5');

    const nurNutzlast = mapCloudArchivedDocumentRow(
      archivZeile({ payload: { id: 'doc-falsch', title: 'Zahlungsavis', category: 'zahlungsavis', linkedInvoiceId: 'inv-5' } }),
      undefined,
      undefined,
      KONTEXT,
    );
    expect(nurNutzlast.linkedInvoiceId).toBeNull();
  });

  it('R3: auch der Bestand auf dem Gerät (gleiche Version) wird beim Abzug entschärft', () => {
    const bestand = {
      id: 'doc-falsch',
      title: 'Rechnung 2026-0005',
      category: 'ausgangsrechnung',
      classifiedKind: 'ausgangsrechnung',
      linkedInvoiceId: 'inv-5',
      sync: meta(1),
    } as unknown as CompanyDocument;
    const echt = {
      id: 'doc-rechnung',
      title: '2026-0005 – Rechnung',
      category: 'ausgangsrechnung',
      classifiedKind: 'ausgangsrechnung',
      linkedInvoiceId: 'inv-5',
      sync: meta(1),
    } as unknown as CompanyDocument;
    const applied = applyIntakePullToState(
      zustand({ documents: [bestand, echt] }),
      abzug({ archivedDocuments: [archivZeile({ linked_invoice_id: 'inv-5' })] }),
      KONTEXT,
    );
    const dokumente = applied.state.documents ?? [];
    expect(dokumente.find((d) => d.id === 'doc-falsch')?.linkedInvoiceId).toBeNull();
    // Der echte Beleg ist kein Archivdokument und bleibt unberührt.
    expect(dokumente.find((d) => d.id === 'doc-rechnung')?.linkedInvoiceId).toBe('inv-5');
    expect(buildArchiveDocumentIdByInvoice(dokumente).get('inv-5')).toBe('doc-rechnung');
  });

  it('R4: die Suche nach dem Beleg einer Rechnung bevorzugt den erzeugten Rechnungsbeleg', () => {
    hydrateDocumentStore([
      { id: 'doc-avis', title: 'Zahlungsavis', category: 'zahlungsavis', linkedInvoiceId: 'inv-5', tags: [], createdAt: '2026-10-10T08:00:00.000Z' },
      {
        id: 'doc-rechnung',
        title: '2026-0005 – Rechnung',
        category: 'ausgangsrechnung',
        classifiedKind: 'ausgangsrechnung',
        linkedInvoiceId: 'inv-5',
        tags: [],
        createdAt: '2026-10-10T08:00:00.000Z',
      },
    ] as never);
    expect(getDocumentByLinkedInvoiceId('inv-5')?.id).toBe('doc-rechnung');
  });

  it('R5: ein Dokument ohne Anspruch auf den Rechnungsbeleg bleibt, wie es ist', () => {
    const doc = { id: 'x', title: 'Lieferschein', category: 'lieferschein', linkedInvoiceId: 'inv-5' } as unknown as CompanyDocument;
    expect(withoutInvoiceDocumentClaim(doc)).toBe(doc);
  });
});

describe('FINALISIERUNG — Vertrauensmarke im Sync', () => {
  it('M1: die Marke kommt mit dem Abzug, auch bei gleicher Version', () => {
    const merged = mergeBindingsFromPull([lokal()], [bindungZeile()], KONTEXT);
    expect(merged.items[0].einvoiceUntrustedAt).toBe('2026-11-07T12:00:00.000Z');
  });

  it('M2: entfernt der Server die Marke, verschwindet sie auch lokal', () => {
    const merged = mergeBindingsFromPull(
      [lokal({ einvoiceUntrustedAt: '2026-11-07T12:00:00.000Z' })],
      [bindungZeile({ einvoice_untrusted_at: null, einvoice_untrusted_reason: null })],
      KONTEXT,
    );
    expect(merged.items[0].einvoiceUntrustedAt).toBeUndefined();
  });

  it('M3: eine lokale, noch nicht übertragene Ersetzung bekommt keine Marke', () => {
    const merged = mergeBindingsFromPull(
      [lokal({ fileRefId: 'file-inhaber' })],
      [bindungZeile()],
      { ...KONTEXT, dirty: new Set(['document_file_binding:doc-rechnung|structured|xrechnung-cii']) },
    );
    expect(merged.items[0].fileRefId).toBe('file-inhaber');
    expect(merged.items[0].einvoiceUntrustedAt).toBeUndefined();
  });

  it('M4: der Bindungsspeicher behält Serverstand und Marke über Laden und Speichern', () => {
    hydrateDocumentFileRepresentationBindingStore([lokal({ einvoiceUntrustedAt: '2026-11-07T12:00:00.000Z', sync: meta(4) })]);
    const [gespeichert] = getDocumentFileRepresentationBindingStoreSnapshot();
    expect(gespeichert.einvoiceUntrustedAt).toBe('2026-11-07T12:00:00.000Z');
    expect(gespeichert.sync?.version).toBe(4);
    expect(gespeichert.part).toBe('xrechnung-cii');
  });
});

describe('FINALISIERUNG — abgewiesene E-Rechnungsbindung weicht dem Cloud-Stand', () => {
  const kennung = 'doc-rechnung|structured|xrechnung-cii';

  it('A1: ohne Cloud-Bindung verschwindet die lokale; der Auftrag gilt als erledigt', () => {
    const state = zustand({
      documentFileRepresentationBindings: [lokal({ fileRefId: 'file-lokal', sync: undefined })],
      syncOutbox: [abgewiesen('document_file_binding', kennung)],
    });
    expect(planRoleDeniedEInvoiceBindingRelease(state).bindingIds.has(kennung)).toBe(true);
    const applied = applyIntakePullToState(state, abzug(), { ...KONTEXT, dirty: new Set([`document_file_binding:${kennung}`]) });
    expect(applied.state.documentFileRepresentationBindings).toEqual([]);
    expect(applied.state.syncOutbox?.[0].status).toBe('completed');
  });

  it('A2: liegt eine Cloud-Bindung vor, ersetzt sie die lokale — mit Marke', () => {
    const state = zustand({
      documentFileRepresentationBindings: [lokal({ fileRefId: 'file-lokal', sync: meta(1) })],
      syncOutbox: [abgewiesen('document_file_binding', kennung)],
    });
    const applied = applyIntakePullToState(state, abzug({ bindings: [bindungZeile()] }), {
      ...KONTEXT,
      dirty: new Set([`document_file_binding:${kennung}`]),
    });
    const [bindung] = applied.state.documentFileRepresentationBindings ?? [];
    expect(bindung.fileRefId).toBe('file-mitglied');
    expect(bindung.einvoiceUntrustedAt).toBe('2026-11-07T12:00:00.000Z');
    expect(applied.state.syncOutbox?.[0].status).toBe('completed');
  });

  it('A3: andere abgewiesene Bindungen bleiben stehen (kein Freibrief)', () => {
    const archiv = 'doc-scan|archive|';
    const state = zustand({
      documentFileRepresentationBindings: [{ documentId: 'doc-scan', kind: 'archive', fileRefId: 'file-scan' }],
      syncOutbox: [abgewiesen('document_file_binding', archiv)],
    });
    expect(planRoleDeniedEInvoiceBindingRelease(state).bindingIds.size).toBe(0);
    const applied = applyIntakePullToState(state, abzug(), { ...KONTEXT, dirty: new Set([`document_file_binding:${archiv}`]) });
    expect(applied.state.documentFileRepresentationBindings).toHaveLength(1);
    expect(applied.state.syncOutbox?.[0].status).toBe('error');
  });
});
