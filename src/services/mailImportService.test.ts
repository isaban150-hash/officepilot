import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCommunicationHistoryStore } from './communicationHistoryStore';
import {
  getCommunicationReplyStatus,
  recordCommunicationResult,
  recordMarkedAnswered,
} from './communicationHistoryService';
import { hydrateDocumentStore } from './documentService';
import * as inboxService from './inboxService';
import { processUpload } from './inboxService';
import {
  archiveMailInboxItem,
  createMailImport,
  importMailAsInboxItem,
  importMailAttachment,
  resetMailImports,
} from './mailImportService';
import {
  getDocumentMemoryByDocumentId,
  getProofMemories,
  resetMemory,
} from './officePilotMemoryService';
import {
  extractDocumentText,
  setImageOcrExtractorForTests,
} from './ocrDocumentService';
import { setPdfTextExtractorForTests } from './uploadTextExtractionService';
import { confirmFilingDecisionForTests } from '../test/confirmFilingDecisionForTests';

const BG_BAU_MAIL_BODY = `
Sehr geehrte Damen und Herren,
anbei der Beitragsbescheid der BG BAU.
Bitte prüfen Sie die Angaben.
`.trim();

const FREISTELLUNG_PDF_TEXT = `
Freistellungsbescheinigung nach §48b EStG
Finanzamt München
Gültig bis 31.12.2026
`.trim();

function createFile(name: string, type: string, content = 'binary'): File {
  return new File([content], name, { type });
}

describe('mailImportService', () => {
  beforeEach(() => {
    resetMailImports();
    resetMemory();
    resetCommunicationHistoryStore();
    hydrateDocumentStore([]);
  });

  afterEach(() => {
    setPdfTextExtractorForTests(null);
    setImageOcrExtractorForTests(null);
  });

  it('Mail ohne Anhang erzeugt InboxItem', () => {
    const mail = createMailImport({
      from: 'steuerberater@kanzlei.de',
      subject: 'Unterlagen für die Buchhaltung',
      bodyText: 'Bitte senden Sie uns die fehlenden Belege.',
    });

    const result = importMailAsInboxItem(mail.id);
    expect(result.inboxItems).toHaveLength(1);
    expect(result.inboxItems[0]?.importSource).toBe('email');
    expect(result.inboxItems[0]?.mailImportId).toBe(mail.id);
    expect(result.inboxItems[0]?.sender).toBe('steuerberater@kanzlei.de');
    expect(result.inboxItems[0]?.title).toBe('Unterlagen für die Buchhaltung');
    expect(result.mailImport.linkedInboxIds).toContain(result.inboxItems[0]?.id);
  });

  it('Mail mit PDF-Anhang nutzt bestehende PDF-Extraktion', async () => {
    setPdfTextExtractorForTests(() => FREISTELLUNG_PDF_TEXT);

    const mail = createMailImport({
      from: 'finanzamt@service.de',
      subject: 'Freistellungsbescheinigung',
      bodyText: 'Anbei die Bescheinigung.',
    });

    const file = createFile('freistellung.pdf', 'application/pdf');
    const result = await importMailAttachment(mail.id, file);

    expect(result.inboxItem.recognizedData._extractedText).toContain('Freistellungsbescheinigung');
    expect(result.attachment.status).toBe('processed');
    expect(result.mailImport.linkedInboxIds).toContain(result.inboxItem.id);
  });

  it('Mail mit Bild-Anhang nutzt OCR-Service', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: FREISTELLUNG_PDF_TEXT,
      confidence: 88,
    }));

    const mail = createMailImport({
      from: 'finanzamt@service.de',
      subject: 'Scan Freistellung',
      bodyText: 'Foto im Anhang.',
    });

    const result = await importMailAttachment(mail.id, createFile('scan.jpg', 'image/jpeg'));
    expect(result.inboxItem.recognizedData._extractedText).toContain('Freistellungsbescheinigung');
    expect(result.inboxItem.importSource).toBe('email');
  });

  it('BG BAU-Mail wird korrekt klassifiziert', () => {
    const mail = createMailImport({
      from: 'service@bg-bau.de',
      subject: 'BG BAU Beitragsbescheid',
      bodyText: BG_BAU_MAIL_BODY,
    });

    const { inboxItems } = importMailAsInboxItem(mail.id);
    expect(inboxItems[0]?.classifiedKind).toBe('bg_bau');
    expect(inboxItems[0]?.sender).toBe('service@bg-bau.de');
  });

  it('Freistellung im Anhang erzeugt ProofMemory', async () => {
    setPdfTextExtractorForTests(() => FREISTELLUNG_PDF_TEXT);

    const mail = createMailImport({
      from: 'finanzamt@service.de',
      subject: 'Freistellungsbescheinigung §48b',
      bodyText: 'Gültigkeitsnachweis im Anhang.',
    });

    const { inboxItem } = await importMailAttachment(
      mail.id,
      createFile('freistellung.pdf', 'application/pdf'),
    );

    confirmFilingDecisionForTests(inboxItem.id);
    const documentId = archiveMailInboxItem(inboxItem, 'Test GmbH', mail.id);
    expect(documentId).toBeTruthy();

    const proofs = getProofMemories().filter(
      (item) => item.proofType === 'freistellungsbescheinigung',
    );
    expect(proofs.length).toBeGreaterThan(0);
  });

  it('Mail-Kontext landet in DocumentMemory', async () => {
    const mail = createMailImport({
      from: 'service@bg-bau.de',
      subject: 'BG BAU Beitragsbescheid',
      bodyText: BG_BAU_MAIL_BODY,
    });

    const { inboxItems } = importMailAsInboxItem(mail.id);
    confirmFilingDecisionForTests(inboxItems[0]!.id);
    const documentId = archiveMailInboxItem(inboxItems[0]!, 'Test GmbH', mail.id);
    expect(documentId).toBeTruthy();
    if (!documentId) return;

    const memory = getDocumentMemoryByDocumentId(documentId);
    expect(memory?.source).toBe('email');
    expect(memory?.mailFrom).toBe('service@bg-bau.de');
    expect(memory?.mailSubject).toBe('BG BAU Beitragsbescheid');
    expect(memory?.mailImportId).toBe(mail.id);
  });

  it('ReplyStatus funktioniert für Mail-Kontext', () => {
    const mail = createMailImport({
      from: 'service@bg-bau.de',
      subject: 'BG BAU Beitragsbescheid',
      bodyText: BG_BAU_MAIL_BODY,
    });

    const contextRef = { type: 'mail' as const, id: mail.id };
    expect(getCommunicationReplyStatus(contextRef)).toBe('needs_reply');

    recordCommunicationResult(
      {
        mode: 'draft',
        intent: 'document_reply',
        status: 'complete',
        title: 'Antwort',
        summary: 'Entwurf',
        drafts: {
          email: {
            intent: 'document_reply',
            channel: 'email',
            subject: 'Antwort BG BAU',
            body: 'Sehr geehrte Damen und Herren, vielen Dank für Ihr Schreiben.',
            tone: 'formal',
            basedOnFacts: [],
            notIncluded: [],
          },
        },
        disclaimer: 'Bitte prüfen.',
      },
      contextRef,
      'Antwort vorbereiten',
    );
    expect(getCommunicationReplyStatus(contextRef)).toBe('draft_ready');

    recordMarkedAnswered(contextRef, 'Antwort gesendet');
    expect(getCommunicationReplyStatus(contextRef)).toBe('answered');
  });

  it('keine zweite Pipeline – Mail nutzt processUpload', () => {
    const processUploadSpy = vi.spyOn(inboxService, 'processUpload');

    const mail = createMailImport({
      from: 'service@bg-bau.de',
      subject: 'BG BAU Beitragsbescheid',
      bodyText: BG_BAU_MAIL_BODY,
    });

    importMailAsInboxItem(mail.id);
    expect(processUploadSpy).toHaveBeenCalledTimes(1);
    expect(processUploadSpy.mock.calls[0]?.[0]?.importSource).toBe('email');
  });
});

describe('mail import OCR integration', () => {
  afterEach(() => {
    setPdfTextExtractorForTests(null);
    setImageOcrExtractorForTests(null);
  });

  it('extractDocumentText bleibt gemeinsamer Extraktionsweg', async () => {
    setPdfTextExtractorForTests(() => FREISTELLUNG_PDF_TEXT);
    const file = createFile('doc.pdf', 'application/pdf');
    const extraction = await extractDocumentText(file);
    const item = processUpload({
      sourceFileName: file.name,
      recognizedText: extraction.recognizedText,
      importSource: 'email',
    });
    expect(item.classifiedKind).toBe('freistellungsbescheinigung');
  });
});
