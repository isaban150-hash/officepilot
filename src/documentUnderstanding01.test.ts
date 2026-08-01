import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentIntakeUnderstandingPanel } from './components/inbox/DocumentIntakeUnderstandingPanel';
import { detectClassifiedKind } from './services/documentClassificationService';
import { extractFieldsFromText, extractFieldsWithConfidence, toConfidentPlainFields } from './services/documentFieldExtractionService';
import { buildUnderstandingFromItem } from './services/documentIntakeUnderstandingService';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { processUpload } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import {
  buildOcrPreviewSummary,
  extractDocumentText,
  setImageOcrExtractorForTests,
} from './services/ocrDocumentService';
import {
  extractPdfTextViaOcr,
  setPdfOcrExtractorForTests,
} from './services/pdfOcrFallbackService';
import {
  assessTextQuality,
  containsCrypticCharacters,
  sanitizeExtractedText,
} from './services/textQualityService';
import {
  extractTextFromPdfBytes,
  setPdfTextExtractorForTests,
} from './services/uploadTextExtractionService';
import type { TranslationKey } from '../i18n';
import { hydrateCompanyProfileStore } from './services/companyProfileService';

const testProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

const DIGITAL_PDF_GARBAGE = `
BT /F1 12 Tf 100 700 Td (Werkvertrag) Tj ET
/F2 10 Tf (Auftraggeber: Müller Bau GmbH) Tj
endobj stream xref trailer /Type /Page /Font
`.trim();

const DIGITAL_PDF_CLEAN = `
Werkvertrag
Auftraggeber: Müller Bau GmbH
Baustellenadresse: Hauptstr. 12, 10115 Berlin
Vertragsdatum: 15.03.2026
`.trim();

const SCANNED_PDF_OCR = `
Mahnung
Rechnungsnummer: RE-2026-8842
Betrag: 1.247,80 EUR
Fälligkeit: 30.03.2026
`.trim();

const MATERIAL_INVOICE = `
Materialrechnung
Lieferant: Baustoff Meyer GmbH
Rechnungsnummer: MR-2026-118
Betrag: 342,16 €
Baustelle: Badezimmer-Sanierung Müller
`.trim();

const TANKBELEG = `
Tankbeleg
Tankstelle Aral
Kraftstoff Diesel
Betrag: 85,40 €
`.trim();

const BG_BAU = `
BG BAU
Beitragsbescheid
Frist: 10.04.2026
`.trim();

const LIEFERSCHEIN = `
Lieferschein Nr. LS-4421
Lieferant: Sanitär Großhandel
Baustelle: Hauptstr. 12 Berlin
`.trim();

const MULTIPAGE_OCR = `
Seite 1 Werkvertrag
Auftraggeber: Müller Bau GmbH

Seite 2 Leistungsverzeichnis
Position 1 Demontage Badewanne
`.trim();

function createFile(name: string, type: string, content = 'binary'): File {
  return new File([content], name, { type });
}

function translate(key: TranslationKey): string {
  return key;
}

describe('textQualityService', () => {
  it('filtert kryptische PDF-Operatoren', () => {
    const sanitized = sanitizeExtractedText(DIGITAL_PDF_GARBAGE);
    expect(sanitized).toContain('Werkvertrag');
    expect(sanitized).toContain('Müller Bau GmbH');
    expect(sanitized).not.toMatch(/endobj|xref|\/Type/);
    expect(containsCrypticCharacters(sanitized)).toBe(false);
  });

  it('bewertet lesbaren Text als readable', () => {
    const quality = assessTextQuality(DIGITAL_PDF_CLEAN);
    expect(quality.readable).toBe(true);
    expect(quality.wordCount).toBeGreaterThan(3);
  });

  it('markiert Garbage als nicht lesbar', () => {
    const garbageOnly = '/Type /Page endobj stream BT ET Tj';
    const quality = assessTextQuality(garbageOnly);
    expect(quality.readable).toBe(false);
  });
});

describe('upload PDF extraction pipeline', () => {
  afterEach(() => {
    setPdfTextExtractorForTests(null);
    setPdfOcrExtractorForTests(null);
    setImageOcrExtractorForTests(null);
  });

  it('übernimmt direkten PDF-Text bei guter Qualität', async () => {
    setPdfTextExtractorForTests(() => DIGITAL_PDF_CLEAN);
    const result = await extractDocumentText(createFile('vertrag.pdf', 'application/pdf'));
    expect(result.extractionMethod).toBe('pdf_direct');
    expect(result.recognizedText).toContain('Werkvertrag');
    expect(containsCrypticCharacters(result.displayText)).toBe(false);
  });

  it('nutzt OCR-Fallback wenn Direkttext kryptisch ist', async () => {
    setPdfTextExtractorForTests(() => '/Type /Page endobj stream BT ET garbage only');
    setPdfOcrExtractorForTests(async () => ({
      text: SCANNED_PDF_OCR,
      confidence: 82,
    }));

    const result = await extractDocumentText(createFile('scan.pdf', 'application/pdf'));
    expect(result.extractionMethod).toBe('pdf_ocr');
    expect(result.recognizedText).toContain('Mahnung');
    expect(result.recognizedText).toContain('RE-2026-8842');
    expect(containsCrypticCharacters(result.displayText)).toBe(false);
  });

  it('vergleicht Direkt- und OCR-Variante und wählt die bessere', async () => {
    setPdfTextExtractorForTests(() => 'abc /Type garbage');
    setPdfOcrExtractorForTests(async () => ({
      text: MATERIAL_INVOICE,
      confidence: 90,
    }));

    const result = await extractDocumentText(createFile('rechnung.pdf', 'application/pdf'));
    expect(result.recognizedText).toContain('Materialrechnung');
    expect(result.extractionMethod).toBe('pdf_ocr');
  });

  it('filtert PDF-Literale von Operatoren', async () => {
    setPdfTextExtractorForTests(() => 'Werkvertrag\nAuftraggeber: Müller Bau GmbH');
    const pdfLike = 'BT (Werkvertrag) Tj (Auftraggeber: Müller Bau GmbH) Tj (/Type) Tj ET';
    const result = await extractTextFromPdfBytes(new TextEncoder().encode(pdfLike));
    expect(result.text).toContain('Werkvertrag');
    expect(result.text).not.toContain('/Type');
  });
});

describe('document classification improvements', () => {
  it('erkennt Werkvertrag', () => {
    expect(detectClassifiedKind({ recognizedText: DIGITAL_PDF_CLEAN })).toBe('werkvertrag');
  });

  it('erkennt Materialrechnung', () => {
    expect(detectClassifiedKind({ recognizedText: MATERIAL_INVOICE })).toBe('eingangsrechnung');
  });

  it('erkennt Mahnung', () => {
    expect(detectClassifiedKind({ recognizedText: SCANNED_PDF_OCR })).toBe('mahnung');
  });

  it('erkennt Tankbeleg', () => {
    expect(detectClassifiedKind({ recognizedText: TANKBELEG })).toBe('tankbeleg');
  });

  it('erkennt BG BAU', () => {
    expect(detectClassifiedKind({ recognizedText: BG_BAU })).toBe('bg_bau');
  });

  it('erkennt Lieferschein', () => {
    expect(detectClassifiedKind({ recognizedText: LIEFERSCHEIN })).toBe('lieferschein');
  });
});

describe('document field extraction and understanding', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
  });

  it('übernimmt kein unsicheres Datum ohne Label', () => {
    const fields = toConfidentPlainFields(extractFieldsWithConfidence('Projektinfo ohne Datum 15.03.2026 im Fließtext'));
    expect(fields.Datum).toBeUndefined();
  });

  it('extrahiert Felder aus Materialrechnung', () => {
    const fields = extractFieldsFromText(MATERIAL_INVOICE);
    expect(fields.Rechnungsnummer).toBe('MR-2026-118');
    expect(fields.Betrag).toContain('342,16');
    expect(fields.Baustelle).toContain('Badezimmer');
  });

  it('erkennt Absender aus ungelabeltem Letterhead (Institution / GmbH / Brand)', () => {
    expect(
      extractFieldsFromText(
        'F Finanzamt Detmold Behördenschreiben Büchenstraße 6 · 32756 Detmold Cirmak Haustechnik GmbH',
      ).Absender,
    ).toBe('Finanzamt Detmold');
    expect(
      extractFieldsFromText(
        'H Hotel Lipperland Hotelrechnung Parkstraße 10 · 32756 Detmold Cirmak Haustechnik GmbH',
      ).Absender,
    ).toBe('Hotel Lipperland');
    expect(
      extractFieldsFromText(
        'C Cirmak Haustechnik GmbH SHK · Werkverträge Industriestraße 18 · 32105 Bad Salzuflen',
      ).Absender,
    ).toBe('Cirmak Haustechnik GmbH');
    expect(
      extractFieldsFromText(
        'H Handwerk OWL — Newsletter 26.03.2026 Thema der Woche: Förderungen',
      ).Absender,
    ).toBe('Handwerk OWL');
    expect(
      extractFieldsFromText(
        'A Aral Station Nord Tankstelle Vlothoer Str. 55 · 32105 Bad Salzuflen Kundenbeleg',
      ).Absender,
    ).toBe('Aral Station Nord');
  });

  it('erzeugt Dokument-Zusammenfassung mit KI-Aktionen', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'mahnung.pdf',
      recognizedText: SCANNED_PDF_OCR,
    });
    const { summary, actions } = buildUnderstandingFromItem(item);
    expect(summary.invoiceNumber).toBe('RE-2026-8842');
    expect(summary.amount).toContain('1.247,80');
    expect(summary.deadline).toBe('30.03.2026');
    expect(actions.map((a) => a.id)).toContain('monitor_deadline');
    expect(actions.map((a) => a.id)).toContain('archive_document');
  });

  it('liefert partielle Erkennung statt kryptischer Zeichen in der Vorschau', () => {
    const preview = buildOcrPreviewSummary('bad.pdf', 'abc xyz');
    expect(preview.previewPartialHint).toBe(true);
    expect(preview.previewLines.length).toBe(0);
  });

  it('integriert Understanding in Workflow', () => {
    const item = processUpload({
      sourceFileName: 'lieferschein.pdf',
      recognizedText: `${LIEFERSCHEIN}\nEmpfänger: Mustermann Sanitär GmbH`,
    });
    const workflow = processUploadedDocument(item.id);
    expect(workflow?.documentUnderstanding).toBeTruthy();
    expect(workflow?.documentUnderstanding?.constructionSite).toContain('Hauptstr');
    expect(workflow?.documentAiActions.length).toBeGreaterThan(0);
  });

  it('rendert DocumentIntakeUnderstandingPanel', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'rechnung.pdf',
      recognizedText: MATERIAL_INVOICE,
    });
    const { summary, actions } = buildUnderstandingFromItem(item);
    const html = renderToStaticMarkup(
      createElement(DocumentIntakeUnderstandingPanel, {
        summary,
        actions,
        translate,
      }),
    );
    expect(html).toContain('doc-understanding-panel');
    expect(html).toContain('document.aiAction.archive');
  });
});

describe('pdfOcrFallbackService', () => {
  afterEach(() => {
    setPdfOcrExtractorForTests(null);
  });

  it('unterstützt Test-Override für mehrseitige PDF', async () => {
    setPdfOcrExtractorForTests(async (_file, options) => ({
      text: MULTIPAGE_OCR,
      confidence: options?.pageCount && options.pageCount > 1 ? 88 : 70,
      pagesProcessed: options?.pageCount ?? 1,
    }));

    const result = await extractPdfTextViaOcr(createFile('multi.pdf', 'application/pdf'), 2);
    expect(result.text).toContain('Seite 1');
    expect(result.text).toContain('Seite 2');
    expect(result.confidence).toBe(88);
    expect(result.pagesProcessed).toBe(2);
  });
});
