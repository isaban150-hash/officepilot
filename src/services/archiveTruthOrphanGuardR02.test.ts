/**
 * ARCHIVE-TRUTH-ORPHAN-GUARD-R02 — verwaistes Archivdokument schuetzt die Inbox.
 *
 * Gemessener Fehler: importInboxDocument speichert Archivdokument und Snapshot ueber
 * eine eigene Persistenzgrenze. Scheitert danach die Inbox-Markierung, bleibt das
 * Archivdokument aktiv, waehrend dem InboxItem importedToArchive und archiveDocumentId
 * fehlen. Der bisherige Loeschschutz griff deshalb nicht und deleteInboxItem entfernte
 * InboxItem samt DWR.
 *
 * Alle Faelle laufen ueber oeffentliche Produktionsfunktionen mit echter Originaldatei.
 * DWR, Snapshot, CompanyDocument, FileRef, Blob und Persistenz-JSON werden nicht von
 * Hand gesetzt.
 */
import { describe, expect, it, vi } from 'vitest';
import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { confirmFilingDecisionForTests } from '../test/confirmFilingDecisionForTests';
import { intakeCachedDocumentFile } from './documentIntakeService';
import { setPdfTextExtractorForTests } from './uploadTextExtractionService';
import { processUploadedDocument } from './intakeWorkflowService';
import {
  deleteDocument,
  getDocumentById,
  getDocumentStoreSnapshot,
  handoffInboxItemToArchive,
  hydrateDocumentStore,
  importInboxDocument,
} from './documentService';
import {
  deleteInboxItem,
  getInboxDeleteBlockReason,
  getInboxItemById,
  markInboxImportedToArchive,
  patchInboxItem,
} from './inboxService';
import { getDocumentWorkResultForItem } from './documentWorkResultService';
import {
  countActiveReferencesToFileRef,
  hasActiveArchiveDocumentForInboxItem,
} from './documentFileReferenceService';
import {
  getDocumentFileRefById,
  getOriginalDocumentFileBytes,
} from './documentFileStoreService';
import * as persistenceService from './persistenceService';
import { bootstrapBusinessState } from './storage/storageBootstrapService';
import { resolveDocumentWorkTruthViewForCompanyDocument } from './documentWorkResultTruthOrchestration';
import { buildDocumentArchiveTruthDisplayView } from './documentArchiveTruthDisplayService';
import { isEntitySyncActive } from './sync/syncMetaService';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';

useDocumentBlobDatabaseReset();

const COMPANY = 'Mustermann Sanitär GmbH';

function bytesFor(marker: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n${marker}\n%%EOF`);
}

function payloadFor(marker: string, fileName: string): CachedDocumentFilePayload {
  const bytes = bytesFor(marker);
  return { fileName, mimeType: 'application/pdf', fileSize: bytes.length, bytes };
}

function seedExtractor(): void {
  setPdfTextExtractorForTests(() =>
    [
      'Rechnung',
      'Absender: Orphan Guard GmbH',
      'Rechnungsnummer: RE-R02-GUARD',
      'Betrag: 1.234,56 EUR',
      'Datum: 01.04.2026',
    ].join('\n'),
  );
}

/** Intake mit echter Datei + Analyse + bestaetigtes Filing, alles produktiv. */
async function seedAnalyzedInbox(marker: string, fileName: string) {
  seedExtractor();
  const intake = await intakeCachedDocumentFile(payloadFor(marker, fileName), {
    importSource: 'upload',
  });
  expect(intake.success).toBe(true);
  if (!intake.success || intake.duplicate) throw new Error('intake fehlgeschlagen');

  const itemId = intake.inboxItem.id;
  expect(processUploadedDocument(itemId)).toBeTruthy();
  expect(getDocumentWorkResultForItem(itemId)).toBeTruthy();
  confirmFilingDecisionForTests(itemId);

  return { itemId, fileRefId: intake.fileRef.id, originalBytes: bytesFor(marker) };
}

/** Genau der persistAll-Aufruf aus patchInboxItem scheitert einmalig. */
function failOnlyInboxMarking(itemId: string, documentId: string) {
  const spy = vi
    .spyOn(persistenceService, 'persistAll')
    .mockReturnValueOnce({
      success: false,
      failure: { reason: 'unknown_persist_error' },
    } as never);
  const marked = markInboxImportedToArchive(itemId, documentId);
  spy.mockRestore();
  return marked;
}

function activeDocsForInbox(itemId: string) {
  return getDocumentStoreSnapshot().filter(
    (doc) => isEntitySyncActive(doc) && doc.sourceInboxItemId === itemId,
  );
}

describe('ARCHIVE-TRUTH-ORPHAN-GUARD-R02', () => {
  it('A: verwaistes Archivdokument blockiert die Inbox-Loeschung', async () => {
    const { itemId, fileRefId, originalBytes } = await seedAnalyzedInbox('GUARD-A', 'guard-a.pdf');

    const imported = importInboxDocument(getInboxItemById(itemId)!, COMPANY);
    expect(imported.success).toBe(true);
    if (!imported.success) throw new Error('import fehlgeschlagen');
    const docId = imported.document.id;
    expect(getDocumentById(docId)?.archiveTruthSnapshot).toBeTruthy();
    expect(getDocumentById(docId)?.sourceInboxItemId).toBe(itemId);

    // Gezielter Persistenzfehler ausschliesslich bei der Inbox-Markierung.
    expect(failOnlyInboxMarking(itemId, docId)).toBeNull();

    const orphan = getInboxItemById(itemId)!;
    expect(orphan).toBeTruthy();
    expect(orphan.importedToArchive).not.toBe(true);
    expect(orphan.archiveDocumentId).toBeUndefined();
    expect(hasActiveArchiveDocumentForInboxItem(itemId)).toBe(true);

    // Der neue Schutz greift.
    expect(getInboxDeleteBlockReason(orphan)).toBe('archive');

    const deleted = await deleteInboxItem(itemId);
    expect(deleted?.success).toBe(false);

    expect(getInboxItemById(itemId)).toBeTruthy();
    expect(getDocumentWorkResultForItem(itemId)).toBeTruthy();
    expect(getDocumentById(docId)).toBeTruthy();
    expect(getDocumentFileRefById(fileRefId)).toBeTruthy();
    const bytes = await getOriginalDocumentFileBytes(getDocumentFileRefById(fileRefId)!);
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!)).toEqual(Array.from(originalBytes));

    setPdfTextExtractorForTests(null);
  }, 120_000);

  it('B: Wiederholung repariert den Handoff statt zu duplizieren', async () => {
    const { itemId } = await seedAnalyzedInbox('GUARD-B', 'guard-b.pdf');

    const imported = importInboxDocument(getInboxItemById(itemId)!, COMPANY);
    expect(imported.success).toBe(true);
    if (!imported.success) throw new Error('import fehlgeschlagen');
    const docId = imported.document.id;
    expect(failOnlyInboxMarking(itemId, docId)).toBeNull();
    expect(activeDocsForInbox(itemId)).toHaveLength(1);

    // Erneuter Handoff über die gemeinsame Produktionsfunktion.
    const repaired = handoffInboxItemToArchive(getInboxItemById(itemId)!, COMPANY);
    expect(repaired.success).toBe(true);
    if (!repaired.success) throw new Error('handoff fehlgeschlagen');

    expect(repaired.reusedExistingDocument).toBe(true);
    expect(repaired.document.id).toBe(docId);
    expect(activeDocsForInbox(itemId)).toHaveLength(1);

    const repairedItem = getInboxItemById(itemId)!;
    expect(repairedItem.importedToArchive).toBe(true);
    expect(repairedItem.archiveDocumentId).toBe(docId);
    expect(getInboxDeleteBlockReason(repairedItem)).toBe('archive');
    expect(getDocumentById(docId)?.archiveTruthSnapshot).toBeTruthy();
    expect(getDocumentWorkResultForItem(itemId)).toBeTruthy();

    setPdfTextExtractorForTests(null);
  }, 120_000);

  it('C: Reload nach Reparatur haelt Dokument, Fakten und Original', async () => {
    const { itemId, fileRefId, originalBytes } = await seedAnalyzedInbox('GUARD-C', 'guard-c.pdf');

    const handoff = handoffInboxItemToArchive(getInboxItemById(itemId)!, COMPANY);
    expect(handoff.success).toBe(true);
    if (!handoff.success) throw new Error('handoff fehlgeschlagen');
    const docId = handoff.document.id;
    expect(handoff.reusedExistingDocument).toBe(false);

    bootstrapBusinessState();

    const doc = getDocumentById(docId);
    expect(doc).toBeTruthy();
    const item = getInboxItemById(itemId);
    expect(item).toBeTruthy();
    expect(item!.importedToArchive).toBe(true);
    expect(item!.archiveDocumentId).toBe(docId);
    expect(getDocumentWorkResultForItem(itemId)).toBeTruthy();
    expect(doc!.archiveTruthSnapshot).toBeTruthy();

    // Zuerst Originaldatei und Metadaten — sie sind der harte Teil von R02.
    expect(doc!.fileRefId).toBe(fileRefId);
    const ref = getDocumentFileRefById(fileRefId);
    expect(ref).toBeTruthy();
    const bytes = await getOriginalDocumentFileBytes(ref!);
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!)).toEqual(Array.from(originalBytes));
    expect(doc!.originalFileName).toBe('guard-c.pdf');
    expect(doc!.mimeType).toBe('application/pdf');
    expect(doc!.fileSize).toBe(originalBytes.length);
    expect(countActiveReferencesToFileRef(fileRefId)).toBe(2);

    // Erst danach die Anzeige. Ein Display-Fakt ist { labelValue, provenance } —
    // labelValue trägt "Label: Wert" als eine Zeichenkette (Muster wie in
    // documentArchiveTruthDisplay01.test.ts).
    const resolved = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc! });
    expect(resolved.truthView).toBeTruthy();

    const display = buildDocumentArchiveTruthDisplayView(doc!);
    expect(display).toBeTruthy();
    const facts = display!.facts;
    expect(facts.length).toBeGreaterThan(0);

    // Mindestens ein konkreter, aus dem Dokument stammender Wert muss sichtbar sein.
    const factText = facts.map((fact) => fact.labelValue).join('\n');
    expect(factText).toMatch(/Orphan Guard GmbH|RE-R02-GUARD|1\.234,56/);

    setPdfTextExtractorForTests(null);
  }, 120_000);

  it('D: getombstonetes Archivdokument blockiert nicht mehr', async () => {
    const { itemId } = await seedAnalyzedInbox('GUARD-D', 'guard-d.pdf');

    // Ohne Archivdokument bleibt das Item löschbar.
    expect(hasActiveArchiveDocumentForInboxItem(itemId)).toBe(false);
    expect(getInboxDeleteBlockReason(getInboxItemById(itemId)!)).toBeNull();

    // Archivdokument ohne anschliessende Inbox-Markierung — das Item traegt also
    // weder importedToArchive noch archiveDocumentId. Der Block kommt allein aus
    // dem Dokumentstore.
    const imported = importInboxDocument(getInboxItemById(itemId)!, COMPANY);
    expect(imported.success).toBe(true);
    if (!imported.success) throw new Error('import fehlgeschlagen');
    const orphanItem = getInboxItemById(itemId)!;
    expect(orphanItem.importedToArchive).not.toBe(true);
    expect(orphanItem.archiveDocumentId).toBeUndefined();
    expect(hasActiveArchiveDocumentForInboxItem(itemId)).toBe(true);
    expect(getInboxDeleteBlockReason(orphanItem)).toBe('archive');

    // Produktiv geloeschtes Archivdokument darf nicht mehr blockieren.
    expect(deleteDocument(imported.document.id).success).toBe(true);
    expect(hasActiveArchiveDocumentForInboxItem(itemId)).toBe(false);
    expect(getInboxDeleteBlockReason(getInboxItemById(itemId)!)).toBeNull();

    const deleted = await deleteInboxItem(itemId);
    expect(deleted?.success).toBe(true);
    expect(getInboxItemById(itemId)).toBeUndefined();

    setPdfTextExtractorForTests(null);
  }, 120_000);

  it('E: echter Importfehler im Handoff hinterlaesst keinen Archivzustand', async () => {
    const { itemId } = await seedAnalyzedInbox('GUARD-E', 'guard-e.pdf');

    // Realistische oeffentliche Konstellation: der Titel wurde geleert. Der produktive
    // Importpfad scheitert dann deterministisch an validateInput → document.titleRequired.
    // Kein Mock, kein Test-Seam.
    expect(patchInboxItem(itemId, { title: '   ' })).toBeTruthy();

    const docsBefore = getDocumentStoreSnapshot().filter(
      (doc) => doc.sourceInboxItemId === itemId,
    ).length;

    const result = handoffInboxItemToArchive(getInboxItemById(itemId)!, COMPANY);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('handoff haette scheitern muessen');
    expect(result.errorKey).toBe('document.titleRequired');
    expect(result.document).toBeUndefined();

    // Kein Archivdokument als Nebenwirkung.
    expect(
      getDocumentStoreSnapshot().filter((doc) => doc.sourceInboxItemId === itemId).length,
    ).toBe(docsBefore);
    expect(activeDocsForInbox(itemId)).toHaveLength(0);

    // Inbox bleibt unangetastet, der DWR bleibt erhalten.
    const after = getInboxItemById(itemId)!;
    expect(after.status).toBe('neu');
    expect(after.importedToArchive).not.toBe(true);
    expect(after.archiveDocumentId).toBeUndefined();
    expect(getDocumentWorkResultForItem(itemId)).toBeTruthy();
    expect(getInboxDeleteBlockReason(after)).toBeNull();

    setPdfTextExtractorForTests(null);
  }, 120_000);

  it('D2: gesetztes Archivflag blockiert unabhaengig vom Dokumentstore', async () => {
    const { itemId } = await seedAnalyzedInbox('GUARD-D2', 'guard-d2.pdf');

    const handoff = handoffInboxItemToArchive(getInboxItemById(itemId)!, COMPANY);
    expect(handoff.success).toBe(true);
    if (!handoff.success) throw new Error('handoff fehlgeschlagen');
    expect(getInboxItemById(itemId)!.importedToArchive).toBe(true);

    /**
     * Der Dokumentstore weiss nichts mehr von diesem Item — das Flag am Item
     * blockiert die Inbox-Loeschung trotzdem. Genau das ist die R02-Zusicherung.
     *
     * Geprueft ohne deleteDocument(): seit 01I nimmt der Final-Delete-Pfad die
     * unsichtbare Herkunftszeile mit, sodass danach gar keine aktive Zeile mehr
     * existiert, an der sich das Flag messen liesse. Die Zusicherung selbst
     * bleibt unveraendert — nur die Herstellung des Zustands.
     */
    hydrateDocumentStore([]);
    expect(hasActiveArchiveDocumentForInboxItem(itemId)).toBe(false);
    expect(getInboxDeleteBlockReason(getInboxItemById(itemId)!)).toBe('archive');

    setPdfTextExtractorForTests(null);
  }, 120_000);
});
