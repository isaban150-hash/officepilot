import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContractAnalysisPanel } from '../components/inbox/ContractAnalysisPanel';
import { analyzeContractFromInbox } from './contractAnalysisService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { detectClassifiedKind } from './documentClassificationService';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import { processUpload } from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import {
  extractTextFromPdfBytes,
  setPdfTextExtractorForTests,
} from './uploadTextExtractionService';
import type { TranslationKey } from '../i18n';

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

const CONTRACT_PDF_TEXT = `
Bau-Subunternehmervertrag

Werkvertrag

Auftraggeber: Müller Bau GmbH
Subunternehmer: Mustermann Sanitär GmbH
Bauvorhaben: Badezimmer-Sanierung Müller
Baustellenadresse: Hauptstr. 12, 10115 Berlin
Vertragsdatum: 15.03.2026
Auftragsnummer: AV-2026-0042

Leistungsverzeichnis
1 | Demontage Badewanne | Stk | 1 | 450,00 | 450,00

Zahlungsbedingungen: 14 Tage netto
Freistellungsbescheinigung, BG BAU Unbedenklichkeitsbescheinigung

Unterschrift Auftraggeber
Unterschrift Auftragnehmer
`.trim();

const GENERIC_PDF_TEXT = 'Allgemeine Projektinformation für das Objekt.';

function translate(key: TranslationKey): string {
  return key;
}

describe('uploadTextExtractionService', () => {
  afterEach(() => {
    setPdfTextExtractorForTests(null);
  });

  it('liest Text aus PDF-Literalen', async () => {
    const pdfLike = 'BT (Bau-Subunternehmervertrag) Tj (Werkvertrag) Tj ET';
    setPdfTextExtractorForTests(() => 'Bau-Subunternehmervertrag\nWerkvertrag');
    const result = await extractTextFromPdfBytes(new TextEncoder().encode(pdfLike));
    expect(result.text).toContain('Bau-Subunternehmervertrag');
    expect(result.text).toContain('Werkvertrag');
  });
});

describe('upload PDF contract recognition', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
  });

  it('erkennt Werkvertrag aus PDF-Text bei generischem Dateinamen', () => {
    const item = processUpload({
      sourceFileName: 'scan.pdf',
      recognizedText: CONTRACT_PDF_TEXT,
    });

    expect(['werkvertrag', 'subunternehmervertrag']).toContain(item.classifiedKind);
    expect(item.documentType).toBe('kundenauftrag');
    expect(item.recognizedData._extractedText).toContain('Werkvertrag');
    expect(analyzeContractFromInbox(item).isContract).toBe(true);
  });

  it('liefert contractAnalysis im Workflow und rendert ContractAnalysisPanel', () => {
    const item = processUpload({
      sourceFileName: 'dokument.pdf',
      recognizedText: CONTRACT_PDF_TEXT,
    });

    const workflow = processUploadedDocument(item.id);
    expect(workflow?.contractAnalysis?.isContract).toBe(true);

    const html = renderToStaticMarkup(
      createElement(ContractAnalysisPanel, {
        analysis: workflow!.contractAnalysis!,
        item,
        translate,
        onAction: () => {},
      }),
    );
    expect(html).toContain('contract.analysisTitle');
    expect(html).toContain('contract.action.createVorgang');
  });

  it('belässt generische PDF ohne Vertragswörter bei pdf_anlage oder sonstiges', () => {
    const item = processUpload({
      sourceFileName: 'dokument.pdf',
      recognizedText: GENERIC_PDF_TEXT,
    });

    expect(['pdf_anlage', 'sonstiges']).toContain(item.classifiedKind);
    expect(item.documentType).toBe('sonstiges');
    expect(analyzeContractFromInbox(item).isContract).toBe(false);
  });

  it('klassifiziert Vertragstext ohne Mock-Auftrag-Chip', () => {
    const kind = detectClassifiedKind({
      sourceFileName: 'unbenannt.pdf',
      recognizedText: CONTRACT_PDF_TEXT,
    });

    expect(['werkvertrag', 'subunternehmervertrag']).toContain(kind);

    const item = createMockInboxItemFromUpload({
      sourceFileName: 'unbenannt.pdf',
      recognizedText: CONTRACT_PDF_TEXT,
    });
    expect(item.documentType).toBe('kundenauftrag');
    expect(analyzeContractFromInbox(item).isContract).toBe(true);
  });
});
