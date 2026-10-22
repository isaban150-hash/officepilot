/**
 * DOKUMENTE-01 — WEISS-Browserbefund „Vorschau fehlgeschlagen" (pdf-preview-encode /
 * pdf-thumbnail-encode, unexpected_failure).
 *
 * Nachgestellt: Gerät A erzeugt Vorschau und Vorschaubild, die Dateien (nicht die
 * Bindungen) gehen in die Cloud. Gerät B zieht die Dateizeilen — ihre Bytes liegen nur
 * in der Cloud — und erzeugt dieselbe Ableitung bytegleich neu (Archivkopie einer
 * Dublette oder „Erneut erstellen"). Der Dateispeicher fand die hashgleiche Referenz,
 * suchte ihre Bytes nur lokal und warf `blob_read_failed`; der Orchestrator meldete
 * `unexpected_failure`.
 *
 * Jetzt: Die eben erzeugten, hashgleichen Bytes werden unter der vorhandenen
 * Cloud-Referenz abgelegt (wie nach einem Download, nur ohne), geprüft und genutzt.
 */
import { useDocumentBlobDatabaseReset } from '../../test/documentBlobTestReset';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDocumentFileRepresentationPlan } from '../documentFileRepresentationPlanService';
import { buildDocumentFileTransformPlan } from '../documentFileTransformPlanService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  resetDocumentFileRepresentationBindingStoreForTests,
} from '../documentFileRepresentationBindingStoreService';
import { orchestratePdfPreviewEncodeAfterImport } from '../documentFilePdfPreviewEncodeOrchestrationService';
import { orchestratePdfThumbnailEncodeAfterImport } from '../documentFilePdfThumbnailEncodeOrchestrationService';
import { setPdfPageJpegEncodeForTests } from '../documentFilePdfPageJpegEncodeService';
import { computeBufferContentHash } from '../documentFileHashService';
import { hydrateDocumentStore } from '../documentService';
import {
  getDocumentFileRefById,
  getDocumentFileRefStoreSnapshot,
  getOriginalDocumentFileBytes,
  hydrateDocumentFileStore,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from '../documentFileStoreService';
import { hasDocumentBlob, readDocumentBlob } from '../storage/documentBlobIndexedDbService';
import { withNewEntitySync } from '../sync/syncMetaService';
import type { DocumentFileRef } from '../../types/documentFileRef';
import type { DocumentFileTransformPlan } from '../../types/documentFileTransformPlan';
import type { CompanyDocument } from '../../types/models';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x44, 0x4f, 0x4b]);
const VORSCHAU = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x44, 0x4f, 0x4b, 0x30, 0x31]);
const VORSCHAUBILD = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x54, 0x48, 0x55, 0x4d]);
const DOC = 'doc-dok01-zweites-geraet';

useDocumentBlobDatabaseReset();

afterEach(() => {
  vi.restoreAllMocks();
  setPdfPageJpegEncodeForTests(null);
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

/** Eine Dateizeile aus dem Abzug: Bytes nur in der Cloud (wie `mapCloudFileRow`). */
async function cloudReferenz(id: string, bytes: Uint8Array, groesse = bytes.byteLength): Promise<DocumentFileRef> {
  const hash = await computeBufferContentHash(bytes);
  return {
    id,
    originalFileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    fileSize: groesse,
    contentHash: hash,
    storageType: 'cloud',
    localDataKey: id,
    createdAt: '2026-10-20T02:49:09.000Z',
    lifecycleStatus: 'committed',
    committedAt: '2026-10-20T02:49:09.000Z',
    cloud: { storagePath: `ws-dok01/${hash}`, uploadedAt: '2026-10-20T02:49:09.000Z' },
  };
}

function plan(): DocumentFileTransformPlan {
  const representationPlan = buildDocumentFileRepresentationPlan({
    policyId: 'business_document',
    decision: 'save_permanently',
  });
  return buildDocumentFileTransformPlan({ representationPlan: representationPlan!, mediaProfile: 'native_pdf' })!;
}

function dokument(fileRefId: string): CompanyDocument {
  return withNewEntitySync(
    {
      id: DOC,
      title: 'Eingangsrechnung Baustoffe (Kopie)',
      category: 'rechnung',
      issuer: 'Baustoffe Beispiel KG',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'rechnungen', name: 'Rechnungen', path: '/rechnungen' },
      paperFolder: { folderId: 'rechnungen', register: 'B', label: 'Rechnungen' },
      tags: [],
      linkedCompany: 'Baustoffe Beispiel KG',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-10-20T10:35:16.000Z',
      fileRefId,
    },
    'document',
  );
}

/** Gerät B: Original lokal vorhanden, die Ableitungen von Gerät A nur als Cloud-Zeilen. */
async function zweitesGeraet(cloud: DocumentFileRef[]) {
  const original = await storeDocumentFileFromCachedPayload(
    { fileName: 'WEISS-DOK01-Upload-Rechnung.pdf', mimeType: 'application/pdf', fileSize: PDF_BYTES.byteLength, bytes: PDF_BYTES },
    { lifecycleIntent: 'committed' },
  );
  hydrateDocumentFileStore([...getDocumentFileRefStoreSnapshot(), ...cloud]);
  hydrateDocumentStore([dokument(original.fileRef.id)]);
  return original.fileRef;
}

function kodiererLiefert(bytes: Uint8Array): void {
  setPdfPageJpegEncodeForTests(async () =>
    Object.freeze({ bytes: bytes.slice(), mimeType: 'image/jpeg' as const, width: 1280, height: 720 }),
  );
}

describe('DOKUMENTE-01 — Vorschau auf einem zweiten Gerät (hashgleiche Cloud-Datei)', () => {
  it('V1 der Speicher übernimmt die hashgleichen Bytes unter der Cloud-Referenz, ohne Download', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const cloud = await cloudReferenz('file-ref-cloud-vorschau', VORSCHAU);
    hydrateDocumentFileStore([cloud]);

    const ergebnis = await storeDocumentFileFromCachedPayload(
      { fileName: 'neu.preview.jpg', mimeType: 'image/jpeg', fileSize: VORSCHAU.byteLength, bytes: VORSCHAU },
      { lifecycleIntent: 'committed' },
    );

    expect(ergebnis.created).toBe(false);
    expect(ergebnis.fileRef.id).toBe(cloud.id);
    expect(ergebnis.fileRef.storageType).toBe('indexeddb');
    expect(ergebnis.fileRef.lifecycleStatus).toBe('committed');
    expect(ergebnis.fileRef.cloud?.storagePath).toBe(cloud.cloud?.storagePath);
    const abgelegt = await readDocumentBlob(cloud.id);
    expect(Array.from(new Uint8Array(await abgelegt!.blob.arrayBuffer()))).toEqual(Array.from(VORSCHAU));
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('V2 passt die Größe der Cloud-Zeile nicht, bleibt es bei blob_read_failed — nichts wird abgelegt', async () => {
    const cloud = await cloudReferenz('file-ref-cloud-falsch', VORSCHAU, VORSCHAU.byteLength + 1);
    hydrateDocumentFileStore([cloud]);

    await expect(
      storeDocumentFileFromCachedPayload(
        { fileName: 'neu.preview.jpg', mimeType: 'image/jpeg', fileSize: VORSCHAU.byteLength, bytes: VORSCHAU },
        { lifecycleIntent: 'committed' },
      ),
    ).rejects.toMatchObject({ code: 'blob_read_failed' });
    expect(await hasDocumentBlob(cloud.id)).toBe(false);
    expect(getDocumentFileRefById(cloud.id)?.storageType).toBe('cloud');
  });

  it('V3 PDF-Vorschau: persisted statt unexpected_failure, Bindung auf die vorhandene Datei', async () => {
    const cloud = await cloudReferenz('file-ref-cloud-vorschau', VORSCHAU);
    const original = await zweitesGeraet([cloud]);
    kodiererLiefert(VORSCHAU);

    const ergebnis = await orchestratePdfPreviewEncodeAfterImport({ documentId: DOC, transformPlan: plan() });

    expect(ergebnis).toMatchObject({
      kind: 'persisted',
      registration: 'created',
      previewFileRefId: cloud.id,
      createdPreviewFileRef: false,
    });
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
      { documentId: DOC, kind: 'preview', fileRefId: cloud.id },
    ]);
    expect(Array.from((await getOriginalDocumentFileBytes(cloud.id)) ?? [])).toEqual(Array.from(VORSCHAU));
    // Das Original bleibt unberührt.
    expect(Array.from((await getOriginalDocumentFileBytes(original)) ?? [])).toEqual(Array.from(PDF_BYTES));
  });

  it('V4 PDF-Vorschaubild ebenso', async () => {
    const cloud = await cloudReferenz('file-ref-cloud-vorschaubild', VORSCHAUBILD);
    await zweitesGeraet([cloud]);
    kodiererLiefert(VORSCHAUBILD);

    const ergebnis = await orchestratePdfThumbnailEncodeAfterImport({ documentId: DOC, transformPlan: plan() });

    expect(ergebnis.kind).toBe('persisted');
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
      { documentId: DOC, kind: 'thumbnail', fileRefId: cloud.id },
    ]);
    expect(getDocumentFileRefById(cloud.id)?.storageType).toBe('indexeddb');
  });
});
