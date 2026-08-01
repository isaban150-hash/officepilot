import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { afterEach, describe, expect, it } from 'vitest';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import { intakeCachedDocumentFile } from './documentIntakeService';
import {
  detectClassifiedKind,
  getClassificationForItem,
} from './documentClassificationService';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import {
  harvestPdfLiteralStringsFromBinary,
  setPdfTextExtractorForTests,
} from './uploadTextExtractionService';
import { setImageOcrExtractorForTests } from './ocrDocumentService';

const INVOICE_TEXT = `
Eingangsrechnung
Rechnungsnummer: ER-2026-101
Rechnungsbetrag: 3.712,80 EUR
Fällig am: 29.07.2026
`.trim();

const AUFTRAG_TEXT = `
Kundenauftrag
Auftragsnummer: AU-2026-023
Datum: 15.07.2026
Auftraggeber: Dachtechnik West GmbH
Auftragswert: 18.750,00 EUR
`.trim();

function createPayload(marker: string, fileName: string, body: string): CachedDocumentFilePayload {
  const bytes = new TextEncoder().encode(`${marker}\n${body}`);
  return {
    fileName,
    mimeType: 'application/pdf',
    fileSize: bytes.length,
    bytes,
  };
}

function installPdfTextRouter(): void {
  setPdfTextExtractorForTests((bytes) => {
    const decoded = new TextDecoder().decode(bytes);
    if (decoded.includes('__INVOICE__')) return INVOICE_TEXT;
    if (decoded.includes('__AUFTRAG__')) return AUFTRAG_TEXT;
    return '';
  });
}

useDocumentBlobDatabaseReset();

describe('P1-DOCUMENT-UPLOAD-ISOLATION-01', () => {
  afterEach(() => {
    setPdfTextExtractorForTests(null);
    setImageOcrExtractorForTests(null);
  });

  it('reproduces whole-file binary harvest leaking ghost literals', () => {
    const auftragPage = 'Kundenauftrag AU-2026-023 18.750,00 EUR';
    const ghostInvoice = '(Eingangsrechnung) (3.712,80 EUR) (29.07.2026) (Zahlungserinnerung)';
    const pdfLike = `${ghostInvoice}\nstream BT (${auftragPage}) Tj ET`;
    const harvested = harvestPdfLiteralStringsFromBinary(new TextEncoder().encode(pdfLike));

    expect(harvested).toContain('Eingangsrechnung');
    expect(harvested).toContain('3.712,80 EUR');
    expect(harvested).toContain('AU-2026-023');
  });

  it('isolates sequential PDF uploads (invoice then auftrag)', async () => {
    installPdfTextRouter();

    const invoiceResult = await intakeCachedDocumentFile(
      createPayload('__INVOICE__', '01_Eingangsrechnung.pdf', INVOICE_TEXT),
      { importSource: 'upload' },
    );
    expect(invoiceResult.success).toBe(true);
    if (!invoiceResult.success || invoiceResult.duplicate) return;

    const auftragResult = await intakeCachedDocumentFile(
      createPayload('__AUFTRAG__', '04_Auftrag.pdf', AUFTRAG_TEXT),
      { importSource: 'upload' },
    );
    expect(auftragResult.success).toBe(true);
    if (!auftragResult.success || auftragResult.duplicate) return;

    const item = auftragResult.inboxItem;
    const extracted = getInboxExtractedDocumentText(item);

    expect(item.classifiedKind).toBe('auftrag');
    expect(extracted).toContain('AU-2026-023');
    expect(extracted).toContain('18.750,00 EUR');
    expect(extracted).toContain('Dachtechnik West GmbH');
    expect(extracted).not.toContain('3.712,80');
    expect(extracted).not.toContain('29.07.2026');
    expect(extracted).not.toContain('Eingangsrechnung');
    expect(item.recognizedData.Auftragsnummer).toBe('AU-2026-023');
  });

  it('isolates sequential PDF uploads when order is reversed', async () => {
    installPdfTextRouter();

    const auftragFirst = await intakeCachedDocumentFile(
      createPayload('__AUFTRAG__', '04_Auftrag.pdf', AUFTRAG_TEXT),
      { importSource: 'upload' },
    );
    expect(auftragFirst.success).toBe(true);
    if (!auftragFirst.success || auftragFirst.duplicate) return;

    const invoiceSecond = await intakeCachedDocumentFile(
      createPayload('__INVOICE__', '01_Eingangsrechnung.pdf', INVOICE_TEXT),
      { importSource: 'upload' },
    );
    expect(invoiceSecond.success).toBe(true);
    if (!invoiceSecond.success || invoiceSecond.duplicate) return;

    const extracted = getInboxExtractedDocumentText(invoiceSecond.inboxItem);
    expect(invoiceSecond.inboxItem.classifiedKind).toBe('eingangsrechnung');
    expect(extracted).toContain('3.712,80');
    expect(extracted).not.toContain('AU-2026-023');
    expect(extracted).not.toContain('18.750,00 EUR');
  });

  it('does not re-inject stale recognizedData fields into re-classification text', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: '04_Auftrag.pdf',
      recognizedText: AUFTRAG_TEXT,
    });

    item.recognizedData.Betrag = '3.712,80 EUR';
    item.recognizedData.Faelligkeit = '29.07.2026';
    item.recognizedData._extractedText = AUFTRAG_TEXT;

    const reclassified = getClassificationForItem(item);
    expect(reclassified.classifiedKind).toBe('auftrag');
    expect(detectClassifiedKind({ recognizedText: getInboxExtractedDocumentText(item) })).toBe('auftrag');
  });

  it('keeps single upload isolated after a prior multi-document session', async () => {
    installPdfTextRouter();

    await intakeCachedDocumentFile(
      createPayload('__INVOICE__', '01_Eingangsrechnung.pdf', INVOICE_TEXT),
      { importSource: 'upload' },
    );
    await intakeCachedDocumentFile(
      createPayload('__INVOICE__', '02_Zahlungserinnerung.pdf', 'Zahlungserinnerung 3.712,80 EUR'),
      { importSource: 'upload' },
    );
    await intakeCachedDocumentFile(
      createPayload('__AUFTRAG__', '03_Angebot.pdf', 'Angebot AN-2026-11 5.000,00 EUR'),
      { importSource: 'upload' },
    );

    const auftragOnly = await intakeCachedDocumentFile(
      createPayload('__AUFTRAG__', '04_Auftrag.pdf', AUFTRAG_TEXT),
      { importSource: 'upload' },
    );
    expect(auftragOnly.success).toBe(true);
    if (!auftragOnly.success || auftragOnly.duplicate) return;

    const extracted = getInboxExtractedDocumentText(auftragOnly.inboxItem);
    expect(auftragOnly.inboxItem.classifiedKind).toBe('auftrag');
    expect(extracted).not.toMatch(/Eingangsrechnung|Zahlungserinnerung|Angebot/);
    expect(extracted).toContain('AU-2026-023');
  });
});
