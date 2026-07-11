import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_SETUP } from '../data/mockData';
import { computeFileContentHash } from './documentFileHashService';
import {
  getDocumentFileBlobStoreSnapshot,
  getDocumentFileRefStoreSnapshot,
  hydrateDocumentFileStore,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromUpload,
} from './documentFileStoreService';
import { findDuplicateByContentHash } from './documentDuplicateService';
import { intakeDocumentFile } from './documentIntakeService';
import {
  getDocumentStoreSnapshot,
  hydrateDocumentStore,
  importInboxDocument,
} from './documentService';
import { getInboxStoreSnapshot, hydrateInboxStore } from './inboxService';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import { setImageOcrExtractorForTests } from './ocrDocumentService';
import {
  migratePersistedStateV3ToV4,
  STORAGE_VERSION,
  STORAGE_VERSION_V3,
} from './sync/syncMigrationService';
import type { AppPersistedState } from '../types/models';
import { attachCompanyDocumentToVorgang, getVorgangStoreSnapshot, hydrateVorgangStore } from './vorgangService';
import { resetTestStores } from '../test/resetStores';

function samplePdfFile(name: string, content: string): File {
  return new File([content], name, { type: 'application/pdf' });
}

describe('DOC-FOUNDATION-01 file ref', () => {
  beforeEach(() => {
    resetDocumentFileStoreForTests();
  });

  it('erzeugt FileRef mit Originaldateiname, MIME und Größe', async () => {
    const file = samplePdfFile('rechnung.pdf', '%PDF-1.4 test');
    const { fileRef, created } = await storeDocumentFileFromUpload(file);
    expect(created).toBe(true);
    expect(fileRef.originalFileName).toBe('rechnung.pdf');
    expect(fileRef.mimeType).toBe('application/pdf');
    expect(fileRef.fileSize).toBe(file.size);
    expect(fileRef.contentHash).toHaveLength(64);
  });

  it('speichert Bytes nur einmal bei gleichem Inhalt', async () => {
    const fileA = samplePdfFile('a.pdf', '%PDF-same-content');
    const fileB = samplePdfFile('b.pdf', '%PDF-same-content');
    await storeDocumentFileFromUpload(fileA);
    const second = await storeDocumentFileFromUpload(fileB);
    expect(second.created).toBe(false);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);
    expect(Object.keys(getDocumentFileBlobStoreSnapshot())).toHaveLength(1);
  });
});

describe('DOC-FOUNDATION-01 hash', () => {
  it('gleiche Bytes ergeben gleichen SHA-256', async () => {
    const content = 'identical-bytes';
    const hashA = await computeFileContentHash(samplePdfFile('x.pdf', content));
    const hashB = await computeFileContentHash(samplePdfFile('y.pdf', content));
    expect(hashA).toBe(hashB);
  });

  it('unterschiedliche Bytes ergeben unterschiedlichen Hash', async () => {
    const hashA = await computeFileContentHash(samplePdfFile('a.pdf', 'content-a'));
    const hashB = await computeFileContentHash(samplePdfFile('b.pdf', 'content-b'));
    expect(hashA).not.toBe(hashB);
  });
});

describe('DOC-FOUNDATION-01 duplicates', () => {
  beforeEach(() => {
    resetTestStores();
    resetDocumentFileStoreForTests();
    setImageOcrExtractorForTests(async () => ({ text: '', confidence: 0 }));
  });

  it('erkennt identische Datei mit anderem Namen', async () => {
    const first = await intakeDocumentFile(samplePdfFile('first.pdf', '%PDF-dup'), {
      importSource: 'upload',
    });
    expect(first.success).toBe(true);
    if (!first.success || first.duplicate) return;

    const second = await intakeDocumentFile(samplePdfFile('second.pdf', '%PDF-dup'), {
      importSource: 'upload',
    });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.duplicate).toBe(true);
    expect(getInboxStoreSnapshot()).toHaveLength(1);
  });

  it('blockiert nicht bei gleichem Namen und anderem Inhalt', async () => {
    await intakeDocumentFile(samplePdfFile('doc.pdf', '%PDF-one'), { importSource: 'upload' });
    const second = await intakeDocumentFile(samplePdfFile('doc.pdf', '%PDF-two'), {
      importSource: 'upload',
    });
    expect(second.success).toBe(true);
    if (second.success && !second.duplicate) {
      expect(getInboxStoreSnapshot()).toHaveLength(2);
    }
  });
});

describe('DOC-FOUNDATION-01 intake upload flow', () => {
  beforeEach(() => {
    resetTestStores();
    resetDocumentFileStoreForTests();
    setImageOcrExtractorForTests(async () => ({ text: '', confidence: 0 }));
  });

  it('legt InboxItem mit Ordnern und fileRef an', async () => {
    const result = await intakeDocumentFile(
      samplePdfFile('werkvertrag.pdf', 'Werkvertrag Bauvorhaben Müller'),
      { importSource: 'upload' },
    );
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;
    expect(result.inboxItem.fileRefId).toBeTruthy();
    expect(result.inboxItem.digitalFolder.path).toBeTruthy();
    expect(result.inboxItem.paperFiling.folderId).toBeTruthy();
    expect(result.inboxItem.isNewUpload).toBe(true);
  });

  it('erzeugt ohne OCR keinen zufälligen Mock-Typ', async () => {
    const item = createMockInboxItemFromUpload({ sourceFileName: 'unbekannt.pdf' });
    expect(item.classifiedKind).toBe('sonstiges');
  });
});

describe('DOC-FOUNDATION-01 archive', () => {
  beforeEach(() => {
    resetTestStores();
    resetDocumentFileStoreForTests();
    setImageOcrExtractorForTests(async () => ({ text: '', confidence: 0 }));
  });

  it('archiviert mit fileRef und sourceInboxItemId', async () => {
    const intake = await intakeDocumentFile(samplePdfFile('archiv.pdf', '%PDF-archiv'), {
      importSource: 'upload',
    });
    if (!intake.success || intake.duplicate) throw new Error('intake failed');
    const result = importInboxDocument(intake.inboxItem, DEFAULT_SETUP.companyName);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.document.fileRefId).toBe(intake.fileRef.id);
    expect(result.document.sourceInboxItemId).toBe(intake.inboxItem.id);
    expect(result.document.originalFileName).toBe('archiv.pdf');
  });

  it('lässt Legacy-Dokument ohne fileRef lesbar', () => {
    hydrateDocumentStore([
      {
        id: 'doc-legacy',
        title: 'Legacy',
        category: 'sonstiges',
        issuer: 'Test',
        recognizedText: '',
        issueDate: null,
        validUntil: null,
        digitalFolder: { id: 'd1', name: 'Firma', path: '/Firma/' },
        paperFolder: { folderId: 'f1', register: 'A', label: 'Test' },
        tags: [],
        linkedCompany: 'Test GmbH',
        linkedVorgang: null,
        archived: true,
        createdAt: '2026-07-01T10:00:00.000Z',
      },
    ]);
    expect(getDocumentStoreSnapshot()[0].title).toBe('Legacy');
    expect(getDocumentStoreSnapshot()[0].fileRefId).toBeUndefined();
  });
});

describe('DOC-FOUNDATION-01 vorgang link', () => {
  beforeEach(() => {
    resetTestStores();
    resetDocumentFileStoreForTests();
    setImageOcrExtractorForTests(async () => ({ text: '', confidence: 0 }));
  });

  it('verknüpft Vorgang über companyDocumentId', async () => {
    hydrateVorgangStore([
      {
        id: 'v-1',
        title: 'Test',
        customer: 'Kunde',
        baustelle: 'Baustelle',
        status: 'neu',
        materialSource: 'unclear',
        orderPositions: [],
        documents: [],
        tasks: [],
        photos: [],
        invoices: [],
      },
    ]);

    const intake = await intakeDocumentFile(samplePdfFile('vorgang.pdf', '%PDF-v'), {
      importSource: 'upload',
    });
    if (!intake.success || intake.duplicate) throw new Error('intake failed');
    const archived = importInboxDocument(intake.inboxItem, DEFAULT_SETUP.companyName);
    if (!archived.success) throw new Error('archive failed');

    attachCompanyDocumentToVorgang('v-1', archived.document, intake.inboxItem);
    const linked = getVorgangStoreSnapshot()[0];
    expect(linked.documents.some((d) => d.companyDocumentId === archived.document.id)).toBe(true);
    expect(Object.keys(getDocumentFileBlobStoreSnapshot())).toHaveLength(1);
  });
});

describe('DOC-FOUNDATION-01 migration', () => {
  it('migriert V3 mit UploadedDocuments idempotent', () => {
    const v3: AppPersistedState = {
      version: STORAGE_VERSION_V3,
      setup: DEFAULT_SETUP,
      inboxItems: [],
      vorgaenge: [],
      tasks: [],
      documents: [],
      uploadedDocuments: [
        {
          id: 'upl-1',
          fileName: 'legacy.pdf',
          fileType: 'application/pdf',
          fileSize: 100,
          uploadedAt: '2026-07-01T10:00:00.000Z',
          status: 'uploaded',
          source: 'upload',
          originalFileDataUrl: 'data:application/pdf;base64,JVBERi0=',
        },
      ],
      savedAt: '2026-07-01T10:00:00.000Z',
    };

    const once = migratePersistedStateV3ToV4(v3);
    expect(once.version).toBe(STORAGE_VERSION);
    expect(once.documentFileRefs?.length).toBe(1);
    expect(once.documentFileBlobs?.['legacy-blob-upl-1']).toContain('data:application/pdf');

    const twice = migratePersistedStateV3ToV4(once);
    expect(twice.documentFileRefs?.length).toBe(1);
    expect(twice.uploadedDocuments?.length).toBe(1);
  });
});
